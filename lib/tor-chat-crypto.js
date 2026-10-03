(function initializeTorChatCrypto(root, createApi) {
  const api = createApi();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.linsoftTorChatCrypto = api;
})(globalThis, () => {
  function encodeBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeBase64Url(value) {
    const encoded = String(value || '');
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error('Invalid base64url data.');
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function importKey(encodedKey) {
    const rawKey = decodeBase64Url(encodedKey);
    if (rawKey.length !== 32) throw new Error('The chat key must contain 256 bits.');
    return globalThis.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function generateKey() {
    const rawKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const encoded = encodeBase64Url(rawKey);
    return { encoded, key: await importKey(encoded) };
  }

  async function encrypt(key, plaintext) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plaintext)));
    return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) };
  }

  async function decrypt(key, envelope) {
    const iv = decodeBase64Url(envelope?.iv);
    const ciphertext = decodeBase64Url(envelope?.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encrypted chat message.');
    const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  }

  return Object.freeze({ decodeBase64Url, encodeBase64Url, decrypt, encrypt, generateKey, importKey });
});