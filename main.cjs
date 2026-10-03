const { app, BrowserWindow, WebContentsView, Menu, shell, session, ipcMain, dialog, screen, safeStorage, clipboard, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { canAutoCheckForUpdates, formatUpdateFailure, getPermissionDecision, getUpdateStatus, isSafeLocalHtmlUrl, isSafeWebUrl, normalizePermissionOrigin } = require('./lib/browser-policies.cjs');
const { loadSavedTorHostingState, requestOnionService, resolveHostedFile, saveTorHostingFolder, waitForOnionService } = require('./lib/tor-hosting.cjs');
const { createTorChatRoom, createTorChatServer, enqueueTorChatMessage, isValidTorChatEnvelope } = require('./lib/tor-chat-protocol.cjs');
const { createPermissionCheckHandler, createPermissionRequestHandler } = require('./lib/permission-handlers.cjs');
const { NativeTabManager } = require('./lib/native-tab-manager.cjs');
app.setName('Linsoft Browser');
const isPackagedBuild = app.isPackaged && process.env.LINSOFT_DEV_LAUNCH !== '1';
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }
let updateState = { status: 'idle' };
const experimentalNativeTabs = process.env.LINSOFT_NATIVE_TABS === '1';
const isLinux = process.platform === 'linux';
const browserUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36 LinsoftBrowser/${app.getVersion()}`;
app.userAgentFallback = browserUserAgent;
const writableDataPath = process.env.LINSOFT_BROWSER_USER_DATA || path.join(app.getPath('appData'), 'Linsoft Browser');
app.setPath('userData', writableDataPath);
app.setPath('cache', path.join(writableDataPath, 'Cache'));
const windowStatePath = path.join(writableDataPath, 'window-state.json');
const passwordVaultPath = path.join(writableDataPath, 'password-vault.json');
const downloadHistoryPath = path.join(writableDataPath, 'download-history.json');
const sitePermissionsPath = path.join(writableDataPath, 'site-permissions.json');
const torHostingStatePath = path.join(writableDataPath, 'tor-hosting-state.json');
const torHostingHostnamePath = path.join(writableDataPath, 'tor-hosting', 'hidden-service', 'hostname');
/** @type {Set<import('electron').BrowserWindow>} */
const browserWindows = new Set();
let certificateErrorHandlerRegistered = false;

function publishUpdateState(state) {
  updateState = state;
  for (const window of browserWindows) {
    if (!window.isDestroyed()) window.webContents.send('update-state', state);
  }
}

function setupAutoUpdater() {
  if (!autoUpdater || !isPackagedBuild || process.platform !== 'win32') return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => publishUpdateState({ status: 'available', version: info.version, checkedAt: Date.now() }));
  autoUpdater.on('update-not-available', (info) => publishUpdateState({ status: 'latest', version: info.version, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({ status: 'downloading', version: updateState.version, percent: Math.round(progress.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (error) => { console.warn('Linsoft Browser update check failed:', error.message); publishUpdateState({ ...formatUpdateFailure(error), checkedAt: Date.now() }); });

  const checkForUpdates = () => {
    if (!canAutoCheckForUpdates({ isPackaged: isPackagedBuild, platform: process.platform, enabled: browserPreferences.autoUpdateCheck, status: updateState.status })) return;
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
let torProxyProcess = null;
let torHostingProcess = null;
let torServer = null;
let torChatProcess = null;
let torChatServer = null;
let torChatReadyPromise = Promise.resolve(false);
let torChatSession = null;
let torChatRoom = null;
let torChatStartPromise = null;
let torChatStartController = null;
let torChatGeneration = 0;
let torProxyGeneration = 0;
let torProxyReadyPromise = Promise.resolve(false);
let torHostingReadyPromise = Promise.resolve(false);
let torStartPromise = null;
let torHostingStartPromise = null;
let torHostingStartController = null;
let torHostingGeneration = 0;
let torShutdownPromise = null;
let torState = { ...loadSavedTorHostingState(torHostingStatePath, torHostingHostnamePath), proxyEnabled: false, proxyStatus: 'stopped', proxyMessage: 'Tor proxy je vypnutá.', requestCount: 0, lastRequest: '' };
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

function isPrivateNetworkAddress(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  } catch { return false; }
}

function configureCertificateErrorHandling() {
  if (certificateErrorHandlerRegistered) return;
  certificateErrorHandlerRegistered = true;
  app.on('certificate-error', async (event, webContents, url, error, _certificate, callback, isMainFrame) => {
    if (!isMainFrame || !String(error).startsWith('net::ERR_CERT_') || !isPrivateNetworkAddress(url)) return callback(false);
    event.preventDefault();
    const parentContents = webContents.hostWebContents || webContents;
    const parentWindow = BrowserWindow.fromWebContents(parentContents) || [...browserWindows].find((window) => [...(window.__nativeTabs?.views?.values() || [])].some((view) => view.webContents === webContents));
    try {
      const result = await dialog.showMessageBox(parentWindow, {
        type: 'warning',
        title: 'Nedôveryhodný certifikát',
        message: `Certifikát pre ${new URL(url).hostname} nie je dôveryhodný.`,
        detail: 'Môže ísť o lokálne zariadenie so samopodpísaným certifikátom. Pokračuj iba vtedy, ak zariadeniu dôveruješ.',
        buttons: ['Pokračovať nezabezpečene', 'Zrušiť'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      callback(result.response === 0);
    } catch {
      callback(false);
    }
  });
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
  spellcheckLanguages: null,
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
let adBlockSaveTimer = null;
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
  if (adBlockSaveTimer) clearTimeout(adBlockSaveTimer);
  adBlockSaveTimer = setTimeout(() => {
    adBlockSaveTimer = null;
    persistAdBlockLearning();
  }, 1500);
  adBlockSaveTimer.unref?.();
}

async function persistAdBlockLearning() {
  try {
    const compactCandidates = Object.fromEntries(Object.entries(adBlockCandidates).sort((left, right) => right[1] - left[1]).slice(0, 5000));
    const compactHostCounts = Object.fromEntries(Object.entries(adBlockHostsCount).sort((left, right) => right[1] - left[1]).slice(0, 1000));
    const fs = require('node:fs/promises');
    await fs.mkdir(path.dirname(adBlockLearningPath), { recursive: true });
    await fs.writeFile(adBlockLearningPath, JSON.stringify({ learnedAdHosts: [...learnedAdHosts].slice(-500), candidates: compactCandidates, blocked: adBlockCount, hostCounts: compactHostCounts, allowlistedHosts: [...allowlistedHosts], dynamicAdHosts: [...dynamicAdHosts].slice(-50000) }), 'utf8');
  } catch {}
}

function flushAdBlockLearning() {
  if (!adBlockSaveTimer) return;
  clearTimeout(adBlockSaveTimer);
  adBlockSaveTimer = null;
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

function ownedWebContentsForEvent(event, webContentsId) {
  if (!Number.isInteger(webContentsId)) return null;
  const contents = require('electron').webContents.fromId(webContentsId);
  if (!contents) return null;
  if (contents === event.sender || contents.hostWebContents === event.sender) return contents;
  for (const window of browserWindows) {
    if (window.isDestroyed() || window.webContents !== event.sender) continue;
    const nativeView = [...(window.__nativeTabs?.views?.values() || [])].find((view) => view.webContents === contents);
    if (nativeView) return contents;
  }
  return null;
}

function editTargetForEvent(event, webContentsId) {
  return ownedWebContentsForEvent(event, webContentsId) || event.sender.__lastContextWebContents || null;
}

async function pasteAtContextPoint(contents, point) {
  if (!point || typeof contents.executeJavaScript !== 'function') return false;
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  const text = String(clipboard.readText() || '');
  if (!text) return false;
  try {
    return Boolean(await contents.executeJavaScript(`(() => {
      let target = document.elementFromPoint(${x}, ${y});
      while (target?.shadowRoot) {
        const nested = target.shadowRoot.elementFromPoint(${x}, ${y});
        if (!nested || nested === target) break;
        target = nested;
      }
      const fieldSelector = 'input, textarea, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"]';
      const active = document.activeElement;
      const field = target?.closest?.(fieldSelector) || (active?.matches?.(fieldSelector) || active?.isContentEditable ? active : null);
      const editableInputTypes = ['email', 'password', 'search', 'tel', 'text', 'url'];
      const editable = field?.isContentEditable || field?.matches('textarea, [role="textbox"], [role="searchbox"], [role="combobox"]') || (field?.matches('input') && editableInputTypes.includes(field.type));
      if (!editable) return false;
      field.focus();
      if (field.matches('input, textarea')) {
        const value = field.value;
        const start = typeof field.selectionStart === 'number' ? field.selectionStart : value.length;
        const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : start;
        const nextValue = value.slice(0, start) + ${JSON.stringify(text)} + value.slice(end);
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
        if (setter) setter.call(field, nextValue);
        else field.value = nextValue;
        const caret = start + ${JSON.stringify(text)}.length;
        field.setSelectionRange?.(caret, caret);
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
        return field.value === nextValue;
      }
      return document.execCommand('insertText', false, ${JSON.stringify(text)});
    })()`, true));
  } catch {
    return false;
  }
}

function showMouseEditContextMenu(window, contents, params, menuData) {
  const items = [];
  const editFlags = params.editFlags || {};
  const misspelledWord = String(params.misspelledWord || '');
  const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 5) : [];
  const hasClipboardText = Boolean(clipboard.readText());
  if ((params.isEditable || editFlags.canPaste) && hasClipboardText) items.push({ label: 'Vložiť', click: () => contents.paste() });
  if (params.selectionText || editFlags.canCopy) items.push({ label: 'Kopírovať', click: () => contents.copy() });
  if ((params.isEditable || editFlags.canCut) && (params.selectionText || editFlags.canCut)) items.push({ label: 'Vystrihnúť', click: () => contents.cut() });
  if (params.isEditable || editFlags.canSelectAll) items.push({ label: 'Označiť všetko', click: () => contents.selectAll() });
  if (misspelledWord) {
    items.push({ type: 'separator' });
    if (suggestions.length) suggestions.forEach((suggestion) => items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }));
    else items.push({ label: 'Bez návrhov', enabled: false });
    items.push({ label: 'Pridať do slovníka', click: () => contents.session.addWordToSpellCheckerDictionary(misspelledWord) });
  }
  if (!items.length) return false;
  items.push({ type: 'separator' }, { label: 'Preložiť stránku do slovenčiny', click: () => window.webContents.send('translate-page', menuData.pageURL || contents.getURL()) }, { label: 'Ďalšie možnosti Linsoft', click: () => window.webContents.send('webview-context-menu', menuData) });
  Menu.buildFromTemplate(items).popup({ window });
  return true;
}

function dispatchExternalUrl(window, url) {
  if (!window || !url) return;
  if (/^file:\/\//i.test(url) && !isSafeLocalHtmlUrl(url)) return;
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
  configureCertificateErrorHandling(guestSession);
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
    webPreferences.spellcheck = true;
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

function configureNativeTabContents(window, tabId, contents) {
  contents.on('enter-html-full-screen', () => { if (!window.isDestroyed()) { window.setFullScreen(true); window.webContents.send('webview-fullscreen', true); } });
  contents.on('leave-html-full-screen', () => { if (!window.isDestroyed()) { window.setFullScreen(false); window.webContents.send('webview-fullscreen', false); } });
  contents.on('before-input-event', (inputEvent, input) => {
    const key = String(input.key || '').toLowerCase();
    if (input.type === 'keyDown' && key === 'f' && !input.control && !input.meta && !input.alt && /youtube\.com|youtu\.be/i.test(contents.getURL?.() || '')) {
      inputEvent.preventDefault();
      const fullscreen = !window.isFullScreen();
      window.setFullScreen(fullscreen);
      window.webContents.send('webview-fullscreen', fullscreen);
      return;
    }
    if (input.type === 'mouseDown' && ['left', 'right', 'middle'].includes(input.button)) {
      window.webContents.send('dismiss-webview-overlay');
      if (input.button === 'left') return;
    }
    if (input.type === 'mouseDown' && (input.button === 'back' || input.button === 'forward')) {
      inputEvent.preventDefault();
      window.webContents.send('browser-shortcut', { key: input.button === 'back' ? 'arrowleft' : 'arrowright', shift: false });
      return;
    }
    if (input.type === 'keyDown' && key === 'escape') {
      inputEvent.preventDefault();
      window.webContents.send('browser-shortcut', { key, shift: false });
      return;
    }
    if (input.type !== 'keyDown' || (!(input.control || input.meta) && !input.alt)) return;
    if (!['l', 'k', 'r', 't', 'w', 'c', 'x', 'v', 'a', 'z', 'y', 'f', 'p', '0', '-', '=', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'tab', 'arrowleft', 'arrowright'].includes(key) && !(key === 'i' && input.shift) && !(key === 't' && input.shift) && !(key === 's' && input.shift)) return;
    if (input.alt && !input.control && !input.meta && !['arrowleft', 'arrowright'].includes(key)) return;
    inputEvent.preventDefault();
    window.webContents.send('browser-shortcut', { key, shift: Boolean(input.shift) });
  });
  contents.on('context-menu', (_event, params) => {
    window.__lastContextWebContents = contents;
    window.webContents.__lastContextWebContents = contents;
    window.webContents.__lastContextPoint = { x: params.x || 0, y: params.y || 0 };
    const menuData = { tabId, x: params.x || 0, y: params.y || 0, pageURL: params.pageURL || contents.getURL(), selectionText: params.selectionText || '', linkURL: params.linkURL || '', srcURL: params.srcURL || '', isEditable: Boolean(params.isEditable), mediaType: params.mediaType || '' };
    if (showMouseEditContextMenu(window, contents, params, menuData)) return;
    window.webContents.send('webview-context-menu', menuData);
  });
  contents.setUserAgent(browserUserAgent);
  contents.on('will-navigate', (event, url) => { if (!supportedNavigationUrl(url)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!supportedWebUrl(url)) return { action: 'deny' };
    window.webContents.send(disposition === 'new-window' ? 'open-link-in-window' : 'open-link-in-tab', url);
    return { action: 'deny' };
  });
}

function createWindow(initialUrl = 'linsoft://start', { guest = false } = {}) {
  const safeInitialUrl = /^linsoft:\/\//i.test(initialUrl) || /^file:\/\//i.test(initialUrl);
  const normalizedInitialUrl = initialUrl;
  const windowState = guest ? {} : getVisibleWindowState(savedWindowState);
  const partition = guest ? `guest-${crypto.randomUUID()}` : '';
  const useNativeTabs = experimentalNativeTabs;
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
      webviewTag: !useNativeTabs,
      spellcheck: true,
      sandbox: true,
      partition: partition || undefined
    }
  });
  window.__guest = guest;
  window.__nativeTabsEnabled = useNativeTabs;
  try {
    const spellSession = window.webContents.session;
    const availableLanguages = spellSession.availableSpellCheckerLanguages || [];
    const preferredLanguages = ['sk-SK', 'sk', 'en-US', 'en-GB', 'en'];
    const requestedLanguages = browserPreferences.spellcheckLanguages;
    const languages = (Array.isArray(requestedLanguages) ? requestedLanguages : preferredLanguages).filter((language) => availableLanguages.includes(language));
    spellSession.setSpellCheckerLanguages(languages);
  } catch {}
  if (useNativeTabs) {
    window.__nativeTabs = new NativeTabManager({
      window,
      WebContentsView,
      createWebPreferences: () => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, partition: partition || undefined }),
      configureWebContents: (tabId, contents) => configureNativeTabContents(window, tabId, contents),
      onEvent: (tabId, type, data) => window.webContents.send('native-tab-event', { tabId, type, ...data })
    });
  }

  function isYoutubeCoreHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtubei.googleapis.com' || host.endsWith('.googlevideo.com') || host.endsWith('.ytimg.com') || host.endsWith('.ggpht.com');
  }
  window.loadFile(path.join(__dirname, 'index.html'), { query: { ...(guest ? { guest: '1' } : {}), ...(useNativeTabs ? { nativeTabs: '1' } : {}) } });
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
    window.__nativeTabs?.destroyAll();
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
ipcMain.on('set-browser-preferences', (event, preferences) => {
  if (!preferences || typeof preferences !== 'object') return;
  const enablingAutoUpdates = browserPreferences.autoUpdateCheck === false && preferences.autoUpdateCheck === true;
  for (const key of Object.keys(browserPreferences)) {
    if (typeof preferences[key] === typeof browserPreferences[key]) browserPreferences[key] = preferences[key];
  }
  if (preferences.spellcheckLanguages === null || Array.isArray(preferences.spellcheckLanguages)) {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const spellSession = ownerWindow?.webContents.session || event.sender.session;
    const availableLanguages = spellSession.availableSpellCheckerLanguages || [];
    const requestedLanguages = Array.isArray(preferences.spellcheckLanguages) ? preferences.spellcheckLanguages : ['sk-SK', 'sk', 'en-US', 'en-GB', 'en'];
    const selectedLanguages = [...new Set(requestedLanguages)].filter((language) => typeof language === 'string' && availableLanguages.includes(language));
    browserPreferences.spellcheckLanguages = Array.isArray(preferences.spellcheckLanguages) ? selectedLanguages : null;
    spellSession.setSpellCheckerLanguages(selectedLanguages);
  }
  if (enablingAutoUpdates && autoUpdater && canAutoCheckForUpdates({ isPackaged: isPackagedBuild, platform: process.platform, enabled: browserPreferences.autoUpdateCheck, status: updateState.status })) autoUpdater.checkForUpdates().catch(() => {});
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
  const contents = ownedWebContentsForEvent(event, webContentsId);
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
  const contents = ownedWebContentsForEvent(event, webContentsId);
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
ipcMain.handle('capture-page-to-clipboard', async (event, webContentsId) => {
  const contents = ownedWebContentsForEvent(event, webContentsId);
  if (!contents) return { ok: false, message: 'Stránka nie je pripravená na snímku.' };
  try { clipboard.writeImage(nativeImage.createFromBitmap((await contents.capturePage()).toBitmap())); return { ok: true }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('edit-command', async (event, webContentsId, command) => {
  const contents = editTargetForEvent(event, webContentsId);
  const allowedCommands = new Set(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo']);
  if (!contents || !allowedCommands.has(command)) return { ok: false, message: 'Úprava nie je dostupná na tejto stránke.' };
  try {
    if (command === 'paste') {
      const text = String(clipboard.readText() || '');
      if (!text) return { ok: false, message: 'Schránka je prázdna. Najprv skopíruj text.' };
      if (await pasteAtContextPoint(contents, event.sender.__lastContextPoint)) return { ok: true };
      contents.focus?.();
      if (typeof contents.paste === 'function') contents.paste();
      else if (typeof contents.insertText === 'function') await contents.insertText(text);
      else if (typeof contents.sendInputEvent === 'function') {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      }
      else if (typeof contents.paste === 'function') contents.paste();
      else return { ok: false, message: 'Vloženie nie je dostupné na tejto stránke.' };
      return { ok: true };
    }
    if (typeof contents[command] !== 'function') return { ok: false, message: 'Úprava nie je dostupná na tejto stránke.' };
    contents[command]();
    return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('clipboard-read-text', () => clipboard.readText());
ipcMain.handle('clipboard-write-text', (_event, value) => { clipboard.writeText(String(value || '')); return { ok: true }; });
ipcMain.handle('page-source', async (event) => {
  const contents = event.sender.__lastContextWebContents;
  const url = contents?.getURL?.() || '';
  if (!contents || contents.isDestroyed() || !ownedWebContentsForEvent(event, contents.id) || !/^https?:/i.test(url)) {
    return { ok: false, message: 'Zdrojový kód tejto stránky nie je dostupný.' };
  }
  try { return { ok: true, source: await contents.executeJavaScript('document.documentElement?.outerHTML || ""', true), url }; }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('clipboard-copy-selection', async (event, selectedText = '') => {
  let text = String(selectedText || '');
  const candidate = event.sender.__lastContextWebContents;
  const contents = candidate && !candidate.isDestroyed() && ownedWebContentsForEvent(event, candidate.id) ? candidate : null;
  if (contents) {
    try {
      const previousClipboardText = clipboard.readText();
      contents.focus?.();
      contents.copy();
      const nativeCopiedText = clipboard.readText();
      if (nativeCopiedText && nativeCopiedText !== previousClipboardText && (!text || nativeCopiedText === text)) return { ok: true };
    } catch {}
    if (!text && contents.executeJavaScript) {
      try {
        text = String(await contents.executeJavaScript('String(window.getSelection?.()?.toString?.() || document.activeElement?.value?.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) || "")', true) || '');
      } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    }
  }
  if (!text) return { ok: false, message: 'Nie je označený žiadny text.' };
  try {
    clipboard.writeText(text);
    return clipboard.readText() === text ? { ok: true } : { ok: false, message: 'Schránka text neprijala.' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('clipboard-write-image', async (_event, url) => {
  if (!supportedWebUrl(url)) return { ok: false, message: 'Adresa obrázka nie je bezpečná.' };
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, message: `Obrázok sa nepodarilo načítať (${response.status}).` };
    const buffer = Buffer.from(await response.arrayBuffer());
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return { ok: false, message: 'Odpoveď neobsahuje platný obrázok.' };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('update-state', () => updateState);
ipcMain.handle('update-check', async () => {
  if (!autoUpdater || !isPackagedBuild) return { ok: false, status: 'unavailable', message: 'Aktualizácie sú dostupné iba v nainštalovanej verzii.' };
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
function torExecutable() {
  const platformFolder = process.platform === 'win32' ? 'windows' : 'linux';
  const binaryName = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const bundledCandidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'tor', platformFolder, 'tor', binaryName),
    path.join(__dirname, 'assets', 'tor', platformFolder, 'tor', binaryName)
  ];
  const candidates = [...bundledCandidates, process.env.TOR_PATH, process.platform === 'win32' ? 'C:\\Program Files\\Tor\\tor.exe' : '/usr/bin/tor', 'tor.exe', 'tor'].filter(Boolean);
  const fs = require('node:fs');
  return candidates.find((candidate) => candidate === 'tor.exe' || candidate === 'tor' || fs.existsSync(candidate)) || '';
}

function publishTorState(state) {
  torState = { ...torState, ...state };
  for (const window of browserWindows) if (!window.isDestroyed()) window.webContents.send('tor-status', torState);
}

function closeTorServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
}

function terminateTorProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener('exit', finish);
      resolve();
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish();
    }, 5000);
    child.once('exit', finish);
    try { if (!child.kill()) finish(); } catch { finish(); }
  });
}

async function stopTorHostingResources() {
  torHostingStartController?.abort();
  torHostingStartController = null;
  const child = torHostingProcess;
  torHostingProcess = null;
  torHostingReadyPromise = Promise.resolve(false);
  const server = torServer;
  torServer = null;
  await Promise.all([terminateTorProcess(child), closeTorServer(server)]);
}

async function stopTorProxyProcess(invalidateStart = true) {
  if (invalidateStart) torProxyGeneration += 1;
  const child = torProxyProcess;
  torProxyProcess = null;
  torProxyReadyPromise = Promise.resolve(false);
  await terminateTorProcess(child);
}

async function stopTorHosting() {
  torHostingGeneration += 1;
  await stopTorHostingResources();
  const hasSavedAddress = Boolean(torState.onion);
  publishTorState({
    status: 'stopped',
    message: hasSavedAddress ? 'Hosting je vypnutý. Onion adresa zostáva uložená a čaká na ručné spustenie.' : 'Tor hosting je vypnutý.'
  });
  return { ok: true, ...torState };
}

function waitForTcpPort(port, timeout = 30000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const probe = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); if (Date.now() - startedAt >= timeout) resolve(false); else setTimeout(probe, 250); });
    };
    probe();
  });
}

function launchTorProcess(executable, args) {
  let resolveReady;
  let readyResolved = false;
  let logBuffer = '';
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const markReady = (value) => {
    if (readyResolved) return;
    readyResolved = true;
    resolveReady(value);
  };
  const child = spawn(executable, [...args, '--Log', 'notice stdout'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const observe = (chunk) => {
    logBuffer = `${logBuffer}${String(chunk)}`.slice(-4096);
    if (/Bootstrapped 100% \(done\)/i.test(logBuffer)) markReady(true);
  };
  child.stdout?.on('data', observe);
  child.stderr?.on('data', (chunk) => { console.error('Tor stderr:', String(chunk)); observe(chunk); });
  child.once('error', () => markReady(false));
  child.once('exit', () => markReady(false));
  return { child, ready };
}

function waitForTorHostingReady(hostnamePath, readyPromise, signal, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let bootstrapped = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(true);
    };
    const onAbort = () => {
      const error = new Error('Tor hosting was stopped while starting.');
      error.name = 'AbortError';
      finish(error);
    };
    const check = () => {
      if (signal.aborted) return onAbort();
      if (bootstrapped && require('node:fs').existsSync(hostnamePath)) finish();
    };
    const poll = setInterval(check, 250);
    const timeout = setTimeout(() => finish(new Error('Tor did not bootstrap and create an onion address in time.')), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    readyPromise.then((ready) => {
      if (!ready) return finish(new Error('Tor exited before completing bootstrap.'));
      bootstrapped = true;
      check();
    }, finish);
    check();
  });
}

async function enableTorProxyInternal() {
  const fs = require('node:fs');
  const executable = torExecutable();
  if (!executable) {
    const message = 'Pribalený Tor sa nenašiel.';
    publishTorState({ proxyEnabled: false, proxyStatus: 'error', proxyMessage: message });
    return { ok: false, ...torState, message };
  }
  if (torState.proxyEnabled) return { ok: true, ...torState };
  const generation = ++torProxyGeneration;
  publishTorState({ proxyStatus: 'connecting', proxyEnabled: false, proxyMessage: 'Tor sa pripája...' });
  if (!torProxyProcess || torProxyProcess.exitCode !== null || torProxyProcess.signalCode !== null) {
    const proxyDir = path.join(writableDataPath, 'tor-proxy');
    const dataDir = path.join(proxyDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    try { fs.unlinkSync(path.join(dataDir, 'lock')); } catch {}
    const configPath = path.join(proxyDir, 'torrc');
    const torDataPath = dataDir.replace(/\\/g, '/');
    fs.writeFileSync(configPath, `DataDirectory "${torDataPath}"\nSocksPort 127.0.0.1:9150\n`, 'utf8');
    const launched = launchTorProcess(executable, ['-f', configPath]);
    torProxyProcess = launched.child;
    torProxyReadyPromise = launched.ready;
    const proxyChild = launched.child;
    const handleProxyExit = (code, error) => {
      if (torProxyProcess !== proxyChild) return;
      torProxyProcess = null;
      const message = error ? `Tor proxy sa nespustila: ${error.message}` : `Tor proxy skončila s kódom ${code}.`;
      if (torState.proxyEnabled) {
        session.defaultSession.setProxy({ mode: 'direct' })
          .then(() => session.defaultSession.closeAllConnections())
          .catch(() => {});
      }
      publishTorState({ proxyEnabled: false, proxyStatus: 'error', proxyMessage: message });
    };
    proxyChild.once('error', (error) => handleProxyExit(null, error));
    proxyChild.once('exit', (code) => handleProxyExit(code));
  }
  const proxyChild = torProxyProcess;
  const bootstrapped = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 180000);
    torProxyReadyPromise.then((ready) => { clearTimeout(timeout); resolve(ready); }, () => { clearTimeout(timeout); resolve(false); });
  });
  if (generation !== torProxyGeneration) return { ok: false, cancelled: true, ...torState };
  if (!bootstrapped || !proxyChild || torProxyProcess !== proxyChild) {
    await stopTorProxyProcess(false);
    const message = 'Tor sa nepripojil do siete. Skontroluj pripojenie a skús to znova.';
    publishTorState({ proxyEnabled: false, proxyStatus: 'error', proxyMessage: message });
    return { ok: false, ...torState, message };
  }
  const proxyReady = await waitForTcpPort(9150, 5000);
  if (generation !== torProxyGeneration) return { ok: false, cancelled: true, ...torState };
  if (!proxyReady || torProxyProcess !== proxyChild) {
    await stopTorProxyProcess(false);
    const message = 'Tor SOCKS proxy sa nespustila.';
    publishTorState({ proxyEnabled: false, proxyStatus: 'error', proxyMessage: message });
    return { ok: false, ...torState, message };
  }
  if (generation !== torProxyGeneration) return { ok: false, cancelled: true, ...torState };
  await session.defaultSession.setProxy({ proxyRules: 'socks5://127.0.0.1:9150', proxyBypassRules: '<local>' });
  await session.defaultSession.closeAllConnections();
  publishTorState({ proxyEnabled: true, proxyStatus: 'running', proxyMessage: 'Prehliadanie cez Tor je zapnuté.' });
  return { ok: true, ...torState };
}

async function enableTorProxy() {
  if (torStartPromise) return torStartPromise;
  torStartPromise = enableTorProxyInternal();
  try { return await torStartPromise; } finally { torStartPromise = null; }
}

async function disableTorProxy() {
  await session.defaultSession.setProxy({ mode: 'direct' });
  await session.defaultSession.closeAllConnections();
  await stopTorProxyProcess();
  publishTorState({ proxyEnabled: false, proxyStatus: 'stopped', proxyMessage: 'Prehliadanie cez Tor je vypnuté.' });
  return { ok: true, ...torState };
}

async function startTorHosting(folder) {
  const fs = require('node:fs');
  const requestedFolder = String(folder || '').trim();
  if (!requestedFolder) return { ok: false, message: 'Najprv vyber priečinok pre hosting.' };
  let root;
  try { root = fs.realpathSync(path.resolve(requestedFolder)); } catch { return { ok: false, message: 'Vybraný priečinok neexistuje.' }; }
  if (!fs.statSync(root).isDirectory()) return { ok: false, message: 'Vybraný priečinok neexistuje.' };
  const indexPath = resolveHostedFile(root, 'index.html');
  if (!indexPath || !fs.statSync(indexPath).isFile()) return { ok: false, message: 'Vybraný priečinok neobsahuje index.html.' };
  if (torState.status === 'running') {
    if (torState.folder === root) return { ok: true, ...torState };
    return { ok: false, message: 'Najprv zastav aktuálny hosting a potom vyber iný priečinok.' };
  }
  const executable = torExecutable();
  if (!executable) return { ok: false, message: 'Tor sa nenašiel. Nainštaluj Tor a nastav TOR_PATH.' };
  const generation = ++torHostingGeneration;
  await stopTorHostingResources();
  if (generation !== torHostingGeneration) return { ok: false, cancelled: true, ...torState };
  const controller = new AbortController();
  const { signal } = controller;
  torHostingStartController = controller;
  const hostDir = path.join(writableDataPath, 'tor-hosting');
  const serviceDir = path.join(hostDir, 'hidden-service');
  const hostingDataDir = path.join(hostDir, 'data');
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
  torState.requestCount = 0;
  torState.lastRequest = '';
  try {
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.mkdirSync(hostingDataDir, { recursive: true });
    try { fs.unlinkSync(path.join(hostingDataDir, 'lock')); } catch {}
    torServer = http.createServer((request, response) => {
      let requested;
      try { requested = decodeURIComponent((request.url || '/').split('?')[0]); } catch { response.writeHead(400); response.end('Bad request'); return; }
      if (!['GET', 'HEAD'].includes(request.method || '')) {
        response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        response.end('Method not allowed');
        return;
      }
      const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
      const filePath = resolveHostedFile(root, relative);
      torState.requestCount += 1;
      torState.lastRequest = `${request.method || 'GET'} ${requested}`;
      publishTorState({ requestCount: torState.requestCount, lastRequest: torState.lastRequest });
      if (!filePath) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end('Not found'); return; }
      fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end('Not found'); return; }
        response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': stats.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        if (request.method === 'HEAD') { response.end(); return; }
        fs.createReadStream(filePath).on('error', () => { if (!response.headersSent) response.writeHead(500); response.end('Server error'); }).pipe(response);
      });
    });
    await new Promise((resolve, reject) => { torServer.once('error', reject); torServer.listen(0, '127.0.0.1', resolve); });
    const port = torServer.address().port;
    const configPath = path.join(hostDir, 'torrc');
    const torHostDataPath = hostingDataDir.replace(/\\/g, '/');
    const torServicePath = serviceDir.replace(/\\/g, '/');
    fs.writeFileSync(configPath, `DataDirectory "${torHostDataPath}"\nSocksPort 127.0.0.1:9151\nHiddenServiceDir "${torServicePath}"\nHiddenServicePort 80 127.0.0.1:${port}\n`, 'utf8');
    publishTorState({ status: 'starting', onion: '', folder: root, message: 'Tor sa pripája...' });
    const launched = launchTorProcess(executable, ['-f', configPath]);
    const hostingChild = launched.child;
    torHostingProcess = hostingChild;
    torHostingReadyPromise = launched.ready;
    const handleHostingExit = (message) => {
      if (torHostingProcess !== hostingChild) return;
      torHostingProcess = null;
      controller.abort();
      const server = torServer;
      torServer = null;
      void closeTorServer(server);
      publishTorState({ status: 'error', onion: '', folder: root, message });
    };
    hostingChild.once('error', (error) => handleHostingExit(`Tor sa nespustil: ${error.message}`));
    hostingChild.once('exit', (code) => handleHostingExit(`Tor hosting sa neočakávane zastavil (kód ${code}).`));
    const hostnamePath = path.join(serviceDir, 'hostname');
    await waitForTorHostingReady(hostnamePath, launched.ready, signal);
    if (generation !== torHostingGeneration || torHostingProcess !== hostingChild) throw new Error('Tor hosting was stopped while starting.');
    const onion = fs.readFileSync(hostnamePath, 'utf8').trim();
    if (!/^[a-z2-7]{56}\.onion$/i.test(onion)) throw new Error('Tor returned an invalid v3 onion address.');
    const address = `http://${onion}/`;
    publishTorState({ status: 'starting', onion: address, folder: root, message: 'Čakám na zverejnenie onion služby a overujem jej dostupnosť...' });
    await waitForOnionService(address, 9151, { timeoutMs: 180000, attemptTimeoutMs: 15000, retryDelayMs: 5000, signal });
    if (generation !== torHostingGeneration || torHostingProcess !== hostingChild) throw new Error('Tor hosting was stopped while starting.');
    saveTorHostingFolder(torHostingStatePath, root);
    torHostingStartController = null;
    publishTorState({ status: 'running', onion: address, folder: root, message: `Hosting je dostupný na ${address}` });
    return { ok: true, ...torState };
  } catch (error) {
    const cancelled = generation !== torHostingGeneration || (signal.aborted && torState.status === 'stopped');
    await stopTorHostingResources();
    if (cancelled) return { ok: false, cancelled: true, ...torState };
    if (signal.aborted && torState.status === 'error') return { ok: false, ...torState };
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Tor hosting sa nepodarilo spustiť alebo overiť: ${detail}`;
    publishTorState({ status: 'error', onion: '', folder: root, message });
    return { ok: false, ...torState, message };
  }
}

function startTorHosting(folder) {
  if (torHostingStartPromise) return torHostingStartPromise;
  const startPromise = startTorHostingInternal(folder);
  torHostingStartPromise = startPromise;
  return startPromise.finally(() => {
    if (torHostingStartPromise === startPromise) torHostingStartPromise = null;
  });
}

const torChatApiPrefix = '/_linsoft/chat/v1';
const torChatHostSocksPort = 9152;
const torChatClientSocksPort = 9153;

async function clearTorChatResources() {
  torChatStartController?.abort();
  torChatStartController = null;
  const child = torChatProcess;
  torChatProcess = null;
  torChatReadyPromise = Promise.resolve(false);
  const server = torChatServer;
  torChatServer = null;
  torChatSession = null;
  torChatRoom = null;
  await Promise.all([terminateTorProcess(child), closeTorServer(server)]);
}

async function stopTorChat() {
  torChatGeneration += 1;
  await clearTorChatResources();
  return { ok: true };
}

async function waitForTorChatClient(signal) {
  if (!torChatProcess || torChatProcess.exitCode !== null || torChatProcess.signalCode !== null) {
    const executable = torExecutable();
    if (!executable) throw new Error('Pribalený Tor sa nenašiel.');
    const clientDir = path.join(writableDataPath, 'tor-chat-client');
    const dataDir = path.join(clientDir, 'data');
    require('node:fs').mkdirSync(dataDir, { recursive: true });
    try { require('node:fs').unlinkSync(path.join(dataDir, 'lock')); } catch {}
    const configPath = path.join(clientDir, 'torrc');
    require('node:fs').writeFileSync(configPath, `DataDirectory "${dataDir.replace(/\\/g, '/')}"\nSocksPort 127.0.0.1:${torChatClientSocksPort}\n`, 'utf8');
    const launched = launchTorProcess(executable, ['-f', configPath]);
    torChatProcess = launched.child;
    torChatReadyPromise = launched.ready;
    const child = launched.child;
    const cleanupUnexpectedExit = () => {
      if (torChatProcess !== child) return;
      torChatProcess = null;
      torChatSession = null;
      torChatRoom = null;
      torChatStartController?.abort();
    };
    child.once('error', cleanupUnexpectedExit);
    child.once('exit', cleanupUnexpectedExit);
  }
  const child = torChatProcess;
  const ready = await Promise.race([
    torChatReadyPromise,
    new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 180000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false); }, { once: true }); })
  ]);
  if (signal.aborted || torChatProcess !== child) throw new Error('Chat connection was cancelled.');
  if (!ready) throw new Error('Tor sa nepripojil do siete.');
  if (!(await waitForTcpPort(torChatClientSocksPort, 5000))) throw new Error('Tor chat proxy sa nespustila.');
}

async function startTorChatHostInternal() {
  if (torChatSession) return { ok: false, message: 'Najprv ukonči aktívny onion chat.' };
  if (torChatProcess || torChatServer) return { ok: false, message: 'Tor chat už sa spúšťa alebo beží.' };
  const executable = torExecutable();
  if (!executable) return { ok: false, message: 'Pribalený Tor sa nenašiel.' };
  const generation = ++torChatGeneration;
  const controller = new AbortController();
  torChatStartController = controller;
  const { signal } = controller;
  const chatDir = path.join(writableDataPath, 'tor-chat');
  const dataDir = path.join(chatDir, 'data');
  const serviceDir = path.join(chatDir, 'hidden-service');
  const hostnamePath = path.join(serviceDir, 'hostname');
  const token = crypto.randomBytes(24).toString('base64url');
  torChatRoom = createTorChatRoom(token);
  try {
    require('node:fs').mkdirSync(dataDir, { recursive: true });
    require('node:fs').mkdirSync(serviceDir, { recursive: true });
    try { require('node:fs').unlinkSync(path.join(dataDir, 'lock')); } catch {}
    torChatServer = createTorChatServer(torChatRoom);
    await new Promise((resolve, reject) => { torChatServer.once('error', reject); torChatServer.listen(0, '127.0.0.1', resolve); });
    const localPort = torChatServer.address().port;
    const configPath = path.join(chatDir, 'torrc');
    require('node:fs').writeFileSync(configPath, `DataDirectory "${dataDir.replace(/\\/g, '/')}"\nSocksPort 127.0.0.1:${torChatHostSocksPort}\nHiddenServiceDir "${serviceDir.replace(/\\/g, '/')}"\nHiddenServicePort 80 127.0.0.1:${localPort}\n`, 'utf8');
    const launched = launchTorProcess(executable, ['-f', configPath]);
    const child = launched.child;
    torChatProcess = child;
    torChatReadyPromise = launched.ready;
    const handleExit = () => {
      if (torChatProcess !== child) return;
      torChatProcess = null;
      torChatSession = null;
      torChatRoom = null;
      torChatStartController?.abort();
      const server = torChatServer;
      torChatServer = null;
      void closeTorServer(server);
    };
    child.once('error', handleExit);
    child.once('exit', handleExit);
    await waitForTorHostingReady(hostnamePath, launched.ready, signal, 180000);
    if (signal.aborted || generation !== torChatGeneration || torChatProcess !== child) throw new Error('Chat host was cancelled.');
    const hostname = require('node:fs').readFileSync(hostnamePath, 'utf8').trim();
    if (!/^[a-z2-7]{56}\.onion$/i.test(hostname)) throw new Error('Tor returned an invalid onion address.');
    const onion = `http://${hostname}/`;
    const healthUrl = new URL(`${torChatApiPrefix}/health`, onion).href;
    await waitForOnionService(healthUrl, torChatHostSocksPort, {
      timeoutMs: 180000,
      attemptTimeoutMs: 15000,
      retryDelayMs: 5000,
      headers: { Authorization: `Bearer ${token}` },
      signal
    });
    if (signal.aborted || generation !== torChatGeneration || torChatProcess !== child) throw new Error('Chat host was cancelled.');
    torChatSession = { role: 'host', onion, token };
    torChatStartController = null;
    return { ok: true, onion, token };
  } catch (error) {
    const cancelled = signal.aborted || generation !== torChatGeneration;
    await clearTorChatResources();
    if (cancelled) return { ok: false, cancelled: true, message: 'Spúšťanie chatu bolo zrušené.' };
    return { ok: false, message: `Onion chat sa nepodarilo spustiť: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function startTorChatHost() {
  if (torChatStartPromise) return torChatStartPromise;
  const promise = startTorChatHostInternal();
  torChatStartPromise = promise;
  return promise.finally(() => { if (torChatStartPromise === promise) torChatStartPromise = null; });
}

function startTorChatJoin(address, token) {
  if (torChatStartPromise) return torChatStartPromise;
  const promise = joinTorChat(address, token);
  torChatStartPromise = promise;
  return promise.finally(() => { if (torChatStartPromise === promise) torChatStartPromise = null; });
}

function validTorChatInvite(address, token) {
  try {
    const url = new URL(String(address || ''));
    return url.protocol === 'http:' && /^[a-z2-7]{56}\.onion$/i.test(url.hostname) && !url.username && !url.password && /^[A-Za-z0-9_-]{32}$/.test(String(token || ''))
      ? `${url.origin}/`
      : '';
  } catch { return ''; }
}

async function joinTorChat(address, token) {
  if (torChatSession || torChatStartPromise) return { ok: false, message: 'Najprv ukonči aktívny chat.' };
  const onion = validTorChatInvite(address, token);
  if (!onion) return { ok: false, message: 'Pozvánka musí obsahovať platnú v3 onion adresu a kľúč miestnosti.' };
  const controller = new AbortController();
  const { signal } = controller;
  torChatStartController = controller;
  const generation = ++torChatGeneration;
  try {
    await waitForTorChatClient(signal);
    const healthUrl = new URL(`${torChatApiPrefix}/health`, onion).href;
    const health = await requestOnionService(healthUrl, torChatClientSocksPort, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 30000, signal });
    if (health.statusCode !== 200 || JSON.parse(health.body).ok !== true) throw new Error('Onion chat rejected the invitation.');
    if (signal.aborted || generation !== torChatGeneration || !torChatProcess) throw new Error('Chat connection was cancelled.');
    torChatSession = { role: 'guest', onion, token, clientId: crypto.randomBytes(18).toString('base64url') };
    torChatStartController = null;
    return { ok: true, onion };
  } catch (error) {
    const cancelled = signal.aborted || generation !== torChatGeneration;
    await clearTorChatResources();
    return { ok: false, cancelled, message: cancelled ? 'Pripojenie bolo zrušené.' : `K onion chatu sa nepodarilo pripojiť: ${error instanceof Error ? error.message : String(error)}` };
  }
}

ipcMain.handle('tor-status', () => torState);
ipcMain.handle('tor-chat-host-start', async (event) => {
  if (torChatSession || torChatStartPromise) return { ok: false, message: 'Najprv ukonči aktívny alebo práve spúšťaný chat.' };
  const warning = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender) || undefined, {
    type: 'warning',
    title: 'Onion chat 1:1',
    message: 'Chat bude dostupný cez Tor. Pozvánku zdieľaj iba s druhým účastníkom.',
    detail: 'Správy sú šifrované medzi aplikáciami a neukladajú sa na disk. Hostiteľ musí zostať online.',
    buttons: ['Zrušiť', 'Vytvoriť onion pozvánku'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (warning.response !== 1) return { ok: false, cancelled: true };
  return startTorChatHost();
});
ipcMain.handle('tor-chat-join', (_event, { address, token } = {}) => startTorChatJoin(address, token));
ipcMain.handle('tor-chat-stop', () => stopTorChat());
ipcMain.handle('tor-chat-poll', async (_event, afterId = 0) => {
  const after = Number(afterId);
  if (!torChatSession || !Number.isSafeInteger(after) || after < 0) return { ok: false, message: 'Onion chat nie je pripojený.' };
  if (torChatSession.role === 'host') {
    if (!torChatRoom) return { ok: false, message: 'Onion chat host sa odpojil.' };
    return { ok: true, messages: torChatRoom.messages.filter((message) => message.id > after) };
  }
  try {
    const url = new URL(`${torChatApiPrefix}/messages`, torChatSession.onion);
    url.searchParams.set('after', String(after));
    const response = await requestOnionService(url.href, torChatClientSocksPort, {
      headers: { Authorization: `Bearer ${torChatSession.token}`, 'X-Linsoft-Chat-Client': torChatSession.clientId },
      timeoutMs: 15000,
      maxResponseBytes: 65536
    });
    const result = JSON.parse(response.body);
    if (response.statusCode !== 200 || !result.ok || !Array.isArray(result.messages)) throw new Error(result.message || `HTTP ${response.statusCode}`);
    return { ok: true, messages: result.messages };
  } catch (error) {
    return { ok: false, message: `Spojenie s onion chatom zlyhalo: ${error instanceof Error ? error.message : String(error)}` };
  }
});
ipcMain.handle('tor-chat-send', async (_event, envelope) => {
  if (!torChatSession || !isValidTorChatEnvelope(envelope)) return { ok: false, message: 'Chat nie je pripojený alebo správa nie je platná.' };
  if (torChatSession.role === 'host') {
    const message = enqueueTorChatMessage(torChatRoom, 'host', envelope);
    return message ? { ok: true, id: message.id } : { ok: false, message: 'Chat sa ukončil.' };
  }
  try {
    const url = new URL(`${torChatApiPrefix}/messages`, torChatSession.onion);
    const response = await requestOnionService(url.href, torChatClientSocksPort, {
      method: 'POST',
      headers: { Authorization: `Bearer ${torChatSession.token}`, 'X-Linsoft-Chat-Client': torChatSession.clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      timeoutMs: 30000,
      maxResponseBytes: 65536
    });
    const result = JSON.parse(response.body);
    if (response.statusCode !== 201 || !result.ok) throw new Error(result.message || `HTTP ${response.statusCode}`);
    return { ok: true, id: result.id };
  } catch (error) {
    return { ok: false, message: `Správu sa nepodarilo odoslať cez Tor: ${error instanceof Error ? error.message : String(error)}` };
  }
});
ipcMain.handle('tor-chat-host-start', async (event) => {
  if (torChatSession || torChatStartPromise) return { ok: false, message: 'Najprv ukonči aktívny alebo práve spúšťaný chat.' };
  const warning = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender) || undefined, {
    type: 'warning',
    title: 'Onion chat 1:1',
    message: 'Chat bude dostupný cez Tor. Pozvánku zdieľaj iba s druhým účastníkom.',
    detail: 'Správy sú šifrované medzi aplikáciami a neukladajú sa na disk. Hostiteľ musí zostať online.',
    buttons: ['Zrušiť', 'Vytvoriť onion pozvánku'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (warning.response !== 1) return { ok: false, cancelled: true };
  return startTorChatHost();
});
ipcMain.handle('tor-chat-join', (_event, { address, token } = {}) => joinTorChat(address, token));
ipcMain.handle('tor-chat-stop', () => stopTorChat());
ipcMain.handle('tor-chat-poll', async (_event, afterId = 0) => {
  const after = Number(afterId);
  if (!torChatSession || !Number.isSafeInteger(after) || after < 0) return { ok: false, message: 'Onion chat nie je pripojený.' };
  if (torChatSession.role === 'host') {
    if (!torChatRoom) return { ok: false, message: 'Onion chat host sa odpojil.' };
    return { ok: true, messages: torChatRoom.messages.filter((message) => message.id > after) };
  }
  try {
    const url = new URL(`${torChatApiPrefix}/messages`, torChatSession.onion);
    url.searchParams.set('after', String(after));
    const response = await requestOnionService(url.href, torChatClientSocksPort, {
      headers: { Authorization: `Bearer ${torChatSession.token}`, 'X-Linsoft-Chat-Client': torChatSession.clientId },
      timeoutMs: 15000,
      maxResponseBytes: 65536
    });
    const result = JSON.parse(response.body);
    if (response.statusCode !== 200 || !result.ok || !Array.isArray(result.messages)) throw new Error(result.message || `HTTP ${response.statusCode}`);
    return { ok: true, messages: result.messages };
  } catch (error) {
    return { ok: false, message: `Spojenie s onion chatom zlyhalo: ${error instanceof Error ? error.message : String(error)}` };
  }
});
ipcMain.handle('tor-chat-send', async (_event, envelope) => {
  if (!torChatSession || !isValidTorChatEnvelope(envelope)) return { ok: false, message: 'Chat nie je pripojený alebo správa nie je platná.' };
  if (torChatSession.role === 'host') {
    const message = enqueueTorChatMessage(torChatRoom, 'host', envelope);
    return message ? { ok: true, id: message.id } : { ok: false, message: 'Chat sa ukončil.' };
  }
  try {
    const url = new URL(`${torChatApiPrefix}/messages`, torChatSession.onion);
    const response = await requestOnionService(url.href, torChatClientSocksPort, {
      method: 'POST',
      headers: { Authorization: `Bearer ${torChatSession.token}`, 'X-Linsoft-Chat-Client': torChatSession.clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      timeoutMs: 30000,
      maxResponseBytes: 65536
    });
    const result = JSON.parse(response.body);
    if (response.statusCode !== 201 || !result.ok) throw new Error(result.message || `HTTP ${response.statusCode}`);
    return { ok: true, id: result.id };
  } catch (error) {
    return { ok: false, message: `Správu sa nepodarilo odoslať cez Tor: ${error instanceof Error ? error.message : String(error)}` };
  }
});
ipcMain.handle('tor-default-folder', () => {
  const fs = require('node:fs');
  const folder = path.join(writableDataPath, 'Tor Hosting');
  fs.mkdirSync(folder, { recursive: true });
  const indexPath = path.join(folder, 'index.html');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '<!doctype html><html lang="sk"><meta charset="utf-8"><title>Linsoft Tor Hosting</title><h1>Linsoft Tor Hosting funguje</h1><p>Toto je tvoja predvolená onion stránka.</p></html>', 'utf8');
  return folder;
});
ipcMain.handle('tor-select-folder', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || undefined, { properties: ['openDirectory'], title: 'Vybrať priečinok pre Tor hosting' });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('tor-start-hosting', async (event, folder) => {
  const root = path.resolve(String(folder || ''));
  const warning = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender) || undefined, {
    type: 'warning',
    title: 'Verejný Tor hosting',
    message: 'Obsah vybraného priečinka bude dostupný každému, kto pozná onion adresu.',
    detail: `Zdieľaný priečinok: ${root}\n\nNezdieľaj priečinky s osobnými alebo citlivými súbormi.`,
    buttons: ['Zrušiť', 'Zverejniť web'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (warning.response !== 1) return { ok: false, cancelled: true, ...torState };
  return startTorHosting(folder);
});
ipcMain.handle('tor-stop-hosting', () => stopTorHosting());
ipcMain.handle('tor-enable-proxy', () => enableTorProxy());
ipcMain.handle('tor-disable-proxy', () => disableTorProxy());
ipcMain.handle('set-manual-proxy', async (_event, { protocol = 'socks5', host = '', port = '' } = {}) => {
  const normalizedHost = String(host).trim();
  const normalizedPort = Number(port);
  const normalizedProtocol = protocol === 'socks4' ? 'socks4' : 'socks5';
  if (normalizedProtocol === 'socks5' && normalizedHost === '127.0.0.1' && normalizedPort === 9150) return enableTorProxy();
  if (!normalizedHost && !port) { await session.defaultSession.setProxy({ mode: 'direct' }); await session.defaultSession.closeAllConnections(); await stopTorProxyProcess(); publishTorState({ proxyEnabled: false, proxyStatus: 'stopped', proxyMessage: 'Proxy je vypnutá.' }); return { ok: true, ...torState }; }
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(normalizedHost) || !Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) return { ok: false, message: 'Zadaj platného hostiteľa a port 1-65535.' };
  await stopTorProxyProcess();
  await session.defaultSession.setProxy({ proxyRules: `${normalizedProtocol}://${normalizedHost}:${normalizedPort}`, proxyBypassRules: '<local>' });
  await session.defaultSession.closeAllConnections();
  publishTorState({ proxyEnabled: true, proxyStatus: 'manual', proxyMessage: `Manuálna ${normalizedProtocol.toUpperCase()} proxy je zapnutá: ${normalizedHost}:${normalizedPort}` });
  return { ok: true, ...torState };
});
ipcMain.on('open-browser-window', (_event, url) => { if (!supportedWebUrl(url)) return; if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); dispatchExternalUrl(mainWindow, url); } else if (hasLock) createWindow(url); });
ipcMain.on('open-detached-window', (_event, url) => { if (hasLock) createWindow(url || 'linsoft://start'); });
ipcMain.on('open-guest-window', () => { if (hasLock) createWindow('linsoft://start', { guest: true }); });
function nativeTabsForEvent(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window?.__nativeTabsEnabled ? window.__nativeTabs : null;
}
ipcMain.handle('native-tabs-enabled', (event) => BrowserWindow.fromWebContents(event.sender)?.__nativeTabsEnabled === true);
ipcMain.handle('spellchecker-languages', (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  const spellSession = ownerWindow?.webContents.session || event.sender.session;
  return { available: spellSession.availableSpellCheckerLanguages || [], selected: browserPreferences.spellcheckLanguages };
});
ipcMain.on('native-tab-layout', (event, bounds) => {
  const manager = nativeTabsForEvent(event);
  if (!manager || !bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
  manager.setBounds({ x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) });
});
ipcMain.handle('native-tab-load', (event, { tabId, url } = {}) => {
  const manager = nativeTabsForEvent(event);
  if (!manager || !Number.isInteger(tabId) || !supportedWebUrl(url)) return { ok: false };
  manager.load(tabId, url);
  manager.activate(tabId);
  return { ok: true };
});
ipcMain.handle('native-tab-activate', (event, tabId) => ({ ok: nativeTabsForEvent(event)?.activate(tabId) === true }));
ipcMain.handle('native-tab-deactivate', (event) => { nativeTabsForEvent(event)?.deactivate(); return { ok: true }; });
ipcMain.handle('native-tab-destroy', (event, tabId) => { nativeTabsForEvent(event)?.destroy(tabId); return { ok: true }; });
ipcMain.handle('native-tab-command', async (event, { tabId, command, value, fromContextMenu } = {}) => {
  const view = nativeTabsForEvent(event)?.views.get(tabId);
  if (!view) return { ok: false };
  const contents = view.webContents;
  if (command === 'reload') contents.reload();
  else if (command === 'back' && contents.canGoBack()) contents.goBack();
  else if (command === 'forward' && contents.canGoForward()) contents.goForward();
  else if (command === 'zoom' && Number.isFinite(value)) contents.setZoomFactor(value);
  else if (command === 'paste' && fromContextMenu) {
    if (!(await pasteAtContextPoint(contents, event.sender.__lastContextPoint))) {
      const text = String(clipboard.readText() || '');
      if (!text) return { ok: false, message: 'Schránka je prázdna. Najprv skopíruj text.' };
      contents.focus?.();
      if (typeof contents.paste === 'function') contents.paste();
      else if (typeof contents.insertText === 'function') await contents.insertText(text);
      else if (typeof contents.sendInputEvent === 'function') {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      } else if (typeof contents.paste === 'function') contents.paste();
      else return { ok: false };
    }
  }
  else if (['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'].includes(command) && typeof contents[command] === 'function') contents[command]();
  else return { ok: false };
  return { ok: true };
});
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
  configureCertificateErrorHandling(session.defaultSession);
  session.defaultSession.on('will-attach-webview', (event, webPreferences, params) => {
    if (!supportedWebUrl(params.src) && !isSafeLocalHtmlUrl(params.src)) {
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
      if (input.type === 'keyDown' && key === 'f' && !input.control && !input.meta && !input.alt && /youtube\.com|youtu\.be/i.test(contents.getURL?.() || '')) {
        inputEvent.preventDefault();
        const parent = BrowserWindow.fromWebContents(contents.hostWebContents);
        if (parent && !parent.isDestroyed()) { const fullscreen = !parent.isFullScreen(); parent.setFullScreen(fullscreen); parent.webContents.send('webview-fullscreen', fullscreen); }
        return;
      }
      if (input.type === 'mouseDown' && ['left', 'right', 'middle'].includes(input.button)) {
        contents.hostWebContents?.send('dismiss-webview-overlay');
        if (input.button === 'left') return;
      }
      if (input.type === 'mouseDown' && (input.button === 'back' || input.button === 'forward')) {
        inputEvent.preventDefault();
        contents.hostWebContents?.send('browser-shortcut', { key: input.button === 'back' ? 'arrowleft' : 'arrowright', shift: false });
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
      if (contents.hostWebContents) contents.hostWebContents.__lastContextWebContents = contents;
      if (contents.hostWebContents) contents.hostWebContents.__lastContextPoint = { x: params.x || 0, y: params.y || 0 };
      const menuData = { x: params.x || 0, y: params.y || 0, pageURL: params.pageURL || contents.getURL(), selectionText: params.selectionText || '', linkURL: params.linkURL || '', srcURL: params.srcURL || '', isEditable: Boolean(params.isEditable), mediaType: params.mediaType || '' };
      const hostWindow = BrowserWindow.fromWebContents(contents.hostWebContents);
      if (hostWindow && showMouseEditContextMenu(hostWindow, contents, params, menuData)) return;
      contents.hostWebContents?.send('webview-context-menu', menuData);
    });
    contents.setUserAgent(browserUserAgent);
    contents.on('render-process-gone', (_event, details) => { contents.hostWebContents?.send('webview-process-gone', { reason: details.reason }); });
    contents.on('enter-html-full-screen', () => { const parent = BrowserWindow.fromWebContents(contents.hostWebContents); if (parent && !parent.isDestroyed()) { parent.setFullScreen(true); parent.webContents.send('webview-fullscreen', true); } });
    contents.on('leave-html-full-screen', () => { const parent = BrowserWindow.fromWebContents(contents.hostWebContents); if (parent && !parent.isDestroyed()) { parent.setFullScreen(false); parent.webContents.send('webview-fullscreen', false); } });
    contents.on('will-navigate', (navigationEvent, url) => { if (!supportedNavigationUrl(url)) navigationEvent.preventDefault(); });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!supportedWebUrl(url)) return { action: 'deny' };
      contents.hostWebContents?.send(disposition === 'new-window' ? 'open-link-in-window' : 'open-link-in-tab', url);
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
  flushAdBlockLearning();
  if (torShutdownPromise) { event.preventDefault(); return; }
  if (torHostingProcess || torProxyProcess || torChatProcess || torHostingStartPromise || torStartPromise || torChatStartPromise) {
    event.preventDefault();
    torShutdownPromise = Promise.allSettled([stopTorHosting(), disableTorProxy(), stopTorChat()]).finally(() => {
      torShutdownPromise = null;
      app.quit();
    });
    return;
  }
  if (!browserPreferences.clearExit || clearingExitData) return;
  event.preventDefault();
  clearingExitData = true;
    try {
    await session.defaultSession.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] });
  } finally {
    app.quit();
  }
});
