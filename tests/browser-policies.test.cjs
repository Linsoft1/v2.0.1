const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const {
  canAutoCheckForUpdates,
  formatUpdateFailure,
  getPermissionDecision,
  getStorageTypesToClearOnExit,
  getUpdateStatus,
  isSafeLocalDocumentUrl,
  isSafeLocalHtmlUrl,
  isSafeLocalPdfUrl,
  isSafeWebUrl,
  linsoftSearchQueryFromUrl,
  linsoftSearchInitializationScript,
  normalizePermissionOrigin
} = require('../lib/browser-policies.cjs');
const { createPermissionCheckHandler, createPermissionRequestHandler, mediaTypesFromDetails } = require('../lib/permission-handlers.cjs');
const { checkDebianUpdate, getDebianUpdateStatus } = require('../lib/debian-updates.cjs');

test('update status distinguishes latest and available versions', () => {
  assert.deepEqual(getUpdateStatus('2.0.11', { version: '2.0.11' }), { status: 'latest', version: '2.0.11' });
  assert.deepEqual(getUpdateStatus('2.0.11', { version: '2.0.12' }), { status: 'available', version: '2.0.12' });
  assert.deepEqual(getUpdateStatus('2.0.11', {}), { status: 'latest', version: '2.0.11' });
});

test('update errors are localized and bounded', () => {
  assert.equal(formatUpdateFailure(new Error('Unable to find latest version on GitHub')).status, 'unavailable');
  const longError = formatUpdateFailure(new Error(`HTTP failure ${'header '.repeat(80)}`));
  assert.equal(longError.status, 'error');
  assert.ok(longError.message.length < 100);
  assert.match(formatUpdateFailure(new Error('Network offline')).message, /Network offline/);
});

test('automatic update checks only run in eligible packaged Windows and Linux states', () => {
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'win32', enabled: true, status: 'idle' }), true);
  assert.equal(canAutoCheckForUpdates({ isPackaged: false, platform: 'win32', enabled: true, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'linux', enabled: true, status: 'idle' }), true);
  assert.equal(canAutoCheckForUpdates({ isPackaged: false, platform: 'linux', enabled: true, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'linux', enabled: false, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'darwin', enabled: true, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'win32', enabled: false, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'win32', enabled: true, status: 'downloading' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'linux', enabled: true, status: 'downloaded' }), false);
});

function debianRelease(version = '2.0.28', architecture = 'amd64') {
  const name = `Linsoft-Browser-${version}-${architecture}.deb`;
  return {
    tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [{ name, state: 'uploaded', browser_download_url: `https://github.com/Linsoft1/v2.0.1/releases/download/v${version}/${name}` }]
  };
}

test('Debian updates select a newer stable package for the current architecture', () => {
  const release = debianRelease();
  assert.deepEqual(getDebianUpdateStatus('2.0.27', release, 'x64'), {
    status: 'available', version: '2.0.28', manualInstall: true,
    downloadUrl: release.assets[0].browser_download_url
  });
  for (const version of ['2.0.28', '2.0.29', '2.1.0', '3.0.0']) {
    assert.deepEqual(getDebianUpdateStatus(version, release, 'x64'), { status: 'latest', version });
  }
  assert.equal(getDebianUpdateStatus('2.0.9', debianRelease('2.0.10'), 'x64').status, 'available');
  assert.equal(getDebianUpdateStatus('2.0.27', debianRelease('2.0.28', 'arm64'), 'arm64').status, 'available');
  assert.throws(() => getDebianUpdateStatus('2.0.27', release, 'arm64'), /architektúru/);
  assert.throws(() => getDebianUpdateStatus('2.0.27', release, 'ia32'), /architektúru/);
});

test('Debian updates reject drafts, prereleases, invalid metadata and untrusted asset URLs', () => {
  for (const change of [
    { draft: true }, { prerelease: true }, { tag_name: 'v2.0.28-beta' },
    { tag_name: 'invalid' }, { assets: [] }, { assets: null },
    { assets: [{ ...debianRelease().assets[0], browser_download_url: 'https://example.com/update.deb' }] },
    { assets: [{ ...debianRelease().assets[0], state: 'new' }] }
  ]) assert.throws(() => getDebianUpdateStatus('2.0.27', { ...debianRelease(), ...change }, 'x64'));
  assert.throws(() => getDebianUpdateStatus('invalid', debianRelease(), 'x64'));
});

