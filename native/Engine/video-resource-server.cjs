// SPDX-License-Identifier: GPL-3.0-or-later
// The sandboxed player sees only opaque, per-item loopback URLs. It cannot ask
// this server to fetch arbitrary URLs or access the receiver's credentials.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { playableUrl } = require('./protocol/videoInCar.js');
const MANIFEST_LIMIT = 2 * 1024 * 1024;
const RESOURCE_LIMIT = 32 * 1024 * 1024;

function blockedAddress(address) {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  // WHATWG URL canonicalizes IPv4-mapped literals to hex (e.g. ::ffff:7f00:1).
  const mapped = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) { const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16); ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return ip === '::' || ip === '::1' || /^(127\.|0\.|169\.254\.)/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}
function rewritePlaylist(text, base, register) {
  const child = value => register(new URL(value, base).href);
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${child(uri)}"`);
    return child(line.trim());
  }).join('\n');
}
async function collect(stream, max) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > max) { stream.destroy(); throw Error('Media resource exceeds size limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class VideoResourceServer {
  constructor(resolveFromPhone, { allowLoopback = false } = {}) {
    this.resolveFromPhone = resolveFromPhone;
    this.allowLoopback = allowLoopback; // Only used by isolated local-fixture tests.
    this.requests = new Set(); this.current = undefined; this.closed = false;
    this.server = http.createServer((req, res) => this.serve(req, res));
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 10000;
    this.listening = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(); });
    });
  }
  async start(itemId, url, streaming) {
    if (this.closed) throw Error('Media proxy closed');
    this.stop();
    const item = { itemId, token: randomBytes(24).toString('hex'), resources: new Map(), byUrl: new Map() };
    this.current = item;
    await this.listening;
    if (this.current !== item) return undefined;
    return this.register(item, url, streaming);
  }
  register(item, url, manifest = false) {
    if (!playableUrl(url)) throw Error('Unsupported media URL');
    if (item.byUrl.has(url)) return item.byUrl.get(url);
    if (item.resources.size >= 10000) throw Error('Too many media resources');
    const id = randomBytes(12).toString('hex') + (manifest || /\.m3u8(?:\?|$)/i.test(url) ? '.m3u8' : '');
    item.resources.set(id, { url, manifest });
    const local = `http://127.0.0.1:${this.port}/${item.token}/${id}`;
    item.byUrl.set(url, local);
    return local;
  }
  stop() {
    this.current = undefined;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.stop();
    this.listening.then(() => { this.server.close(); this.server.closeAllConnections(); }, () => {});
  }
  async get(item, url, range, signal, redirects = 0) {
    if (signal.aborted || this.current !== item) throw Error('Playback ended');
    if (!playableUrl(url) || redirects > 5) throw Error('Unsupported media redirect');
    const target = new URL(url);
    let result;
    if (['http:', 'https:'].includes(target.protocol)) {
      if (!this.allowLoopback && (blockedAddress(target.hostname.replace(/^\[|\]$/g, '')) || target.hostname.toLowerCase() === 'localhost')) throw Error('Local service URL rejected');
      result = await new Promise((resolve, reject) => {
        const lookup = (hostname, options, callback) => dns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          const candidates = addresses.filter(a => this.allowLoopback || !blockedAddress(a.address));
          if (!candidates.length) return callback(Error('Local service address rejected'));
          if (options?.all) callback(null, candidates);
          else callback(null, candidates[0].address, candidates[0].family);
        });
        const req = (target.protocol === 'https:' ? https : http).get(target, {
          signal, lookup, headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'MacPlay-CarPlayVideo/1', ...(range ? { Range: range } : {}) }
        }, response => resolve({ status: response.statusCode || 502, headers: response.headers, body: response, url }));
        req.setTimeout(20000, () => req.destroy(Error('Media request timed out')));
        req.once('error', reject);
      });
    } else {
      const response = await this.resolveFromPhone(item.itemId, url);
      if (signal.aborted || this.current !== item) throw Error('Playback ended');
      const data = Buffer.isBuffer(response.data) ? response.data : Buffer.alloc(0);
      if (data.length > RESOURCE_LIMIT) throw Error('Phone resource exceeds size limit');
      const headers = { 'content-type': response.contentType || 'application/octet-stream' };
      if (response.location) headers.location = response.location;
      let status = response.status, body = data;
      if (range && status === 200) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match || Number(match[1]) >= data.length) return { status: 416, headers: { 'content-range': `bytes */${data.length}` }, body: Readable.from([]), url };
        const start = Number(match[1]), end = Math.min(data.length - 1, match[2] ? Number(match[2]) : data.length - 1);
        if (end < start) throw Error('Invalid media range');
        body = data.subarray(start, end + 1); status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${data.length}`;
      }
      headers['content-length'] = String(body.length); headers['accept-ranges'] = 'bytes';
      result = { status, headers, body: Readable.from([body]), url };
    }
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      result.body.destroy();
      return this.get(item, new URL(result.headers.location, url).href, range, signal, redirects + 1);
    }
    return result;
  }
  async serve(req, res) {
    const item = this.current, parts = (req.url || '').split('/');
    const entry = item && parts.length === 3 && parts[1] === item.token && item.resources.get(parts[2]);
    if (!entry || !['GET', 'HEAD'].includes(req.method) || req.headers.host !== `127.0.0.1:${this.port}`) { res.writeHead(404).end(); return; }
    if (this.requests.size >= 32) { res.writeHead(429).end(); return; }
    const controller = new AbortController(); this.requests.add(controller);
    res.once('close', () => controller.abort());
    const range = req.headers.range;
    if (range && !/^bytes=\d+-\d*$/.test(range)) { res.writeHead(416).end(); this.requests.delete(controller); return; }
    try {
      const upstream = await this.get(item, entry.url, range, controller.signal);
      if (this.current !== item || controller.signal.aborted) { upstream.body.destroy(); return; }
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers[name]) headers[name] = upstream.headers[name];
      const playlist = upstream.status === 200 && (entry.manifest || /mpegurl/i.test(headers['content-type'] || '') || /\.m3u8(?:\?|$)/i.test(upstream.url));
      if (playlist && req.method !== 'HEAD') {
        const input = (await collect(upstream.body, MANIFEST_LIMIT)).toString('utf8');
        if (!input.trimStart().startsWith('#EXTM3U')) throw Error('Invalid HLS playlist');
        const body = Buffer.from(rewritePlaylist(input, upstream.url, url => this.register(item, url)));
        headers['content-type'] = 'application/vnd.apple.mpegurl'; headers['content-length'] = String(body.length);
        delete headers['content-range'];
        res.writeHead(200, headers).end(body);
      } else {
        res.writeHead(upstream.status, headers);
        if (req.method === 'HEAD') { upstream.body.destroy(); res.end(); }
        else await pipeline(upstream.body, res);
      }
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    } finally { this.requests.delete(controller); }
  }
}
module.exports = { VideoResourceServer, rewritePlaylist, blockedAddress };
