const { app, BrowserWindow, shell, session, ipcMain, dialog, screen, safeStorage, clipboard, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { canAutoCheckForUpdates, formatUpdateFailure, getPermissionDecision, getUpdateStatus, isSafeWebUrl, normalizePermissionOrigin } = require('./lib/browser-policies.cjs');
const { createPermissionCheckHandler, createPermissionRequestHandler } = require('./lib/permission-handlers.cjs');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }
let updateState = { status: 'idle' };
const isLinux = process.platform === 'linux';
const writableDataPath = process.env.LINSOFT_BROWSER_USER_DATA || path.join(app.getPath('appData'), 'Linsoft Browser');
app.setPath('userData', writableDataPath);
app.setPath('cache', path.join(writableDataPath, 'Cache'));
const windowStatePath = path.join(writableDataPath, 'window-state.json');
const passwordVaultPath = path.join(writableDataPath, 'password-vault.json');
const downloadHistoryPath = path.join(writableDataPath, 'download-history.json');
const sitePermissionsPath = path.join(writableDataPath, 'site-permissions.json');
/** @type {Set<import('electron').BrowserWindow>} */
const browserWindows = new Set();

function publishUpdateState(state) {
  updateState = state;
  for (const window of browserWindows) {
    if (!window.isDestroyed()) window.webContents.send('update-state', state);
  }
}

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged || process.platform !== 'win32') return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => publishUpdateState({ status: 'available', version: info.version, checkedAt: Date.now() }));
  autoUpdater.on('update-not-available', (info) => publishUpdateState({ status: 'latest', version: info.version, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({ status: 'downloading', version: updateState.version, percent: Math.round(progress.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (error) => { console.warn('Linsoft Browser update check failed:', error.message); publishUpdateState({ ...formatUpdateFailure(error), checkedAt: Date.now() }); });

  const checkForUpdates = () => {
    if (!canAutoCheckForUpdates({ isPackaged: app.isPackaged, platform: process.platform, enabled: browserPreferences.autoUpdateCheck, status: updateState.status })) return;
    autoUpdater.checkForUpdates().catch((error) => publishUpdateState({ ...formatUpdateFailure(error), checkedAt: Date.now() }));
  };
  setTimeout(checkForUpdates, 8000);
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {import('child_process').ChildProcess | null} */
let openVpnProcess = null;
let openVpnProfile = '';
const activeDownloads = new Map();
let downloadHistory = [];
let passwordVault = [];
let sitePermissions = {};

function loadSitePermissions() {
  try {
    const stored = JSON.parse(require('node:fs').readFileSync(sitePermissionsPath, 'utf8'));
    sitePermissions = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [key, decision] of Object.entries(stored)) {
        const separator = key.lastIndexOf('|');
        const origin = key.slice(0, separator);
        const permission = key.slice(separator + 1);
        if (separator > 0 && normalizePermissionOrigin(origin) === origin && ['allow', 'deny'].includes(decision) && ['notifications', 'audio', 'video', 'audio,video'].includes(permission)) sitePermissions[key] = decision;
      }
    }
  } catch {
    sitePermissions = {};
  }
}

function saveSitePermissions() {
  require('node:fs').mkdirSync(path.dirname(sitePermissionsPath), { recursive: true });
  require('node:fs').writeFileSync(sitePermissionsPath, JSON.stringify(sitePermissions), 'utf8');
}

function permissionLabel(permission, mediaTypes = []) {
  if (permission === 'notifications') return 'webovým upozorneniam';
  const labels = mediaTypes.map((type) => type === 'video' ? 'kamere' : type === 'audio' ? 'mikrofónu' : '').filter(Boolean);
  return labels.length ? labels.join(' a ') : 'médiám';
}

function isGuestWebContents(webContents) {
  const parentContents = webContents?.hostWebContents || webContents;
  return BrowserWindow.fromWebContents(parentContents)?.__guest === true;
}

async function requestSitePermission(webContents, permission, callback, details = {}) {
  const guest = isGuestWebContents(webContents);
  const request = getPermissionDecision({ permission, mediaTypes: details.mediaTypes, requestingUrl: details.requestingUrl, preferences: browserPreferences, decisions: guest ? {} : sitePermissions });
  if (request.decision === 'deny') return callback(false);
  if (request.decision === 'allow') return callback(true);

  try {
    const parentContents = webContents.hostWebContents || webContents;
    const parentWindow = BrowserWindow.fromWebContents(parentContents) || undefined;
    const result = await dialog.showMessageBox(parentWindow, {
      type: 'question',
      title: 'Povolenie webovej stránky',
      message: `${request.origin} žiada o prístup ku ${permissionLabel(permission, details.mediaTypes)}.`,
      detail: 'Povoliť prístup iba tejto stránke?',
      buttons: ['Blokovať', 'Povoliť teraz', 'Vždy povoliť'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    const allowed = result.response === 1 || result.response === 2;
    if (!guest && (result.response === 0 || result.response === 2)) {
      sitePermissions[request.key] = allowed ? 'allow' : 'deny';
      saveSitePermissions();
    }
    callback(allowed);
  } catch {
    callback(false);
  }
}

function saveDownloadHistory() {
  require('node:fs').mkdirSync(path.dirname(downloadHistoryPath), { recursive: true });
  require('node:fs').writeFileSync(downloadHistoryPath, JSON.stringify(downloadHistory.slice(0, 100)), 'utf8');
}

function loadDownloadHistory() {
  try {
    const stored = JSON.parse(require('node:fs').readFileSync(downloadHistoryPath, 'utf8'));
    downloadHistory = Array.isArray(stored) ? stored.slice(0, 100) : [];
  } catch {
    downloadHistory = [];
  }
}

function savePasswordVault() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Šifrované úložisko hesiel nie je dostupné.');
  const encrypted = safeStorage.encryptString(JSON.stringify(passwordVault));
  require('node:fs').mkdirSync(path.dirname(passwordVaultPath), { recursive: true });
  require('node:fs').writeFileSync(passwordVaultPath, JSON.stringify({ encrypted: encrypted.toString('base64') }), 'utf8');
}

function loadPasswordVault() {
  try {
    const stored = JSON.parse(require('node:fs').readFileSync(passwordVaultPath, 'utf8'));
    if (stored.encrypted && safeStorage.isEncryptionAvailable()) passwordVault = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64')));
  } catch { passwordVault = []; }
}
const dangerousDownloadExtensions = new Set(['.exe', '.msi', '.msp', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar', '.hta']);
const browserPreferences = {
  downloads: 'Downloads',
  downloadFolderPath: '',
  askDownload: false,
  adBlock: true,
  trackingProtection: true,
  camera: false,
  microphone: false,
  webNotifications: false,
  clearExit: false,
  autoUpdateCheck: true
};
let clearingExitData = false;

function readWindowState() {
  try {
    const state = JSON.parse(require('node:fs').readFileSync(windowStatePath, 'utf8'));
    if (!state || typeof state !== 'object') return {};
    return {
      x: Number.isFinite(state.x) ? state.x : undefined,
      y: Number.isFinite(state.y) ? state.y : undefined,
      width: Number.isFinite(state.width) && state.width >= 960 ? state.width : 1440,
      height: Number.isFinite(state.height) && state.height >= 640 ? state.height : 920,
      isMaximized: state.isMaximized === true
    };
  } catch {
    return {};
  }
}

function saveWindowState(window) {
  if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  try {
    const bounds = window.getBounds();
    require('node:fs').mkdirSync(path.dirname(windowStatePath), { recursive: true });
    require('node:fs').writeFileSync(windowStatePath, JSON.stringify({ ...bounds, isMaximized: window.isMaximized() }), 'utf8');
  } catch {}
}

const savedWindowState = readWindowState();

function getVisibleWindowState(state) {
  if (state.x === undefined || state.y === undefined) return state;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return state.x < area.x + area.width && state.x + state.width > area.x && state.y < area.y + area.height && state.y + state.height > area.y;
  });
  return visible ? state : { ...state, x: undefined, y: undefined, isMaximized: false };
}
const blockedAdHosts = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'adservice.google.com',
  'ads.youtube.com',
  'pagead2.googlesyndication.com',
  'pubads.g.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'imasdk.googleapis.com',
  'adsrvr.org',
  'adnxs.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'amazon-adsystem.com',
  'moatads.com',
  'adsafeprotected.com',
  'quantserve.com',
  'scorecardresearch.com',
  'connectad.io',
  'smartadserver.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  '33across.com',
  'adsymptotic.com'
];

const adPattern = /(?:^|[._/-])(ad|ads|advert|advertising|adservice|banner|doubleclick|prebid|popunder|sponsor)(?:[._/?=-]|$)/i;
const trackerPattern = /(?:analytics|telemetry|tracking|pixel|beacon|fingerprint|metrics|collect)/i;
const adBlockLearningPath = path.join(writableDataPath, 'adblock-learning.json');
let learnedAdHosts = new Set();
let adBlockCandidates = {};
let adBlockCount = 0;
let adBlockHostsCount = {};
let allowlistedHosts = new Set();
let dynamicAdHosts = new Set();
function isYoutubeCoreHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtubei.googleapis.com' || host.endsWith('.googlevideo.com') || host.endsWith('.ytimg.com') || host.endsWith('.ggpht.com');
}
try {
  const stored = JSON.parse(require('node:fs').readFileSync(adBlockLearningPath, 'utf8'));
  learnedAdHosts = new Set((Array.isArray(stored.learnedAdHosts) ? stored.learnedAdHosts : []).filter((host) => !isYoutubeCoreHost(host)));
  adBlockCandidates = stored.candidates && typeof stored.candidates === 'object' ? stored.candidates : {};
  adBlockCount = Number(stored.blocked) || 0;
  adBlockHostsCount = stored.hostCounts && typeof stored.hostCounts === 'object' ? stored.hostCounts : {};
  allowlistedHosts = new Set(Array.isArray(stored.allowlistedHosts) ? stored.allowlistedHosts : []);
  dynamicAdHosts = new Set(Array.isArray(stored.dynamicAdHosts) ? stored.dynamicAdHosts : []);
} catch {}

function saveAdBlockLearning() {
  try {
    const compactCandidates = Object.fromEntries(Object.entries(adBlockCandidates).sort((left, right) => right[1] - left[1]).slice(0, 5000));
    const compactHostCounts = Object.fromEntries(Object.entries(adBlockHostsCount).sort((left, right) => right[1] - left[1]).slice(0, 1000));
    require('node:fs').mkdirSync(path.dirname(adBlockLearningPath), { recursive: true });
    require('node:fs').writeFileSync(adBlockLearningPath, JSON.stringify({ learnedAdHosts: [...learnedAdHosts].slice(-500), candidates: compactCandidates, blocked: adBlockCount, hostCounts: compactHostCounts, allowlistedHosts: [...allowlistedHosts], dynamicAdHosts: [...dynamicAdHosts].slice(-50000) }), 'utf8');
  } catch {}
}

function learnAdHost(hostname) {
  const count = (Number(adBlockCandidates[hostname]) || 0) + 1;
  adBlockCandidates[hostname] = count;
  if (count >= 3 && !learnedAdHosts.has(hostname)) {
    learnedAdHosts.add(hostname);
    saveAdBlockLearning();
  }
}

function isBlockedAdRequest(url, details = {}) {
  try {
    const parsed = new URL(url);
    if (details.resourceType === 'mainFrame') return false;
    if (allowlistedHosts.has(parsed.hostname)) return false;
    const youtubeCoreHost = isYoutubeCoreHost(parsed.hostname);
    const hostBlocked = blockedAdHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    const resourcePath = `${parsed.pathname}${parsed.search}`;
    const youtubeAdPath = /\/api\/stats\/ads|\/pagead\/|googleads|ad_break/i.test(resourcePath);
    const pathLooksLikeAd = adPattern.test(resourcePath);
    const learnedHost = !youtubeCoreHost && learnedAdHosts.has(parsed.hostname);
    const dynamicHost = !youtubeCoreHost && dynamicAdHosts.has(parsed.hostname);
    const trackerBlocked = browserPreferences.trackingProtection && (trackerPattern.test(parsed.hostname) || /\/collect(?:\?|\/)|\/pixel(?:\?|\/)|\/beacon(?:\?|\/)/i.test(resourcePath));
    const adBlocked = browserPreferences.adBlock && (hostBlocked || learnedHost || dynamicHost || (parsed.hostname.endsWith('youtube.com') && youtubeAdPath));
    const blocked = adBlocked || trackerBlocked;
    let initiatorHost = '';
    try { initiatorHost = details.initiator ? new URL(details.initiator).hostname : ''; } catch {}
    const thirdPartyRequest = !initiatorHost || initiatorHost !== parsed.hostname;
    if (!blocked && thirdPartyRequest && details.resourceType !== 'mainFrame' && pathLooksLikeAd) learnAdHost(parsed.hostname);
    if (blocked) {
      adBlockCount += 1;
      adBlockHostsCount[parsed.hostname] = (Number(adBlockHostsCount[parsed.hostname]) || 0) + 1;
      if (adBlockCount % 10 === 0) saveAdBlockLearning();
    }
    return blocked;
  } catch {
    return false;
  }
}

function adBlockStats() {
  return { blocked: adBlockCount, learned: learnedAdHosts.size + dynamicAdHosts.size, allowlisted: allowlistedHosts.size, topHosts: Object.entries(adBlockHostsCount).sort((left, right) => right[1] - left[1]).slice(0, 10) };
}

function sendVpnStatus(status, message = '') {
  for (const window of browserWindows) {
    if (!window.isDestroyed()) window.webContents.send('openvpn-status', { status, message, profile: openVpnProfile });
  }
}

function openVpnExecutable() {
  const fs = require('node:fs');
  /** @type {string[]} */
  const candidates = [process.env.OPENVPN_PATH, 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', 'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe', 'C:\\Program Files\\OpenVPN\\bin\\openvpn-gui.exe', 'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn-gui.exe'].filter((value) => typeof value === 'string');
  const installedPath = /** @type {string | undefined} */(candidates.find((candidate) => fs.existsSync(candidate)));
  if (installedPath) return installedPath;
  try {
    const result = require('node:child_process').execFileSync('where.exe', ['openvpn.exe'], { windowsHide: true, encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
    if (result) return result.trim();
  } catch {}
  return 'openvpn.exe';
}

function externalUrlFromArgs(args) {
  const explicitUrl = args.find((value) => /^linsoft:\/\/(?:apps|centrum|install\?|uninstall\?)/i.test(value) || /^file:\/\//i.test(value));
  if (explicitUrl) return explicitUrl;
  const htmlFile = args.find((value) => /\.html?$/i.test(value) && !String(value).startsWith('-'));
  return htmlFile ? pathToFileURL(path.resolve(htmlFile)).href : undefined;
}

function startupUrlFromArgs(args) {
  const explicitUrl = externalUrlFromArgs(args);
  if (explicitUrl) return explicitUrl;
  const incomingWebUrl = args.find((value) => /^https?:\/\//i.test(value));
  if (incomingWebUrl) return incomingWebUrl;
  return 'linsoft://start';
}

function supportedWebUrl(value) {
  return isSafeWebUrl(value);
}

function supportedNavigationUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol === 'http:') return Boolean(parsed.hostname);
    if (parsed.protocol === 'https:') return Boolean(parsed.hostname);
    if (parsed.protocol !== 'file:') return false;
    const localPath = path.resolve(decodeURIComponent(parsed.pathname.replace(/^\//, '').replace(/^([A-Za-z]):/, '$1:')));
    return /\.(?:html?|css|js|json|png|jpg|jpeg|gif|svg|ico)$/i.test(localPath) && require('node:fs').existsSync(localPath);
  } catch { return false; }
}

function dispatchExternalUrl(window, url) {
  if (!window || !url) return;
  if (/^linsoft:\/\/install\?/i.test(url)) {
    try {
      const parsed = new URL(url);
      const targetUrl = parsed.searchParams.get('url') || '';
      if (supportedWebUrl(targetUrl)) window.webContents.send('install-external-app', { name: (parsed.searchParams.get('name') || parsed.hostname).slice(0, 80), url: targetUrl });
    } catch {}
    return;
  }
  if (/^linsoft:\/\/uninstall\?/i.test(url)) {
    try {
      const parsed = new URL(url);
      const targetUrl = parsed.searchParams.get('url') || '';
      if (supportedWebUrl(targetUrl)) window.webContents.send('uninstall-external-app', { name: (parsed.searchParams.get('name') || '').slice(0, 80), url: targetUrl });
    } catch {}
    return;
  }
  if (/^linsoft:\/\/(?:apps|centrum)$/i.test(url)) {
    window.webContents.send('open-app-center');
    return;
  }
  window.webContents.send('open-external-url', url);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

function configureGuestSession(guestSession) {
  guestSession.setPermissionRequestHandler(createPermissionRequestHandler(requestSitePermission));
  guestSession.setPermissionCheckHandler(createPermissionCheckHandler(({ permission, requestingUrl, mediaTypes }) => {
    return getPermissionDecision({ permission, mediaTypes, requestingUrl, preferences: browserPreferences, decisions: {} });
  }));
  guestSession.on('will-attach-webview', (event, webPreferences, params) => {
    if (!supportedWebUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  guestSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders.DNT = '1';
    details.requestHeaders['Sec-GPC'] = '1';
    callback({ requestHeaders: details.requestHeaders });
  });
  guestSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame') return callback({ cancel: false });
    callback({ cancel: isBlockedAdRequest(details.url, details) });
  });
}

function createWindow(initialUrl = 'linsoft://start', { guest = false } = {}) {
  const safeInitialUrl = /^linsoft:\/\//i.test(initialUrl) || /^file:\/\//i.test(initialUrl);
  const normalizedInitialUrl = initialUrl;
  const windowState = guest ? {} : getVisibleWindowState(savedWindowState);
  const partition = guest ? `guest-${crypto.randomUUID()}` : '';
  if (guest) configureGuestSession(session.fromPartition(partition));
  const window = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width || 1440,
    height: windowState.height || 920,
    icon: path.join(__dirname, 'assets', isLinux ? 'linsoft-icon-256.png' : 'linsoft-icon.ico'),
    minWidth: 960,
    minHeight: 640,
    title: guest ? 'Linsoft Browser - hosť' : 'Linsoft Browser',
    backgroundColor: '#0b1118',
    frame: false,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: true,
      partition: partition || undefined
    }
  });
  window.__guest = guest;

  function isYoutubeCoreHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtubei.googleapis.com' || host.endsWith('.googlevideo.com') || host.endsWith('.ytimg.com') || host.endsWith('.ggpht.com');
  }
  window.loadFile(path.join(__dirname, 'index.html'), { query: guest ? { guest: '1' } : undefined });
  window.once('ready-to-show', () => {
    if (window.isMinimized()) window.restore();
    if (windowState.isMaximized) window.maximize();
    else if (windowState.x === undefined || windowState.y === undefined) window.center();
    window.setAlwaysOnTop(true);
    window.show();
    window.focus();
    setTimeout(() => { if (!window.isDestroyed()) window.setAlwaysOnTop(false); }, 700);
  });
  if (!guest) {
    window.on('resize', () => saveWindowState(window));
    window.on('move', () => saveWindowState(window));
    window.on('maximize', () => saveWindowState(window));
    window.on('unmaximize', () => saveWindowState(window));
    window.on('close', () => saveWindowState(window));
  }
  window.on('close', (event) => {
    if (window.__closeConfirmed) return;
    event.preventDefault();
    window.webContents.send('window-close-request');
  });
  window.webContents.once('did-finish-load', () => {
    if (safeInitialUrl || /^https?:\/\//i.test(normalizedInitialUrl) === false) dispatchExternalUrl(window, normalizedInitialUrl || 'linsoft://start');
    else dispatchExternalUrl(window, 'linsoft://start');
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle('Linsoft Browser');
  });
  browserWindows.add(window);
  window.on('closed', () => {
    browserWindows.delete(window);
    if (mainWindow === window) mainWindow = browserWindows.values().next().value || null;
  });
  mainWindow = window;
}

if (hasLock) {
  app.on('second-instance', (_event, commandLine) => {
    const url = externalUrlFromArgs(commandLine);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (url) dispatchExternalUrl(mainWindow, url);
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow) dispatchExternalUrl(mainWindow, url);
  });
}

ipcMain.on('window-control', (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (action === 'minimize') window.minimize();
  if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === 'restore') {
    if (window.isMinimized()) window.restore();
    if (window.isMaximized()) window.unmaximize();
  }
  if (action === 'fullscreen') window.setFullScreen(!window.isFullScreen());
  if (action === 'toggle-always-on-top') window.setAlwaysOnTop(!window.isAlwaysOnTop());
  if (action === 'close') window.close();
});
ipcMain.on('confirm-window-close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  window.__closeConfirmed = true;
  window.close();
});

function configuredDownloadFolder() {
  if (browserPreferences.downloadFolderPath) return browserPreferences.downloadFolderPath;
  const folderName = browserPreferences.downloads === 'Desktop' ? 'desktop' : browserPreferences.downloads === 'Documents' ? 'documents' : 'downloads';
  return app.getPath(folderName);
}

ipcMain.on('open-downloads', () => shell.openPath(configuredDownloadFolder()));
ipcMain.handle('select-download-folder', async (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
  const result = await dialog.showOpenDialog(parentWindow, { title: 'Vybrať priečinok na sťahovanie', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? '' : result.filePaths[0] || '';
});
ipcMain.on('open-download-file', (_event, filePath) => shell.openPath(filePath));
ipcMain.on('show-download-file', (_event, filePath) => shell.showItemInFolder(filePath));
ipcMain.on('cancel-download', (_event, id) => { const download = activeDownloads.get(id); if (download) { download.cancel(); activeDownloads.delete(id); } });
ipcMain.on('pause-download', (_event, id) => { const download = activeDownloads.get(id); if (download && !download.isPaused()) download.pause(); });
ipcMain.on('resume-download', (_event, id) => { const download = activeDownloads.get(id); if (download?.canResume?.() && download.isPaused()) download.resume(); });
ipcMain.handle('download-list', () => downloadHistory);
ipcMain.handle('download-remove', (_event, id) => {
  downloadHistory = downloadHistory.filter((download) => download.id !== id);
  saveDownloadHistory();
  return { ok: true };
});
ipcMain.handle('download-clear', () => {
  downloadHistory = [];
  saveDownloadHistory();
  return { ok: true };
});
ipcMain.on('set-browser-preferences', (_event, preferences) => {
  if (!preferences || typeof preferences !== 'object') return;
  const enablingAutoUpdates = browserPreferences.autoUpdateCheck === false && preferences.autoUpdateCheck === true;
  for (const key of Object.keys(browserPreferences)) {
    if (typeof preferences[key] === typeof browserPreferences[key]) browserPreferences[key] = preferences[key];
  }
  if (enablingAutoUpdates && autoUpdater && canAutoCheckForUpdates({ isPackaged: app.isPackaged, platform: process.platform, enabled: browserPreferences.autoUpdateCheck, status: updateState.status })) autoUpdater.checkForUpdates().catch(() => {});
});
ipcMain.handle('site-permission-list', (event) => {
  if (isGuestWebContents(event.sender)) return [];
  return Object.entries(sitePermissions).map(([key, decision]) => {
  const separator = key.lastIndexOf('|');
  return { key, origin: key.slice(0, separator), permission: key.slice(separator + 1), decision };
  });
});
ipcMain.handle('site-permission-revoke', (event, key) => {
  if (isGuestWebContents(event.sender)) return { ok: false };
  if (typeof key !== 'string' || !Object.hasOwn(sitePermissions, key)) return { ok: false };
  delete sitePermissions[key];
  try { saveSitePermissions(); return { ok: true }; } catch { return { ok: false }; }
});
ipcMain.handle('site-permission-clear', (event) => {
  if (isGuestWebContents(event.sender)) return { ok: false };
  sitePermissions = {};
  try { saveSitePermissions(); return { ok: true }; } catch { return { ok: false }; }
});
ipcMain.handle('clear-cache', async () => {
  try { await session.defaultSession.clearCache(); return { ok: true }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('save-page-pdf', async (event, webContentsId) => {
  const contents = Number.isInteger(webContentsId) ? require('electron').webContents.fromId(webContentsId) : null;
  if (!contents) return { ok: false, message: 'Stránka nie je pripravená na uloženie.' };
  try {
    const pdf = await contents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const parentWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showSaveDialog(parentWindow, { title: 'Uložiť stránku ako PDF', defaultPath: 'linsoft-page.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    require('node:fs').writeFileSync(result.filePath, pdf);
    return { ok: true, filePath: result.filePath };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('capture-page', async (event, webContentsId) => {
  const contents = Number.isInteger(webContentsId) ? require('electron').webContents.fromId(webContentsId) : null;
  if (!contents) return { ok: false, message: 'Stránka nie je pripravená na snímku.' };
  try {
    const image = await contents.capturePage();
    const parentWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showSaveDialog(parentWindow, { title: 'Uložiť snímku webu', defaultPath: 'linsoft-screenshot.png', filters: [{ name: 'PNG obrázok', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    require('node:fs').writeFileSync(result.filePath, image.toPNG());
    return { ok: true, filePath: result.filePath };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('capture-page-to-clipboard', async (_event, webContentsId) => {
  const contents = Number.isInteger(webContentsId) ? require('electron').webContents.fromId(webContentsId) : null;
  if (!contents) return { ok: false, message: 'Stránka nie je pripravená na snímku.' };
  try { clipboard.writeImage(nativeImage.createFromBitmap((await contents.capturePage()).toBitmap())); return { ok: true }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('update-state', () => updateState);
ipcMain.handle('update-check', async () => {
  if (!autoUpdater || !app.isPackaged) return { ok: false, status: 'unavailable', message: 'Aktualizácie sú dostupné iba v nainštalovanej verzii.' };
  try { autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true; const result = await autoUpdater.checkForUpdates(); const state = { ...getUpdateStatus(app.getVersion(), result?.updateInfo), checkedAt: Date.now() }; publishUpdateState(state); return { ok: true, ...state }; } catch (error) { const state = { ...formatUpdateFailure(error), checkedAt: Date.now() }; publishUpdateState(state); return state; }
});
ipcMain.handle('update-download', async () => { if (!autoUpdater) return { ok: false }; try { await autoUpdater.downloadUpdate(); return { ok: true }; } catch (error) { return formatUpdateFailure(error); } });
ipcMain.on('update-install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });
ipcMain.handle('password-list', (event) => isGuestWebContents(event.sender) ? [] : passwordVault.map(({ id, hostname, username, createdAt, updatedAt }) => ({ id, hostname, username, createdAt, updatedAt })));
ipcMain.handle('password-get', (event, id) => { if (isGuestWebContents(event.sender)) return null; const entry = passwordVault.find((item) => item.id === id); return entry ? { hostname: entry.hostname, username: entry.username, password: entry.password } : null; });
ipcMain.handle('password-save', (event, entry) => {
  try {
    if (isGuestWebContents(event.sender)) return { ok: false, message: 'Heslá sa v okne hosťa neukladajú.' };
    const hostname = String(entry?.hostname || '').trim().toLowerCase();
    const username = String(entry?.username || '').trim();
    const password = String(entry?.password || '');
    if (!hostname || !username || !password) return { ok: false, message: 'Vyplň doménu, používateľa aj heslo.' };
    const existing = passwordVault.find((item) => item.hostname === hostname && item.username === username);
    const saved = { id: existing?.id || crypto.randomUUID(), hostname, username, password, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
    if (existing) Object.assign(existing, saved); else passwordVault.push(saved);
    savePasswordVault();
    return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('password-delete', (event, id) => { if (isGuestWebContents(event.sender)) return { ok: false, message: 'Heslá sa v okne hosťa nemenia.' }; passwordVault = passwordVault.filter((item) => item.id !== id); try { savePasswordVault(); return { ok: true }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; } });
loadPasswordVault();
loadDownloadHistory();
loadSitePermissions();
ipcMain.handle('adblock-stats', () => adBlockStats());
ipcMain.handle('adblock-toggle-site', (_event, hostname) => {
  const host = String(hostname || '').toLowerCase().trim();
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host) && !/^(?:localhost|127\.0\.0\.1)$/i.test(host)) return { ok: false, message: 'Neplatná doména.' };
  if (allowlistedHosts.has(host)) allowlistedHosts.delete(host);
  else allowlistedHosts.add(host);
  saveAdBlockLearning();
  return { ok: true, allowlisted: allowlistedHosts.has(host), host };
});
ipcMain.handle('adblock-update-list', async () => {
  try {
    const response = await fetch('https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const hosts = text.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2 && /^(?:0\.0\.0\.0|127\.0\.0\.1)$/.test(parts[0]) && /^[a-z0-9.-]+$/i.test(parts[1])).map((parts) => parts[1].toLowerCase()).filter((host) => host.includes('.') && !/^(?:localhost|broadcast|local)$/i.test(host));
    dynamicAdHosts = new Set(hosts.slice(0, 50000));
    saveAdBlockLearning();
    return { ok: true, count: dynamicAdHosts.size };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.on('open-browser-window', (_event, url) => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); if (url) dispatchExternalUrl(mainWindow, url); } else if (hasLock) createWindow(url); });
ipcMain.on('open-detached-window', (_event, url) => { if (hasLock) createWindow(url || 'linsoft://start'); });
ipcMain.on('open-guest-window', () => { if (hasLock) createWindow('linsoft://start', { guest: true }); });
ipcMain.handle('install-web-app', async (_event, data) => {
  if (!data?.url || !supportedWebUrl(data.url)) return { ok: false, message: 'Neplatná webová adresa.' };
  let parsedUrl;
  try { parsedUrl = new URL(data.url); } catch { return { ok: false, message: 'Neplatná webová adresa.' }; }
  const shortcutName = String(data.title || parsedUrl.hostname).replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 80) || 'Linsoft Web App';
  if (isLinux) {
    const fs = require('node:fs');
    const desktopDir = path.join(os.homedir(), 'Desktop');
    const desktopFile = path.join(desktopDir, `${shortcutName}.desktop`);
    const iconPath = path.join(app.getAppPath(), 'assets', 'linsoft-icon-256.png');
    const content = [
      '[Desktop Entry]',
      'Version=1.0',
      `Name=${shortcutName}`,
      `Exec=${JSON.stringify(process.execPath)} ${JSON.stringify(data.url)}`,
      'Type=Application',
      'Terminal=false',
      'Categories=Network;WebBrowser;',
      `Icon=${iconPath}`,
      'StartupNotify=true'
    ].join('\n');
    try {
      fs.mkdirSync(desktopDir, { recursive: true });
      fs.writeFileSync(desktopFile, content, 'utf8');
      fs.chmodSync(desktopFile, 0o755);
      return { ok: true, path: desktopFile };
    } catch (err) {
      const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      return { ok: false, message: `Skratku sa nepodarilo vytvoriť: ${msg}` };
    }
  }
  const shortcut = path.join(app.getPath('desktop'), `${shortcutName}.lnk`);
  const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = `$s=New-Object -ComObject WScript.Shell;$l=$s.CreateShortcut(${quotePowerShell(shortcut)});$l.TargetPath=${quotePowerShell(process.execPath)};$l.Arguments=${quotePowerShell(data.url)};$l.WorkingDirectory=${quotePowerShell(path.dirname(process.execPath))};$l.Description=${quotePowerShell(`${shortcutName} - Linsoft Browser`)};$l.Save()`;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let error = '';
    child.stderr.on('data', (data) => { error += String(data); });
    child.once('error', (spawnError) => {
      const msg = spawnError && typeof spawnError === 'object' && 'message' in spawnError ? spawnError.message : String(spawnError);
      resolve({ ok: false, message: `Skratku sa nepodarilo vytvoriť: ${msg}` });
    });
    child.once('close', (code) => resolve(code === 0 ? { ok: true, path: shortcut } : { ok: false, message: error.trim() || `Windows vrátil kód ${code}.` }));
  });
});
ipcMain.handle('uninstall-web-app', async (_event, data) => {
  const fs = require('node:fs');
  const name = String(data?.title || '').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 80) || 'Linsoft Web App';
  const shortcut = path.join(app.getPath('desktop'), `${name}.lnk`);
  try { if (fs.existsSync(shortcut)) fs.unlinkSync(shortcut); } catch (err) { const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err); return { ok: false, message: `Skratku sa nepodarilo odstrániť: ${msg}` }; }
  return { ok: true, path: shortcut };
});
ipcMain.handle('openvpn-path', () => {
  /** @type {string[]} */
  const candidates = [process.env.OPENVPN_PATH, 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', 'C:\\Program Files\\OpenVPN\\bin\\openvpn-gui.exe', 'openvpn.exe'].filter((value) => typeof value === 'string');
  return /** @type {string | undefined} */(candidates.find((candidate) => candidate === 'openvpn.exe' || require('node:fs').existsSync(candidate))) || '';
});
ipcMain.handle('openvpn-select-profile', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'OpenVPN profil', extensions: ['ovpn'] }] });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.on('openvpn-connect', (_event, profile) => {
  if (!profile) return sendVpnStatus('error', 'Vyber najprv .ovpn profil.');
  try {
    const fs = require('node:fs');
    if (openVpnExecutable() === 'openvpn.exe') {
      return sendVpnStatus('error', 'OpenVPN klient sa nenašiel. Server môže byť nainštalovaný, ale na pripojenie je potrebný aj klientsky openvpn.exe a .ovpn profil.');
    }
  } catch {
    return sendVpnStatus('error', 'OpenVPN klient sa nenašiel. Skontroluj openvpn.exe a klientsky .ovpn profil.');
  }
  if (openVpnProcess) openVpnProcess.kill();
  openVpnProfile = profile;
  sendVpnStatus('connecting', 'OpenVPN sa pripája...');
  try {
    openVpnProcess = spawn(openVpnExecutable(), ['--config', profile], { windowsHide: true });
    openVpnProcess.stdout.on('data', (data) => { if (/Initialization Sequence Completed/i.test(String(data))) sendVpnStatus('connected', 'VPN je pripojená.'); });
    openVpnProcess.stderr.on('data', (data) => { const text = String(data).trim(); if (text) sendVpnStatus('log', text.slice(-240)); });
    openVpnProcess.on('error', (err) => {
      openVpnProcess = null;
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      sendVpnStatus('error', code === 'ENOENT' ? 'OpenVPN klient sa nenašiel. Nainštaluj OpenVPN Community a skús znova.' : `OpenVPN sa nespustilo: ${msg}`);
    });
    openVpnProcess.on('exit', (code) => { openVpnProcess = null; if (code !== 0) sendVpnStatus('error', `VPN skončila s kódom ${code ?? 'neznámym'}.`); else sendVpnStatus('disconnected', 'VPN je odpojená.'); });
  } catch (err) { openVpnProcess = null; const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err); sendVpnStatus('error', `OpenVPN sa nespustilo: ${msg}`); }
});
ipcMain.on('openvpn-disconnect', () => { if (openVpnProcess) { openVpnProcess.kill(); openVpnProcess = null; } sendVpnStatus('disconnected', 'VPN je odpojená.'); });

app.whenReady().then(() => {
  if (process.platform === 'win32' || process.platform === 'linux') app.setAsDefaultProtocolClient('linsoft');
  app.commandLine.appendSwitch('enable-features', 'ParallelDownloading');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (browserPreferences.trackingProtection && details.url.startsWith('http')) {
      details.requestHeaders.DNT = '1';
      details.requestHeaders['Sec-GPC'] = '1';
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame') return callback({ cancel: false });
    callback({ cancel: (browserPreferences.adBlock || browserPreferences.trackingProtection) && isBlockedAdRequest(details.url, details) });
  });
  session.defaultSession.setPermissionRequestHandler(createPermissionRequestHandler(requestSitePermission));
  session.defaultSession.setPermissionCheckHandler(createPermissionCheckHandler(({ permission, requestingUrl, mediaTypes }) => {
    return getPermissionDecision({ permission, mediaTypes, requestingUrl, preferences: browserPreferences, decisions: sitePermissions });
  }));
  session.defaultSession.on('will-attach-webview', (event, webPreferences, params) => {
    if (!supportedWebUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('before-input-event', (inputEvent, input) => {
      const key = String(input.key || '').toLowerCase();
      if (input.type === 'mouseDown' && input.button === 'left') {
        contents.hostWebContents?.send('dismiss-webview-overlay');
        return;
      }
      if (input.type === 'keyDown' && key === 'escape') {
        inputEvent.preventDefault();
        contents.hostWebContents?.send('browser-shortcut', { key, shift: false });
        return;
      }
      if (input.type !== 'keyDown' || (!(input.control || input.meta) && !input.alt)) return;
      if (!['l', 'k', 'r', 't', 'w', 'c', 'x', 'v', 'a', 'z', 'y', 'f', 'p', '0', '-', '=', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'tab', 'arrowleft', 'arrowright'].includes(key) && !(key === 'i' && input.shift) && !(key === 't' && input.shift) && !(key === 's' && input.shift)) return;
      if (input.alt && !input.control && !input.meta && !['arrowleft', 'arrowright'].includes(key)) return;
      inputEvent.preventDefault();
      contents.hostWebContents?.send('browser-shortcut', { key, shift: Boolean(input.shift) });
    });
    contents.on('context-menu', (_event, params) => {
      contents.hostWebContents?.send('webview-context-menu', { x: params.x || 0, y: params.y || 0, selectionText: params.selectionText || '', linkURL: params.linkURL || '', srcURL: params.srcURL || '', isEditable: Boolean(params.isEditable), mediaType: params.mediaType || '' });
    });
    contents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    contents.on('render-process-gone', (_event, details) => { contents.hostWebContents?.send('webview-process-gone', { reason: details.reason }); });
    contents.on('will-navigate', (navigationEvent, url) => { if (!supportedNavigationUrl(url)) navigationEvent.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => {
      if (!supportedWebUrl(url)) return { action: 'deny' };
      contents.hostWebContents?.send('open-link-in-tab', url);
      return { action: 'deny' };
    });
  });
  session.defaultSession.on('will-download', async (event, item, webContents) => {
    let folder = configuredDownloadFolder();
    const downloadId = crypto.randomUUID();
    try {
      require('node:fs').mkdirSync(folder, { recursive: true });
    } catch {
      folder = app.getPath('downloads');
      require('node:fs').mkdirSync(folder, { recursive: true });
    }
    const rawName = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'download';
    const extension = path.extname(rawName);
    if (dangerousDownloadExtensions.has(extension.toLowerCase())) {
      const parentWindow = BrowserWindow.fromWebContents(webContents) || undefined;
      const warning = await dialog.showMessageBox(parentWindow, { type: 'warning', title: 'Rizikové sťahovanie', message: `Súbor ${rawName} môže obsahovať spustiteľný kód.`, detail: 'Ulož ho iba vtedy, ak dôveruješ zdroju.', buttons: ['Zrušiť', 'Uložiť aj tak'], defaultId: 0, cancelId: 0 });
      if (warning.response !== 1) { event.preventDefault(); return; }
    }
    const stem = extension ? rawName.slice(0, -extension.length) : rawName;
    let downloadPath = path.join(folder, rawName);
    let suffix = 1;
    while (require('node:fs').existsSync(downloadPath)) downloadPath = path.join(folder, `${stem} (${suffix++})${extension}`);
    if (browserPreferences.askDownload) {
      const parentWindow = BrowserWindow.fromWebContents(webContents) || undefined;
      const result = await dialog.showSaveDialog(parentWindow, { defaultPath: downloadPath, title: 'Uložiť stiahnutý súbor' });
      if (result.canceled || !result.filePath) { event.preventDefault(); return; }
      downloadPath = result.filePath;
    }
    const sender = BrowserWindow.fromWebContents(webContents)?.webContents || webContents.hostWebContents || webContents;
    try {
      item.setSavePath(downloadPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sender?.send('download-update', { id: downloadId, fileName: item.getFilename(), filePath: downloadPath, sourceUrl: item.getURL(), status: `Sťahovanie zlyhalo: ${message}`, received: 0, total: item.getTotalBytes(), startedAt: Date.now(), percent: 0 });
      event.preventDefault();
      return;
    }
    const fileName = item.getFilename();
    activeDownloads.set(downloadId, item);
    const startedAt = Date.now();
    /** @param {string} status @param {number} [received] @param {number} [total] */
    const sourceUrl = item.getURL();
    const sendUpdate = (status, received = 0, total = item.getTotalBytes()) => sender?.send('download-update', { id: downloadId, fileName, filePath: downloadPath, sourceUrl, status, received, total, startedAt, percent: total > 0 ? Math.round((received / total) * 100) : 0 });
    sender?.send('download-update', { id: downloadId, fileName, filePath: downloadPath, sourceUrl, status: 'Pripravuje sa', received: 0, total: item.getTotalBytes(), startedAt, percent: 0 });
    sendUpdate('Sťahovanie začalo');
    item.on('updated', (_downloadEvent, state) => { if (state === 'progressing') sendUpdate('Sťahuje sa', item.getReceivedBytes(), item.getTotalBytes()); });
    item.once('done', (_downloadEvent, state) => {
      activeDownloads.delete(downloadId);
      const status = state === 'completed' ? 'Stiahnuté' : state === 'cancelled' ? 'Zrušené' : 'Sťahovanie zlyhalo';
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      const record = { id: downloadId, fileName, filePath: downloadPath, sourceUrl, status, received, total, startedAt, percent: total > 0 ? Math.round((received / total) * 100) : 0, completedAt: Date.now() };
      downloadHistory = [record, ...downloadHistory.filter((download) => download.id !== downloadId)].slice(0, 100);
      saveDownloadHistory();
      sendUpdate(status, received, total);
    });
  });
  setupAutoUpdater();
  if (hasLock) createWindow(startupUrlFromArgs(process.argv));
  app.on('activate', () => {
    if (hasLock && BrowserWindow.getAllWindows().length === 0) createWindow('linsoft://start');
  });
});

app.on('window-all-closed', () => {
  if (openVpnProcess) openVpnProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!browserPreferences.clearExit || clearingExitData) return;
  event.preventDefault();
  clearingExitData = true;
    try {
    await session.defaultSession.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] });
  } finally {
    app.quit();
  }
});