test('Debian update checks request GitHub metadata with a timeout and report failures', async () => {
  const result = await checkDebianUpdate('2.0.27', 'x64', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/Linsoft1/v2.0.1/releases/latest');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => debianRelease() };
  });
  assert.equal(result.status, 'available');
  await assert.rejects(checkDebianUpdate('2.0.27', 'x64', async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(checkDebianUpdate('2.0.27', 'x64', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(checkDebianUpdate('2.0.27', 'x64', async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })), /Invalid JSON/);
});

test('Linux main-process checks publish updates, deduplicate requests and honor automatic settings', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const start = source.indexOf('function setupAutoUpdater()');
  const end = source.indexOf('/** @type {import(\'electron\').BrowserWindow | null} */', start);
  assert.ok(start !== -1 && end > start);
  let requests = 0;
  const timers = [];
  const context = vm.createContext({
    isPackagedBuild: true, isLinux: true, autoUpdater: null,
    process: { platform: 'linux', arch: 'x64' }, app: { getVersion: () => '2.0.27' },
    browserPreferences: { autoUpdateCheck: true }, updateState: { status: 'idle' },
    checkDebianUpdate, canAutoCheckForUpdates, formatUpdateFailure, getUpdateStatus,
    electronNet: { fetch: async () => { requests++; return { ok: true, json: async () => debianRelease() }; } },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    setInterval: (callback, delay) => timers.push({ callback, delay }),
    console,
    publishUpdateState: (state) => { context.updateState = state; }
  });
  vm.runInContext(source.slice(start, end), context);
  context.setupAutoUpdater();
  assert.deepEqual(timers.map(({ delay }) => delay), [8000, 6 * 60 * 60 * 1000]);
  timers[0].callback();
  const first = context.checkBrowserUpdates();
  assert.equal(first, context.checkBrowserUpdates());
  assert.equal((await first).status, 'available');
  assert.equal(requests, 1);
  assert.equal(context.updateState.manualInstall, true);
  context.browserPreferences.autoUpdateCheck = false;
  timers[1].callback();
  assert.equal(requests, 1);
  context.browserPreferences.autoUpdateCheck = true;
  timers[1].callback();
  await context.checkBrowserUpdates();
  assert.equal(requests, 2);
  context.electronNet.fetch = async () => { throw new Error('offline'); };
  context.console = { warn() {} };
  assert.equal((await context.checkBrowserUpdates()).status, 'error');
  assert.equal(context.updateState.message, 'offline');
  context.isPackagedBuild = false;
  assert.equal((await context.checkBrowserUpdates()).status, 'unavailable');
  context.isPackagedBuild = true;
  context.isLinux = false;
  context.process.platform = 'win32';
  context.autoUpdater = { checkForUpdates: async () => ({ updateInfo: { version: '2.0.28' } }) };
  assert.equal((await context.checkBrowserUpdates()).status, 'available');
  assert.equal(context.updateState.manualInstall, undefined);
  assert.equal(context.autoUpdater.autoDownload, false);
  assert.equal(context.autoUpdater.autoInstallOnAppQuit, true);
});

test('Linux update IPC opens the verified package URL without invoking the Windows installer', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('update-download'");
  const end = source.indexOf("ipcMain.handle('password-list'", start);
  assert.ok(start !== -1 && end > start);
  const handlers = new Map();
  const opened = [];
  let installed = false;
  const context = vm.createContext({
    isLinux: true, isPackagedBuild: true, process: { platform: 'linux' },
    updateState: getDebianUpdateStatus('2.0.27', debianRelease(), 'x64'),
    ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => handlers.set(name, callback) },
    shell: { openExternal: async (url) => { opened.push(url); } },
    autoUpdater: { quitAndInstall: () => { installed = true; } },
    formatUpdateFailure, console: { warn() {} }
  });
  vm.runInContext(source.slice(start, end), context);
  const result = await handlers.get('update-download')();
  assert.equal(result.ok, true);
  assert.equal(result.manualInstall, true);
  assert.deepEqual(opened, [context.updateState.downloadUrl]);
  handlers.get('update-install')();
  assert.equal(installed, false);
  context.shell.openExternal = async () => { throw new Error('Cannot open browser'); };
  assert.equal((await handlers.get('update-download')()).ok, false);
  context.updateState = { status: 'idle' };
  assert.equal((await handlers.get('update-download')()).ok, false);
  assert.equal(opened.length, 1);
});

