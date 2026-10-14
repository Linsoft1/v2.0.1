const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const electron = require('electron');

const appPath = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function getFreePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function removeProfile(profilePath) {
  for (let attempt = 0; attempt < 10 && fs.existsSync(profilePath); attempt += 1) {
    try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(profilePath)) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (fs.existsSync(profilePath)) throw new Error(`Temporary browser profile could not be removed: ${profilePath}`);
}

async function connectPageDebugger(debugPort, pageUrl, mainProcess = false) {
  const deadline = Date.now() + 10000;
  let target;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = response.ok ? await response.json() : [];
    target = targets.find((item) => (mainProcess ? item.type === 'node' : ['page', 'webview'].includes(item.type) && item.url === pageUrl) && item.webSocketDebuggerUrl);
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!target) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((response) => response.json())
      .catch(() => []);
    throw new Error(`No Electron page target found for ${pageUrl}. Targets: ${JSON.stringify(targets.map(({ type, title, url }) => ({ type, title, url })))}`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method} on ${pageUrl}: ${String(params.expression || '').slice(0, 180)}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return {
    evaluate: async (expression, userGesture = false) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Website evaluation failed');
      return result.result.value;
    },
    crash: () => { void send('Page.crash').catch(() => {}); },
    close: () => socket.close()
  };
}

