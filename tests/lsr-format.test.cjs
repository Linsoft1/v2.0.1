const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ZipReader, ZipWriter, compareVersions, extractLsaPackage, openLsaPackage, safeEntryPath, validateManifest, verifyInstalledApp } = require('../runtime/lib/lsr-format.cjs');
const { createKey, tempDir, writePackage } = require('./lsr-test-helpers.cjs');

const key = createKey();

test('zip writer output round-trips through the zip reader', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.zip');
  const zip = new ZipWriter(file);
  const big = Buffer.alloc(100000, 'x');
  zip.add('big.txt', big);
  zip.add('dir/small.bin', Buffer.from([1, 2, 3]));
  zip.close();
  const reader = new ZipReader(file);
  assert.deepEqual([...reader.entries.keys()], ['big.txt', 'dir/small.bin']);
  assert.ok(reader.entries.get('big.txt').compressed < big.length);
  assert.deepEqual(reader.read('big.txt'), big);
  assert.deepEqual(reader.read('dir/small.bin'), Buffer.from([1, 2, 3]));
  reader.close();
});

test('package paths that could escape the install folder are rejected', () => {
  for (const name of ['../evil.js', 'a/../../b', '/etc/passwd', 'C:/Windows/x', 'a\\b', 'a//b', 'a/./b', 'file.', 'con', 'nul.txt', 'a/aux/b', 'x:stream', '']) {
    assert.throws(() => safeEntryPath(name), { code: 'unsafe-path' }, name);
  }
  assert.equal(safeEntryPath('node_modules/@zxing/browser/umd/zxing-browser.min.js'), 'node_modules/@zxing/browser/umd/zxing-browser.min.js');
});

test('a signed package opens, extracts and verifies', () => {
  const dir = tempDir();
  const file = writePackage(path.join(dir, 'ok.lsr'), { key, executable: ['assets/a.txt'] });
  const opened = openLsaPackage(file, [key.trusted]);
  assert.equal(opened.manifest.version, '1.0.0');
  assert.equal(opened.signer.keyId, key.trusted.keyId);
  const target = path.join(dir, 'installed');
  extractLsaPackage(opened, target);
  opened.reader.close();
  assert.equal(fs.readFileSync(path.join(target, 'assets', 'a.txt'), 'utf8'), 'hello');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(target, 'assets', 'a.txt')).mode & 0o777, 0o755);
  assert.equal(verifyInstalledApp(target, [key.trusted]).id, 'sk.linsoft.browser');
  fs.writeFileSync(path.join(target, 'main.cjs'), 'changed size!!!!!!!!!!!!!!!!!!!!!!!!');
  assert.throws(() => verifyInstalledApp(target, [key.trusted]), { code: 'damaged' });
});

test('a package signed by an unknown key is refused', () => {
  const dir = tempDir();
  const file = writePackage(path.join(dir, 'other.lsr'), { key: createKey('Attacker') });
  assert.throws(() => openLsaPackage(file, [key.trusted]), { code: 'untrusted' });
});

test('a file changed after signing is detected before it is written', () => {
  const dir = tempDir();
  const file = writePackage(path.join(dir, 'tampered.lsr'), { key, content: { 'main.cjs': 'evil();;;;;;;;;;;;;;;;', 'assets/a.txt': 'hello' }, signedContent: { 'main.cjs': 'module.exports = 1;\n', 'assets/a.txt': 'hello' } });
  const opened = openLsaPackage(file, [key.trusted]);
  const target = path.join(dir, 'installed');
  assert.throws(() => extractLsaPackage(opened, target), { code: 'tampered' });
  opened.reader.close();
  assert.equal(fs.existsSync(path.join(target, 'main.cjs')), false);
});

test('a file with the right size but different content is detected', () => {
  const dir = tempDir();
  const file = writePackage(path.join(dir, 'tampered.lsr'), { key, content: { 'main.cjs': 'module.exports = 2;\n', 'assets/a.txt': 'hello' }, signedContent: { 'main.cjs': 'module.exports = 1;\n', 'assets/a.txt': 'hello' } });
  const opened = openLsaPackage(file, [key.trusted]);
  assert.throws(() => extractLsaPackage(opened, path.join(dir, 'installed')), { code: 'tampered' });
  opened.reader.close();
});

test('unsigned extra files and missing files are refused', () => {
  const dir = tempDir();
  const extra = writePackage(path.join(dir, 'extra.lsr'), { key, content: { 'main.cjs': 'x', 'payload.exe': 'MZ' }, signedContent: { 'main.cjs': 'x' } });
  assert.throws(() => openLsaPackage(extra, [key.trusted]), { code: 'tampered' });
  const missing = writePackage(path.join(dir, 'missing.lsr'), { key, content: { 'main.cjs': 'x' }, signedContent: { 'main.cjs': 'x', 'lib/a.cjs': 'y' } });
  assert.throws(() => openLsaPackage(missing, [key.trusted]), { code: 'missing-file' });
});

test('a non-zip file is reported as corrupt', () => {
  const dir = tempDir();
  const file = path.join(dir, 'junk.lsr');
  fs.writeFileSync(file, 'this is not a package');
  assert.throws(() => openLsaPackage(file, [key.trusted]), { code: 'corrupt' });
});

test('manifest validation rejects bad identity, versions and update settings', () => {
  const base = { lsa: 1, id: 'sk.linsoft.browser', name: 'X', version: '1.0.0', main: 'main.cjs', minRuntimeVersion: '1.0.0', electron: '44.4.5', files: { 'main.cjs': { size: 1, sha256: 'a'.repeat(64) } } };
  assert.doesNotThrow(() => validateManifest(base));
  assert.throws(() => validateManifest({ ...base, lsa: 2 }), { code: 'unsupported-format' });
  assert.throws(() => validateManifest({ ...base, id: '../x' }), { code: 'bad-manifest' });
  assert.throws(() => validateManifest({ ...base, version: '1.0' }), { code: 'bad-manifest' });
  assert.throws(() => validateManifest({ ...base, main: 'missing.cjs' }), { code: 'bad-manifest' });
  assert.throws(() => validateManifest({ ...base, files: { ...base.files, 'MAIN.cjs': base.files['main.cjs'] } }), { code: 'bad-manifest' });
  assert.throws(() => validateManifest({ ...base, updates: { github: 'evil.com/../x', asset: '{version}.lsr' } }), { code: 'bad-manifest' });
  assert.doesNotThrow(() => validateManifest({ ...base, updates: { github: 'Linsoft1/v2.0.1', asset: 'Linsoft-Browser-{version}.lsr' } }));
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('2.0.10', '2.0.9'), 1);
  assert.equal(compareVersions('2.0.32', '2.0.32'), 0);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
});