test('Windows automatic checks run at startup and every six hours while respecting disabled settings', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const start = source.indexOf('function setupAutoUpdater()');
  const end = source.indexOf("let updateCheckPromise", start);
  const timers = [];
  let checks = 0;
  const context = vm.createContext({
    isPackagedBuild: true, process: { platform: 'win32' },
    autoUpdater: { on() {} }, browserPreferences: { autoUpdateCheck: false },
    updateState: { status: 'idle' }, canAutoCheckForUpdates,
    checkBrowserUpdates: async () => { checks++; },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    setInterval: (callback, delay) => timers.push({ callback, delay })
  });
  vm.runInContext(source.slice(start, end), context);
  context.setupAutoUpdater();
  assert.deepEqual(timers.map(({ delay }) => delay), [8000, 21600000]);
  timers[0].callback();
  timers[1].callback();
  assert.equal(checks, 0);
  context.browserPreferences.autoUpdateCheck = true;
  timers[0].callback();
  timers[1].callback();
  assert.equal(checks, 2);
  context.updateState.status = 'downloading';
  timers[1].callback();
  context.updateState.status = 'downloaded';
  timers[1].callback();
  assert.equal(checks, 2);
});

test('Windows and Debian show available updates again after dismissal on the next check', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = source.indexOf('function renderUpdateNotice(state)');
  const end = source.indexOf("updateNoticeAction.addEventListener", start);
  const dismissStart = source.indexOf("updateNoticeDismiss.addEventListener");
  const dismissEnd = source.indexOf('window.linsoftBrowser?.onUpdateState', dismissStart);
  let dismiss;
  const context = vm.createContext({
    updateNotice: {}, updateNoticeTitle: {}, updateNoticeText: {},
    updateProgress: {}, updateProgressBar: { style: {} }, updateNoticeAction: {},
    updateNoticeDismiss: { addEventListener: (_event, callback) => { dismiss = callback; } },
    sessionStorage: { getItem: () => '2.0.28', setItem: () => assert.fail('Dismissal must not suppress future checks') },
    visibleUpdateState: null
  });
  vm.runInContext(source.slice(start, end) + source.slice(dismissStart, dismissEnd), context);
  for (const manualInstall of [false, true]) {
    const state = { status: 'available', version: '2.0.28', manualInstall };
    context.renderUpdateNotice(state);
    assert.equal(context.updateNotice.hidden, false);
    dismiss();
    assert.equal(context.updateNotice.hidden, true);
    context.renderUpdateNotice({ ...state, checkedAt: Date.now() });
    assert.equal(context.updateNotice.hidden, false);
    context.renderUpdateNotice({ status: 'latest', version: '2.0.28' });
    assert.equal(context.updateNotice.hidden, true);
  }
});

test('Debian update banner offers a package without implying Windows restart installation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = source.indexOf('function renderUpdateNotice(state)');
  const end = source.indexOf("updateNoticeAction.addEventListener", start);
  assert.ok(start !== -1 && end > start);
  const context = vm.createContext({
    updateNotice: {}, updateNoticeTitle: {}, updateNoticeText: {},
    updateProgress: {}, updateProgressBar: { style: {} }, updateNoticeAction: {},
    sessionStorage: { getItem: () => null }, visibleUpdateState: null
  });
  vm.runInContext(source.slice(start, end), context);
  context.renderUpdateNotice(getDebianUpdateStatus('2.0.27', debianRelease(), 'x64'));
  assert.equal(context.updateNotice.hidden, false);
  assert.equal(context.updateNoticeAction.textContent, 'Stiahnuť .deb');
  assert.equal(context.updateNoticeAction.disabled, false);
  assert.match(context.updateNoticeText.textContent, /správcu balíkov/);
  assert.equal(context.updateProgress.hidden, true);
  context.renderUpdateNotice({ status: 'available', version: '2.0.28' });
  assert.equal(context.updateNoticeAction.textContent, 'Stiahnuť');
  context.renderUpdateNotice({ status: 'downloaded', version: '2.0.28' });
  assert.equal(context.updateNoticeAction.textContent, 'Reštartovať');
});

test('exit cleanup removes cookies and shader cache while preserving website document storage', () => {
  const storages = getStorageTypesToClearOnExit();
  assert.deepEqual(storages, ['cookies', 'shadercache']);
  for (const storage of ['filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage']) {
    assert.equal(storages.includes(storage), false, `${storage} must be preserved on exit`);
  }
});

