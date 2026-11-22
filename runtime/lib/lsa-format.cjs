'use strict';
// Linsoft Application package (.lsa) format.
// An .lsa file is a ZIP archive that contains `manifest.json`, `signature.sig`
// and every application file listed (with size and SHA-256) in the manifest.
// The signature is an Ed25519 signature over the exact bytes of manifest.json,
// so one signature check plus per-file hash checks authenticate the whole package.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const LSA_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const SIGNATURE_NAME = 'signature.sig';
const MAX_ENTRIES = 20000;
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 16 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

class LsaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LsaError';
    this.code = code;
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Returns a normalized package path or throws when the path could escape the install folder. */
function safeEntryPath(name) {
  if (typeof name !== 'string' || !name || name.length > 400) throw new LsaError('unsafe-path', 'Neplatná cesta v balíku.');
  if (/[\\:*?"<>|\u0000-\u001f]/.test(name) || name.startsWith('/')) throw new LsaError('unsafe-path', `Nebezpečná cesta v balíku: ${name}`);
  const segments = name.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ')) {
      throw new LsaError('unsafe-path', `Nebezpečná cesta v balíku: ${name}`);
    }
    if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(segment)) throw new LsaError('unsafe-path', `Rezervovaný názov súboru: ${name}`);
  }
  return segments.join('/');
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new LsaError('bad-manifest', 'Manifest chýba alebo je poškodený.');
  if (manifest.lsa !== LSA_FORMAT_VERSION) throw new LsaError('unsupported-format', `Nepodporovaná verzia formátu .lsa: ${manifest.lsa}`);
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) throw new LsaError('bad-manifest', 'Manifest má neplatné id aplikácie.');
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80) throw new LsaError('bad-manifest', 'Manifest má neplatný názov aplikácie.');
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) throw new LsaError('bad-manifest', 'Manifest má neplatnú verziu.');
  if (typeof manifest.minRuntimeVersion !== 'string' || !VERSION_PATTERN.test(manifest.minRuntimeVersion)) throw new LsaError('bad-manifest', 'Manifest nemá platnú minimálnu verziu runtime.');
  if (typeof manifest.electron !== 'string' || !/^\d+\./.test(manifest.electron)) throw new LsaError('bad-manifest', 'Manifest neuvádza verziu Electronu.');
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new LsaError('bad-manifest', 'Manifest neobsahuje zoznam súborov.');
  const names = Object.keys(files);
  if (!names.length || names.length > MAX_ENTRIES) throw new LsaError('bad-manifest', 'Manifest má neplatný počet súborov.');
  const lowerNames = new Set();
  let total = 0;
  for (const name of names) {
    safeEntryPath(name);
    if (name === MANIFEST_NAME || name === SIGNATURE_NAME) throw new LsaError('bad-manifest', 'Manifest nesmie obsahovať sám seba.');
    const lower = name.toLowerCase();
    if (lowerNames.has(lower)) throw new LsaError('bad-manifest', `Duplicitný súbor v manifeste: ${name}`);
    lowerNames.add(lower);
    const entry = files[name];
    if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_SIZE || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
      throw new LsaError('bad-manifest', `Neplatný záznam súboru v manifeste: ${name}`);
    }
    total += entry.size;
  }
  if (total > MAX_TOTAL_SIZE) throw new LsaError('too-large', 'Balík je príliš veľký.');
  const main = manifest.main;
  if (typeof main !== 'string' || !files[safeEntryPath(main)]) throw new LsaError('bad-manifest', 'Manifest neuvádza existujúci hlavný súbor (main).');
  if (manifest.updates !== undefined) {
    const updates = manifest.updates;
    if (!updates || !/^[\w.-]+\/[\w.-]+$/.test(updates.github || '') || typeof updates.asset !== 'string' || !updates.asset.includes('{version}') || /[/\\]/.test(updates.asset)) {
      throw new LsaError('bad-manifest', 'Manifest má neplatné nastavenie aktualizácií.');
    }
  }
  return manifest;
}

function publicKeyId(publicKey) {
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
  return sha256(key.export({ type: 'spki', format: 'der' })).slice(0, 16);
}

function signManifest(manifestBytes, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    algorithm: 'ed25519',
    keyId: publicKeyId(publicKey),
    signature: crypto.sign(null, manifestBytes, privateKey).toString('base64')
  };
}

/**
 * @param {Buffer} manifestBytes
 * @param {Buffer|string} signatureBytes
 * @param {Array<{keyId?: string, publicKey: string}>} trustedKeys
 */
