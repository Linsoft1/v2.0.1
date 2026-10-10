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

async function connectPageDebugger(debugPort, pageUrl) {
  const deadline = Date.now() + 10000;
  let target;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = response.ok ? await response.json() : [];
    target = targets.find((item) => ['page', 'webview'].includes(item.type) && item.url === pageUrl && item.webSocketDebuggerUrl);
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
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return {
    evaluate: async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
  const environment = {
    ...process.env,
    LINSOFT_DEV_LAUNCH: '1',
    LINSOFT_NATIVE_TABS: nativeTabs ? '1' : '0',
    LINSOFT_BROWSER_USER_DATA: profilePath
  };
  const child = spawn(electron, ['--headless', '--disable-gpu', `--remote-debugging-port=${debugPort}`, appPath], {
    cwd: appPath,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let socket;

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

    await evaluate(`document.querySelector('#addressInput').value = ${JSON.stringify(startUrl)}; document.querySelector('#addressForm').requestSubmit()`);
    await waitFor(() => evaluate(`document.querySelector('#tabTitle')?.textContent`), 'Smoke One');
    await evaluate(`savedBookmarks.push({ url: ${JSON.stringify(new URL('/two', startUrl).href)}, title: 'Počasie Bratislava' }); renderAddressSuggestions('pocasie bratislava')`);
    const suggestionUrl = await evaluate(`addressSuggestionItems[0]?.url`);
    if (suggestionUrl !== new URL('/two', startUrl).href) throw new Error('Accent-insensitive bookmark suggestion was not shown.');
    await evaluate(`addressInput.focus(); addressInput.value = 'pocasue bratislava'; addressInput.dispatchEvent(new Event('input', { bubbles: true }))`);
    await waitFor(() => evaluate(`addressSuggestionItems[0]?.typo && !addressSuggestions.hidden`), true);
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
      await activityPage.evaluate(`(() => { const link = document.createElement('a'); link.href = '/download'; link.download = 'smoke.txt'; document.body.append(link); link.click(); link.remove(); })()`);
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), 'download');
      await evaluate('suspendInactiveTabs()');
      if (await evaluate(`tabs.get(${activityId}).suspended === true`)) throw new Error('A source tab with an active download was suspended.');
      await waitFor(() => evaluate(`window.linsoftBrowser.inspectTab(liveTabTarget(${activityId})).then(result => result.reason)`), '');
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
  const server = http.createServer((request, response) => {
    if (request.url === '/upload') {
      request.resume();
      setTimeout(() => { response.writeHead(200); response.end('Uploaded'); }, 2500);
      return;
    }
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="smoke.txt"', 'Content-Length': '10' });
      response.write('Smoke');
      setTimeout(() => response.end(' file'), 2500);
      return;
    }
    const routes = {
      '/one': ['Smoke One', '<p>Smoke One</p>'],
      '/two': ['Smoke Two', '<p style="height:5000px">Smoke Two</p>'],
      '/activity': ['Smoke Activity', '<p>Activity test</p>'],
      '/crash': ['Smoke Crash', '<p>Crash recovery test</p>'],
      '/draft': ['Smoke Draft', '<textarea id="draft" aria-label="Draft"></textarea>'],
      '/office': ['Linsoft Office', '<button id="open-word" onclick="window.open(\'/office/word\', \'_blank\')">Word</button><button id="open-excel" onclick="window.open(\'/office/excel\', \'_blank\')">Excel</button><button id="open-presentation" onclick="window.open(\'/office/presentation\', \'_blank\')">Prezentácia</button>'],
      '/office/word': ['Linsoft Word', '<p>Word editor</p>'],
      '/office/excel': ['Linsoft Excel', '<p>Excel editor</p>'],
      '/office/presentation': ['Linsoft Prezentácie', '<p>Editor prezentácií</p>']
    };
    const [title, content] = routes[request.url] || ['Not Found', '<p>Not Found</p>'];
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title}</title>${content}`);
  });
  const port = await listen(server);
  const startUrl = `http://127.0.0.1:${port}/one`;
  try {
    await smokeTabEngine({ nativeTabs: false, startUrl });
    await smokeTabEngine({ nativeTabs: true, startUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`Electron smoke test failed: ${error.stack || error}`);
  process.exitCode = 1;
});