test('permission origins accept only credential-free HTTP(S) origins', () => {
  assert.equal(normalizePermissionOrigin('https://example.com/path?q=1'), 'https://example.com');
  assert.equal(normalizePermissionOrigin('http://localhost:8080/camera'), 'http://localhost:8080');
  assert.equal(normalizePermissionOrigin('file:///tmp/page.html'), '');
  assert.equal(normalizePermissionOrigin('javascript:alert(1)'), '');
  assert.equal(normalizePermissionOrigin('https://user:pass@example.com'), '');
});

test('webview and external URLs accept only safe HTTP(S) addresses', () => {
  assert.equal(isSafeWebUrl('https://example.com/page'), true);
  assert.equal(isSafeWebUrl('http://localhost:8080'), true);
  assert.equal(isSafeWebUrl('file:///C:/page.html'), false);
  assert.equal(isSafeWebUrl('javascript:alert(1)'), false);
  assert.equal(isSafeWebUrl('https://user:pass@example.com'), false);
  assert.equal(isSafeWebUrl('https://'), false);
});

test('Linsoft Search query handoff is limited to its HTTPS search page', () => {
  assert.equal(linsoftSearchQueryFromUrl('https://linsoft.ddns.net/linsoft-search/?q=hello+world'), 'hello world');
  assert.equal(linsoftSearchQueryFromUrl('https://linsoft.ddns.net/linsoft-search/?q=%3Cscript%3E'), '<script>');
  assert.equal(linsoftSearchQueryFromUrl('https://linsoft.ddns.net/linsoft-search/?q=%20%20'), '');
  assert.equal(linsoftSearchQueryFromUrl('http://linsoft.ddns.net/linsoft-search/?q=hello'), '');
  assert.equal(linsoftSearchQueryFromUrl('https://evil.example/linsoft-search/?q=hello'), '');
  assert.equal(linsoftSearchQueryFromUrl('https://linsoft.ddns.net/other/?q=hello'), '');
});

test('search preload hides the home view before rendering and restores it when results start', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'search-page-preload.cjs'), 'utf8');
  for (const href of ['https://linsoft.ddns.net/linsoft-search/?q=hello', 'https://linsoft.ddns.net/linsoft-search/?q=timeout', 'https://linsoft.ddns.net/linsoft-search/', 'https://example.com/?q=hello']) {
    let callback;
    let timeout;
    let hidden = false;
    let removed = false;
    let disconnected = false;
    let errorReported = false;
    let style;
    const context = {
      URL, location: { href },
      document: {
        createElement: () => (style = { isConnected: false, setAttribute() {}, remove: () => { removed = true; } }),
        documentElement: { append: (element) => { element.isConnected = true; } },
        getElementById: () => ({ classList: { contains: () => hidden }, prepend() {} })
      },
      MutationObserver: class {
        constructor(fn) { callback = fn; }
        observe() {}
        disconnect() { disconnected = true; }
      },
      setTimeout: (fn) => { timeout = fn; return 1; },
      clearTimeout: () => { timeout = null; },
      console: { error: () => { errorReported = true; } }
    };
    vm.runInNewContext(source, context);
    if (!href.includes('linsoft-search/?q=')) {
      assert.equal(style, undefined);
      continue;
    }
    assert.equal(style.isConnected, true);
    assert.match(style.textContent, /#home-view.*visibility: hidden/);
    callback();
    assert.equal(removed, false);
    if (href.includes('q=timeout')) {
      timeout();
      assert.equal(errorReported, true);
    } else {
      hidden = true;
      callback();
    }
    assert.equal(removed, true);
    assert.equal(disconnected, true);
    assert.equal(timeout, null);
  }
});