function verifyManifestSignature(manifestBytes, signatureBytes, trustedKeys) {
  let signature;
  try { signature = JSON.parse(String(signatureBytes)); } catch { throw new LsaError('bad-signature', 'Podpis balíka je poškodený.'); }
  if (signature?.algorithm !== 'ed25519' || typeof signature.signature !== 'string') throw new LsaError('bad-signature', 'Nepodporovaný podpis balíka.');
  for (const trusted of trustedKeys || []) {
    try {
      const key = crypto.createPublicKey(trusted.publicKey);
      if (publicKeyId(key) !== signature.keyId) continue;
      if (crypto.verify(null, manifestBytes, key, Buffer.from(signature.signature, 'base64'))) return { keyId: signature.keyId, publisher: trusted.name || '' };
    } catch {}
  }
  throw new LsaError('untrusted', 'Balík nie je podpísaný dôveryhodným kľúčom Linsoft.');
}

function parseManifest(manifestBytes) {
  if (manifestBytes.length > MAX_MANIFEST_SIZE) throw new LsaError('bad-manifest', 'Manifest je príliš veľký.');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new LsaError('bad-manifest', 'Manifest nie je platný JSON.'); }
  return validateManifest(manifest);
}

// ---------------------------------------------------------------- ZIP writer

function dosDateTime() {
  // Fixed 1980-01-01 00:00 timestamp keeps builds reproducible.
  return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
}

class ZipWriter {
  constructor(filePath) {
    this.fd = fs.openSync(filePath, 'w');
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
  }

  write(buffer) {
    fs.writeSync(this.fd, buffer);
    this.offset += buffer.length;
  }

  add(name, data, { mode = 0o644 } = {}) {
    safeEntryPath(name);
    if (this.names.has(name)) throw new LsaError('duplicate', `Duplicitný súbor: ${name}`);
    this.names.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const crc = crc32(data);
    const { time, date } = dosDateTime();
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const localOffset = this.offset;
    this.write(header);
    this.write(nameBytes);
    this.write(payload);
    if (this.offset > 0xfffffff0) throw new LsaError('too-large', 'Balík presahuje 4 GB.');
    this.entries.push({ nameBytes, method: useDeflate ? 8 : 0, crc, compressed: payload.length, size: data.length, localOffset, mode, time, date });
  }

  close() {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | 20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      header.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      this.write(header);
      this.write(entry.nameBytes);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
  }
}

// ---------------------------------------------------------------- ZIP reader

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, position + read);
    if (!count) throw new LsaError('corrupt', 'Balík je neúplný alebo poškodený.');
    read += count;
  }
  return buffer;
}

class ZipReader {
  constructor(filePath) {
    this.fd = fs.openSync(filePath, 'r');
    try { this.entries = this.readCentralDirectory(); } catch (error) { this.close(); throw error; }
  }

  readCentralDirectory() {
    const size = fs.fstatSync(this.fd).size;
    if (size < 22) throw new LsaError('corrupt', 'Súbor nie je balík .lsa.');
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = readAt(this.fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new LsaError('corrupt', 'Súbor nie je balík .lsa.');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || count > MAX_ENTRIES + 2) throw new LsaError('corrupt', 'Balík má nepodporovanú štruktúru.');
    if (cdOffset + cdSize > size) throw new LsaError('corrupt', 'Balík je poškodený.');
    const cd = readAt(this.fd, cdOffset, cdSize);
    const entries = new Map();
    let pos = 0;
    for (let i = 0; i < count; i += 1) {
      if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw new LsaError('corrupt', 'Balík je poškodený.');
      const flags = cd.readUInt16LE(pos + 8);
      const method = cd.readUInt16LE(pos + 10);
      const crc = cd.readUInt32LE(pos + 16);
      const compressed = cd.readUInt32LE(pos + 20);
      const uncompressed = cd.readUInt32LE(pos + 24);
      const nameLength = cd.readUInt16LE(pos + 28);
      const extraLength = cd.readUInt16LE(pos + 30);
      const commentLength = cd.readUInt16LE(pos + 32);
      const localOffset = cd.readUInt32LE(pos + 42);
      const name = cd.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
      pos += 46 + nameLength + extraLength + commentLength;
      if (flags & 0x0001) throw new LsaError('corrupt', 'Šifrované balíky nie sú podporované.');
      if (![0, 8].includes(method)) throw new LsaError('corrupt', 'Balík používa nepodporovanú kompresiu.');
      if (name.endsWith('/')) continue;
      safeEntryPath(name);
      if (entries.has(name)) throw new LsaError('corrupt', `Duplicitný súbor v balíku: ${name}`);
      entries.set(name, { name, method, crc, compressed, uncompressed, localOffset });
    }
    return entries;
  }

  has(name) { return this.entries.has(name); }

