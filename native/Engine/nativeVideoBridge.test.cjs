const test = require('node:test'), assert = require('node:assert/strict');
const { NativeVideoBridge } = require('../../build/engine/nativeVideoBridge');
const turn = () => new Promise(resolve => setImmediate(resolve));
const owner = () => ({ resolveVideoUrl: async () => ({ status: 200, data: Buffer.from('fixture') }), updateVideoState() {} });

test('async load preserves an immediate rate/seek and hides the original media URL', async t => {
  const sent = [], bridge = new NativeVideoBridge(message => sent.push(message)), stack = owner(); t.after(() => bridge.close());
  bridge.handle(stack, { action: 'load', itemId: 'a', url: 'fixture://token/clip.mp4' });
  bridge.handle(stack, { action: 'rate', itemId: 'a', playing: true });
  bridge.handle(stack, { action: 'seek', itemId: 'a', seconds: 4 });
  await turn();
  assert.deepEqual(sent.map(value => value.action), ['load', 'rate', 'seek']);
  assert(sent[0].url.startsWith('http://127.0.0.1:')); assert(!sent[0].url.includes('token'));
  assert.equal(await (await fetch(sent[0].url)).text(), 'fixture');
});

test('stop/replacement cannot reveal a delayed load, and stale owners cannot stop another item', async t => {
  const sent = [], bridge = new NativeVideoBridge(message => sent.push(message)), first = owner(), second = owner(); t.after(() => bridge.close());
  bridge.handle(first, { action: 'load', itemId: 'a', url: 'fixture://old' });
  bridge.handle(first, { action: 'stop', itemId: 'a' });
  bridge.handle(second, { action: 'load', itemId: 'b', url: 'fixture://new' });
  bridge.stop(first);
  await turn();
  assert.deepEqual(sent.filter(value => value.action === 'load').map(value => value.itemId), ['b']);
  const url = sent.find(value => value.action === 'load').url;
  bridge.close(); await turn();
  await assert.rejects(fetch(url));
});