test('search initialization waits for scripts, avoids duplicate native searches and reports failure', async () => {
  const url = 'https://linsoft.ddns.net/linsoft-search/?q=hello';
  for (const mode of ['delayed', 'native', 'form', 'missing', 'rejected', 'navigated']) {
    let time = 0;
    let submissions = 0;
    let hidden = mode === 'native';
    const input = { value: '' };
    const results = { value: hidden ? 'hello' : '' };
    const complete = () => { submissions += 1; hidden = true; results.value = input.value; };
    const context = {
      location: { href: mode === 'navigated' ? 'https://example.com/' : url },
      Date: { now: () => time },
      document: { getElementById: id => id === 'home-view' ? { classList: { contains: () => hidden } } : id === 'results-input' ? results : input },
      setTimeout: callback => {
        time += 100;
        if (mode === 'delayed' && time === 300) context.doSearch = complete;
        callback();
      }
    };
    if (mode === 'form') input.form = { requestSubmit: complete };
    if (mode === 'rejected') context.doSearch = () => { submissions += 1; return Promise.reject(new Error('Search offline')); };
    const script = linsoftSearchInitializationScript(url);
    if (['missing', 'rejected'].includes(mode)) await assert.rejects(vm.runInNewContext(script, context), mode === 'rejected' ? /Search offline/ : /10 seconds/);
    else assert.equal(await vm.runInNewContext(script, context), mode !== 'navigated');
    assert.equal(submissions, ['delayed', 'form', 'rejected'].includes(mode) ? 1 : 0);
  }
  assert.throws(() => linsoftSearchInitializationScript('https://example.com/?q=x'));
  assert.equal(linsoftSearchQueryFromUrl('https://linsoft.ddns.net:444/linsoft-search/?q=x'), '');
  const hostileQuery = `"); throw new Error('injected'); //`;
  const hostileUrl = `https://linsoft.ddns.net/linsoft-search/?q=${encodeURIComponent(hostileQuery)}`;
  let received;
  await vm.runInNewContext(linsoftSearchInitializationScript(hostileUrl), {
    location: { href: hostileUrl }, Date: { now: () => 0 },
    document: { getElementById: id => id === 'search-input' ? { value: '' } : id === 'results-input' ? { value: received } : { classList: { contains: () => Boolean(received) } } },
    doSearch: query => { received = query; }, setTimeout: callback => callback()
  });
  assert.equal(received, hostileQuery);
});

test('permissions are denied unless enabled globally and explicitly remembered or approved', () => {
  const request = { permission: 'media', mediaTypes: ['video'], requestingUrl: 'https://camera.example/path', preferences: { camera: true } };
  const result = getPermissionDecision(request);
  assert.equal(result.decision, 'prompt');
  assert.equal(result.origin, 'https://camera.example');
  assert.equal(getPermissionDecision({ ...request, preferences: { camera: false } }).decision, 'deny');
  assert.equal(getPermissionDecision({ ...request, mediaTypes: ['audio', 'video'], preferences: { camera: true, microphone: false } }).decision, 'deny');
  assert.equal(getPermissionDecision({ ...request, decisions: { 'https://camera.example|video': 'allow' } }).decision, 'allow');
  assert.equal(getPermissionDecision({ ...request, decisions: { 'https://camera.example|video': 'deny' } }).decision, 'deny');
});

test('new profiles allow media requests while stored global blocks remain unchanged', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = renderer.indexOf('const defaultSettings =');
  const end = renderer.indexOf('defaultSettings.learnSuggestions', start);
  assert.ok(start !== -1 && end > start);
  for (const stored of [{}, { camera: false, microphone: false }, { camera: true, microphone: false }]) {
    const context = vm.createContext({ localStorage: { getItem: () => JSON.stringify(stored) } });
    vm.runInContext(`${renderer.slice(start, end)}; globalThis.settings = settingsState;`, context);
    assert.equal(context.settings.camera, stored.camera ?? true);
    assert.equal(context.settings.microphone, stored.microphone ?? true);
    assert.equal(context.settings.webNotifications, false);
  }
});

test('settings microphone grants are temporary, audio-only and limited to the browser UI', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const start = source.indexOf('function isBrowserUiUrl');
  const end = source.indexOf('function revokeTorChatCameraGrant', start);
  assert.ok(start !== -1 && end > start);
  const grants = new Map();
  const context = vm.createContext({
    URL, path, pathToFileURL, __dirname: path.join(__dirname, '..'),
    microphoneTestGrants: grants, clearTimeout
  });
  vm.runInContext(source.slice(start, end), context);
  const appUrl = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
  const contents = { id: 42, getURL: () => `${appUrl}?nativeTabs=1`, removeListener() {} };
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', appUrl, ['audio']), false);
  grants.set(42, { approved: false, cleanup() {} });
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', appUrl, ['audio']), false);
  grants.get(42).approved = true;
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', `${appUrl}?guest=1`, ['audio']), true);
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', 'file:///', ['audio']), true);
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', appUrl, ['video']), false);
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', appUrl, ['audio', 'video']), false);
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', 'https://example.com', ['audio']), false);
  assert.equal(context.isMicrophoneTestGrant({ ...contents, getURL: () => 'https://example.com' }, 'media', 'file:///', ['audio']), false);
  context.releaseMicrophoneTest(contents);
  assert.equal(grants.size, 0);
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', appUrl, ['audio']), false);
});

