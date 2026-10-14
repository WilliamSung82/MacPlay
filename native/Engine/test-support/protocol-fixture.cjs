// Protocol-only tests: replace the platform media addon and use Node/OpenSSL
// for the same ChaCha20-Poly1305 primitive. No Bluetooth or audio devices open.
const crypto = require('node:crypto');
const mediaPath = require.resolve('../../../build/engine/media');
require.cache[mediaPath] = { id: mediaPath, filename: mediaPath, loaded: true, exports: {
  addon: { mediaActivity: () => [0, 0] }, onAudioReceiverStarted() {}, gstHost: { onAudioStarted() {} }
} };
const aeadPath = require.resolve('livi-crypto');
require.cache[aeadPath] = { id: aeadPath, filename: aeadPath, loaded: true, exports: {
  seal(key, nonce, plain, aad) {
    const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad) c.setAAD(aad, { plaintextLength: plain.length });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  },
  open(key, nonce, sealed, aad) {
    try {
      const c = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAuthTag(sealed.subarray(-16));
      if (aad) c.setAAD(aad, { plaintextLength: sealed.length - 16 });
      return Buffer.concat([c.update(sealed.subarray(0, -16)), c.final()]);
    } catch { return null; }
  }
} };
