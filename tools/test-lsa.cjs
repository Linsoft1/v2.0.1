// End-to-end test of a built Linsoft Browser .lsa package.
//
//   node tools/test-lsa.cjs [path/to/Linsoft-Browser-<version>.lsa] [--skip-tor]
//
// 1. package integrity (signature, every file hash, required files)
// 2. damaged copies are refused (library and runtime level)
// 3. "double-click" install through the development runtime, then browser feature checks
// 4. the packaged Linsoft Runtime (dist-runtime) starts the installed browser
// 5. automatic rollback after a new version fails to start twice
// Everything runs in a temporary runtime home and browser profile; real user data is not touched.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const electronPath = require('electron');
const { ZipReader, ZipWriter, MANIFEST_NAME, SIGNATURE_NAME, extractLsaPackage, openLsaPackage, publicKeyId, sha256, signManifest } = require('../runtime/lib/lsa-format.cjs');
const { createLsaStore } = require('../runtime/lib/lsa-store.cjs');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lsaFile = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || path.join(root, 'dist-lsa', `Linsoft-Browser-${pkg.version}.lsa`));
const skipTor = process.argv.includes('--skip-tor');
const trustedKeys = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'trusted-keys.json'), 'utf8')).keys;
const runtimeVersion = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'package.json'), 'utf8')).version;
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const BROWSER_ID = 'sk.linsoft.browser';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-lsa-e2e-'));
const runtimeHome = path.join(work, 'runtime-home');
const profile = path.join(work, 'profile');
const children = new Set();

let failures = 0;
let warnings = 0;
let expectedVersion = '';

function log(symbol, text) { console.log(`${symbol} ${text}`); }
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    log('✔', `${name}${detail ? ` – ${detail}` : ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failures += 1;
    log('✘', `${name}\n    ${error instanceof Error ? error.message : error}`);
  }
}
function warn(text) { warnings += 1; log('⚠', text); }
function assert(condition, message) { if (!condition) throw new Error(message); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storeFor = (keys = trustedKeys) => createLsaStore({ root: runtimeHome, trustedKeys: keys, runtimeVersion, electronVersion });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function launch(executable, args, extraEnv = {}) {
  const env = { ...process.env, LINSOFT_RUNTIME_HOME: runtimeHome, LINSOFT_BROWSER_USER_DATA: profile, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  children.add(child);
  const exited = new Promise((resolve) => child.once('exit', (code) => { children.delete(child); resolve(code); }));
  return { child, exited, output: () => output };
}

async function devRuntime(args, extraEnv) {
  return launch(electronPath, [path.join(root, 'runtime'), ...args], { LINSOFT_RUNTIME_AUTO_CONFIRM: '1', ...extraEnv });
}

async function waitForBrowserPage(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === 'page' && /\/index\.html/.test(target.url) && !/centrum/i.test(target.url));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Okno prehliadača sa neotvorilo do ${timeoutMs / 1000} s.`);
}

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('DevTools spojenie zlyhalo.')); });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
  };
  return {
    async evaluate(expression) {
      const response = await new Promise((resolve) => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'Chyba v stránke');
      return response.result?.result?.value;
    },
    close() { socket.close(); }
  };
}

async function closeBrowser(port) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve) => { socket.onopen = resolve; socket.onerror = resolve; });
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch { return; }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch { return; }
      await sleep(300);
    }
  }
  throw new Error('Prehliadač sa nezatvoril ani na tretí pokus.');
}

function copyWithFlippedByte(source, target, entryName) {
  fs.copyFileSync(source, target);
  const reader = new ZipReader(source);
  const entry = reader.entries.get(entryName);
  reader.close();
  const fd = fs.openSync(target, 'r+');
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, entry.localOffset);
  const dataOffset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const position = dataOffset + Math.floor(entry.compressed / 2);
  const byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, position);
  byte[0] ^= 0xff;
  fs.writeSync(fd, byte, 0, 1, position);
  fs.closeSync(fd);
}