  read(name, expectedSize) {
    const entry = this.entries.get(name);
    if (!entry) throw new LsaError('missing-file', `V balíku chýba súbor: ${name}`);
    const limit = name === MANIFEST_NAME || name === SIGNATURE_NAME ? MAX_MANIFEST_SIZE : MAX_FILE_SIZE;
    if (entry.uncompressed > limit || entry.compressed > limit) throw new LsaError('too-large', `Súbor v balíku je príliš veľký: ${name}`);
    if (expectedSize !== undefined && entry.uncompressed !== expectedSize) throw new LsaError('tampered', `Súbor má nesprávnu veľkosť: ${name}`);
    const local = readAt(this.fd, entry.localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new LsaError('corrupt', 'Balík je poškodený.');
    const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = readAt(this.fd, dataOffset, entry.compressed);
    let data;
    try {
      data = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressed) }) : raw;
    } catch { throw new LsaError('corrupt', `Súbor v balíku sa nedá rozbaliť: ${name}`); }
    if (data.length !== entry.uncompressed || crc32(data) !== entry.crc) throw new LsaError('corrupt', `Súbor v balíku je poškodený: ${name}`);
    return data;
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }
}

/**
 * Opens an .lsa package, checks its signature against trusted keys and validates the manifest.
 * The caller must close the returned reader.
 */
function openLsaPackage(filePath, trustedKeys) {
  const reader = new ZipReader(filePath);
  try {
    const manifestBytes = reader.read(MANIFEST_NAME);
    const signer = verifyManifestSignature(manifestBytes, reader.read(SIGNATURE_NAME), trustedKeys);
    const manifest = parseManifest(manifestBytes);
    for (const name of reader.entries.keys()) {
      if (name !== MANIFEST_NAME && name !== SIGNATURE_NAME && !manifest.files[name]) throw new LsaError('tampered', `Balík obsahuje nepodpísaný súbor: ${name}`);
    }
    for (const name of Object.keys(manifest.files)) {
      if (!reader.has(name)) throw new LsaError('missing-file', `V balíku chýba súbor: ${name}`);
    }
    return { reader, manifest, manifestBytes, signatureBytes: reader.read(SIGNATURE_NAME), signer };
  } catch (error) {
    reader.close();
    throw error;
  }
}

/** Extracts a verified package into `targetDir` (must not exist). Every file is hash-checked. */
function extractLsaPackage(opened, targetDir, { onProgress } = {}) {
  const { reader, manifest, manifestBytes, signatureBytes } = opened;
  fs.mkdirSync(targetDir, { recursive: false });
  const root = path.resolve(targetDir);
  const names = Object.keys(manifest.files);
  let done = 0;
  for (const name of names) {
    const entry = manifest.files[name];
    const data = reader.read(name, entry.size);
    if (sha256(data) !== entry.sha256) throw new LsaError('tampered', `Súbor nezodpovedá podpisu: ${name}`);
    const destination = path.resolve(root, ...name.split('/'));
    if (!destination.startsWith(root + path.sep)) throw new LsaError('unsafe-path', `Nebezpečná cesta v balíku: ${name}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { mode: entry.executable ? 0o755 : 0o644 });
    if (entry.executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
    done += 1;
    if (onProgress) onProgress(done / names.length);
  }
  fs.writeFileSync(path.join(root, MANIFEST_NAME), manifestBytes);
  fs.writeFileSync(path.join(root, SIGNATURE_NAME), signatureBytes);
}

/**
 * Re-checks an installed copy: manifest signature and the presence and size of every file.
 * Hashes are verified once at install time; launch only does this cheap check.
 */
function verifyInstalledApp(dir, trustedKeys) {
  const manifestBytes = fs.readFileSync(path.join(dir, MANIFEST_NAME));
  const signatureBytes = fs.readFileSync(path.join(dir, SIGNATURE_NAME));
  verifyManifestSignature(manifestBytes, signatureBytes, trustedKeys);
  const manifest = parseManifest(manifestBytes);
  for (const [name, entry] of Object.entries(manifest.files)) {
    let stat;
    try { stat = fs.statSync(path.join(dir, ...name.split('/'))); } catch { throw new LsaError('damaged', `Inštalácia je poškodená, chýba: ${name}`); }
    if (!stat.isFile() || stat.size !== entry.size) throw new LsaError('damaged', `Inštalácia je poškodená: ${name}`);
  }
  return manifest;
}

module.exports = {
  LSA_FORMAT_VERSION,
  MANIFEST_NAME,
  SIGNATURE_NAME,
  LsaError,
  ZipReader,
  ZipWriter,
  compareVersions,
  crc32,
  extractLsaPackage,
  openLsaPackage,
  parseManifest,
  publicKeyId,
  safeEntryPath,
  sha256,
  signManifest,
  validateManifest,
  verifyInstalledApp,
  verifyManifestSignature
};
