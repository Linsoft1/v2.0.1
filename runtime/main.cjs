'use strict';
// Linsoft Runtime: installs signed .lsr packages and starts Linsoft Browser from them.
//
//   Linsoft Runtime                 → start the installed Linsoft Browser
//   Linsoft Runtime file.lsr        → verify, confirm and install the package, then start it
//   Linsoft Runtime --rollback      → switch back to the previously installed version
//
// The browser runs inside this process: after the installed copy is verified, its main
// script is required directly, so it uses this runtime's Electron build.
const { app, BrowserWindow, dialog, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { compareVersions } = require('./lib/lsr-format.cjs');
const { createLsaStore } = require('./lib/lsr-store.cjs');

const BROWSER_ID = 'sk.linsoft.browser';
const DEFAULT_UPDATES = { github: 'Linsoft1/v2.0.1', asset: 'Linsoft-Browser-{version}.lsr' };
const RUNTIME_NAME = 'Linsoft Runtime';
const runtimeVersion = app.getVersion();
// Automated tests only: a development (unpackaged) runtime can skip confirmation dialogs.
const autoConfirm = !app.isPackaged && process.env.LINSOFT_RUNTIME_AUTO_CONFIRM === '1';

function showError(message) {
  if (autoConfirm) console.error(`${RUNTIME_NAME}: ${message}`);
  else dialog.showErrorBox(RUNTIME_NAME, message);
}

function runtimeHome() {
  if (process.env.LINSOFT_RUNTIME_HOME) return path.resolve(process.env.LINSOFT_RUNTIME_HOME);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Linsoft', 'Runtime');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'linsoft-runtime');
}

function loadTrustedKeys() {
  const keys = [];
  try { keys.push(...JSON.parse(fs.readFileSync(path.join(__dirname, 'trusted-keys.json'), 'utf8')).keys); } catch {}
  // Extra keys are accepted only in an unpackaged (development) runtime, for local test packages.
  if (!app.isPackaged && process.env.LINSOFT_RUNTIME_DEV_KEYS) {
    try { keys.push(...JSON.parse(fs.readFileSync(process.env.LINSOFT_RUNTIME_DEV_KEYS, 'utf8')).keys); } catch {}
  }
  return keys.filter((key) => typeof key?.publicKey === 'string');
}

const storeOptions = { root: runtimeHome(), trustedKeys: loadTrustedKeys(), runtimeVersion, electronVersion: process.versions.electron };
const store = createLsaStore(storeOptions);

function packageArgument(argv) {
  return argv.slice(1).find((value) => /\.lsr$/i.test(value) && fs.existsSync(value)) || '';
}

function relaunchWithout(value) {
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== value && arg !== '--rollback') });
  app.exit(0);
}

