require('./test-support/protocol-fixture.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), net = require('node:net');
const { once } = require('node:events');
const { CpStack } = require('../../build/engine/protocol/cpStack');
const { buildInfoPlist } = require('../../build/engine/protocol/getInfo');
const { encodeBplist, decodeBplist } = require('../../build/engine/protocol/bplist');
const { ControlCipher } = require('../../build/engine/protocol/controlCipher');
const { hkdfSha512 } = require('../../build/engine/protocol/crypto');
const { parseMessages } = require('../../build/engine/protocol/rtspMessage');
const { VideoSettingsChannel } = require('../../build/engine/protocol/videoSettingsChannel');
const { VideoPlayback } = require('../../build/engine/protocol/videoPlayback');
const { VIDEO_REMOTE_UUIDS, VIDEO_SETTINGS_UUID, playableUrl } = require('../../build/engine/protocol/videoInCar');
const config = () => ({ mfi: {}, main: { widthPixels: 1280, heightPixels: 720 }, icons: [], entertainmentSampleRate: 48000 });
const req = (body, stream) => ({ method: 'POST', path: '/command', headers: stream === undefined ? {} : { 'x-apple-streamid': String(stream) }, body: encodeBplist(body) });

test('native video is opt-in and advertises extended video bits only when configured', () => {
  assert.equal(buildInfoPlist(config()).videoPlaybackInfo, undefined);
  const info = buildInfoPlist({ ...config(), videoInCar: true, videoPlaybackAllowed: true });
  assert.equal(info.videoPlaybackInfo.videoPlaybackAllowed, true);
  const bits = Buffer.from(info.videoPlaybackInfo.featuresEx, 'base64');
  assert.equal(bits[8] & 1, 1); assert.equal(bits[0] & 1, 1);
  assert.equal(info.videoPlaybackInfo.playbackCapabilities.supportsFPSSecureStop, false);
  assert.equal(buildInfoPlist({ ...config(), videoInCar: true }).videoPlaybackInfo.videoPlaybackAllowed, false);
});

test('session SETUP enables video only if both sides propose it', async t => {
  for (const enabled of [false, true]) for (const proposed of [[], ['videoPlayback']]) {
    const stack = new CpStack({ ...config(), videoInCar: enabled }), session = { peerHost: '127.0.0.1', pairVerify: {}, audioMeta: [] };
    t.after(() => stack._teardown(session));
    const result = decodeBplist((await stack._handleSetup(req({ features: proposed }), session)).body);
    assert.equal(result.enabledFeatures.includes('videoPlayback'), enabled && proposed.length > 0);
  }
});

test('encrypted settings stream acknowledges fragmented sync packets and preserves sequence', { timeout: 5000 }, async t => {
  const read = Buffer.alloc(32, 1), write = Buffer.alloc(32, 2), channel = new VideoSettingsChannel(read, write, '127.0.0.1');
  const port = await channel.listen(), client = net.connect(port, '127.0.0.1');
  t.after(() => { client.destroy(); channel.stop(); channel.stop(); });
  await once(client, 'connect');
  const cipher = new ControlCipher(write, read), sync = Buffer.alloc(32);
  sync.writeUInt32BE(32); sync.write('sync', 4); sync.writeBigUInt64BE(9007199254740993n, 20);
  const sealed = cipher.encrypt(sync), received = once(client, 'data');
  client.write(sealed.subarray(0, 9)); client.write(sealed.subarray(9));
  const reply = cipher.decrypt((await received)[0]).data;
  assert.equal(reply.readUInt32BE(0), 32); assert.equal(reply.toString('ascii', 4, 8), 'rply');
  assert.deepEqual(reply.subarray(20, 28), sync.subarray(20, 28));
});

test('video stream allocation and teardown leave the iAP tunnel and other video stream intact', async t => {
  const stack = new CpStack({ ...config(), videoInCar: true, videoPlaybackAllowed: true });
  let iapClosed = false;
  const session = { videoNegotiated: true, peerHost: '127.0.0.1', pairVerify: { sharedSecret: Buffer.alloc(32, 1) }, audioMeta: [], iapTunnel: { stop() { iapClosed = true; } } };
  t.after(() => session.videoSettings?.stop());
  const a = await stack._setupDataStream({ clientTypeUUID: [...VIDEO_REMOTE_UUIDS][0], controlType: 1 }, session);
  const b = await stack._setupDataStream({ clientTypeUUID: [...VIDEO_REMOTE_UUIDS][1], controlType: 1 }, session);
  assert.equal(a.streamID, 3); assert.equal(b.streamID, 4); assert.equal(a.dataPort, undefined);
  const settings = await stack._setupDataStream({ clientTypeUUID: VIDEO_SETTINGS_UUID, seed: -1n, streamConnectionID: 42 }, session);
  assert.equal(settings.streamID, 2); assert.equal(settings.streamConnectionID, 42); assert(settings.dataPort > 0);
  stack._handleTeardown(req({ streams: [{ type: 130, streamID: 2 }, { type: 130, streamID: 4 }] }), session);
  assert.equal(iapClosed, false); assert(session.videoStreams.has(3)); assert(!session.videoStreams.has(4));
});

test('availability waits for RECORD, resends on reconnect, and remote replies use their stream header', { timeout: 5000 }, async t => {
  const stack = new CpStack({ ...config(), videoInCar: true, videoPlaybackAllowed: true }), shared = Buffer.alloc(32, 9);
  const session = { videoNegotiated: true, videoStreams: new Map([[3, 'video']]), pairVerify: { sharedSecret: shared }, audioMeta: [], pendingEvents: [], recordResponseSent: false, eventCseq: 0 };
  stack._liveSession = session; stack._openIapMessageRelay = () => {};
  const port = await stack._openEventChannel(session), clients = [];
  t.after(() => { clients.forEach(c => c.destroy()); stack._teardown(session); });
  async function connect() {
    const accepted = once(stack, 'protocol-state'), client = net.connect(port, '127.0.0.1'); clients.push(client);
    const cipher = new ControlCipher(hkdfSha512(shared, 'Events-Salt', 'Events-Write-Encryption-Key', 32), hkdfSha512(shared, 'Events-Salt', 'Events-Read-Encryption-Key', 32));
    let encrypted = Buffer.alloc(0), plain = Buffer.alloc(0); const messages = [];
    client.on('data', data => { encrypted = Buffer.concat([encrypted, data]); const d = cipher.decrypt(encrypted); encrypted = d.rest; plain = Buffer.concat([plain, d.data]); const parsed = parseMessages(plain); plain = parsed.rest; messages.push(...parsed.messages); });
    await accepted;
    const next = async () => { for (let i = 0; i < 200; i++) { if (messages.length) return messages.shift(); await new Promise(r => setTimeout(r, 5)); } throw Error('Event timeout'); };
    return { client, next, messages };
  }
  const first = await connect(); stack._sendVideoAvailability(session);
  assert.equal(session.videoAllowedSent, undefined);
  stack._recordResponseWritten(session);
  assert.equal(decodeBplist((await first.next()).body).params.videoPlaybackAllowed, true);
  const nested = { type: 'property', kind: 'request', property: 'hasEnabledAudio', messageID: 17 };
  assert.equal(stack._handleCommand(req({ params: { data: encodeBplist(nested) } }, 3), session).status, 200);
  const reply = await first.next(); assert.equal(reply.headers['x-apple-streamid'], '3');
  assert.deepEqual(decodeBplist(decodeBplist(reply.body).params.data), { type: 'property', kind: 'response', messageID: 17, key: 'hasEnabledAudio', value: true });
  const second = await connect();
  assert.equal(decodeBplist((await second.next()).body).params.videoPlaybackAllowed, true);
  let host = false; stack.on('host-ui-requested', () => host = true);
  stack._handleCommand(req({ type: 'requestUI', params: { url: 'videoplayback:' } }), session);
  assert.equal(host, false);
});

test('queue, rate, seek and player feedback preserve item identity and discard stale player updates', async () => {
  const sent = [], emitted = []; let allowed = true;
  const player = new VideoPlayback((stream, message) => { sent.push({ stream, message }); return true; }, message => emitted.push(message), () => allowed);
  player.handle(3, { type: 'insertPlayQueueItem', item: { uuid: Buffer.from('abc'), 'Content-Location': 'https://example.com/a.mp4', 'Start-Position-Seconds': 2 } });
  const id = emitted.at(-1).itemId;
  player.handle(3, { type: 'setRate', rate: 1 }); assert.equal(emitted.at(-1).playing, true);
  player.handle(4, { type: 'seek', kind: 'request', messageID: 8, time: { value: 3500, timescale: 1000 } });
  assert.equal(emitted.at(-1).seconds, 3.5); assert.equal(sent.at(-1).stream, 4);
  player.update(id, { prepared: true, playing: true, positionSeconds: 3.5, durationSeconds: 60, bufferedSeconds: 10 });
  assert.equal(sent.at(-1).stream, 3); assert.equal(sent.at(-1).message.name, 'playing');
  player.handle(4, { type: 'playbackInfo', kind: 'request', messageID: 9 });
  assert.equal(sent.at(-1).message.info.position.value, 3500);
  const resource = player.resolveUrl(id, 'app-resource://media/segment');
  const requestId = sent.at(-1).message.request.FCUP_Response_RequestID;
  player.handle(3, { type: 'unhandledURL', response: { FCUP_Response_RequestID: requestId, FCUP_Response_StatusCode: 200, FCUP_Response_Data: Buffer.from('data') } });
  assert.equal((await resource).data.toString(), 'data');
  const pending = player.resolveUrl(id, 'app-resource://pending'); player.stop(); assert.equal((await pending).status, 410);
  const count = sent.length; player.update(id, { playing: true }); assert.equal(sent.length, count);
  allowed = false; player.handle(3, { type: 'insertPlayQueueItem', item: { 'Content-Location': 'https://example.com/no.mp4' } });
  assert.equal(sent.at(-1).message.error.code, -12927);
});

test('media rejects file, script, credentials and FairPlay URLs', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'skd://key', 'https://user:password@example.com/', 'data:text/html,bad', 'not a url']) assert.equal(playableUrl(url), false, url);
  for (const url of ['https://example.com/a.mp4', 'http://192.168.1.2/media', 'app-resource://id']) assert.equal(playableUrl(url), true, url);
});