test('settings microphone meter stops capture at 60 seconds and closes its audio context', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const startIndex = source.indexOf('function addMicrophoneTest(panel)');
  const endIndex = source.indexOf('function addSecuritySettings()', startIndex);
  const elements = new Map();
  for (const selector of ['[data-microphone-start]', '[data-microphone-stop]', '[data-microphone-status]', '[data-microphone-level]', '[data-microphone-device]', '[data-microphone-refresh]']) {
    elements.set(selector, { addEventListener(name, callback) { this[name] = callback; }, value: 0 });
  }
  const device = elements.get('[data-microphone-device]');
  device.value = '';
  device.options = [];
  device.replaceChildren = option => { device.options = [option]; };
  device.add = option => device.options.push(option);
  const card = { querySelector: selector => elements.get(selector), isConnected: true };
  const panel = { insertAdjacentHTML() {}, querySelector: () => card };
  let stopped = 0, closed = 0, released = 0;
  const capturedConstraints = [];
  const timers = [];
  const track = { label: 'Test microphone', stop: () => stopped++, addEventListener() {} };
  const context = vm.createContext({
    stopSettingsMicrophoneTest() {}, content: {},
    document: { addEventListener() {}, removeEventListener() {} },
    window: {
      addEventListener() {}, removeEventListener() {},
      linsoftBrowser: {
        authorizeMicrophoneTest: async () => ({ ok: true }),
        releaseMicrophoneTest: async () => { released++; }
      }
    },
    navigator: { mediaDevices: { getUserMedia: async constraints => {
      capturedConstraints.push(JSON.parse(JSON.stringify(constraints)));
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    }, enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'usb-mic', label: 'USB microphone' },
      { kind: 'videoinput', deviceId: 'camera', label: 'Camera' }
    ] } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    AudioContext: class {
      async resume() {}
      async close() { closed++; }
      createAnalyser() { return { getFloatTimeDomainData: samples => samples.fill(0.1) }; }
      createMediaStreamSource() { return { connect() {} }; }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    cancelAnimationFrame() {}, requestAnimationFrame: () => 1,
    clearTimeout() {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 1; },
    showToast: message => assert.fail(message)
  });
  vm.runInContext(source.slice(startIndex, endIndex), context);
  context.addMicrophoneTest(panel);
  await elements.get('[data-microphone-start]').click();
  assert.deepEqual(capturedConstraints[0], { audio: true, video: false });
  assert.deepEqual(device.options.map(option => option.value), ['', 'usb-mic']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60000);
  assert.ok(elements.get('[data-microphone-level]').value > 0);
  assert.match(elements.get('[data-microphone-status]').textContent, /prijíma zvuk/);
  const previousReleases = released;
  timers[0].callback();
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  assert.equal(released, previousReleases + 1);
  assert.equal(elements.get('[data-microphone-level]').value, 0);
  assert.equal(elements.get('[data-microphone-stop]').disabled, true);
  assert.match(elements.get('[data-microphone-status]').textContent, /60 sekundách/);
  device.value = 'usb-mic';
  device.change();
  await elements.get('[data-microphone-start]').click();
  assert.deepEqual(capturedConstraints[1], { audio: { deviceId: { exact: 'usb-mic' } }, video: false });
  device.value = '';
  device.change();
  assert.equal(elements.get('[data-microphone-stop]').disabled, true);
  assert.equal(stopped, 2);
});

