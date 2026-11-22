const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MANIFEST_NAME, SIGNATURE_NAME, ZipWriter, publicKeyId, sha256, signManifest } = require('../runtime/lib/lsr-format.cjs');

function createKey(name = 'Test') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), trusted: { keyId: publicKeyId(publicKeyPem), name, publicKey: publicKeyPem } };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lsa-test-'));
}

/**
 * Writes an .lsr file. `content` maps package paths to file contents (what the zip holds);
 * `signedContent` (defaults to `content`) is what the manifest describes and signs.
 */
function writePackage(file, { key, version = '1.0.0', id = 'sk.linsoft.browser', content = { 'main.cjs': 'module.exports = 1;\n', 'assets/a.txt': 'hello' }, signedContent, manifest: overrides = {}, executable = [] }) {
  const described = signedContent || content;
  const files = {};
  for (const [name, text] of Object.entries(described)) {
    const data = Buffer.from(text);
    files[name] = { size: data.length, sha256: sha256(data), ...(executable.includes(name) ? { executable: true } : {}) };
  }
  const manifest = { lsa: 1, id, name: 'Linsoft Browser', version, main: 'main.cjs', minRuntimeVersion: '1.0.0', electron: '44.4.5', files, ...overrides };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const zip = new ZipWriter(file);
  zip.add(MANIFEST_NAME, manifestBytes);
  zip.add(SIGNATURE_NAME, Buffer.from(JSON.stringify(signManifest(manifestBytes, key.privateKeyPem))));
  for (const [name, text] of Object.entries(content)) zip.add(name, Buffer.from(text));
  zip.close();
  return file;
}

module.exports = { createKey, tempDir, writePackage };