async function smokeTabEngine({ nativeTabs, startUrl }) {
  const profilePath = path.join(os.tmpdir(), `linsoft-electron-smoke-${process.pid}-${crypto.randomUUID()}`);
  const debugPort = await getFreePort();
  const mainDebugPort = await getFreePort();
  const environment = {
    ...process.env,
    LINSOFT_DEV_LAUNCH: '1',
    LINSOFT_NATIVE_TABS: nativeTabs ? '1' : '0',
    LINSOFT_BROWSER_USER_DATA: profilePath
  };
  const child = spawn(electron, ['--headless', '--disable-gpu', '--use-fake-device-for-media-stream', `--inspect=${mainDebugPort}`, `--remote-debugging-port=${debugPort}`, appPath], {
    cwd: appPath,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let socket;
  let mainDebugger;

  try {
    const debugUrl = `http://127.0.0.1:${debugPort}/json/list`;
    const startupDeadline = Date.now() + 30000;
    let appTarget;
    while (Date.now() < startupDeadline) {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${stderr.slice(-1200)}`);
      try {
        const response = await fetch(debugUrl);
        const targets = response.ok ? await response.json() : [];
        appTarget = targets.find((target) => target.type === 'page' && target.url.includes('index.html') && target.webSocketDebuggerUrl);
      } catch {}
      if (appTarget) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!appTarget) throw new Error(`Electron renderer did not start: ${stderr.slice(-1200)}`);
    mainDebugger = await connectPageDebugger(mainDebugPort, 'main process', true);
    await mainDebugger.evaluate(`(() => {
      const dialog = process.mainModule.require('electron').dialog;
      const original = dialog.showMessageBox.bind(dialog);
      globalThis.smokePermissionResponses = [];
      globalThis.smokePermissionPrompts = [];
      dialog.showMessageBox = (...args) => {
        const options = args[args.length - 1];
        if (options.title === 'Test mikrofónu') return Promise.resolve({ response: globalThis.smokeMicrophoneTestResponse ?? 1 });
        if (options.title === 'Test kamery') return Promise.resolve({ response: globalThis.smokeCameraTestResponse ?? 1 });
        if (options.title !== 'Povolenie webovej stránky') return original(...args);
        smokePermissionPrompts.push(options.message);
        if (!smokePermissionResponses.length) throw new Error('Unexpected site permission prompt');
        return Promise.resolve({ response: smokePermissionResponses.shift() });
      };
      return true;
    })()`);

    socket = new WebSocket(appTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
      return result.result.value;
    }

    await send('Runtime.enable');
    const readyDeadline = Date.now() + 15000;
    let initial;
    while (Date.now() < readyDeadline) {
      initial = await evaluate(`({ ready: document.readyState, tabs: document.querySelectorAll('.managed-tab').length, api: typeof window.linsoftBrowser?.nativeTabsEnabled === 'function' })`);
      if (initial.ready === 'complete' && initial.tabs > 0 && initial.api) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (initial?.ready !== 'complete' || initial.tabs < 1 || !initial.api) throw new Error(`Unexpected initial UI state: ${JSON.stringify(initial)}`);
    if (await evaluate('window.linsoftBrowser.nativeTabsEnabled()') !== nativeTabs) throw new Error('Tab engine IPC state did not match the requested mode.');
    const linsoftServices = await evaluate(`Array.from(document.querySelectorAll('.start-favorite-open')).map(button => ({ title: button.querySelector(':scope > span:last-child')?.textContent.trim(), url: button.dataset.url }))`);
    for (const [name, url] of [
      ['Linsoft Chat', 'https://linsoft.ddns.net/linsoft-chat/'],
      ['Linsoft Office', 'https://linsoft.ddns.net/linsoft-offiece/']
    ]) {
      if (!linsoftServices.some((service) => service.title === name && service.url === url)) {
        throw new Error(`${name} is missing from the browser start-page quick links: ${JSON.stringify(linsoftServices)}`);
      }
    }
    const initialAdBlock = await evaluate(`({ enabled: settingsState.adBlock, active: document.querySelector('#adBlockButton')?.classList.contains('active') })`);
    if (initialAdBlock.enabled || initialAdBlock.active) throw new Error(`AdBlock should start disabled until manually enabled: ${JSON.stringify(initialAdBlock)}`);
    await evaluate(`document.querySelector('#adBlockButton').click()`);
    await waitFor(() => evaluate(`settingsState.adBlock && document.querySelector('#adBlockButton')?.classList.contains('active')`), true);
    await evaluate(`document.querySelector('#adBlockButton').click()`);
    await waitFor(() => evaluate(`!settingsState.adBlock && !document.querySelector('#adBlockButton')?.classList.contains('active')`), true);
    const originalWindowState = await mainDebugger.evaluate(`(() => {
      const BrowserWindow = process.mainModule.require('electron').BrowserWindow;
      const browserWindow = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
      if (!browserWindow) throw new Error('Browser window not found for drag-region test.');
      globalThis.smokeDragTestWindow = browserWindow;
      browserWindow.__smokeActualIsMaximized = browserWindow.isMaximized.bind(browserWindow);
      browserWindow.__smokeMaximized = browserWindow.__smokeActualIsMaximized();
      browserWindow.isMaximized = () => browserWindow.__smokeMaximized;
      browserWindow.maximize = () => {
        browserWindow.__smokeMaximized = true;
        browserWindow.webContents.send('window-state', { maximized: true });
      };
      browserWindow.unmaximize = () => {
        browserWindow.__smokeMaximized = false;
        browserWindow.webContents.send('window-state', { maximized: false });
      };
      return { bounds: browserWindow.getBounds(), maximized: browserWindow.isMaximized() };
    })()`);
    try {
      await waitFor(() => evaluate(`document.querySelector('#maximizeWindow')?.dataset.state`), originalWindowState.maximized ? 'maximized' : 'restored');
      await mainDebugger.evaluate('smokeDragTestWindow.maximize(); true');
      await waitFor(() => mainDebugger.evaluate('smokeDragTestWindow.isMaximized()'), true);
      await waitFor(() => evaluate(`document.querySelector('#maximizeWindow')?.dataset.state`), 'maximized');
      const dragRegionState = await evaluate(`(() => {
        const header = document.querySelector('.tabs-bar');
        const region = document.querySelector('#windowDragRegion');
        const doubleClick = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
        region.dispatchEvent(doubleClick);
        return {
          exists: Boolean(region),
          headerRegion: getComputedStyle(header).getPropertyValue('-webkit-app-region'),
          dragRegion: getComputedStyle(region).getPropertyValue('-webkit-app-region'),
          doubleClickPrevented: doubleClick.defaultPrevented
        };
      })()`);
      if (!dragRegionState.exists || dragRegionState.headerRegion !== 'no-drag' ||
          dragRegionState.dragRegion !== 'no-drag' || !dragRegionState.doubleClickPrevented ||
          await mainDebugger.evaluate('smokeDragTestWindow.isMaximized()') !== true) {
        throw new Error(`Maximized window can still be toggled by titlebar double-click: ${JSON.stringify(dragRegionState)}`);
      }
      await evaluate(`(() => {
        const button = document.querySelector('#maximizeWindow');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
        return true;
      })()`);
      await waitFor(() => mainDebugger.evaluate('smokeDragTestWindow.isMaximized()'), false);
      await waitFor(() => evaluate(`document.querySelector('#maximizeWindow')?.dataset.state`), 'restored');
      await evaluate(`document.querySelector('#maximizeWindow').click()`);
      await waitFor(() => mainDebugger.evaluate('smokeDragTestWindow.isMaximized()'), true);
      await waitFor(() => evaluate(`document.querySelector('#maximizeWindow')?.dataset.state`), 'maximized');
      await evaluate(`document.querySelector('#maximizeWindow').click()`);
      await waitFor(() => mainDebugger.evaluate('smokeDragTestWindow.isMaximized()'), false);
      await waitFor(() => evaluate(`document.querySelector('#maximizeWindow')?.dataset.state`), 'restored');
      await evaluate(`document.querySelector('#maximizeWindow').click()`);
      await waitFor(() => mainDebugger.evaluate('smokeDragTestWindow.isMaximized()'), true);
      await waitFor(() => evaluate(`document.querySelector('#maximizeWindow')?.dataset.state`), 'maximized');
      await mainDebugger.evaluate(`if (smokeDragTestWindow.isMaximized()) smokeDragTestWindow.unmaximize(); smokeDragTestWindow.setBounds({ x: 120, y: 110, width: 1100, height: 720 }); true`);
      await evaluate(`window.linsoftBrowser.moveWindow('start', 100, 100); window.linsoftBrowser.moveWindow('move', 130, 145); window.linsoftBrowser.moveWindow('end'); true`);
      await waitFor(() => mainDebugger.evaluate(`JSON.stringify(smokeDragTestWindow.getBounds())`), JSON.stringify({ x: 150, y: 155, width: 1100, height: 720 }));
    } finally {
      await mainDebugger.evaluate(`(() => {
        const actualIsMaximized = smokeDragTestWindow.__smokeActualIsMaximized;
        delete smokeDragTestWindow.isMaximized;
        delete smokeDragTestWindow.maximize;
        delete smokeDragTestWindow.unmaximize;
        delete smokeDragTestWindow.__smokeActualIsMaximized;
        delete smokeDragTestWindow.__smokeMaximized;
        if (actualIsMaximized()) smokeDragTestWindow.unmaximize();
        smokeDragTestWindow.setBounds(${JSON.stringify(originalWindowState.bounds)});
        if (${JSON.stringify(originalWindowState.maximized)}) smokeDragTestWindow.maximize();
        return true;
      })()`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const glassChrome = await evaluate(`(() => {
      const body = getComputedStyle(document.body);
      const window = getComputedStyle(document.querySelector('.browser-window'));
      const toolbar = getComputedStyle(document.querySelector('.toolbar'));
      const content = getComputedStyle(document.querySelector('.content'));
      const activeTab = getComputedStyle(document.querySelector('.managed-tab.active'));
      const addressBar = getComputedStyle(document.querySelector('.address-bar'));
      return {
        enabled: document.body.classList.contains('glass-blue-theme'),
        bodyBackground: body.backgroundColor,
        windowBackground: window.backgroundColor,
        toolbarBackground: toolbar.backgroundImage,
        toolbarFilter: toolbar.backdropFilter,
        contentBackground: content.backgroundColor,
        activeTabBackground: activeTab.backgroundImage,
        addressBarBackground: addressBar.backgroundImage,
        inactiveTabMinimum: getComputedStyle(document.querySelector('.managed-tab')).minWidth
      };
    })()`);
    if (!glassChrome.enabled || glassChrome.bodyBackground !== 'rgba(0, 0, 0, 0)' ||
        glassChrome.windowBackground !== 'rgba(0, 0, 0, 0)' ||
        glassChrome.contentBackground !== 'rgb(18, 43, 64)' ||
        !glassChrome.toolbarBackground.includes('rgba(26, 59, 84, 0.62)') ||
        !glassChrome.toolbarFilter.includes('blur(12px)') ||
        !glassChrome.activeTabBackground.includes('rgba(76, 154, 207, 0.82)') ||
        !glassChrome.addressBarBackground.includes('rgba(5, 22, 37, 0.58)') ||
        glassChrome.inactiveTabMinimum !== '62px') {
      throw new Error(`Glass should be limited to browser chrome: ${JSON.stringify(glassChrome)}`);
    }
    const chromePolish = await evaluate(`(() => {
      const fullscreen = document.querySelector('#fullscreenWindow');
      const pin = document.querySelector('#pinWindow');
      const preview = document.querySelector('.tab-hover-preview');
      return {
        secondaryControlsMoved: getComputedStyle(fullscreen).display === 'none' && getComputedStyle(pin).display === 'none',
        menuFullscreen: Boolean(document.querySelector('#menuFullscreen')),
        menuPin: Boolean(document.querySelector('#menuPinWindow')),
        previewReady: Boolean(preview && preview.hidden)
      };
    })()`);
    if (!chromePolish.secondaryControlsMoved || !chromePolish.menuFullscreen || !chromePolish.menuPin || !chromePolish.previewReady) {
      throw new Error(`Window controls or tab preview are not available as expected: ${JSON.stringify(chromePolish)}`);
    }
    await evaluate(`(() => {
      const tab = document.querySelector('.managed-tab.active');
      tab.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      return true;
    })()`);
    await waitFor(() => evaluate(`document.querySelector('.tab-hover-preview')?.hidden`), false);
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor(() => evaluate(`document.querySelector('.tab-hover-preview')?.hidden`), true);
    await evaluate(`openSettings('appearance')`);
    const appearanceSettings = await evaluate(`(() => {
      const opacity = document.querySelector('#glassOpacitySetting');
      const blur = document.querySelector('#glassBlurSetting');
      const compact = document.querySelector('[data-setting-toggle="compact"]');
      const motion = document.querySelector('[data-setting-toggle="reduceMotion"]');
      if (!opacity || !blur || !compact || !motion) return false;
      opacity.value = '74';
      opacity.dispatchEvent(new Event('input', { bubbles: true }));
      blur.value = '18';
      blur.dispatchEvent(new Event('input', { bubbles: true }));
      const result = {
        opacity: getComputedStyle(document.body).getPropertyValue('--glass-opacity').trim(),
        blur: getComputedStyle(document.body).getPropertyValue('--glass-blur').trim(),
        compact: Boolean(compact),
        reduceMotion: Boolean(motion)
      };
      settingsState.glassOpacity = 62;
      settingsState.glassBlur = 12;
      applyTheme();
      return result;
    })()`);
    if (!appearanceSettings || appearanceSettings.opacity !== '0.74' || appearanceSettings.blur !== '18px' ||
        !appearanceSettings.compact || !appearanceSettings.reduceMotion) {
      throw new Error(`Appearance controls did not update the browser chrome: ${JSON.stringify(appearanceSettings)}`);
    }
    const tabSearchState = await evaluate(`(() => {
      const originalIds = new Set(tabs.keys());
      openNewTab();
      openNewTab();
      const createdIds = [...tabs.keys()].filter(id => !originalIds.has(id));
      searchOpenTabs();
      const input = document.querySelector('#tabSearchInput');
      input.value = 'linsoft://start';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const options = [...document.querySelectorAll('#tabSearchResults [role="option"]')];
      if (options.length < 2) return { error: 'Search did not return multiple matching cards', createdIds };
      const expectedId = Number(options[1].dataset.tabId);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      const selectedId = Number(document.querySelector('#tabSearchResults [aria-selected="true"]')?.dataset.tabId);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const result = { expectedId, selectedId, activeTabId, dialogClosed: !document.querySelector('#tabSearchDialog').open, createdIds };
      for (const id of createdIds) closeTab(id);
      return result;
    })()`);
    if (tabSearchState.error || tabSearchState.expectedId !== tabSearchState.selectedId ||
        tabSearchState.expectedId !== tabSearchState.activeTabId || !tabSearchState.dialogClosed) {
      throw new Error(`Keyboard tab search did not select the highlighted result: ${JSON.stringify(tabSearchState)}`);
    }
    const backupState = await evaluate(`(() => {
      openSettings('general');
      document.querySelector('[data-settings-section="advanced"]').click();
      const previousDownloadPath = settingsState.downloadFolderPath;
      const previousVpnProfile = settingsState.openvpnProfile;
      settingsState.downloadFolderPath = 'C:/private/downloads';
      settingsState.openvpnProfile = 'C:/private/profile.ovpn';
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = () => {};
      let backup;
      try { backup = exportBrowserBackup(); globalThis.smokeBrowserBackup = backup; }
      finally { HTMLAnchorElement.prototype.click = anchorClick; }
      const result = {
        format: backup.format,
        version: backup.version,
        hasBookmarks: Array.isArray(backup.bookmarks),
        hasSettings: Boolean(backup.settings),
        excludesLocalPaths: !Object.hasOwn(backup.settings, 'downloadFolderPath') && !Object.hasOwn(backup.settings, 'openvpnProfile'),
        hasUserData: ['history', 'passwords', 'cookies'].every(key => !Object.hasOwn(backup, key))
      };
      settingsState.downloadFolderPath = previousDownloadPath;
      settingsState.openvpnProfile = previousVpnProfile;
      return result;
    })()`);
    if (backupState.format !== 'linsoft-browser-backup' || backupState.version !== 1 ||
        !backupState.hasBookmarks || !backupState.hasSettings || !backupState.excludesLocalPaths || !backupState.hasUserData) {
      throw new Error(`Browser backup contains the wrong data scope: ${JSON.stringify(backupState)}`);
    }
    const memoryWarning = await evaluate(`(() => {
      const saved = new Map(tabMeasurements);
      tabMeasurements.clear();
      tabMeasurements.set(activeTabId, { tabId: activeTabId, pid: 98765, memoryBytes: 1300 * 1048576 });
      renderTabPerformance();
      const summary = document.querySelector('#tabPerformanceSummary');
      const result = {
        warning: summary.classList.contains('performance-warning'),
        includesUsage: summary.textContent.includes('1300 MB')
      };
      tabMeasurements.clear();
      for (const [id, measurement] of saved) tabMeasurements.set(id, measurement);
      renderTabPerformance();
      return result;
    })()`);
    if (!memoryWarning.warning || !memoryWarning.includesUsage) {
      throw new Error(`High-memory browser-process usage was not surfaced: ${JSON.stringify(memoryWarning)}`);
    }
    const importBackupState = await evaluate(`(() => {
      const backup = JSON.parse(JSON.stringify(smokeBrowserBackup));
      const previousOpacity = settingsState.glassOpacity;
      const expectedOpacity = previousOpacity === 90 ? 89 : previousOpacity + 1;
      backup.settings.glassOpacity = expectedOpacity;
      globalThis.smokeOriginalConfirm = window.confirm;
      window.confirm = () => true;
      importBrowserBackup(new File([JSON.stringify(backup)], 'smoke-backup.json', { type: 'application/json' }));
      return { previousOpacity, expectedOpacity };
    })()`);
    await waitFor(() => evaluate('settingsState.glassOpacity'), importBackupState.expectedOpacity);
    await evaluate(`window.confirm = smokeOriginalConfirm; delete globalThis.smokeOriginalConfirm; delete globalThis.smokeBrowserBackup; settingsState.glassOpacity = ${importBackupState.previousOpacity}; saveSettings()`);
    const toolbarVisibility = await evaluate(`(() => {
      const toolbar = document.querySelector('.toolbar');
      toolbar.classList.remove('tools-collapsed');
      const hiddenDuplicates = ['findPageButton', 'zoomOutButton', 'zoomInButton', 'printButton', 'savePdfButton'];
      const retainedTools = ['bookmarkButton', 'adBlockButton', 'capturePageButton', 'readerModeButton', 'downloadsButton'];
      const result = {
        hiddenDuplicates: hiddenDuplicates.filter(id => getComputedStyle(document.getElementById(id)).display === 'none'),
        retainedTools: retainedTools.filter(id => {
          const button = document.getElementById(id);
          return button && !button.hidden && getComputedStyle(button).display !== 'none';
        }),
        downloadsHiddenWhenIdle: false
      };
      toolbar.classList.add('tools-collapsed');
      result.downloadsHiddenWhenIdle = getComputedStyle(document.querySelector('#downloadsButton')).display === 'none';
      return result;
    })()`);
    if (toolbarVisibility.hiddenDuplicates.join(',') !== 'findPageButton,zoomOutButton,zoomInButton,printButton,savePdfButton' ||
        toolbarVisibility.retainedTools.join(',') !== 'bookmarkButton,adBlockButton,capturePageButton,readerModeButton,downloadsButton' ||
        !toolbarVisibility.downloadsHiddenWhenIdle) {
      throw new Error(`Toolbar still shows duplicate actions or hides unique tools: ${JSON.stringify(toolbarVisibility)}`);
    }
    const downloadButtonState = await evaluate(`(() => {
      const button = document.querySelector('#downloadsButton');
      const panel = document.querySelector('#downloadPanel');
      const toolbar = document.querySelector('.toolbar');
      downloadItems.set('smoke-download-animation', {
        id: 'smoke-download-animation',
        fileName: 'smoke-download.bin',
        status: 'Sťahuje sa',
        active: true,
        startedAt: Date.now(),
        percent: 42,
        received: 42,
        total: 100
      });
      updateDownloadButton();
      renderDownloads();
      const downloadRow = document.querySelector('[data-download-id="smoke-download-animation"]');
      const activeState = {
        visible: getComputedStyle(button).display !== 'none',
        active: button.classList.contains('download-active'),
        animating: button.classList.contains('downloading') &&
          getComputedStyle(button.querySelector('.ui-icon')).animationName === 'download-arrow-bounce',
        rowClass: downloadRow.classList.contains('is-downloading'),
        fileIconAnimation: getComputedStyle(downloadRow.querySelector('.download-file-icon')).animationName,
        progressAnimation: getComputedStyle(downloadRow.querySelector('.download-item-progress i')).animationName,
        progressShineAnimation: getComputedStyle(downloadRow.querySelector('.download-item-progress i'), '::after').animationName
      };
      button.click();
      const bounds = panel.getBoundingClientRect();
      const panelState = {
        open: !panel.hidden,
        expanded: button.getAttribute('aria-expanded'),
        animation: getComputedStyle(panel).animationName,
        top: bounds.top,
        bottom: bounds.bottom,
        toolbarBottom: toolbar.getBoundingClientRect().bottom
      };
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      button.click();
      const closedByIcon = panel.hidden && button.getAttribute('aria-expanded') === 'false';
      button.click();
      const reopenedByIcon = !panel.hidden && button.getAttribute('aria-expanded') === 'true';
      document.body.click();
      downloadItems.set('smoke-download-animation', {
        id: 'smoke-download-animation',
        fileName: 'smoke-download.bin',
        status: 'Stiahnuté',
        active: false,
        percent: 100,
        justCompleted: true
      });
      renderDownloads();
      const completedRow = document.querySelector('[data-download-id="smoke-download-animation"]');
      const completionState = {
        rowClass: completedRow.classList.contains('is-complete'),
        popAnimation: getComputedStyle(completedRow.querySelector('.download-file-icon')).animationName
      };
      downloadItems.delete('smoke-download-animation');
      settingsState.downloadFolderPath = ${JSON.stringify(path.join(profilePath, 'downloads'))};
      settingsState.askDownload = false;
      saveSettings();
      const retryUrl = ${JSON.stringify(new URL('/retry-download', startUrl).href)};
      downloadItems.set('smoke-download-retry', {
        id: 'smoke-download-retry',
        fileName: 'smoke-retry.bin',
        sourceUrl: retryUrl,
        status: 'Sťahovanie zlyhalo: test',
        active: false,
        percent: 0
      });
      renderDownloads();
      const retryButton = document.querySelector('[data-download-id="smoke-download-retry"] .download-retry-icon');
      const retryState = {
        failedRow: retryButton?.closest('.download-item').classList.contains('is-failed') === true,
        visible: Boolean(retryButton),
        accessible: retryButton?.getAttribute('aria-label') === 'Znova stiahnuť smoke-retry.bin',
        icon: retryButton?.querySelector('use')?.getAttribute('href'),
        actionVisible: Boolean(document.querySelector('[data-download-id="smoke-download-retry"] .download-item-actions [data-retry-download]'))
      };
      downloadItems.delete('smoke-download-retry');
      renderDownloads();
      updateDownloadButton();
      return {
        activeState,
        panelState,
        closedByIcon,
        reopenedByIcon,
        completionState,
        retryState,
        idleButtonHidden: getComputedStyle(button).display === 'none',
        panelClosed: panel.hidden && button.getAttribute('aria-expanded') === 'false'
      };
    })()`);
    if (!downloadButtonState.activeState.visible || !downloadButtonState.activeState.active || !downloadButtonState.activeState.animating ||
        !downloadButtonState.activeState.rowClass || downloadButtonState.activeState.fileIconAnimation !== 'download-file-pulse' ||
        downloadButtonState.activeState.progressAnimation !== 'download-progress-flow' ||
        downloadButtonState.activeState.progressShineAnimation !== 'download-progress-shine' ||
        !downloadButtonState.panelState.open || downloadButtonState.panelState.expanded !== 'true' ||
        downloadButtonState.panelState.animation !== 'download-panel-in' ||
        downloadButtonState.panelState.top < downloadButtonState.panelState.toolbarBottom + 7 ||
        downloadButtonState.panelState.bottom > 900 || !downloadButtonState.closedByIcon || !downloadButtonState.reopenedByIcon ||
        !downloadButtonState.panelClosed ||
        !downloadButtonState.completionState.rowClass || downloadButtonState.completionState.popAnimation !== 'download-complete-pop' ||
        !downloadButtonState.retryState.failedRow || !downloadButtonState.retryState.visible ||
        !downloadButtonState.retryState.accessible || downloadButtonState.retryState.icon !== '#icon-rotate-cw' ||
        !downloadButtonState.retryState.actionVisible ||
        !downloadButtonState.idleButtonHidden) {
      throw new Error(`Download button animation or panel positioning failed: ${JSON.stringify(downloadButtonState)}`);
    }
    const securityPanelLayout = await evaluate(`(() => {
      window.smokeOriginalFetch = window.fetch;
      window.fetch = async () => ({ ok: true, json: async () => ({ ip: '203.0.113.10', org: 'Smoke ISP', country_name: 'Test' }) });
      document.querySelector('#securityButton').click();
      const panel = document.querySelector('#securityPanel');
      const button = document.querySelector('#securityButton');
      const bounds = panel.getBoundingClientRect();
      return {
        open: !panel.hidden,
        expanded: button.getAttribute('aria-expanded'),
        lockAnimation: getComputedStyle(button.querySelector('.ui-icon')).animationName,
        rippleAnimation: getComputedStyle(button, '::before').animationName,
        panelAnimation: getComputedStyle(panel).animationName,
        checkAnimation: getComputedStyle(panel.querySelector('.security-check')).animationName,
        top: bounds.top,
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        toolbarBottom: document.querySelector('.toolbar').getBoundingClientRect().bottom
      };
    })()`);
    if (!securityPanelLayout.open || securityPanelLayout.expanded !== 'true' ||
        securityPanelLayout.lockAnimation !== 'security-lock-pop' || securityPanelLayout.rippleAnimation !== 'security-ring' ||
        securityPanelLayout.panelAnimation !== 'security-panel-in' || securityPanelLayout.checkAnimation !== 'security-check-in' ||
        securityPanelLayout.top < securityPanelLayout.toolbarBottom + 7 ||
        securityPanelLayout.left < 0 || securityPanelLayout.right > 1280 || securityPanelLayout.bottom > 900) {
      throw new Error(`Security panel overlaps the toolbar or exceeds the viewport: ${JSON.stringify(securityPanelLayout)}`);
    }
    const securityPanelClosed = await evaluate(`document.querySelector('#securityButton').click(); ({
      expanded: document.querySelector('#securityButton').getAttribute('aria-expanded'),
      hidden: document.querySelector('#securityPanel').hidden
    })`);
    if (securityPanelClosed.expanded !== 'false' || !securityPanelClosed.hidden) {
      throw new Error(`Security button state did not reset after closing the panel: ${JSON.stringify(securityPanelClosed)}`);
    }
    await evaluate(`window.fetch = window.smokeOriginalFetch; delete window.smokeOriginalFetch`);
    await evaluate(`document.querySelector('#menuButton').click()`);
    const menuLayout = await evaluate(`(() => {
      const menu = document.querySelector('#browserMenu');
      const allRows = [...menu.querySelectorAll('button')];
      const rows = [...menu.querySelectorAll(':scope > button')].filter(row => !row.hidden);
      const visibleButtons = allRows.filter(row => !row.closest('[hidden]'));
      const zoomRow = menu.querySelector('.menu-zoom-row');
      const toolbar = document.querySelector('.toolbar');
      const menuButton = document.querySelector('#menuButton');
      const menuBounds = menu.getBoundingClientRect();
      return {
        open: !menu.hidden,
        visibleRowIds: rows.map(row => row.id),
        visibleButtonIds: visibleButtons.map(row => row.id),
        hiddenExtraRows: allRows.filter(row => row.closest('[hidden]')).length,
        rowsHaveIconsAndLabels: rows.every(row => row.querySelector('.menu-icon') && row.querySelector('.menu-label')),
        missingIcons: rows.filter(row => !row.querySelector('.menu-icon')).map(row => row.id || row.textContent.trim()),
        missingLabels: rows.filter(row => !row.querySelector('.menu-label')).map(row => row.id || row.textContent.trim()),
        rowHeights: [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))],
        zoomControls: [...zoomRow.querySelectorAll('button')].map(button => button.id),
        zoomLevel: menu.querySelector('#menuZoomLevel').textContent,
        menuTop: menuBounds.top,
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        menuButtonBottom: menuButton.getBoundingClientRect().bottom,
        fitsViewport: menuBounds.bottom <= innerHeight,
        scrollableWhenNeeded: menu.scrollHeight <= menu.clientHeight || getComputedStyle(menu).overflowY === 'auto'
      };
    })()`);
    if (!menuLayout.open || menuLayout.visibleRowIds.join(',') !== 'menuBack,menuNewTab,menuGuestWindow,menuAppCenter,menuLinsoftChat,menuLinsoftOffice,menuLinsoftBrowserWebsite,menuHistory,menuBookmarks,menuDownloads,menuPrintPage,menuSavePagePdf,menuTranslatePage,menuFindPage,menuSettings' ||
        menuLayout.visibleButtonIds.join(',') !== 'menuBack,menuNewTab,menuGuestWindow,menuAppCenter,menuLinsoftChat,menuLinsoftOffice,menuLinsoftBrowserWebsite,menuHistory,menuBookmarks,menuDownloads,menuPrintPage,menuSavePagePdf,menuTranslatePage,menuFindPage,menuZoomOut,menuZoomIn,menuFullscreen,menuPinWindow,menuSettings' ||
        menuLayout.hiddenExtraRows === 0 || !menuLayout.rowsHaveIconsAndLabels || menuLayout.rowHeights.length !== 1 ||
        menuLayout.zoomControls.join(',') !== 'menuZoomOut,menuZoomIn,menuFullscreen,menuPinWindow' || !/^\d+ %$/.test(menuLayout.zoomLevel) ||
        menuLayout.menuTop < menuLayout.toolbarBottom + 7 || menuLayout.menuTop < menuLayout.menuButtonBottom + 7 ||
        !menuLayout.fitsViewport || !menuLayout.scrollableWhenNeeded) {
      throw new Error(`Browser menu rows are not evenly aligned: ${JSON.stringify(menuLayout)}`);
    }
    await evaluate(`document.querySelector('#menuButton').click()`);

    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(startUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke One');
    const expectedFavicon = new URL('/favicon.svg', startUrl).href;
    await waitFor(() => evaluate(`tabs.get(activeTabId)?.icon`), expectedFavicon);
    await waitFor(() => evaluate(`document.querySelector('.managed-tab.active .tab-favicon')?.naturalWidth > 0`), true);
    const displayedFavicon = await evaluate(`(() => {
      const image = document.querySelector('.managed-tab.active .tab-favicon');
      return { src: image?.src, visible: image?.hidden === false, loaded: image?.naturalWidth > 0 };
    })()`);
    if (displayedFavicon.src !== expectedFavicon || !displayedFavicon.visible || !displayedFavicon.loaded) {
      const iconDebug = await evaluate(`({
        stored: tabs.get(activeTabId)?.icon,
        source: document.querySelector('.managed-tab.active .tab-favicon')?.getAttribute('src'),
        hidden: document.querySelector('.managed-tab.active .tab-favicon')?.hidden
      })`);
      throw new Error(`Tab is not displaying the website's original favicon: ${JSON.stringify({ displayedFavicon, iconDebug })}`);
    }
    await waitFor(() => evaluate(`JSON.parse(localStorage.getItem('linsoft-history') || '[]').find(item => item.url === ${JSON.stringify(startUrl)})?.favicon`), expectedFavicon);
    await evaluate(`(() => {
      tabs.get(activeTabId).icon = 'https://www.youtube.com/favicon.ico';
      const tab = document.querySelector('.managed-tab.active');
      tab.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    })()`);
    await waitFor(() => evaluate(`document.querySelector('.tab-hover-preview')?.hidden`), false);
    const previewFavicon = await evaluate(`(() => ({
      actual: document.querySelector('.managed-tab.active .tab-favicon')?.currentSrc,
      preview: document.querySelector('.tab-hover-preview-icon img')?.currentSrc,
      previewVisible: document.querySelector('.tab-hover-preview-icon img')?.hidden === false
    }))()`);
    if (!previewFavicon.previewVisible || previewFavicon.preview !== previewFavicon.actual) {
      throw new Error(`Tab hover preview did not reuse the visible tab favicon: ${JSON.stringify(previewFavicon)}`);
    }
    await evaluate(`(() => {
      tabs.get(activeTabId).icon = 'https://www.youtube.com/favicon.ico';
      startPage();
      document.querySelector('.managed-tab.active').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    })()`);
    await waitFor(() => evaluate(`document.querySelector('.tab-hover-preview')?.hidden`), true);
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor(() => evaluate(`document.querySelector('.tab-hover-preview')?.hidden`), false);
    const startPreviewIcon = await evaluate(`(() => {
      const tabIcon = document.querySelector('.managed-tab.active .tab-logo');
      const previewIcon = document.querySelector('.tab-hover-preview-icon');
      return {
        staleTabIcon: tabs.get(activeTabId)?.icon || '',
        tabBrand: getComputedStyle(tabIcon).backgroundImage,
        previewBrand: previewIcon.style.backgroundImage,
        previewFaviconVisible: previewIcon.querySelector('img').hidden === false
      };
    })()`);
    if (startPreviewIcon.staleTabIcon || startPreviewIcon.tabBrand === 'none' ||
        startPreviewIcon.previewBrand !== startPreviewIcon.tabBrand || startPreviewIcon.previewFaviconVisible) {
      throw new Error(`Start-page tab preview retained a stale website favicon: ${JSON.stringify(startPreviewIcon)}`);
    }
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor(() => evaluate(`document.querySelector('.tab-hover-preview')?.hidden`), true);
    const fullscreenUrl = new URL('/fullscreen', startUrl).href;
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(fullscreenUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Fullscreen');
    const fullscreenPage = await connectPageDebugger(debugPort, fullscreenUrl);
    try {
      const beforeFullscreen = await mainDebugger.evaluate(`(() => {
        const { BrowserWindow, screen } = process.mainModule.require('electron');
        const window = BrowserWindow.getAllWindows()[0];
        const bounds = window.getBounds();
        return { bounds, displayBounds: screen.getDisplayMatching(bounds).bounds };
      })()`);
      await fullscreenPage.evaluate(`document.querySelector('#fullscreen-target').requestFullscreen()`, true);
      await waitFor(() => fullscreenPage.evaluate(`Boolean(document.fullscreenElement && document.fullscreenElement.id === 'fullscreen-target')`), true);
      await waitFor(() => evaluate(`document.querySelector('.browser-window')?.classList.contains('webview-fullscreen')`), true);
      const fullscreenWindowState = () => mainDebugger.evaluate(`(() => {
        const { BrowserWindow, screen } = process.mainModule.require('electron');
        const window = BrowserWindow.getAllWindows()[0];
        const bounds = window.getBounds();
        const displayBounds = screen.getDisplayMatching(bounds).bounds;
        const minimum = window.getMinimumSize();
        return {
          fullScreen: window.isFullScreen(),
          bounds,
          expectedBounds: {
            x: displayBounds.x,
            y: displayBounds.y,
            width: Math.max(displayBounds.width, minimum[0]),
            height: Math.max(displayBounds.height, minimum[1])
          }
        };
      })()`);
      try {
        await waitFor(async () => {
          const state = await fullscreenWindowState();
          return !state.fullScreen && state.bounds.x === state.expectedBounds.x && state.bounds.y === state.expectedBounds.y &&
            state.bounds.width === state.expectedBounds.width && state.bounds.height === state.expectedBounds.height;
        }, true);
      } catch (error) {
        throw new Error(`${error.message} Fullscreen window state: ${JSON.stringify(await fullscreenWindowState())}. Before: ${JSON.stringify(beforeFullscreen)}`);
      }
      await mainDebugger.evaluate(`(() => {
        const window = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];
        const contents = window?.__htmlFullscreenContents;
        if (!contents) throw new Error('Electron did not track the webpage in fullscreen.');
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
        return true;
      })()`);
      await waitFor(() => fullscreenPage.evaluate(`!document.fullscreenElement`), true);
      await waitFor(() => evaluate(`!document.querySelector('.browser-window')?.classList.contains('webview-fullscreen')`), true);
      await waitFor(() => mainDebugger.evaluate(`(() => {
        const window = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];
        const current = window.getBounds();
        const previous = ${JSON.stringify(beforeFullscreen.bounds)};
        return current.x === previous.x && current.y === previous.y &&
          current.width === previous.width && current.height === previous.height;
      })()`), true);
      const maximizedWindowState = await mainDebugger.evaluate(`(() => {
        const window = smokeDragTestWindow;
        const actualIsMaximized = window.isMaximized.bind(window);
        window.__fullscreenTestActualIsMaximized = actualIsMaximized;
        window.__fullscreenTestMaximized = false;
        window.isMaximized = () => window.__fullscreenTestMaximized;
        window.maximize = () => { window.__fullscreenTestMaximized = true; };
        window.unmaximize = () => { window.__fullscreenTestMaximized = false; };
        window.__smokeMaximized = true;
        window.__fullscreenTestMaximized = true;
        window.webContents.send('window-state', { maximized: true });
        return { bounds: window.getNormalBounds(), alwaysOnTop: window.isAlwaysOnTop() };
      })()`);
      await waitFor(() => mainDebugger.evaluate('smokeDragTestWindow.isMaximized()'), true);
      await fullscreenPage.evaluate(`document.querySelector('#fullscreen-target').requestFullscreen()`, true);
      await waitFor(() => fullscreenPage.evaluate(`Boolean(document.fullscreenElement)`), true);
      try {
        await waitFor(() => mainDebugger.evaluate('Boolean(smokeDragTestWindow.__htmlFullscreenWindowState?.maximized)'), true);
      } catch (error) {
        const state = await mainDebugger.evaluate(`(() => {
          const window = smokeDragTestWindow;
          return {
            pageFullscreenTracked: Boolean(window.__htmlFullscreenContents),
            savedWindowState: window.__htmlFullscreenWindowState,
            maximized: window.isMaximized(),
            fullscreen: window.isFullScreen()
          };
        })()`);
        throw new Error(`${error.message} Maximized fullscreen state: ${JSON.stringify(state)}`);
      }
      await fullscreenPage.evaluate(`document.exitFullscreen()`);
      await waitFor(() => fullscreenPage.evaluate(`!document.fullscreenElement`), true);
      await waitFor(() => mainDebugger.evaluate(`(() => {
        const window = smokeDragTestWindow;
        const current = window.getNormalBounds();
        const previous = ${JSON.stringify(maximizedWindowState.bounds)};
        return window.isMaximized() && window.isAlwaysOnTop() === ${JSON.stringify(maximizedWindowState.alwaysOnTop)} &&
          current.x === previous.x && current.y === previous.y &&
          current.width === previous.width && current.height === previous.height;
      })()`), true);
      await mainDebugger.evaluate(`(() => {
        const window = smokeDragTestWindow;
        window.__smokeMaximized = false;
        window.__fullscreenTestMaximized = false;
        window.webContents.send('window-state', { maximized: false });
        delete window.isMaximized;
        delete window.maximize;
        delete window.unmaximize;
        delete window.__fullscreenTestActualIsMaximized;
        delete window.__fullscreenTestMaximized;
        return true;
      })()`);
    } finally {
      fullscreenPage.close();
    }
    console.log(`${nativeTabs ? 'native' : 'webview'} tabs: webpage fullscreen is exited with Escape`);
    await evaluate(`renderAddressSuggestions('smoke one')`);
    const historySuggestionFavicon = await evaluate(`document.querySelector('.address-suggestion-icon img')?.src`);
    if (historySuggestionFavicon !== expectedFavicon) {
      throw new Error(`Address suggestions did not reuse the website's original favicon: ${historySuggestionFavicon}`);
    }
    const noFaviconUrl = new URL('/no-favicon', startUrl).href;
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(noFaviconUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke No Favicon');
    const fallbackFavicon = new URL('/favicon.ico', startUrl).href;
    await waitFor(() => evaluate(`tabs.get(activeTabId)?.icon`), fallbackFavicon);
    await waitFor(() => evaluate(`document.querySelector('.managed-tab.active .tab-favicon')?.naturalWidth > 0`), true);
    const displayedFallback = await evaluate(`document.querySelector('.managed-tab.active .tab-favicon')?.src`);
    if (displayedFallback !== fallbackFavicon) throw new Error(`Default website favicon was not displayed: ${displayedFallback}`);
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(startUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`tabs.get(activeTabId)?.icon`), expectedFavicon);
    await evaluate(`document.querySelector('#readerModeButton').click()`);
    await waitFor(() => evaluate(`readerModeTabs.has(activeTabId) && document.querySelector('#readerModeButton')?.getAttribute('aria-pressed') === 'true'`), true);
    if (!nativeTabs) {
      const readerModePageState = await evaluate(`activeViewer().executeJavaScript('Boolean(document.body.classList.contains("linsoft-reader-active") && document.querySelector("#linsoft-reader-mode"))')`);
      if (readerModePageState !== true) throw new Error('Reader mode did not apply its readable page styling.');
    }
    await evaluate(`document.querySelector('#readerModeButton').click()`);
    await waitFor(() => evaluate(`!readerModeTabs.has(activeTabId) && document.querySelector('#readerModeButton')?.getAttribute('aria-pressed') === 'false'`), true);
    if (!nativeTabs) {
      const readerModeRestored = await evaluate(`activeViewer().executeJavaScript('!document.body.classList.contains("linsoft-reader-active") && !document.querySelector("#linsoft-reader-mode")')`);
      if (readerModeRestored !== true) throw new Error('Reader mode could not restore the original page styling.');
    }
    const loadingNotice = await evaluate(`(() => {
      const originalSetTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 15000) { window.smokeSlowLoadCallback = () => callback(...args); return 987654321; }
        return originalSetTimeout(callback, delay, ...args);
      };
      try {
        updateTabLoading(activeTabId, true);
        window.smokeSlowLoadCallback();
        const notice = document.querySelector('.slow-load-notice');
        const stopLabel = document.querySelector('#reloadButton').getAttribute('aria-label');
        return { notice: Boolean(notice && notice.textContent.includes('načítava dlhšie')), stopLabel };
      } finally {
        window.setTimeout = originalSetTimeout;
        delete window.smokeSlowLoadCallback;
        updateTabLoading(activeTabId, false);
      }
    })()`);
    if (!loadingNotice.notice || loadingNotice.stopLabel !== 'Zastaviť načítavanie') {
      throw new Error(`Slow page load was not clearly indicated: ${JSON.stringify(loadingNotice)}`);
    }
    const navigationFailure = await evaluate(`(() => {
      let retried = '';
      showNavigationFailure(activeTabId, 'Testovacia chyba načítania', url => { retried = url; });
      const message = document.querySelector('.navigation-error-state [role="alert"], .navigation-error-state p')?.textContent;
      document.querySelector('.navigation-error-state button').click();
      const result = { message, retried, removed: !document.querySelector('.navigation-error-state') };
      return result;
    })()`);
    if (!navigationFailure.message?.includes('Testovacia chyba načítania') ||
        navigationFailure.retried !== startUrl || !navigationFailure.removed) {
      throw new Error(`Navigation error recovery UI failed: ${JSON.stringify(navigationFailure)}`);
    }
    await evaluate(`changePageZoom(10)`);
    if (await evaluate(`siteZooms[new URL(${JSON.stringify(startUrl)}).origin]`) !== 110) {
      throw new Error('Per-site zoom was not saved for the current website.');
    }
    await evaluate(`resetPageZoom()`);
    await evaluate(`document.querySelector('#downloadsButton').click(); !document.querySelector('#downloadPanel').hidden`);
    const firstPage = await connectPageDebugger(debugPort, startUrl);
    try {
      await firstPage.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
      await waitFor(() => evaluate(`document.querySelector('#downloadPanel').hidden && document.querySelector('#downloadsButton').getAttribute('aria-expanded') === 'false'`), true);
    } finally {
      firstPage.close();
    }
    await evaluate(`savedBookmarks.push({ url: ${JSON.stringify(new URL('/two', startUrl).href)}, title: 'Počasie Bratislava' }); renderAddressSuggestions('pocasie bratislava')`);
    const suggestionUrl = await evaluate(`addressSuggestionItems[0]?.url`);
    if (suggestionUrl !== new URL('/two', startUrl).href) throw new Error('Accent-insensitive bookmark suggestion was not shown.');
    await evaluate(`addressInput.focus(); addressInput.value = 'pocasue bratislava'; addressInput.dispatchEvent(new Event('input', { bubbles: true }))`);
    await waitFor(() => evaluate(`addressSuggestionItems[0]?.typo && !addressSuggestions.hidden`), true);
    const suggestionPresentation = await evaluate(`(() => {
      const icon = document.querySelector('.address-suggestion-icon');
      const image = icon?.querySelector('img');
      const fallback = icon?.querySelector('.address-suggestion-fallback');
      const popup = getComputedStyle(addressSuggestions);
      const iconStyle = icon && getComputedStyle(icon);
      const result = {
        faviconUrl: image?.src || '',
        iconSize: iconStyle?.width || '',
        popupRadius: popup.borderRadius,
        popupBelowAnchor: addressSuggestions.getBoundingClientRect().top >= document.querySelector('#addressForm').getBoundingClientRect().bottom,
        popupInsideViewport: addressSuggestions.getBoundingClientRect().right <= window.innerWidth &&
          addressSuggestions.getBoundingClientRect().bottom <= window.innerHeight,
        fallbackReady: Boolean(fallback && fallback.hidden)
      };
      image?.dispatchEvent(new Event('error'));
      result.fallbackAfterError = Boolean(fallback && !fallback.hidden && image.hidden);
      return result;
    })()`);
    if (!suggestionPresentation.faviconUrl.includes('&sz=64') ||
        suggestionPresentation.iconSize !== '38px' ||
        suggestionPresentation.popupRadius !== '15px' ||
        !suggestionPresentation.popupBelowAnchor ||
        !suggestionPresentation.popupInsideViewport ||
        !suggestionPresentation.fallbackReady ||
        !suggestionPresentation.fallbackAfterError) {
      throw new Error(`Address suggestion icons or styling are incomplete: ${JSON.stringify(suggestionPresentation)}`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 170, deviceScaleFactor: 1, mobile: false });
    const constrainedSuggestionPosition = await evaluate(`(() => {
      positionAddressSuggestions();
      const popup = addressSuggestions.getBoundingClientRect();
      return { top: popup.top, bottom: popup.bottom, viewportHeight: window.innerHeight };
    })()`);
    if (constrainedSuggestionPosition.top < 0 || constrainedSuggestionPosition.bottom > constrainedSuggestionPosition.viewportHeight) {
      throw new Error(`Address suggestions overflow a short viewport: ${JSON.stringify(constrainedSuggestionPosition)}`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate('positionAddressSuggestions()');
    await evaluate(`document.querySelector('[data-address-suggestion="0"]').click()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Two');
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(startUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke One');
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(new URL('/two', startUrl).href)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Two');
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(startUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke One');
    await evaluate(`document.querySelector('#backButton').click()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Two');
    await evaluate(`document.querySelector('#forwardButton').click()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke One');
    if (process.env.LINSOFT_SMOKE_LIVE_SEARCH === '1') {
      await evaluate(`document.querySelector('#menuSettings').click(); document.querySelector('#searchSetting').value = 'Linsoft Search'; document.querySelector('#saveSettings').click()`);
      for (const query of ['Linsoft browser', 'Bratislava weather']) {
        const searchUrl = `https://linsoft.ddns.net/linsoft-search/?q=${encodeURIComponent(query)}`;
        await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(query)}; document.querySelector('#addressForm').requestSubmit()`);
        const searchPage = await connectPageDebugger(debugPort, searchUrl);
        try {
          await waitFor(() => searchPage.evaluate(`document.querySelector('#results-input')?.value`), query);
          await waitFor(() => searchPage.evaluate(`document.querySelector('#home-view')?.classList.contains('hidden')`), true);
          await waitFor(() => searchPage.evaluate(`document.querySelectorAll('#results-content a[href]').length > 0`), true);
        } finally {
          searchPage.close();
        }
      }
      console.log(`${nativeTabs ? 'native' : 'webview'} tabs: live Linsoft Search query and result links passed`);
    }
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(async () => (await evaluate(`document.querySelectorAll('.managed-tab').length`)) >= 2, true);

    const officeUrl = new URL('/office', startUrl).href;
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(officeUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Linsoft Office');
    const officePage = await connectPageDebugger(debugPort, officeUrl);
    try {
      for (const [name, title] of [['word', 'Linsoft Word'], ['excel', 'Linsoft Excel'], ['presentation', 'Linsoft Prezentácie']]) {
        const currentCount = await evaluate(`document.querySelectorAll('.managed-tab').length`);
        await officePage.evaluate(`document.querySelector('#open-${name}').click()`);
        const expectedUrl = new URL(`/office/${name}`, startUrl).href;
        await waitFor(async () => {
          const count = await evaluate(`document.querySelectorAll('.managed-tab').length`);
          const address = await evaluate(`document.querySelector('#addressInput')?.value`);
          return count === currentCount + 1 && address === expectedUrl;
        }, true);
        await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), title);
      }
    } finally {
      officePage.close();
    }

    const googlePopupTestUrl = new URL('/google-popup', startUrl).href;
    await evaluate(`openNewTab(${JSON.stringify(googlePopupTestUrl)})`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Google popup test');
    const googlePopupTestPage = await connectPageDebugger(debugPort, googlePopupTestUrl);
    let googlePopupTarget;
    try {
      await googlePopupTestPage.evaluate(`document.querySelector('#open-google-popup').click(); true`);
      await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = response.ok ? await response.json() : [];
        googlePopupTarget = targets.find((target) => target.type === 'page' && target.url.startsWith('https://accounts.google.com/gsi/select'));
        return Boolean(googlePopupTarget);
      }, true);
    } finally {
      googlePopupTestPage.close();
      if (googlePopupTarget) await fetch(`http://127.0.0.1:${debugPort}/json/close/${googlePopupTarget.id}`);
    }
    console.log(`${nativeTabs ? 'native' : 'webview'} tabs: Google OAuth popup opens in an isolated browser window`);

    const bareLocalUrl = startUrl.replace('http://', '');
    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(bareLocalUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke One');
    const cleanId = await evaluate(`openNewTab(${JSON.stringify(new URL('/two', startUrl).href)}); activeTabId`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Two');
    const cleanPage = await connectPageDebugger(debugPort, new URL('/two', startUrl).href);
    await cleanPage.evaluate('window.scrollTo(0, 800)');
    if (await cleanPage.evaluate('scrollY') !== 800) throw new Error('The scroll restoration fixture did not scroll.');
    cleanPage.close();
    const draftUrl = new URL('/draft', startUrl).href;
    const draftId = await evaluate(`openNewTab(${JSON.stringify(draftUrl)}); activeTabId`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Draft');
    const tabCount = await evaluate('tabs.size');
    await evaluate(`renderAddressSuggestions(${JSON.stringify(new URL('/two', startUrl).href)}); document.querySelector('[data-address-suggestion="0"]').click()`);
    if (await evaluate('activeTabId') !== cleanId || await evaluate('tabs.size') !== tabCount) throw new Error('Open-tab suggestion did not switch to the existing tab.');
    await evaluate(`selectTab(${draftId})`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Draft');
    const draftPage = await connectPageDebugger(debugPort, draftUrl);
    try {
      await draftPage.evaluate(`document.querySelector('#draft').focus(); document.querySelector('#draft').addEventListener('input', event => { globalThis.smokeTrustedInput = event.isTrusted; })`);
      await draftPage.evaluate(`document.execCommand('insertText', false, 'Unsaved draft')`);
      if (!await draftPage.evaluate(`document.documentElement.hasAttribute('data-linsoft-edited')`)) {
        const state = await draftPage.evaluate(`({ value: document.querySelector('#draft').value, trusted: globalThis.smokeTrustedInput, focused: document.activeElement?.id, protocol: location.protocol })`);
        throw new Error(`Trusted edits were not tracked by the site preload: ${JSON.stringify(state)}. ${stderr.slice(-2000)}`);
      }
      await draftPage.evaluate(`document.querySelector('#draft').value = ''`);
      await evaluate(`showTabContextMenu(100, 100, ${cleanId}); document.querySelector('[data-tab-action="protect"]').click(); openNewTab(); tabs.get(${cleanId}).inactiveSince = Date.now() - 1200001; tabs.get(${draftId}).inactiveSince = Date.now() - 1200001; suspendInactiveTabs()`);
      if (await evaluate(`tabs.get(${cleanId}).suspended === true`)) throw new Error('An explicitly protected site was suspended.');
      if (!await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).neverSuspendOrigins.includes(${JSON.stringify(new URL(startUrl).origin)})`)) throw new Error('Site protection was not persisted.');
      await evaluate(`toggleSiteSuspensionProtection(${cleanId}); suspendInactiveTabs()`);
      await waitFor(() => evaluate(`tabs.get(${cleanId}).suspended === true && !suspendingTabs.has(${cleanId}) && !suspendingTabs.has(${draftId})`), true);
      if (await evaluate(`tabs.get(${draftId}).suspended === true`)) throw new Error('The unsaved draft tab was suspended.');
      if (!await draftPage.evaluate(`document.documentElement.hasAttribute('data-linsoft-edited')`)) throw new Error('Edit protection was lost after clearing the field.');
      await evaluate(`selectTab(${cleanId})`);
      await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Two');
      if (await evaluate(`tabs.get(${cleanId}).suspended === true`)) throw new Error('Suspended tab did not restore on selection.');
      const restoredPage = await connectPageDebugger(debugPort, new URL('/two', startUrl).href);
      try { await waitFor(() => restoredPage.evaluate('Math.round(scrollY)'), 800); }
      finally { restoredPage.close(); }
    } finally {
      draftPage.close();
    }

    const activityUrl = new URL('/activity', startUrl).href;
    const activityId = await evaluate(`openNewTab(${JSON.stringify(activityUrl)}); activeTabId`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Activity');
    const activityPage = await connectPageDebugger(debugPort, activityUrl);
    try {
      await mainDebugger.evaluate('smokePermissionResponses.push(1); true');
      const capture = async (constraints) => activityPage.evaluate(`(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)});
          const kinds = stream.getTracks().map(track => track.kind).sort().join(',');
          stream.getTracks().forEach(track => track.stop());
          return kinds;
        } catch (error) { return error.name; }
      })()`);
      if (await capture({ audio: true, video: true }) !== 'audio,video') throw new Error('One-time camera and microphone permission did not enable capture.');
      if (await mainDebugger.evaluate('smokePermissionPrompts.length') !== 1) throw new Error('Camera/microphone request did not prompt once.');
      await mainDebugger.evaluate('smokePermissionResponses.push(1); true');
      if (await capture({ audio: true, video: true }) !== 'audio,video') throw new Error('Repeated one-time media request did not enable capture.');
      if (await mainDebugger.evaluate('smokePermissionPrompts.length') !== 2) throw new Error('One-time media approval was saved as a permanent grant.');
      await mainDebugger.evaluate('smokePermissionResponses.push(2); true');
      if (await capture({ video: true }) !== 'video') throw new Error('Remembered camera permission did not enable capture.');
      if (await capture({ video: true }) !== 'video') throw new Error('Remembered camera permission was not reused.');
      if (await mainDebugger.evaluate('smokePermissionPrompts.length') !== 3) throw new Error('Remembered camera capture prompted again.');
      const mediaSettingsId = await evaluate('openNewTab("linsoft://settings"); openSettings("privacy"); document.querySelector(\'[data-setting-toggle="camera"]\').click(); activeTabId');
      await evaluate(`selectTab(${activityId})`);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (await capture({ video: true }) !== 'NotAllowedError') throw new Error('Global camera block did not prevent capture immediately.');
      await evaluate(`selectTab(${mediaSettingsId}); document.querySelector('[data-setting-toggle="camera"]').click(); selectTab(${activityId})`);
      await new Promise(resolve => setTimeout(resolve, 150));
      await mainDebugger.evaluate('smokePermissionResponses.push(1); true');
      if (await capture({ audio: true }) !== 'audio') throw new Error('Microphone-only permission did not enable capture.');
      await evaluate(`selectTab(${mediaSettingsId}); document.querySelector('[data-setting-toggle="microphone"]').click(); selectTab(${activityId})`);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (await capture({ audio: true }) !== 'NotAllowedError') throw new Error('Global microphone block did not prevent capture immediately.');
      await evaluate(`selectTab(${mediaSettingsId}); document.querySelector('[data-setting-toggle="microphone"]').click(); selectTab(${activityId})`);
      await new Promise(resolve => setTimeout(resolve, 150));
      await mainDebugger.evaluate('smokePermissionResponses.push(0); true');
      if (await capture({ audio: true }) !== 'NotAllowedError') throw new Error('Declined microphone capture was allowed.');
      if (await capture({ audio: true }) !== 'NotAllowedError') throw new Error('Remembered microphone block was not reused.');
      if (await mainDebugger.evaluate('smokePermissionPrompts.length') !== 5) throw new Error('Blocked microphone prompted again.');
      await evaluate(`selectTab(${mediaSettingsId}); openSettings('privacy'); document.querySelector('[data-microphone-start]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-level]').value > 0 ? 'signal' : document.querySelector('[data-microphone-status]').textContent`), 'signal');
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-status]').textContent.includes('prijíma zvuk')`), true);
      const selectedMicrophone = await evaluate(`(() => {
        const select = document.querySelector('[data-microphone-device]');
        const option = [...select.options].find(item => item.value && item.value !== 'default' && item.value !== 'communications');
        if (!option) throw new Error('No microphone available in the settings selector');
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
        return option.textContent;
      })()`);
      if (!await evaluate(`document.querySelector('[data-microphone-stop]').disabled`)) throw new Error('Changing microphone did not stop capture');
      await evaluate(`document.querySelector('[data-microphone-start]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-level]').value > 0`), true);
      if (!await evaluate(`document.querySelector('[data-microphone-status]').textContent.includes(${JSON.stringify(selectedMicrophone)})`)) throw new Error('Microphone test did not use the selected device');
      await evaluate(`document.querySelector('[data-microphone-stop]').click()`);
      if (await evaluate(`document.querySelector('[data-microphone-level]').value`) !== 0) throw new Error('Microphone test meter was not reset.');
      const internalCapture = `navigator.mediaDevices.getUserMedia({audio:true}).then(stream => { stream.getTracks().forEach(track => track.stop()); return 'allowed'; }, error => error.name)`;
      if (await evaluate(internalCapture) !== 'NotAllowedError') throw new Error('Internal microphone grant remained after stopping test.');
      await evaluate(`document.querySelector('[data-microphone-start]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-level]').value > 0 ? 'signal' : document.querySelector('[data-microphone-status]').textContent`), 'signal');
      await evaluate(`document.querySelector('[data-settings-section="general"]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-stop]').disabled`), true);
      if (await evaluate(internalCapture) !== 'NotAllowedError') throw new Error('Internal microphone grant remained after leaving privacy panel.');
      await mainDebugger.evaluate('globalThis.smokeMicrophoneTestResponse = 0; true');
      await evaluate(`document.querySelector('[data-settings-section="privacy"]').click(); document.querySelector('[data-microphone-start]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-status]').textContent`), 'Test bol zrušený.');
      await mainDebugger.evaluate('globalThis.smokeMicrophoneTestResponse = 1; true');
      await evaluate(`document.querySelector('[data-microphone-start]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-level]').value > 0`), true);
      await evaluate(`selectTab(${cleanId})`);
      await waitFor(() => evaluate(`document.querySelector('[data-microphone-stop]').disabled`), true);
      if (await evaluate(internalCapture) !== 'NotAllowedError') throw new Error('Internal microphone grant remained after switching tabs.');
      await evaluate(`selectTab(${mediaSettingsId}); openSettings('privacy'); document.querySelector('[data-camera-start]').click()`);
      const cameraPlaying = `(() => {
        const video = document.querySelector('[data-camera-preview]');
        return !video.hidden && video.videoWidth > 0 && video.readyState >= 2;
      })()`;
      await waitFor(() => evaluate(cameraPlaying), true);
      const selectedCamera = await evaluate(`(() => {
        const select = document.querySelector('[data-camera-device]');
        const option = [...select.options].find(item => item.value);
        if (!option) throw new Error('No camera available in the settings selector');
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
        return option.textContent;
      })()`);
      if (!await evaluate(`document.querySelector('[data-camera-preview]').srcObject === null`)) throw new Error('Changing camera did not release the preview');
      await evaluate(`document.querySelector('[data-camera-start]').click()`);
      await waitFor(() => evaluate(cameraPlaying), true);
      await waitFor(() => evaluate(`document.querySelector('[data-camera-status]').textContent.includes(${JSON.stringify(selectedCamera)})`), true);
      if (!await evaluate(`document.querySelector('[data-camera-preview]').srcObject.getAudioTracks().length === 0`)) throw new Error('Camera test enabled audio');
      await evaluate(`globalThis.smokeCameraStream = document.querySelector('[data-camera-preview]').srcObject; document.querySelector('[data-camera-stop]').click()`);
      if (!await evaluate(`smokeCameraStream.getTracks().every(track => track.readyState === 'ended') && document.querySelector('[data-camera-preview]').srcObject === null`)) throw new Error('Stopping camera left capture active');
      const internalCameraCapture = `navigator.mediaDevices.getUserMedia({video:true}).then(stream => { stream.getTracks().forEach(track => track.stop()); return 'allowed'; }, error => error.name)`;
      if (await evaluate(internalCameraCapture) !== 'NotAllowedError') throw new Error('Camera grant remained after stopping');
      await mainDebugger.evaluate('globalThis.smokeCameraTestResponse = 0; true');
      await evaluate(`document.querySelector('[data-camera-start]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-camera-status]').textContent`), 'Test bol zrušený.');
      await mainDebugger.evaluate('globalThis.smokeCameraTestResponse = 1; true');
      await evaluate(`document.querySelector('[data-camera-start]').click()`);
      await waitFor(() => evaluate(cameraPlaying), true);
      await evaluate(`document.querySelector('[data-settings-section="general"]').click()`);
      await waitFor(() => evaluate(`document.querySelector('[data-camera-stop]').disabled`), true);
      if (await evaluate(internalCameraCapture) !== 'NotAllowedError') throw new Error('Camera grant remained after leaving privacy panel');
      await evaluate(`document.querySelector('[data-settings-section="privacy"]').click(); document.querySelector('[data-camera-start]').click()`);
      await waitFor(() => evaluate(cameraPlaying), true);
      await evaluate(`selectTab(${cleanId})`);
      await waitFor(() => evaluate(`document.querySelector('[data-camera-stop]').disabled`), true);
      if (await evaluate(internalCameraCapture) !== 'NotAllowedError') throw new Error('Camera grant remained after switching tabs');
      console.log(`${nativeTabs ? 'native' : 'webview'} tabs: fake camera/microphone capture, permissions, settings microphone meter and camera preview, device selection, stopping and cancellation passed`);
      await evaluate(`selectTab(${cleanId})`);
      await activityPage.evaluate(`globalThis.smokePeer = new RTCPeerConnection({ iceServers: [] }); smokePeer.createDataChannel('smoke')`);
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), 'call');
      await evaluate(`selectTab(${cleanId}); tabs.get(${activityId}).inactiveSince = Date.now() - 1200001; suspendInactiveTabs()`);
      if (await evaluate(`tabs.get(${activityId}).suspended === true`)) throw new Error('A WebRTC connection was suspended.');
      await activityPage.evaluate('smokePeer.close()');
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), '');
      await activityPage.evaluate(`globalThis.smokeUpload = fetch('/upload', { method: 'POST', body: 'Smoke upload' }); true`);
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), 'transfer');
      await evaluate('suspendInactiveTabs()');
      if (await evaluate(`tabs.get(${activityId}).suspended === true`)) throw new Error('An active upload was suspended.');
      await activityPage.evaluate('smokeUpload.then(response => response.text())');
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), '');
      await evaluate(`settingsState.downloadFolderPath = ${JSON.stringify(path.join(profilePath, 'downloads'))}; settingsState.askDownload = false; saveSettings()`);
      await activityPage.evaluate(`(() => { const link = document.createElement('a'); link.href = '/download'; link.download = 'smoke.exe'; document.body.append(link); link.click(); link.remove(); })()`);
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), 'download');
      await evaluate('suspendInactiveTabs()');
      if (await evaluate(`tabs.get(${activityId}).suspended === true`)) throw new Error('A source tab with an active download was suspended.');
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), '');
      const retryFile = path.join(profilePath, 'downloads', 'smoke-retry.bin');
      const retryUrl = new URL('/retry-download', startUrl).href;
      await evaluate(`(() => {
        downloadItems.set('smoke-download-retry', {
          id: 'smoke-download-retry',
          fileName: 'smoke-retry.bin',
          sourceUrl: ${JSON.stringify(retryUrl)},
          status: 'Sťahovanie zlyhalo: test',
          active: false,
          percent: 0
        });
        renderDownloads();
        const retryButton = document.querySelector('[data-download-id="smoke-download-retry"] .download-retry-icon');
        if (!retryButton) throw new Error('Failed download retry icon was not rendered.');
        retryButton.click();
        downloadItems.delete('smoke-download-retry');
        renderDownloads();
      })()`);
      await waitFor(() => fs.existsSync(retryFile) ? fs.readFileSync(retryFile, 'utf8') : '', 'Retry file');
      const downloadedFile = path.join(profilePath, 'downloads', 'smoke.exe');
      await waitFor(() => fs.existsSync(downloadedFile) ? fs.readFileSync(downloadedFile, 'utf8') : '', 'Smoke file');
      const metrics = await evaluate('measureLiveTabs()');
      if (!metrics.some(row => row.tabId === activityId && row.memoryBytes > 0 && row.pid > 0)) throw new Error('Real Chromium process memory was not measured.');
      await evaluate('suspendInactiveTabs()');
      await waitFor(() => evaluate(`tabs.get(${activityId}).suspended === true`), true);
    } finally { activityPage.close(); }

    await evaluate(`savedBookmarks.push({ url: ${JSON.stringify(startUrl)}, title: 'Learning smoke' }, { url: ${JSON.stringify(new URL('/two', startUrl).href)}, title: 'Learning smoke' }); renderAddressSuggestions('learning smoke')`);
    const learnedUrl = await evaluate('addressSuggestionItems[1].url');
    await evaluate('activateAddressSuggestion(addressSuggestionItems[1])');
    if (!await evaluate(`learnedSuggestions.some(entry => entry.query === 'learning smoke' && entry.url === ${JSON.stringify(learnedUrl)})`)) throw new Error('Selected suggestions were not learned.');
    await evaluate('openNewTab("linsoft://settings"); document.querySelector(\'[data-settings-section="advanced"]\').click(); document.querySelector("#learnSuggestionsToggle").click()');
    if (await evaluate('settingsState.learnSuggestions') !== false) throw new Error('Learning toggle did not disable local personalization.');
    const learningBefore = await evaluate('localStorage.getItem("linsoft-suggestion-learning")');
    await evaluate('renderAddressSuggestions("learning smoke"); activateAddressSuggestion(addressSuggestionItems[0])');
    if (await evaluate('localStorage.getItem("linsoft-suggestion-learning")') !== learningBefore) throw new Error('Disabled learning changed saved preferences.');
    await waitFor(() => evaluate(`tabs.get(activeTabId).loading !== true`), true);
    await evaluate('openSettings(); document.querySelector(\'[data-settings-section="advanced"]\').click(); document.querySelector("#clearSuggestionLearning").click(); document.querySelector("#learnSuggestionsToggle").click(); refreshTabPerformance()');
    if (await evaluate('learnedSuggestions.length') !== 0 || await evaluate('localStorage.getItem("linsoft-suggestion-learning")') !== null) throw new Error('Learning clear action retained saved data.');
    if (!await evaluate('document.querySelector("#tabPerformanceList").textContent.includes("MB")')) throw new Error('Performance overview did not show measured memory.');

    const crashUrl = new URL('/crash', startUrl);
    crashUrl.hostname = 'localhost';
    const crashId = await evaluate(`openNewTab(${JSON.stringify(crashUrl.href)}); activeTabId`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Crash');
    const crashPage = await connectPageDebugger(debugPort, crashUrl.href);
    try {
      crashPage.crash();
      await waitFor(() => evaluate(`tabs.get(${crashId}).crashed === true && Boolean(document.querySelector('[data-recover-tab="${crashId}"]'))`), true);
      await evaluate(`selectTab(${cleanId}); selectTab(${crashId})`);
      if (!await evaluate(`tabs.get(${crashId}).crashed && Boolean(document.querySelector('[data-recover-tab="${crashId}"]'))`)) throw new Error('Selecting a crashed tab automatically reloaded it.');
      await evaluate(`document.querySelector('[data-recover-tab="${crashId}"]').click()`);
      await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke Crash');
      if (await evaluate(`tabs.get(${crashId}).crashed`)) throw new Error('Explicit crash recovery did not recreate the tab.');
    } finally { crashPage.close(); }
    console.log(`${nativeTabs ? 'native' : 'webview'} tabs: scroll restore, WebRTC/upload protection, real memory, local learning controls, performance overview and explicit crash recovery passed`);

    const handoffUrl = `${startUrl}?handoff=${nativeTabs ? 'native' : 'webview'}`;
    const countBeforeHandoff = await evaluate(`document.querySelectorAll('.managed-tab').length`);
    const handoffProcess = spawn(electron, [`--remote-debugging-port=${debugPort}`, appPath, handoffUrl], {
      cwd: appPath,
      env: environment,
      stdio: 'ignore'
    });
    await waitFor(async () => {
      const count = await evaluate(`document.querySelectorAll('.managed-tab').length`);
      const address = await evaluate(`document.querySelector('#addressInput')?.value`);
      return count === countBeforeHandoff + 1 && address === handoffUrl;
    }, true);
    await waitForExit(handoffProcess, 10000);
    if (handoffProcess.exitCode !== 0 && handoffProcess.exitCode !== null) {
      throw new Error(`The second browser launch exited with code ${handoffProcess.exitCode}.`);
    }
    console.log(`${nativeTabs ? 'native' : 'webview'} tabs: navigation/history, local address recognition, popup tabs, safe suspension/restoration, draft preservation, and URL handoff passed`);
  } finally {
    mainDebugger?.close();
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
        socket.close();
      }
    } catch {}
    await waitForExit(child, 3000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child, 5000);
    }
    await removeProfile(profilePath);
  }
}