function writeBrokenUpdate(file, key, version) {
  const files = { 'main.cjs': 'process.exit(3);\n' };
  const manifest = { lsa: 1, id: BROWSER_ID, name: 'Linsoft Browser', version, main: 'main.cjs', minRuntimeVersion: '1.0.0', electron: electronVersion, files: {} };
  for (const [name, text] of Object.entries(files)) manifest.files[name] = { size: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const zip = new ZipWriter(file);
  zip.add(MANIFEST_NAME, manifestBytes);
  zip.add(SIGNATURE_NAME, Buffer.from(JSON.stringify(signManifest(manifestBytes, key))));
  for (const [name, text] of Object.entries(files)) zip.add(name, Buffer.from(text));
  zip.close();
}

async function browserChecks(port, label) {
  const page = await waitForBrowserPage(port);
  const cdp = await connect(page);
  try {
    await check(`${label}: spustená verzia ${expectedVersion} z nainštalovanej .lsa`, async () => {
      const version = await cdp.evaluate('window.linsoftBrowser.getVersion()');
      assert(version === expectedVersion, `verzia je ${version}`);
      const href = await cdp.evaluate('location.href');
      assert(decodeURIComponent(href).includes(`/apps/${BROWSER_ID}/versions/${expectedVersion}/index.html`), `stránka nie je z inštalácie: ${href}`);
      // Window closing is confirmed by app.js, so wait until the browser UI has fully loaded.
      for (let i = 0; i < 40 && await cdp.evaluate('document.readyState') !== 'complete'; i += 1) await sleep(250);
      await sleep(1000);
      return decodeURIComponent(href).split('/apps/')[1].split('?')[0];
    });
    return cdp;
  } catch (error) { cdp.close(); throw error; }
}

async function main() {
  console.log(`Linsoft .lsa test · ${path.relative(root, lsaFile)}\nPracovný priečinok: ${work}\n`);
  assert(fs.existsSync(lsaFile), `Balík neexistuje: ${lsaFile} (spusti npm run build:lsa)`);

  console.log('— 1. Integrita balíka');
  let manifest;
  await check('podpis dôveryhodným kľúčom Linsoft', () => {
    const opened = openLsaPackage(lsaFile, trustedKeys);
    opened.reader.close();
    manifest = opened.manifest;
    expectedVersion = manifest.version;
    return `${manifest.name} ${manifest.version}, kľúč ${opened.signer.keyId}`;
  });
  if (!manifest) throw new Error('Balík sa nedá otvoriť, ďalšie testy nemajú zmysel.');
  await check('verzia balíka = verzia v package.json', () => assert(manifest.version === pkg.version, `${manifest.version} ≠ ${pkg.version}`));
  await check(`Electron v balíku = runtime (${electronVersion})`, () => assert(manifest.electron.split('.')[0] === electronVersion.split('.')[0], `balík: ${manifest.electron}`));
  await check('obsahuje všetky potrebné časti prehliadača', () => {
    const required = ['main.cjs', 'preload.cjs', 'index.html', 'app.js', 'styles.css', 'package.json', 'lib/browser-policies.cjs', 'lib/native-tab-manager.cjs', 'Linsoft centrum app/index.html', 'assets/linsoft-icon.ico', 'node_modules/qrcode/package.json', 'node_modules/electron-updater/package.json', 'node_modules/@zxing/browser/umd/zxing-browser.min.js'];
    if (manifest.platforms.includes('win32-x64')) required.push('assets/tor/windows/tor/tor.exe');
    if (manifest.platforms.includes('linux-x64')) required.push('assets/tor/linux/tor/tor');
    const missing = required.filter((name) => !manifest.files[name]);
    assert(!missing.length, `chýba: ${missing.join(', ')}`);
    const devOnly = Object.keys(manifest.files).filter((name) => /^node_modules\/(?:electron|electron-builder|eslint|sharp)\//.test(name));
    assert(!devOnly.length, `obsahuje vývojárske balíky: ${devOnly.slice(0, 3).join(', ')}`);
    return `${Object.keys(manifest.files).length} súborov`;
  });
  await check('linuxový Tor je označený ako spustiteľný', () => {
    if (!manifest.platforms.includes('linux-x64')) return 'balík nie je pre Linux';
    assert(manifest.files['assets/tor/linux/tor/tor']?.executable === true, 'assets/tor/linux/tor/tor nemá executable');
  });
  await check('každý súbor sa rozbalí a sedí jeho SHA-256', () => {
    const opened = openLsaPackage(lsaFile, trustedKeys);
    try { extractLsaPackage(opened, path.join(work, 'extract-check')); } finally { opened.reader.close(); }
    fs.rmSync(path.join(work, 'extract-check'), { recursive: true, force: true });
  });

  console.log('\n— 2. Poškodené a podvrhnuté balíky');
  const flipped = path.join(work, 'flipped.lsa');
  copyWithFlippedByte(lsaFile, flipped, 'app.js');
  await check('zmenený bajt v app.js sa odhalí', () => {
    const opened = openLsaPackage(flipped, trustedKeys);
    try { extractLsaPackage(opened, path.join(work, 'flipped-out')); } catch (error) { return `odmietnuté (${error.code})`; } finally { opened.reader.close(); }
    throw new Error('poškodený balík prešiel');
  });
  await check('orezaný (nedostiahnutý) balík sa odmietne', () => {
    const truncated = path.join(work, 'truncated.lsa');
    const data = fs.readFileSync(lsaFile);
    fs.writeFileSync(truncated, data.subarray(0, Math.floor(data.length * 0.7)));
    try { openLsaPackage(truncated, trustedKeys).reader.close(); } catch (error) { return `odmietnuté (${error.code})`; }
    throw new Error('orezaný balík prešiel');
  });
  await check('balík podpísaný cudzím kľúčom sa odmietne', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const foreign = path.join(work, 'foreign.lsa');
    writeBrokenUpdate(foreign, privateKey.export({ type: 'pkcs8', format: 'pem' }), '9.9.9');
    try { openLsaPackage(foreign, trustedKeys).reader.close(); } catch (error) { assert(error.code === 'untrusted', error.message); return 'odmietnuté (untrusted)'; }
    throw new Error('cudzí podpis prešiel');
  });
  await check('runtime poškodený balík nenainštaluje', async () => {
    const run = await devRuntime([flipped]);
    const code = await run.exited;
    assert(code !== 0, 'runtime skončil úspešne');
    assert(!fs.existsSync(path.join(runtimeHome, 'apps', BROWSER_ID, 'state.json')), 'niečo sa nainštalovalo');
    return `ukončené s kódom ${code}`;
  });

  console.log('\n— 3. Inštalácia dvojklikom a funkcie prehliadača');
  const port = await freePort();
  await check('runtime nainštaluje .lsa a reštartuje sa do prehliadača', async () => {
    const run = await devRuntime([lsaFile, `--remote-debugging-port=${port}`]);
    const code = await Promise.race([run.exited, sleep(180000).then(() => 'timeout')]);
    assert(code === 0, `inštalácia skončila: ${code}\n${run.output().trim()}`);
    const state = JSON.parse(fs.readFileSync(path.join(runtimeHome, 'apps', BROWSER_ID, 'state.json'), 'utf8'));
    assert(state.current === expectedVersion, `state.current = ${state.current}`);
  });
  let cdp;
  await check('okno prehliadača sa otvorí', async () => { cdp = await browserChecks(port, 'vývojový runtime'); });
  if (cdp) {
    await check('runtime označil spustenie za úspešné', async () => {
      for (let i = 0; i < 20; i += 1) {
        const state = JSON.parse(fs.readFileSync(path.join(runtimeHome, 'apps', BROWSER_ID, 'state.json'), 'utf8'));
        if (!state.pending) return;
        await sleep(500);
      }
      throw new Error('stav "pending" ostal nastavený');
    });
    await check('User-Agent obsahuje verziu', async () => {
      const ua = await cdp.evaluate('navigator.userAgent');
      assert(ua.includes(`LinsoftBrowser/${expectedVersion}`), ua);
    });
    await check('rozhranie prehliadača je načítané', async () => {
      const ready = await cdp.evaluate(`(() => ({ api: Object.keys(window.linsoftBrowser || {}).length, title: document.title, tabs: document.querySelectorAll('[data-tab-id], .tab').length }))()`);
      assert(ready.api > 50, `linsoftBrowser API má iba ${ready.api} funkcií`);
      assert(ready.title === 'Linsoft Browser', `titulok: ${ready.title}`);
      return `${ready.api} API funkcií`;
    });
    await check('knižnica QR skenera (ZXing) z node_modules', async () => assert(await cdp.evaluate('typeof ZXingBrowser') === 'object', 'ZXingBrowser chýba'));
    await check('sťahovanie, povolenia a adblock odpovedajú', async () => {
      const result = await cdp.evaluate(`Promise.all([window.linsoftBrowser.listDownloads(), window.linsoftBrowser.listSitePermissions(), window.linsoftBrowser.getAdblockStats()]).then(([d, p, a]) => ({ downloads: Array.isArray(d), permissions: Array.isArray(p) || typeof p === 'object', adblock: typeof a === 'object' }))`);
      assert(result.downloads && result.permissions && result.adblock, JSON.stringify(result));
    });
    await check('kontrola aktualizácií ide cez runtime (.lsa na GitHube)', async () => {
      const result = await cdp.evaluate('window.linsoftBrowser.checkForUpdates()');
      if (result.status === 'error') { warn(`GitHub nedostupný: ${result.message}`); return 'preskočené'; }
      assert(['latest', 'available'].includes(result.status), JSON.stringify(result));
      return `stav: ${result.status}${result.version ? ` ${result.version}` : ''}`;
    });
    if (skipTor) warn('Tor test preskočený (--skip-tor)');
    else {
      await check('Tor z balíka sa spustí a pripojí', async () => {
        const result = await cdp.evaluate('window.linsoftBrowser.enableTorProxy()');
        const status = result?.proxyStatus || (await cdp.evaluate('window.linsoftBrowser.getTorStatus()')).proxyStatus;
        let detail = '';
        if (status === 'running') {
          try {
            const ip = await cdp.evaluate(`fetch('https://check.torproject.org/api/ip').then((r) => r.json())`);
            detail = ip?.IsTor ? 'premávka ide cez Tor ✔' : `check.torproject.org: ${JSON.stringify(ip)}`;
          } catch { detail = 'overenie cez check.torproject.org nebolo možné'; }
        }
        await cdp.evaluate('window.linsoftBrowser.disableTorProxy()');
        assert(status === 'running', `Tor: ${status} – ${result?.proxyMessage || ''}`);
        return detail;
      });
    }
    cdp.close();
    await check('prehliadač sa korektne zatvorí', () => closeBrowser(port));
  }

  console.log('\n— 4. Zabalený Linsoft Runtime');
  const packaged = process.platform === 'win32' ? path.join(root, 'dist-runtime', 'win-unpacked', 'Linsoft Runtime.exe') : path.join(root, 'dist-runtime', 'linux-unpacked', 'linsoft-runtime');
  if (!fs.existsSync(packaged)) warn(`zabalený runtime neexistuje (${path.relative(root, packaged)}), spusti npm run build:runtime`);
  else {
    const packagedPort = await freePort();
    await check('zabalený runtime spustí nainštalovaný prehliadač', async () => {
      const run = launch(packaged, [`--remote-debugging-port=${packagedPort}`]);
      try {
        const packagedCdp = await browserChecks(packagedPort, 'zabalený runtime');
        packagedCdp.close();
        await closeBrowser(packagedPort);
        await Promise.race([run.exited, sleep(10000)]);
      } catch (error) {
        run.child.kill();
        await run.exited;
        throw new Error(`${error.message}\n    výstup procesu: ${run.output().trim().slice(-800) || '(prázdny)'}`);
      }
    });
  }

  console.log('\n— 5. Automatický návrat na predchádzajúcu verziu');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const testKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const devKeysFile = path.join(work, 'dev-keys.json');
  fs.writeFileSync(devKeysFile, JSON.stringify({ keys: [{ keyId: publicKeyId(testKeyPem), name: 'E2E test', publicKey: testKeyPem }] }));
  const brokenVersion = '99.0.0';
  await check(`nainštaluje sa pokazená verzia ${brokenVersion}`, () => {
    const broken = path.join(work, 'broken.lsa');
    writeBrokenUpdate(broken, privateKey.export({ type: 'pkcs8', format: 'pem' }), brokenVersion);
    const store = storeFor([...trustedKeys, ...JSON.parse(fs.readFileSync(devKeysFile, 'utf8')).keys]);
    store.install(broken);
    assert(store.readState(BROWSER_ID).current === brokenVersion, 'nová verzia nie je aktuálna');
  });
  await check('dve neúspešné spustenia', async () => {
    const codes = [];
    for (let i = 0; i < 2; i += 1) codes.push(await (await devRuntime([], { LINSOFT_RUNTIME_DEV_KEYS: devKeysFile })).exited);
    assert(codes.every((code) => code === 3), `kódy: ${codes.join(', ')}`);
    return `kódy ${codes.join(', ')}`;
  });
  const rollbackPort = await freePort();
  await check(`tretie spustenie sa vráti na ${expectedVersion}`, async () => {
    const run = await devRuntime([`--remote-debugging-port=${rollbackPort}`], { LINSOFT_RUNTIME_DEV_KEYS: devKeysFile });
    const rollbackCdp = await browserChecks(rollbackPort, 'po návrate');
    rollbackCdp.close();
    assert(/rollback 99\.0\.0 ->/.test(run.output()), 'runtime nehlásil návrat');
    const state = storeFor().readState(BROWSER_ID);
    assert(state.current === expectedVersion, `state.current = ${state.current}`);
    await closeBrowser(rollbackPort);
  });
}

main()
  .catch((error) => { failures += 1; log('✘', error.message); })
  .finally(async () => {
    for (const child of children) { try { child.kill(); } catch {} }
    await sleep(1000);
    for (let attempt = 0; attempt < 10 && fs.existsSync(work); attempt += 1) {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { await sleep(500); }
    }
    console.log(`\n${failures ? `✘ ZLYHALO: ${failures}` : '✔ Všetko prešlo'}${warnings ? ` · upozornení: ${warnings}` : ''}`);
    process.exit(failures ? 1 : 0);
  });