test('settings camera grants are video-only, isolated from microphone grants and revocable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const start = source.indexOf('function isBrowserUiUrl');
  const end = source.indexOf('function revokeTorChatCameraGrant', start);
  const grants = new Map();
  const context = vm.createContext({
    URL, path, pathToFileURL, __dirname: path.join(__dirname, '..'),
    cameraTestGrants: grants, microphoneTestGrants: new Map(), clearTimeout
  });
  vm.runInContext(source.slice(start, end), context);
  const appUrl = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
  const contents = { id: 42, getURL: () => `${appUrl}?nativeTabs=1`, removeListener() {} };
  assert.equal(context.isCameraTestGrant(contents, 'media', appUrl, ['video']), false);
  grants.set(42, { approved: false, cleanup() {} });
  assert.equal(context.isCameraTestGrant(contents, 'media', appUrl, ['video']), false);
  grants.get(42).approved = true;
  assert.equal(context.isCameraTestGrant(contents, 'media', 'file:///', ['video']), true);
  assert.equal(context.isCameraTestGrant(contents, 'media', appUrl, ['audio']), false);
  assert.equal(context.isCameraTestGrant(contents, 'media', appUrl, ['audio', 'video']), false);
  assert.equal(context.isCameraTestGrant(contents, 'media', 'https://example.com', ['video']), false);
  assert.equal(context.isCameraTestGrant({ ...contents, id: 43 }, 'media', appUrl, ['video']), false);
  assert.equal(context.isCameraTestGrant({ ...contents, getURL: () => 'https://example.com' }, 'media', 'file:///', ['video']), false);
  assert.equal(context.isMicrophoneTestGrant(contents, 'media', appUrl, ['audio']), false);
  context.releaseCameraTest(contents);
  assert.equal(grants.size, 0);
  assert.equal(context.isCameraTestGrant(contents, 'media', appUrl, ['video']), false);
});

test('settings camera preview selects exact devices, cleans up and handles cancellation and missing cameras', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const startIndex = source.indexOf('function addCameraTest(panel)');
  const endIndex = source.indexOf('function addMicrophoneTest(panel)', startIndex);
  const elements = new Map();
  for (const name of ['start', 'stop', 'status', 'device', 'refresh', 'preview']) {
    elements.set(`[data-camera-${name}]`, { addEventListener(name, callback) { this[name] = callback; } });
  }
  const device = elements.get('[data-camera-device]');
  device.value = '';
  device.options = [];
  device.replaceChildren = option => { device.options = [option]; };
  device.add = option => device.options.push(option);
  const preview = elements.get('[data-camera-preview]');
  preview.play = async () => {};
  preview.pause = () => {};
  const card = { querySelector: selector => elements.get(selector), isConnected: true, closest: () => null };
  const panel = { insertAdjacentHTML() {}, querySelector: () => card };
  let stopped = 0, released = 0, permission = { ok: true }, captureError, deferredCapture;
  let notifyCaptureStarted;
  let cameraDevices = [{ kind: 'videoinput', deviceId: 'usb-camera', label: 'USB camera' }, { kind: 'audioinput', deviceId: 'mic' }];
  const constraints = [], timers = [], observers = [];
  const track = { label: 'USB camera', stop: () => stopped++, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const context = vm.createContext({
    stopSettingsCameraTest() {}, content: {},
    document: { addEventListener() {}, removeEventListener() {} },
    window: {
      addEventListener() {}, removeEventListener() {},
      linsoftBrowser: {
        authorizeCameraTest: async () => permission,
        releaseCameraTest: async () => { released++; }
      }
    },
    navigator: { mediaDevices: {
      enumerateDevices: async () => cameraDevices,
      getUserMedia: async value => {
        constraints.push(JSON.parse(JSON.stringify(value)));
        if (captureError) throw captureError;
        if (deferredCapture) {
          notifyCaptureStarted();
          return deferredCapture;
        }
        return stream;
      }
    } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} },
    clearTimeout() {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 1; },
    showToast: message => assert.fail(message)
  });
  vm.runInContext(source.slice(startIndex, endIndex), context);
  context.addCameraTest(panel);
  const start = elements.get('[data-camera-start]');
  const stop = elements.get('[data-camera-stop]');
  const status = elements.get('[data-camera-status]');
  await start.click();
  assert.deepEqual(constraints[0], { video: true, audio: false });
  assert.deepEqual(device.options.map(option => option.value), ['', 'usb-camera']);
  assert.equal(preview.srcObject, stream);
  assert.equal(preview.hidden, false);
  assert.match(status.textContent, /USB camera/);
  assert.equal(timers[0].delay, 60000);
  const previousReleases = released;
  timers[0].callback();
  assert.equal(stopped, 1);
  assert.equal(released, previousReleases + 1);
  assert.equal(preview.srcObject, null);
  assert.equal(preview.hidden, true);
  assert.match(status.textContent, /60 sekundách/);
  device.value = 'usb-camera';
  device.change();
  await start.click();
  assert.deepEqual(constraints[1], { video: { deviceId: { exact: 'usb-camera' } }, audio: false });
  panel.hidden = true;
  observers.at(-1)();
  assert.equal(stop.disabled, true);
  assert.equal(stopped, 2);
  panel.hidden = false;
  permission = { ok: false, cancelled: true };
  await start.click();
  assert.equal(constraints.length, 2);
  assert.match(status.textContent, /zrušený/);
  permission = { ok: true };
  cameraDevices = [];
  captureError = { name: 'NotFoundError', message: 'No camera' };
  await elements.get('[data-camera-refresh]').click();
  await Promise.resolve();
  assert.deepEqual(device.options.map(option => option.value), ['', 'usb-camera']);
  await start.click();
  assert.match(status.textContent, /Kamera sa nenašla/);
  assert.equal(preview.srcObject, null);
  assert.equal(start.disabled, false);
  captureError = null;
  let resolveCapture;
  deferredCapture = new Promise(resolve => { resolveCapture = resolve; });
  const captureStarted = new Promise(resolve => { notifyCaptureStarted = resolve; });
  const pending = start.click();
  await captureStarted;
  stop.click();
  resolveCapture(stream);
  await pending;
  assert.equal(stopped, 3);
  assert.equal(preview.srcObject, null);
});

