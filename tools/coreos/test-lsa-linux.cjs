// Portable end-to-end test of Linsoft Runtime + .lsa on a Linux machine without Node.js or the repository.
// Run through the installed runtime's own Electron in Node mode (see spusti-test.sh):
//
//   ELECTRON_RUN_AS_NODE=1 "/opt/Linsoft Runtime/linsoft-runtime" test-lsa-linux.cjs Linsoft-Browser-<version>.lsa [--skip-tor]
//
// It uses the libraries and trusted keys of the INSTALLED runtime, a temporary runtime folder and a
// temporary browser profile, so the user's real Linsoft data is not touched.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runtimeDir = process.env.LINSOFT_RUNTIME_DIR || '/opt/Linsoft Runtime';
const runtimeExe = process.env.LINSOFT_RUNTIME_EXE || path.join(runtimeDir, 'linsoft-runtime');
const appDir = path.join(runtimeDir, 'resources', 'app');
const { ZipReader, extractLsaPackage, openLsaPackage } = require(path.join(appDir, 'lib', 'lsa-format.cjs'));
const trustedKeys = JSON.parse(fs.readFileSync(path.join(appDir, 'trusted-keys.json'), 'utf8')).keys;
const lsaFile = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '');
const skipTor = process.argv.includes('--skip-tor');
const BROWSER_ID = 'sk.linsoft.browser';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-lsa-test-'));
const runtimeHome = path.join(work, 'runtime-home');
const profile = path.join(work, 'profile');
const statePath = path.join(runtimeHome, 'apps', BROWSER_ID, 'state.json');
const children = new Set();
let failures = 0;
let warnings = 0;
let expectedVersion = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function warn(text) { warnings += 1; console.log(`⚠ ${text}`); }
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`✔ ${name}${detail ? ` – ${detail}` : ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failures += 1;
    console.log(`✘ ${name}\n    ${error instanceof Error ? error.message : error}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function launchRuntime(args) {
  const env = { ...process.env, LINSOFT_RUNTIME_HOME: runtimeHome, LINSOFT_BROWSER_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtimeExe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  children.add(child);
  const exited = new Promise((resolve) => child.once('exit', (code) => { children.delete(child); resolve(code); }));
  return { child, exited, output: () => output };
}

async function waitForBrowserPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === 'page' && /\/index\.html/.test(target.url) && !/centrum/i.test(target.url));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Okno prehliadača sa neotvorilo do ${Math.round(timeoutMs / 1000)} s.`);
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

async function openBrowser(port, timeoutMs = 90000) {
  const page = await waitForBrowserPage(port, timeoutMs);
  const cdp = await connect(page);
  const href = decodeURIComponent(await cdp.evaluate('location.href'));
  assert(href.includes(`/apps/${BROWSER_ID}/versions/${expectedVersion}/index.html`), `stránka nie je z inštalácie: ${href}`);
  for (let i = 0; i < 40 && await cdp.evaluate('document.readyState') !== 'complete'; i += 1) await sleep(250);
  await sleep(1000);
  return cdp;
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

async function main() {
  console.log(`Linsoft .lsa test (Linux) · ${lsaFile}\nRuntime: ${runtimeDir}\n`);
  assert(fs.existsSync(lsaFile), `Balík neexistuje: ${lsaFile}`);
  assert(process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY, 'Nie je dostupná grafická obrazovka (DISPLAY/WAYLAND_DISPLAY) – spusti test v termináli na ploche.');

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
  const platform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  await check(`balík obsahuje verziu pre ${platform}`, () => assert(manifest.platforms.includes(platform), `platformy: ${manifest.platforms.join(', ')}`));
  await check('každý súbor sa rozbalí, sedí SHA-256 a Tor je spustiteľný', () => {
    const target = path.join(work, 'extract-check');
    const opened = openLsaPackage(lsaFile, trustedKeys);
    try { extractLsaPackage(opened, target); } finally { opened.reader.close(); }
    const tor = process.platform === 'win32' ? path.join(target, 'assets', 'tor', 'windows', 'tor', 'tor.exe') : path.join(target, 'assets', 'tor', 'linux', 'tor', 'tor');
    const mode = fs.statSync(tor).mode & 0o777;
    fs.rmSync(target, { recursive: true, force: true });
    assert(process.platform === 'win32' || (mode & 0o111) !== 0, `tor nemá právo na spustenie (${mode.toString(8)})`);
    return `${Object.keys(manifest.files).length} súborov, tor ${mode.toString(8)}`;
  });

  console.log('\n— 2. Poškodené balíky');
  await check('zmenený bajt v app.js sa odhalí', () => {
    const flipped = path.join(work, 'flipped.lsa');
    fs.copyFileSync(lsaFile, flipped);
    const reader = new ZipReader(lsaFile);
    const entry = reader.entries.get('app.js');
    reader.close();
    const fd = fs.openSync(flipped, 'r+');
    const header = Buffer.alloc(30);
    fs.readSync(fd, header, 0, 30, entry.localOffset);
    const position = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28) + Math.floor(entry.compressed / 2);
    const byte = Buffer.alloc(1);
    fs.readSync(fd, byte, 0, 1, position);
    byte[0] ^= 0xff;
    fs.writeSync(fd, byte, 0, 1, position);
    fs.closeSync(fd);
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

  console.log('\n— 3. Inštalácia ako po dvojkliku');
  const port = await freePort();
  await check('runtime ukáže dialóg, nainštaluje a spustí prehliadač', async () => {
    console.log('    >>> Na obrazovke sa objaví okno „Nainštalovať Linsoft Browser …?“ – klikni Inštalovať. (čakám max. 5 min)');
    const run = launchRuntime([lsaFile, `--remote-debugging-port=${port}`]);
    const code = await Promise.race([run.exited, sleep(300000).then(() => 'timeout')]);
    assert(code === 0, `runtime skončil s kódom ${code}. ${run.output().trim().slice(-500)}`);
    assert(fs.existsSync(statePath), 'inštalácia bola zrušená (v dialógu nebolo zvolené Inštalovať)');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(state.current === expectedVersion, `state.current = ${state.current}`);
  });
  let cdp;
  await check(`prehliadač ${expectedVersion} beží z nainštalovanej .lsa`, async () => { cdp = await openBrowser(port); });
  if (cdp) {
    await check('runtime označil spustenie za úspešné', async () => {
      for (let i = 0; i < 20; i += 1) { if (!JSON.parse(fs.readFileSync(statePath, 'utf8')).pending) return; await sleep(500); }
      throw new Error('stav "pending" ostal nastavený');
    });
    await check('verzia a User-Agent', async () => {
      const version = await cdp.evaluate('window.linsoftBrowser.getVersion()');
      const ua = await cdp.evaluate('navigator.userAgent');
      assert(version === expectedVersion && ua.includes(`LinsoftBrowser/${expectedVersion}`), `${version} / ${ua}`);
      return version;
    });
    await check('rozhranie prehliadača je načítané', async () => {
      const ready = await cdp.evaluate(`({ api: Object.keys(window.linsoftBrowser || {}).length, title: document.title })`);
      assert(ready.api > 50 && ready.title === 'Linsoft Browser', JSON.stringify(ready));
      return `${ready.api} API funkcií`;
    });
    await check('knižnica QR skenera (ZXing)', async () => assert(await cdp.evaluate('typeof ZXingBrowser') === 'object', 'ZXingBrowser chýba'));
    await check('sťahovanie, povolenia a adblock odpovedajú', async () => {
      const result = await cdp.evaluate(`Promise.all([window.linsoftBrowser.listDownloads(), window.linsoftBrowser.listSitePermissions(), window.linsoftBrowser.getAdblockStats()]).then(([d, p, a]) => Array.isArray(d) && p !== undefined && typeof a === 'object')`);
      assert(result === true, 'niektoré API neodpovedá');
    });
    await check('kontrola aktualizácií cez GitHub', async () => {
      const result = await cdp.evaluate('window.linsoftBrowser.checkForUpdates()');
      if (result.status === 'error') { warn(`GitHub nedostupný: ${result.message}`); return 'preskočené'; }
      assert(['latest', 'available'].includes(result.status), JSON.stringify(result));
      return `stav: ${result.status} ${result.version || ''}`;
    });
    if (skipTor) warn('Tor test preskočený (--skip-tor)');
    else {
      await check(`Tor z balíka (${process.platform}) sa spustí a pripojí`, async () => {
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

  console.log('\n— 4. Opätovné spustenie (ako z menu aplikácií)');
  const secondPort = await freePort();
  await check('runtime spustí už nainštalovaný prehliadač', async () => {
    const run = launchRuntime([`--remote-debugging-port=${secondPort}`]);
    try {
      const second = await openBrowser(secondPort, 60000);
      second.close();
      await closeBrowser(secondPort);
      await Promise.race([run.exited, sleep(10000)]);
    } catch (error) {
      run.child.kill();
      throw new Error(`${error.message}\n    výstup: ${run.output().trim().slice(-500) || '(prázdny)'}`);
    }
  });
}

main()
  .catch((error) => { failures += 1; console.log(`✘ ${error.message}`); })
  .finally(async () => {
    for (const child of children) { try { child.kill(); } catch {} }
    await sleep(1000);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    console.log(`\n${failures ? `✘ ZLYHALO: ${failures}` : '✔ Všetko prešlo'}${warnings ? ` · upozornení: ${warnings}` : ''}`);
    process.exit(failures ? 1 : 0);
  });
