// Builds and signs dist-lsr/Linsoft-Browser-<version>.lsr from this project.
//
//   node tools/lsr-build.cjs [--platform all|win32|linux] [--out dist-lsr] [--key <private key>]
//
// The package contains the same files as the electron-builder build (package.json "build.files")
// plus the production node_modules, a manifest with the SHA-256 of every file, and an Ed25519
// signature over that manifest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { LSA_FORMAT_VERSION, MANIFEST_NAME, SIGNATURE_NAME, ZipWriter, sha256, signManifest, validateManifest } = require('../runtime/lib/lsr-format.cjs');

const root = path.resolve(__dirname, '..');
const MIN_RUNTIME_VERSION = '1.0.0';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function toPackagePath(absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function walk(directory, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full, output);
    else if (entry.isFile()) output.add(full);
  }
}

function collectProjectFiles(patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    const directoryPattern = pattern.match(/^(.*)\/\*\*\/\*$/);
    const target = path.join(root, directoryPattern ? directoryPattern[1] : pattern);
    if (!fs.existsSync(target)) throw new Error(`Chýba súbor z build.files: ${pattern}`);
    if (directoryPattern) walk(target, files);
    else files.add(target);
  }
  return files;
}

function collectProductionModules(files) {
  const output = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' });
  const modulesRoot = path.join(root, 'node_modules') + path.sep;
  for (const line of output.split(/\r?\n/)) {
    const directory = line.trim();
    if (!directory.startsWith(modulesRoot) || !fs.existsSync(directory)) continue;
    walk(directory, files);
  }
}

function isExecutable(packagePath, absolute) {
  if (/^assets\/tor\/linux\/(?:tor|debug)\//.test(packagePath)) {
    const base = packagePath.split('/').pop();
    if (!base.includes('.') || /\.so(?:\.\d+)*$/.test(base)) return true;
  }
  if (process.platform !== 'win32') return (fs.statSync(absolute).mode & 0o111) !== 0;
  return false;
}

function main() {
  const platform = argument('--platform', 'all');
  if (!['all', 'win32', 'linux'].includes(platform)) throw new Error('--platform musí byť all, win32 alebo linux');
  const keyPath = path.resolve(argument('--key', process.env.LINSOFT_LSA_KEY || path.join(os.homedir(), '.linsoft', 'lsa-signing-key.pem')));
  if (!fs.existsSync(keyPath)) throw new Error(`Chýba podpisový kľúč ${keyPath}. Vytvor ho príkazom: npm run lsr:keygen`);
  const outDir = path.resolve(root, argument('--out', 'dist-lsr'));

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const publish = pkg.build?.publish || {};
  const suffix = platform === 'all' ? '' : `-${platform}`;
  const assetPattern = `Linsoft-Browser-{version}${suffix}.lsr`;

  const absoluteFiles = collectProjectFiles(pkg.build.files);
  collectProductionModules(absoluteFiles);
  const excluded = platform === 'win32' ? 'assets/tor/linux/' : platform === 'linux' ? 'assets/tor/windows/' : null;
  const entries = [...absoluteFiles]
    .map((absolute) => ({ absolute, name: toPackagePath(absolute) }))
    .filter(({ name }) => !excluded || !name.startsWith(excluded))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const files = {};
  for (const entry of entries) {
    const data = fs.readFileSync(entry.absolute);
    files[entry.name] = { size: data.length, sha256: sha256(data), ...(isExecutable(entry.name, entry.absolute) ? { executable: true } : {}) };
  }
  const manifest = {
    lsa: LSA_FORMAT_VERSION,
    id: pkg.build.appId,
    name: pkg.productName,
    version: pkg.version,
    publisher: 'Linsoft',
    main: pkg.main,
    minRuntimeVersion: MIN_RUNTIME_VERSION,
    electron: electronVersion,
    platforms: platform === 'all' ? ['win32-x64', 'linux-x64'] : [`${platform}-x64`],
    ...(publish.owner && publish.repo ? { updates: { github: `${publish.owner}/${publish.repo}`, asset: assetPattern } } : {}),
    files
  };
  validateManifest(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = signManifest(manifestBytes, fs.readFileSync(keyPath, 'utf8'));
  const trusted = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'trusted-keys.json'), 'utf8')).keys || [];
  if (!trusted.some((key) => key.keyId === signature.keyId)) {
    throw new Error(`Kľúč ${signature.keyId} nie je v runtime/trusted-keys.json – Linsoft Runtime by balík odmietol. Spusti: npm run lsr:keygen`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, assetPattern.replace('{version}', pkg.version));
  const temp = `${outFile}.tmp`;
  const zip = new ZipWriter(temp);
  try {
    zip.add(MANIFEST_NAME, manifestBytes);
    zip.add(SIGNATURE_NAME, Buffer.from(`${JSON.stringify(signature, null, 2)}\n`));
    for (const entry of entries) zip.add(entry.name, fs.readFileSync(entry.absolute), { mode: files[entry.name].executable ? 0o755 : 0o644 });
    zip.close();
  } catch (error) {
    try { zip.close(); } catch {}
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.renameSync(temp, outFile);
  const totalSize = Object.values(files).reduce((sum, file) => sum + file.size, 0);
  console.log(`Vytvorený ${path.relative(root, outFile)}`);
  console.log(`  ${pkg.productName} ${pkg.version} · ${entries.length} súborov · ${(totalSize / 1048576).toFixed(1)} MB → ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB`);
  console.log(`  podpísané kľúčom ${signature.keyId} · Electron ${electronVersion} · platformy: ${manifest.platforms.join(', ')}`);
}

try { main(); } catch (error) {
  console.error(`lsr-build: ${error.message}`);
  process.exit(1);
}