function progressWindow(title) {
  const window = new BrowserWindow({ width: 440, height: 150, resizable: false, minimizable: false, maximizable: false, title, autoHideMenuBar: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:14px system-ui,sans-serif;margin:24px;background:#16181d;color:#e8eaf0}progress{width:100%;height:14px;margin-top:14px}</style><body><div id="t">${title}…</div><progress max="100" value="0"></progress></body>`;
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.once('ready-to-show', () => window.show());
  return {
    set(percent, text) {
      if (window.isDestroyed()) return;
      const script = `document.querySelector('progress').value=${Number(percent) || 0};${text ? `document.getElementById('t').textContent=${JSON.stringify(text)};` : ''}`;
      window.webContents.executeJavaScript(script).catch(() => {});
    },
    close() { if (!window.isDestroyed()) window.destroy(); }
  };
}

function installInWorker(file, installOptions, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'lib', 'install-worker.cjs'), { workerData: { file, storeOptions, installOptions } });
    worker.on('message', (message) => {
      if (message.type === 'progress') onProgress?.(message.percent);
      else if (message.type === 'done') resolve(message);
      else if (message.type === 'error') reject(Object.assign(new Error(message.message), { code: message.code }));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Inštalácia skončila s kódom ${code}.`)); });
  });
}

async function installWithProgress(file, installOptions) {
  const progress = progressWindow('Inštalujem Linsoft aplikáciu');
  try {
    return await installInWorker(file, installOptions, (percent) => progress.set(percent));
  } finally {
    progress.close();
  }
}

async function confirmAndInstall(file) {
  let info;
  try { info = store.inspect(file); } catch (error) {
    showError(`Balík sa nedá nainštalovať.\n\n${error.message}`);
    return false;
  }
  const { manifest, signer, installedVersion, compatibilityError } = info;
  if (compatibilityError) { showError(compatibilityError.message); return false; }
  const downgrade = installedVersion && compareVersions(manifest.version, installedVersion) < 0;
  const detail = [
    `Aplikácia: ${manifest.name}`,
    `Verzia: ${manifest.version}${installedVersion ? ` (nainštalovaná: ${installedVersion})` : ''}`,
    `Podpísal: ${signer.publisher || signer.keyId} ✔`,
    '',
    downgrade ? 'POZOR: inštaluješ STARŠIU verziu.' : 'Ak je prehliadač práve otvorený, nová verzia sa použije po jeho reštarte.'
  ].join('\n');
  const { response } = autoConfirm ? { response: 0 } : await dialog.showMessageBox({ type: downgrade ? 'warning' : 'question', title: RUNTIME_NAME, message: `Nainštalovať ${manifest.name} ${manifest.version}?`, detail, buttons: ['Inštalovať', 'Zrušiť'], defaultId: 0, cancelId: 1, noLink: true });
  if (response !== 0) return false;
  try {
    await installWithProgress(file, { allowDowngrade: Boolean(downgrade) });
    return true;
  } catch (error) {
    showError(`Inštalácia zlyhala.\n\n${error.message}`);
    return false;
  }
}

// ------------------------------------------------------------------ updates

async function findLatestRelease(updates) {
  const response = await net.fetch(`https://api.github.com/repos/${updates.github}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Linsoft-Runtime' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub odpovedal ${response.status}.`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const assetName = updates.asset.replace('{version}', version);
  const asset = (release.assets || []).find((item) => item.name === assetName);
  return asset ? { version, url: asset.browser_download_url, size: asset.size } : { version, url: '' };
}

async function downloadToFile(url, onProgress) {
  const downloads = path.join(storeOptions.root, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const target = path.join(downloads, `${crypto.randomBytes(6).toString('hex')}.lsr`);
  const response = await net.fetch(url, { headers: { 'User-Agent': 'Linsoft-Runtime' } });
  if (!response.ok || !response.body) throw new Error(`Sťahovanie zlyhalo (${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const out = fs.openSync(target, 'w');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      fs.writeSync(out, chunk);
      received += chunk.length;
      if (total) onProgress?.(Math.round((received / total) * 100));
    }
  } catch (error) {
    fs.closeSync(out);
    fs.rmSync(target, { force: true });
    throw error;
  }
  fs.closeSync(out);
  return target;
}

function createHost(installed) {
  const updates = installed.manifest.updates || DEFAULT_UPDATES;
  let available = null;
  return Object.freeze({
    runtimeVersion,
    appVersion: installed.manifest.version,
    appDir: installed.dir,
    async checkForUpdate() {
      const latest = await findLatestRelease(updates);
      if (!latest || !latest.url || compareVersions(latest.version, installed.manifest.version) <= 0) {
        available = null;
        return { status: 'latest', version: installed.manifest.version };
      }
      available = latest;
      return { status: 'available', version: latest.version };
    },
    async downloadUpdate(onProgress) {
      if (!available) throw new Error('Nie je dostupná žiadna aktualizácia.');
      const file = await downloadToFile(available.url, (percent) => onProgress?.(Math.round(percent * 0.8)));
      try {
        const result = await installInWorker(file, { expectedId: installed.manifest.id, runningVersion: installed.manifest.version }, (percent) => onProgress?.(80 + Math.round(percent * 0.2)));
        return { version: result.manifest.version };
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    restartToUpdate() {
      app.relaunch();
      app.quit();
    }
  });
}

// ------------------------------------------------------------------ startup

async function installFromPicker() {
  const { response } = await dialog.showMessageBox({ type: 'info', title: RUNTIME_NAME, message: 'Linsoft Browser ešte nie je nainštalovaný.', detail: 'Stiahni najnovšiu verziu z internetu alebo vyber balík .lsr z počítača.', buttons: ['Stiahnuť najnovšiu', 'Vybrať súbor .lsr', 'Zavrieť'], defaultId: 0, cancelId: 2, noLink: true });
  if (response === 0) {
    const progress = progressWindow('Sťahujem Linsoft Browser');
    try {
      const latest = await findLatestRelease(DEFAULT_UPDATES);
      if (!latest?.url) throw new Error('Na GitHube zatiaľ nie je zverejnený balík .lsr.');
      const file = await downloadToFile(latest.url, (percent) => progress.set(Math.round(percent * 0.8)));
      try {
        progress.set(80, 'Inštalujem…');
        await installInWorker(file, { expectedId: BROWSER_ID }, (percent) => progress.set(80 + Math.round(percent * 0.2)));
      } finally { fs.rmSync(file, { force: true }); }
      return true;
    } catch (error) {
      progress.close();
      dialog.showErrorBox(RUNTIME_NAME, `Stiahnutie zlyhalo.\n\n${error.message}`);
      return false;
    } finally { progress.close(); }
  }
  if (response === 1) {
    const picked = await dialog.showOpenDialog({ title: 'Vyber balík Linsoft Browser', properties: ['openFile'], filters: [{ name: 'Linsoft Runtime balík', extensions: ['lsr'] }] });
    if (picked.canceled || !picked.filePaths[0]) return false;
    return confirmAndInstall(picked.filePaths[0]);
  }
  return false;
}

function launchInstalled(installed) {
  globalThis.linsoftLsaHost = createHost(installed);
  // The browser reports its own version (About dialog, user agent, update checks).
  app.getVersion = () => installed.manifest.version;
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => store.markHealthy(installed.manifest.id, installed.manifest.version));
  });
  if (installed.rolledBackFrom && autoConfirm) console.error(`${RUNTIME_NAME}: rollback ${installed.rolledBackFrom} -> ${installed.manifest.version}`);
  else if (installed.rolledBackFrom) {
    app.whenReady().then(() => dialog.showMessageBox({ type: 'warning', title: RUNTIME_NAME, message: `Verzia ${installed.rolledBackFrom} sa nepodarila spustiť.`, detail: `Linsoft Runtime spustil predchádzajúcu verziu ${installed.manifest.version}.` }));
  }
  require(path.join(installed.dir, installed.manifest.main));
}

function start() {
  const lsaFile = packageArgument(process.argv);
  // Outside of the browser itself, closing the progress window must not end the runtime early.
  const keepAlive = () => app.on('window-all-closed', () => {});
  if (lsaFile) {
    app.setName(RUNTIME_NAME);
    keepAlive();
    app.whenReady().then(async () => {
      if (await confirmAndInstall(lsaFile)) relaunchWithout(lsaFile);
      else app.exit(autoConfirm ? 2 : 0);
    });
    return;
  }
  if (process.argv.includes('--rollback')) {
    app.whenReady().then(async () => {
      try {
        const version = store.rollback(BROWSER_ID);
        await dialog.showMessageBox({ type: 'info', title: RUNTIME_NAME, message: `Obnovená verzia ${version}.` });
        relaunchWithout('--rollback');
      } catch (error) {
        dialog.showErrorBox(RUNTIME_NAME, error.message);
        app.exit(1);
      }
    });
    return;
  }
  let installed = null;
  try { installed = store.resolveLaunch(BROWSER_ID); } catch (error) { console.error('Linsoft Runtime:', error); }
  if (installed) { launchInstalled(installed); return; }
  app.setName(RUNTIME_NAME);
  keepAlive();
  app.whenReady().then(async () => {
    if (await installFromPicker()) relaunchWithout('');
    else app.exit(0);
  });
}

start();