async function waitFor(read, expected) {
  const deadline = Date.now() + 10000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (value === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)}; last value was ${JSON.stringify(value)}.`);
}

async function main() {
  const browserUserAgents = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#14b8a6"/><text x="16" y="23" text-anchor="middle" font-size="22" fill="#102030">S</text></svg>');
      return;
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#14b8a6"/></svg>');
      return;
    }
    if (request.url === '/upload') {
      request.resume();
      setTimeout(() => { response.writeHead(200); response.end('Uploaded'); }, 2500);
      return;
    }
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="smoke.exe"', 'Content-Length': '10' });
      response.write('Smoke');
      setTimeout(() => response.end(' file'), 2500);
      return;
    }
    if (request.url === '/retry-download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="smoke-retry.bin"', 'Content-Length': '10' });
      response.write('Retry');
      setTimeout(() => response.end(' file'), 100);
      return;
    }
    if (request.url === '/one') browserUserAgents.push(request.headers['user-agent'] || '');
    const routes = {
      '/one': ['Smoke One', '<p>Smoke One</p>'],
      '/fullscreen': ['Smoke Fullscreen', '<div id="fullscreen-target" style="width:80vw;height:70vh;background:#123;color:white">Fullscreen target</div>'],
      '/two': ['Smoke Two', '<p style="height:5000px">Smoke Two</p>'],
      '/no-favicon': ['Smoke No Favicon', '<p>No explicit favicon</p>'],
      '/activity': ['Smoke Activity', '<p>Activity test</p>'],
      '/crash': ['Smoke Crash', '<p>Crash recovery test</p>'],
      '/draft': ['Smoke Draft', '<textarea id="draft" aria-label="Draft"></textarea>'],
      '/google-popup': ['Google popup test', "<button id=\"open-google-popup\" onclick=\"window.open('https://accounts.google.com/gsi/select', 'google_signin', 'popup,width=500,height=650')\">Open Google popup</button>"],
      '/office': ['Linsoft Office', '<button id="open-word" onclick="window.open(\'/office/word\', \'_blank\')">Word</button><button id="open-excel" onclick="window.open(\'/office/excel\', \'_blank\')">Excel</button><button id="open-presentation" onclick="window.open(\'/office/presentation\', \'_blank\')">Prezentácia</button>'],
      '/office/word': ['Linsoft Word', '<p>Word editor</p>'],
      '/office/excel': ['Linsoft Excel', '<p>Excel editor</p>'],
      '/office/presentation': ['Linsoft Prezentácie', '<p>Editor prezentácií</p>']
    };
    const [title, content] = routes[request.url] || ['Not Found', '<p>Not Found</p>'];
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>${request.url === '/no-favicon' ? '' : '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'}<title>${title}</title>${content}`);
  });
  const port = await listen(server);
  const startUrl = `http://127.0.0.1:${port}/one`;
  try {
    await smokeTabEngine({ nativeTabs: false, startUrl });
    await smokeTabEngine({ nativeTabs: true, startUrl });
    if (browserUserAgents.length < 2 || browserUserAgents.some((userAgent) => !/LinsoftBrowser\/\d+\.\d+\.\d+ \(Linsoft Browser \d+\.\d+\.\d+\)/.test(userAgent))) {
      throw new Error(`Website requests are missing the Linsoft Browser identity: ${JSON.stringify(browserUserAgents)}`);
    }
    console.log('webview and native tabs: website requests identify Linsoft Browser while retaining Chromium compatibility');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`Electron smoke test failed: ${error.stack || error}`);
  process.exitCode = 1;
});
