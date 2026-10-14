const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { once } = require('node:events');
const { VideoResourceServer, rewritePlaylist, blockedAddress } = require('../../build/engine/video-resource-server.cjs');
async function fixture(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild/index.m3u8\n');
    else if (req.url === '/child/index.m3u8') res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2\n../segment.ts\n');
    else if (req.url === '/redirect') res.writeHead(302, { location: '/media.mp4' }).end();
    else if (req.headers.range) res.writeHead(206, { 'content-range': 'bytes 2-4/10', 'content-type': 'video/mp4' }).end('234');
    else res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }).end('0123456789');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('HLS master, media playlist, init segment and relative segment stay behind opaque proxy URLs', async t => {
  const remote = await fixture(t), proxy = new VideoResourceServer(() => {}, { allowLoopback: true }); t.after(() => proxy.close());
  const url = await proxy.start('item', remote + '/master.m3u8', true);
  const master = await (await fetch(url)).text(), childUrl = master.trim().split('\n').at(-1);
  assert(!master.includes('/child/')); assert(childUrl.startsWith(`http://127.0.0.1:${proxy.port}/`));
  const child = await (await fetch(childUrl)).text();
  assert(!child.includes('../')); assert(!child.includes('init.mp4'));
  const segment = child.trim().split('\n').at(-1); assert.equal(await (await fetch(segment)).text(), '0123456789');
  const init = child.match(/URI="([^"]+)"/)[1]; assert.equal(await (await fetch(init)).text(), '0123456789');
});
test('progressive MP4 forwards ranges and redirects; replacing item invalidates old URLs', async t => {
  const remote = await fixture(t), proxy = new VideoResourceServer(() => {}, { allowLoopback: true }); t.after(() => proxy.close());
  const old = await proxy.start('a', remote + '/redirect', false);
  const response = await fetch(old, { headers: { Range: 'bytes=2-4' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-4/10'); assert.equal(await response.text(), '234');
  const current = await proxy.start('b', remote + '/media.mp4', false);
  assert.equal((await fetch(old)).status, 404); assert.equal((await fetch(current)).status, 200);
  assert.equal((await fetch(current.replace(/.$/, 'x'))).status, 404);
});
test('phone-loaded custom URLs support byte ranges and do not expose phone resource contents in URLs', async t => {
  const calls = [], proxy = new VideoResourceServer(async (id, url) => { calls.push([id, url]); return { status: 200, contentType: 'video/mp4', data: Buffer.from('0123456789') }; }); t.after(() => proxy.close());
  const url = await proxy.start('a', 'app-resource://private-token/video', false);
  assert(!url.includes('private-token'));
  const response = await fetch(url, { headers: { Range: 'bytes=3-5' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '345'); assert.equal(calls[0][0], 'a');
});
test('production proxy blocks loopback and unsupported playlist key schemes', async t => {
  const remote = await fixture(t), proxy = new VideoResourceServer(() => {}); t.after(() => proxy.close());
  const url = await proxy.start('a', remote + '/media.mp4', false);
  assert.equal((await fetch(url)).status, 502);
  assert(blockedAddress('::ffff:127.0.0.1')); assert(blockedAddress('::1')); assert(!blockedAddress('192.168.137.1'));
  assert(blockedAddress('[::ffff:7f00:1]')); assert(blockedAddress('::ffff:a9fe:a9fe'));
  const mapped = await proxy.start('b', `http://[::ffff:7f00:1]:${new URL(remote).port}/media.mp4`, false);
  assert.equal((await fetch(mapped)).status, 502);
  assert.throws(() => rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"', 'https://example.com/a.m3u8', child => proxy.register(proxy.current, child)), /Unsupported/);
});