test('guest permission checks do not inherit saved site grants', () => {
  const request = { permission: 'media', mediaTypes: ['video'], requestingUrl: 'https://camera.example/path', preferences: { camera: true } };
  const savedDecisions = { 'https://camera.example|video': 'allow' };
  assert.equal(getPermissionDecision({ ...request, decisions: savedDecisions }).decision, 'allow');
  assert.equal(getPermissionDecision({ ...request, decisions: {} }).decision, 'prompt');
});

test('unknown permission types fail closed', () => {
  assert.equal(getPermissionDecision({ permission: 'fullscreen', requestingUrl: 'https://example.com', preferences: {} }).decision, 'deny');
  assert.equal(getPermissionDecision({ permission: 'media', mediaTypes: ['unknown'], requestingUrl: 'https://example.com', preferences: {} }).decision, 'deny');
});

test('Electron permission check handler allows only remembered grants', () => {
  const requests = [];
  const handler = createPermissionCheckHandler((request) => {
    requests.push(request);
    return { decision: request.permission === 'media' && request.mediaTypes[0] === 'video' ? 'allow' : 'prompt' };
  });
  assert.equal(handler({}, 'media', 'https://camera.example', { mediaType: 'video' }), true);
  assert.equal(handler({}, 'notifications', 'https://camera.example', {}), false);
  assert.deepEqual(requests[0], { permission: 'media', requestingUrl: 'https://camera.example', mediaTypes: ['video'] });
  assert.deepEqual(mediaTypesFromDetails({ mediaTypes: ['audio', 'video'] }), ['audio', 'video']);
});

test('Electron permission request handler fails closed and responds once', async () => {
  const responses = [];
  const handler = createPermissionRequestHandler(async (_contents, _permission, respond) => {
    respond(true);
    throw new Error('late failure');
  });
  handler({}, 'notifications', (allowed) => responses.push(allowed), { requestingUrl: 'https://example.com' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses, [true]);

  const denied = [];
  createPermissionRequestHandler(async () => { throw new Error('request failed'); })({}, 'notifications', (allowed) => denied.push(allowed));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(denied, [false]);
});

test('local document URLs accept existing HTML and PDF files only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-doc-'));
  const htmlPath = path.join(directory, 'sample page.html');
  const pdfPath = path.join(directory, 'sample report.pdf');
  const textPath = path.join(directory, 'notes.txt');
  fs.writeFileSync(htmlPath, '<!doctype html><title>Local page</title>');
  fs.writeFileSync(pdfPath, '%PDF-1.4');
  fs.writeFileSync(textPath, 'not HTML');
  try {
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(htmlPath).href), true);
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(pdfPath).href), false);
    assert.equal(isSafeLocalPdfUrl(pathToFileURL(pdfPath).href), true);
    assert.equal(isSafeLocalDocumentUrl(pathToFileURL(pdfPath).href), true);
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(textPath).href), false);
    assert.equal(isSafeLocalDocumentUrl(pathToFileURL(textPath).href), false);
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(path.join(directory, 'missing.html')).href), false);
    assert.equal(isSafeLocalPdfUrl(pathToFileURL(path.join(directory, 'missing.pdf')).href), false);
    assert.equal(isSafeLocalHtmlUrl('https://example.com/index.html'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});