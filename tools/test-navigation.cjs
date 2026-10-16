const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function waitFor(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for navigation UI');
}

async function connectPage(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error || message.result.exceptionDetails) request.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
    else request.resolve(message.result.result.value);
  });
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Evaluation timed out: ${expression}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  socket.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
  return { socket, evaluate };
}

async function testEngine(nativeTabs, port) {
  const probe = http.createServer();
  const debugPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-navigation-test-'));
  const child = spawn(electron, [`--remote-debugging-port=${debugPort}`, '--disable-gpu', root], {
    cwd: root,
    env: { ...process.env, LINSOFT_DEV_LAUNCH: '1', LINSOFT_NATIVE_TABS: nativeTabs ? '1' : '0', LINSOFT_BROWSER_USER_DATA: profile },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  let socket;
  try {
    let target;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited: ${stderr.slice(-2000)}`);
      let response;
      try { response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); }
      catch { return false; }
      target = (await response.json()).find((item) => item.type === 'page' && item.url.includes('index.html'));
      return Boolean(target);
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const contexts = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.executionContextCreated') contexts.set(message.params.context.id, message.params.context);
      if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.params.executionContextId);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error || message.result.exceptionDetails) request.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      else request.resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
    const evaluate = (expression, contextId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Evaluation timed out: ${expression}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, contextId, returnByValue: true, awaitPromise: true } }));
    });
    const interactWithLoadedWebsite = async (pageUrl, interaction = { type: 'click', x: 300, y: 400 }) => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const pageTarget = targets.find((item) => ['page', 'webview'].includes(item.type) && item.url.startsWith(pageUrl));
      assert.ok(pageTarget, `Expected a DevTools target for ${pageUrl}; found ${targets.map((item) => `${item.type}:${item.url}`).join(', ')}`);
      const pageSocket = new WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        pageSocket.addEventListener('open', resolve, { once: true });
        pageSocket.addEventListener('error', reject, { once: true });
      });
      let commandId = 0;
      const sendCommand = (method, params) => new Promise((resolve, reject) => {
        const id = ++commandId;
        const timer = setTimeout(() => {
          pageSocket.removeEventListener('message', handleMessage);
          reject(new Error(`DevTools command timed out: ${method}`));
        }, 10000);
        const handleMessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          clearTimeout(timer);
          pageSocket.removeEventListener('message', handleMessage);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        };
        pageSocket.addEventListener('message', handleMessage);
        pageSocket.send(JSON.stringify({ id, method, params }));
      });
      try {
        const clickHandler = await sendCommand('Runtime.evaluate', {
          expression: "window.__linsoftOutsideClickCount=0;window.__linsoftKeyCount=0;if(!window.__linsoftInteractionProbe){window.__linsoftInteractionProbe=true;document.addEventListener('click',()=>window.__linsoftOutsideClickCount++);document.addEventListener('keydown',()=>window.__linsoftKeyCount++)}",
          returnByValue: true
        });
        assert.equal(clickHandler.exceptionDetails, undefined);
        if (interaction.type === 'key') {
          const keyCode = interaction.key.toLowerCase() === 'escape' ? 27 : interaction.key.toLowerCase().charCodeAt(0);
          const code = interaction.key.toLowerCase() === 'escape' ? 'Escape' : `Key${interaction.key.toUpperCase()}`;
          await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: interaction.key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
          await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: interaction.key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
        } else {
          await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: interaction.x, y: interaction.y, button: 'left', clickCount: 1 });
          await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: interaction.x, y: interaction.y, button: 'left', clickCount: 1 });
        }
        await delay(100);
        const result = await sendCommand('Runtime.evaluate', {
          expression: '({ clickCount: window.__linsoftOutsideClickCount, keyCount: window.__linsoftKeyCount, fullscreen: Boolean(document.fullscreenElement) })',
          returnByValue: true
        });
        return result.result.value;
      } finally {
        pageSocket.close();
      }
    };
    await waitFor(() => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('.tab-surface'))`));
    await delay(300);
    assert.equal(await evaluate(`document.querySelector('.managed-tab').hasAttribute('title')`), false);
    assert.equal(await evaluate(`document.querySelector('#homeButton') === null`), true);
    await evaluate(`window.testOriginalTheme=document.body.className;document.body.classList.add('glass-blue-theme');`);
    assert.equal(await evaluate(`document.querySelector('.tabs-bar').getBoundingClientRect().top`), 0);
    assert.equal(await evaluate(`document.querySelector('.toolbar').getBoundingClientRect().top`), 40);
    assert.equal(await evaluate(`document.querySelector('.toolbar').getBoundingClientRect().height`), 38);
    assert.equal(await evaluate(`(()=>{const tabs=document.querySelector('.tabs-bar').getBoundingClientRect();const toolbar=document.querySelector('.toolbar').getBoundingClientRect();return tabs.left===0&&tabs.right===innerWidth&&toolbar.left===0&&toolbar.right===innerWidth})()`), true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.start-weather')).display`), 'none');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.start-customize')).display`), 'none');
    await evaluate(`document.body.className=window.testOriginalTheme;delete window.testOriginalTheme;`);
    assert.equal(await evaluate(`(()=>{const tab=document.querySelector('.managed-tab.active').getBoundingClientRect();const bar=document.querySelector('.tabs-bar').getBoundingClientRect();const buttons=document.querySelector('.window-buttons').getBoundingClientRect();return tab.top>bar.top&&tab.left>bar.left&&tab.bottom<bar.bottom&&bar.left>=0&&bar.right<=innerWidth&&Math.abs((tab.top+tab.height/2)-(buttons.top+buttons.height/2))<2&&parseFloat(getComputedStyle(document.querySelector('.managed-tab.active')).borderTopLeftRadius)>0})()`), true);
    assert.equal(await evaluate(`document.querySelector('#toolbarToolsToggle').getAttribute('aria-label')`), 'Zobraziť nástroje');
    assert.equal(await evaluate(`document.querySelector('#toolbarToolsToggle use').getAttribute('href')`), '#icon-chevron-down');
    await evaluate(`document.querySelector('#toolbarToolsToggle').click()`);
    assert.equal(await evaluate(`document.querySelector('#toolbarToolsToggle').getAttribute('aria-label') === 'Skryť nástroje' && document.querySelector('#toolbarToolsToggle').getAttribute('aria-expanded') === 'true'`), true);
    assert.equal(await evaluate(`document.querySelector('#toolbarToolsToggle use').getAttribute('href')`), '#icon-chevron-up');
    await evaluate(`document.querySelector('#toolbarToolsToggle').click()`);
    assert.equal(await evaluate(`document.querySelector('#toolbarToolsToggle').getAttribute('aria-label')`), 'Zobraziť nástroje');
    assert.equal(await evaluate('isNativeTabs'), nativeTabs);
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new MouseEvent('mouseenter'));`);
    await waitFor(() => evaluate(`!document.querySelector('#tabPreview').hidden && document.querySelector('.tab-preview-image').src.startsWith('data:image/svg+xml') && document.querySelector('.tab-preview-image').naturalWidth === 320`));
    assert.equal(await evaluate(`document.querySelector('#tabPreview').dataset.previewState`), 'ready');
    assert.equal(await evaluate(`document.querySelector('.tab-preview-status').textContent`), '');
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new MouseEvent('mouseleave'));`);
    const url = `http://127.0.0.1:${port}/`;
    await evaluate(`navigate(${JSON.stringify(url)})`);
    await waitFor(() => evaluate(`tabs.get(activeTabId).title === 'Navigation UI test' && !document.querySelector('.navigation-status') && !document.querySelector('.managed-tab.loading')`));
    assert.equal(await evaluate(`document.querySelector('.managed-tab.active').hasAttribute('title')`), false);
    const originalFavicon = new URL('/favicon.svg', url).href;
    await waitFor(() => evaluate(`tabs.get(activeTabId)?.icon === ${JSON.stringify(originalFavicon)}`));
    await waitFor(() => evaluate(`document.querySelector('.managed-tab.active .tab-favicon')?.naturalWidth > 0`));
    assert.equal(await evaluate(`document.querySelector('.managed-tab.active .tab-favicon').src`), originalFavicon);
    assert.equal(await evaluate(`(() => { const logo = document.querySelector('.managed-tab.active .tab-logo'); const staleImage = logo.querySelector('.tab-favicon'); setTabIcon(activeTabId, ${JSON.stringify(`${url}favicon-old.svg`)}); const supersededImage = logo.querySelector('.tab-favicon'); setTabIcon(activeTabId, ${JSON.stringify(originalFavicon)}); staleImage.dispatchEvent(new Event('error')); supersededImage.dispatchEvent(new Event('error')); return logo.querySelector('.tab-favicon')?.src === ${JSON.stringify(originalFavicon)} && !logo.textContent; })()`), true);
    await waitFor(() => evaluate(`document.querySelector('.managed-tab.active .tab-favicon')?.naturalWidth > 0`));
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new MouseEvent('mouseenter'));`);
    await waitFor(() => evaluate(`!document.querySelector('#tabPreview').hidden && document.querySelector('.tab-preview-image').src.startsWith('data:image/png')`));
    assert.equal(await evaluate(`document.querySelector('.tab-preview-title').textContent`), 'Navigation UI test');
    assert.equal(await evaluate(`document.querySelector('.tab-preview-url').textContent`), url);
    await evaluate(`document.querySelector('.managed-tab.active').dispatchEvent(new MouseEvent('mouseleave'));`);
    assert.equal(await evaluate(`document.querySelector('#tabPreview').hidden`), true);
    const originalTabId = await evaluate(`activeTabId`);
    await evaluate(`openNewTab(${JSON.stringify(`${url}other`)})`);
    await waitFor(() => evaluate(`[...tabs.values()].find(tab=>tab.url===${JSON.stringify(`${url}other`)})?.id || false`));
    const backgroundTabId = await evaluate(`[...tabs.values()].find(tab=>tab.url===${JSON.stringify(`${url}other`)})?.id`);
    assert.ok(backgroundTabId);
    await waitFor(() => evaluate(`!document.querySelector('.managed-tab[data-tab-id="${backgroundTabId}"].loading')`));
    await evaluate(`selectTab(${originalTabId})`);
    await evaluate(`document.querySelector('.managed-tab[data-tab-id="${backgroundTabId}"]').dispatchEvent(new MouseEvent('mouseenter'));`);
    await waitFor(() => evaluate(`!document.querySelector('#tabPreview').hidden && document.querySelector('.tab-preview-image').src.startsWith('data:image/png')`));
    await evaluate(`document.querySelector('.managed-tab[data-tab-id="${backgroundTabId}"]').dispatchEvent(new MouseEvent('mouseleave')); closeTab(${backgroundTabId});`);
    assert.deepEqual(await evaluate(`window.linsoftBrowser.clearActiveSiteData(activeViewer()?.getWebContentsId?.())`), { ok: true, origin: new URL(url).origin });
    await evaluate(`addressInput.value='navigation'; renderAddressSuggestions();`);
    assert.match(await evaluate(`document.querySelector('.address-suggestion-copy small').textContent`), /Otvorená karta/);
    assert.equal(await evaluate(`addressSuggestionItems[0].source`), 'tab');
    await evaluate(`closeAddressSuggestions();`);
    await evaluate(`tabs.get(activeTabId).group='blue'; tabs.get(activeTabId).groupName='Pracovné'; updateTabLabel(document.querySelector('.managed-tab.active')); saveSession(); showTabContextMenu(24,100,activeTabId);`);
    assert.equal(await evaluate(`document.querySelector('.managed-tab.active').classList.contains('tab-group-blue')`), true);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-session')).find(tab=>tab.id===activeTabId).groupName`), 'Pracovné');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-tab-action="closeGroup"]'))`), true);
    await evaluate(`closeContextMenus(); tabs.get(activeTabId).group=''; tabs.get(activeTabId).groupName=''; updateTabLabel(document.querySelector('.managed-tab.active')); saveSession();`);
    await evaluate(`window.navigationConfirmOriginal=window.confirm; window.navigationConfirmCount=0; window.confirm=()=>{navigationConfirmCount++;return false}; document.querySelector('#clearCurrentSiteData').click();`);
    assert.equal(await evaluate(`navigationConfirmCount`), 1);
    await evaluate(`window.confirm=navigationConfirmOriginal; delete window.navigationConfirmOriginal;`);
    await evaluate(`document.querySelector('#menuButton').click();
      document.querySelector('#downloadsButton').click();
      document.querySelector('#securityPanel').hidden=false;
      positionSecurityPanel();`);
    assert.equal((await interactWithLoadedWebsite(url)).clickCount, 1);
    await waitFor(() => evaluate(`document.querySelector('#browserMenu').hidden &&
      document.querySelector('#downloadPanel').hidden &&
      document.querySelector('#securityPanel').hidden`));
    assert.equal(await evaluate(`document.querySelector('#menuButton').getAttribute('aria-expanded')`), 'false');
    await evaluate(`document.querySelector('#menuButton').click();
      document.querySelector('#downloadsButton').click();
      document.querySelector('#securityPanel').hidden=false;
      positionSecurityPanel();
      document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`);
    assert.equal(await evaluate(`document.querySelector('#browserMenu').hidden &&
      document.querySelector('#downloadPanel').hidden &&
      document.querySelector('#securityPanel').hidden`), true);
    const fullscreenUrl = `${url}fullscreen`;
    await evaluate(`navigate(${JSON.stringify(fullscreenUrl)})`);
    await waitFor(() => evaluate(`tabs.get(activeTabId).title === 'Video fullscreen test' && !document.querySelector('.managed-tab.loading')`));
    assert.deepEqual(await interactWithLoadedWebsite(fullscreenUrl, { type: 'click', x: 340, y: 410 }), { clickCount: 1, keyCount: 0, fullscreen: true });
    await waitFor(() => evaluate(`document.querySelector('.browser-window').classList.contains('webview-fullscreen') && window.linsoftBrowser.getWindowControlState().then(state=>state.fullscreen)`));
    assert.deepEqual(await interactWithLoadedWebsite(fullscreenUrl, { type: 'key', key: 'f' }), { clickCount: 0, keyCount: 1, fullscreen: false });
    await waitFor(() => evaluate(`!document.querySelector('.browser-window').classList.contains('webview-fullscreen') && window.linsoftBrowser.getWindowControlState().then(state=>!state.fullscreen)`));
    assert.deepEqual(await interactWithLoadedWebsite(fullscreenUrl, { type: 'click', x: 340, y: 410 }), { clickCount: 1, keyCount: 0, fullscreen: true });
    await waitFor(() => evaluate(`document.querySelector('.browser-window').classList.contains('webview-fullscreen') && window.linsoftBrowser.getWindowControlState().then(state=>state.fullscreen)`));
    assert.deepEqual(await interactWithLoadedWebsite(fullscreenUrl, { type: 'key', key: 'Escape' }), { clickCount: 0, keyCount: 0, fullscreen: false });
    await waitFor(() => evaluate(`!document.querySelector('.browser-window').classList.contains('webview-fullscreen') && window.linsoftBrowser.getWindowControlState().then(state=>!state.fullscreen)`));
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: website video fullscreen works by F and mouse click and exits with Escape`);
    await evaluate(`navigate(${JSON.stringify(url)})`);
    await waitFor(() => evaluate(`tabs.get(activeTabId).title === 'Navigation UI test' && !document.querySelector('.managed-tab.loading')`));
    await evaluate(`window.navigationTestOriginalFetch = window.fetch;
      window.fetch = async () => ({ok:true,json:async()=>({ip:'192.0.2.1',org:'Test network',country_name:'Test country'})});
      document.querySelector('#securityButton').click();`);
    const securityPanelGeometry = await evaluate(`(() => {
      const panel = document.querySelector('#securityPanel');
      const bounds = panel.getBoundingClientRect();
      const buttonBounds = document.querySelector('#securityButton').getBoundingClientRect();
      const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
      const bookmarksBar = document.querySelector('#bookmarksBar');
      const bookmarksBottom = bookmarksBar.hidden ? 0 : bookmarksBar.getBoundingClientRect().bottom;
      return {
        hidden: panel.hidden,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        buttonLeft: buttonBounds.left,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        toolbarBottom,
        bookmarksBottom,
        maxHeight: parseFloat(getComputedStyle(panel).maxHeight)
      };
    })()`);
    assert.equal(securityPanelGeometry.hidden, false);
    assert.ok(securityPanelGeometry.left <= securityPanelGeometry.buttonLeft);
    assert.ok(securityPanelGeometry.right <= securityPanelGeometry.viewportWidth);
    assert.ok(securityPanelGeometry.top >= Math.max(securityPanelGeometry.toolbarBottom, securityPanelGeometry.bookmarksBottom));
    assert.ok(securityPanelGeometry.bottom <= securityPanelGeometry.viewportHeight);
    assert.ok(securityPanelGeometry.maxHeight <= securityPanelGeometry.viewportHeight - securityPanelGeometry.top - 11);
    await evaluate(`document.querySelector('#closeSecurity').click();
      window.fetch = window.navigationTestOriginalFetch; delete window.navigationTestOriginalFetch;`);
    assert.equal(await evaluate(`document.querySelector('#securityPanel').hidden`), true);
    await evaluate(`searchOpenTabs();`);
    assert.equal(await evaluate(`document.querySelector('#tabSearchDialog').open`), true);
    await evaluate(`document.querySelector('#tabSearchDialog input').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));`);
    assert.equal(await evaluate(`document.activeElement.hasAttribute('data-select-search-tab')`), true);
    await evaluate(`document.activeElement.click();`);
    await waitFor(() => evaluate(`document.querySelector('#tabSearchDialog') === null`));
    assert.equal(await evaluate(`tabs.get(activeTabId).title`), 'Navigation UI test');

    // Keep subresources pending after DOM readiness to exercise the native chrome warning too.
    const loadingStarted = Date.now();
    await evaluate(`navigate(${JSON.stringify(`${url}slow`)})`);
    await waitFor(() => evaluate(`document.querySelector('#reloadButton').getAttribute('aria-label') === 'Zastaviť načítavanie'`));
    await delay(14000);
    assert.equal(await evaluate(`document.querySelector('#slowLoadNotice').hidden`), true);
    await waitFor(() => evaluate(`!document.querySelector('#slowLoadNotice').hidden`), 5000);
    assert.ok(Date.now() - loadingStarted >= 14900, 'Warning must wait 15 seconds');
    const slowTab = await evaluate('activeTabId');
    await evaluate('openNewTab()');
    assert.equal(await evaluate(`document.querySelector('#slowLoadNotice').hidden`), true);
    await evaluate(`selectTab(${slowTab})`);
    assert.equal(await evaluate(`document.querySelectorAll('.managed-tab[aria-current="page"]').length`), 1);
    assert.equal(await evaluate(`Number(document.querySelector('.managed-tab[aria-current="page"]').dataset.tabId) === activeTabId`), true);
    assert.equal(await evaluate(`document.querySelector('#slowLoadNotice').hidden`), false);
    await evaluate(`document.querySelector('#stopSlowLoad').click()`);
    await waitFor(() => evaluate(`document.querySelector('#slowLoadNotice').hidden && !document.querySelector('.managed-tab.loading')`));
    assert.equal(await evaluate(`document.querySelector('#reloadButton').getAttribute('aria-label')`), 'Obnoviť');
    assert.equal(await evaluate(`tabLoadingTimers.size + slowLoadingTabs.size`), 0);

    await evaluate(`navigate('http://linsoft-navigation-test.invalid/')`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.navigation-status-error'))`));
    assert.match(await evaluate(`document.querySelector('.navigation-description').textContent`), /DNS/);
    await evaluate(`document.querySelector('.navigation-error-details summary').click()`);
    assert.equal(await evaluate(`document.querySelector('.navigation-error-details').open`), true);
    assert.match(await evaluate(`document.querySelector('.navigation-error-details').textContent`), /-105/);
    await evaluate(`document.querySelector('[data-navigation-action="address"]').click()`);
    assert.equal(await evaluate(`document.activeElement === addressInput && addressInput.selectionEnd === addressInput.value.length`), true);
    await evaluate(`document.querySelector('[data-navigation-action="home"]').click()`);
    assert.equal(await evaluate('tabs.get(activeTabId).url'), 'linsoft://start');
    assert.equal(await evaluate(`Boolean(document.querySelector('.tab-surface:not(.inactive-surface) .navigation-status'))`), false);

    await evaluate(`navigate(${JSON.stringify(`${url}headers`)})`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.navigation-status:not(.navigation-status-error)'))`));
    assert.equal(await evaluate(`document.querySelector('.navigation-logo img').naturalWidth > 0`), true);
    await evaluate(`document.querySelector('[data-navigation-action="stop"]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('.managed-tab.loading') && !document.querySelector('.navigation-status:not(.navigation-status-error)')`));

    // Controlled transport results test Tor UI without depending on the public Tor network.
    const originalContexts = new Set(contexts.keys());
    await evaluate(`window.torTestFrame = document.createElement('iframe');
      torTestFrame.src = new URL('index.html', location.href).href;
      document.body.appendChild(torTestFrame);`);
    await waitFor(() => evaluate(`Boolean(torTestFrame.contentWindow.navigate && torTestFrame.contentDocument.querySelector('.tab-surface'))`));
    const torContext = [...contexts.values()].find((context) => !originalContexts.has(context.id) && context.auxData?.isDefault);
    assert.ok(torContext, 'Tor UI frame must have an isolated JavaScript context');
    const torEvaluate = (expression) => evaluate(expression, torContext.id);
    await torEvaluate(`window.linsoftBrowser = {enableTorProxy: () => new Promise(resolve => { window.resolveTestTor = resolve; })};
      navigate('example.onion/');`);
    assert.match(await torEvaluate(`document.querySelector('.navigation-tor-status').textContent`), /pripája/);
    assert.equal(await torEvaluate(`tabs.get(activeTabId).url`), 'http://example.onion/');
    await torEvaluate(`renderNavigationTorStatus({proxyStatus:'running',proxyEnabled:true})`);
    assert.equal(await torEvaluate(`document.querySelector('.navigation-tor-status').textContent`), 'Tor je pripojený');
    await torEvaluate(`renderNavigationTorStatus({proxyStatus:'manual',proxyEnabled:true})`);
    assert.match(await torEvaluate(`document.querySelector('.navigation-tor-status').textContent`), /nie je overený/);
    await torEvaluate(`renderNavigationTorStatus({proxyStatus:'error',proxyEnabled:false,proxyMessage:'Test Tor failure'})`);
    assert.match(await torEvaluate(`document.querySelector('.navigation-tor-status').textContent`), /Test Tor failure/);
    await torEvaluate(`document.querySelector('[data-navigation-action="stop"]').click()`);
    await torEvaluate(`resolveTestTor({ok:true,proxyStatus:'running',proxyEnabled:true})`);
    await delay(200);
    assert.equal(await torEvaluate(`pendingTorNavigations.size`), 0);
    assert.match(await torEvaluate(`document.querySelector('.navigation-status h1').textContent`), /zastavené/);
    await torEvaluate(`navigate('http://example.onion/'); resolveTestTor({ok:false,message:'Test proxy failure'});`);
    await waitFor(() => torEvaluate(`Boolean(document.querySelector('.navigation-error-details'))`));
    assert.match(await torEvaluate(`document.querySelector('.navigation-error-details').textContent`), /TOR_CONNECTION_FAILED/);
    await torEvaluate(`navigate('http://example.onion/'); navigate('linsoft://start'); resolveTestTor({ok:true,proxyStatus:'running',proxyEnabled:true});`);
    await delay(100);
    assert.equal(await torEvaluate(`tabs.get(activeTabId).url`), 'linsoft://start');
    await torEvaluate(`openNewTab('http://example.onion/'); const closedId = activeTabId; closeTab(closedId); resolveTestTor({ok:true,proxyStatus:'running',proxyEnabled:true});`);
    await delay(100);
    assert.equal(await torEvaluate(`pendingTorNavigations.size + tabLoadingTimers.size + slowLoadingTabs.size`), 0);
    await evaluate(`torTestFrame.remove(); navigate(${JSON.stringify(url)})`);
    await waitFor(() => evaluate(`!document.querySelector('.navigation-status') && !document.querySelector('.managed-tab.loading')`));
    await evaluate(`openSettings();`);
    await waitFor(() => evaluate(`settingsVpnStatus.status === 'disconnected'`));
    assert.equal(await evaluate(`document.querySelector('#connectOpenVpn').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#disconnectOpenVpn').disabled`), true);
    await evaluate(`settingsState.openvpnProfile='controlled-profile.ovpn'; renderVpnControls();`);
    assert.equal(await evaluate(`document.querySelector('#connectOpenVpn').disabled`), false);
    await evaluate(`settingsVpnStatus={status:'connecting',message:'Controlled connection'}; renderSettingsConnectionOverview();`);
    assert.equal(await evaluate(`document.querySelector('#connectOpenVpn').disabled && document.querySelector('#chooseOpenVpn').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#disconnectOpenVpn').textContent`), 'Zrušiť pripájanie');
    await evaluate(`settingsVpnStatus={status:'disconnecting',message:'Controlled disconnect'}; renderSettingsConnectionOverview();`);
    assert.equal(await evaluate(`document.querySelector('#disconnectOpenVpn').disabled`), true);
    await evaluate(`settingsState.openvpnProfile=''; settingsVpnStatus={status:'disconnected',message:'VPN je odpojená.'}; renderSettingsConnectionOverview();`);
    assert.equal(await evaluate(`document.querySelector('#openVpnStatus').getAttribute('role')`), 'status');
    await evaluate(`document.querySelector('#openVpnLog').textContent='Controlled VPN log'; document.querySelector('[data-clear-vpn-log]').click();`);
    assert.equal(await evaluate(`document.querySelector('#openVpnLog').textContent`), 'Čaká sa na operáciu...');
    assert.equal(await evaluate(`document.querySelector('#openVpnLog').tabIndex`), 0);
    assert.equal(await evaluate(`document.querySelector('#connectOpenVpn').closest('.settings-vpn-connection') !== null`), true);
    assert.equal(await evaluate(`document.querySelectorAll('.settings-advanced-group').length`), 5);
    assert.equal(await evaluate(`document.querySelectorAll('.settings-proxy-field').length`), 3);
    await evaluate(`renderNavigationTorStatus({proxyStatus:'manual',proxyEnabled:true});`);
    assert.equal(await evaluate(`document.querySelector('.settings-tor-connections [data-connection-tor]').textContent`), 'Odpojený');
    assert.equal(await evaluate(`document.querySelector('.settings-tor-connections [data-connection-proxy]').dataset.status`), 'connected');
    await evaluate(`renderNavigationTorStatus({proxyStatus:'running',proxyEnabled:true});`);
    assert.equal(await evaluate(`document.querySelector('.settings-tor-connections [data-connection-tor]').textContent`), 'Pripojený');
    assert.equal(await evaluate(`document.querySelector('.settings-tor-connections [data-connection-proxy]').dataset.status`), 'disconnected');
    await evaluate(`renderNavigationTorStatus({proxyStatus:'stopped',proxyEnabled:false});`);
    await evaluate(`document.querySelector('[data-groups-open="false"]').click();`);
    assert.equal(await evaluate(`document.querySelectorAll('.settings-group-body[hidden]').length`), 5);
    await evaluate(`openSettings();`);
    assert.equal(await evaluate(`document.querySelectorAll('.settings-group-body[hidden]').length`), 5);
    assert.equal(await evaluate(`Object.values(JSON.parse(localStorage.getItem('linsoft-settings-groups'))).every(value=>value===false)`), true);
    assert.equal(await evaluate(`document.querySelector('#downloadsSetting').closest('.settings-advanced-group').id.endsWith('-downloads')`), true);
    await evaluate(`document.querySelector('[data-settings-section="advanced"]').click(); document.querySelector('.settings-advanced-links button').click();`);
    assert.equal(await evaluate(`document.activeElement.classList.contains('settings-advanced-group')`), true);
    assert.equal(await evaluate(`document.activeElement.querySelector('[data-group-toggle]').getAttribute('aria-expanded')`), 'true');
    await evaluate(`document.querySelector('[data-setting-toggle="adBlock"]').click();`);
    await evaluate(`document.querySelector('[data-groups-open="false"]').click(); document.querySelector('[data-groups-open="true"]').click();`);
    assert.equal(await evaluate(`document.querySelectorAll('.settings-group-body[hidden]').length`), 0);
    assert.equal(await evaluate(`document.querySelector('[data-setting-toggle="adBlock"]').classList.contains('on')`), false);
    assert.equal(await evaluate(`document.querySelector('.settings-actions').classList.contains('has-changes')`), true);
    await evaluate(`document.querySelector('#discardSettings').click();`);
    assert.equal(await evaluate(`document.querySelector('[data-setting-toggle="adBlock"]').classList.contains('on')`), true);
    await evaluate(`document.querySelector('[data-settings-section="general"]').click();`);
    await evaluate(`document.querySelector('[data-groups-open="false"]').click();`);
    await evaluate(`renderSettingsUpdateState({status:'checking'});`);
    assert.equal(await evaluate(`document.querySelector('[data-update-action]').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('.settings-update-status').getAttribute('aria-busy')`), 'true');
    await evaluate(`renderSettingsUpdateState({status:'downloading',percent:47});`);
    assert.equal(await evaluate(`document.querySelector('.settings-update-progress').value`), 47);
    assert.equal(await evaluate(`document.querySelector('.settings-update-progress').hidden`), false);
    await evaluate(`document.querySelector('#autoUpdateCheckToggle').click();`);
    assert.equal(await evaluate(`document.querySelector('[data-update-note]').textContent`), 'Sťahuje sa aktualizácia: 47 %.');
    await evaluate(`document.querySelector('#autoUpdateCheckToggle').click();`);
    await evaluate(`renderSettingsUpdateState({status:'downloading',percent:150});`);
    assert.equal(await evaluate(`document.querySelector('.settings-update-progress').value`), 100);
    await evaluate(`renderSettingsUpdateState({status:'downloaded',version:'2.0.31'});`);
    assert.equal(await evaluate(`document.querySelector('[data-update-action]').dataset.updateAction`), 'install');
    assert.equal(await evaluate(`document.querySelector('.settings-update-progress').hidden`), true);
    await evaluate(`renderSettingsUpdateState({status:'error',message:'Controlled update failure'});`);
    assert.equal(await evaluate(`document.querySelector('[data-update-note]').textContent`), 'Controlled update failure');
    assert.equal(await evaluate(`document.querySelector('[data-update-action]').disabled`), false);
    assert.equal(await evaluate(`document.querySelector('[data-update-action]').textContent`), 'Skúsiť znova');
    await evaluate(`renderSettingsUpdateState({status:'latest',version:'2.0.30',checkedAt:1700000000000});`);
    assert.equal(await evaluate(`document.querySelector('[data-update-title]').textContent`), 'Používaš najnovšiu verziu');
    assert.equal(await evaluate(`document.querySelector('.settings-update-icon use').getAttribute('href')`), '#icon-shield-check');
    assert.equal(await evaluate(`document.querySelector('[data-update-checked]').textContent === 'Posledná kontrola: ' + new Date(1700000000000).toLocaleString('sk-SK')`), true);
    await evaluate(`renderSettingsUpdateState({status:'downloading',percent:47});`);
    assert.equal(await evaluate(`document.querySelector('[data-update-checked]').textContent.startsWith('Posledná kontrola: ')`), true);
    await evaluate(`renderSettingsUpdateState({status:'idle'});`);
    assert.equal(await evaluate(`document.querySelector('[data-update-checked]').textContent`), 'Kontrola zatiaľ neprebehla.');
    assert.equal(await evaluate(`document.querySelector('.settings-page').lastElementChild.classList.contains('settings-actions')`), true);
    assert.equal(await evaluate(`Boolean(document.querySelector('#themeSetting').getAttribute('aria-labelledby'))`), true);
    assert.equal(await evaluate(`document.querySelector('.settings-brand img').naturalWidth > 0`), true);
    assert.equal(await evaluate(`window.linsoftBrowser.getOpenVpnStatus().then(status => status.status)`), 'disconnected');
    await evaluate(`window.linsoftBrowser.checkForUpdates().then(renderSettingsUpdateState);`);
    assert.equal(await evaluate(`document.querySelector('.settings-update-status').dataset.updateStatus`), 'unavailable');
    await evaluate(`document.querySelector('#settingsSearch').value='stiahnute'; document.querySelector('#settingsSearch').dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.ok(await evaluate(`document.querySelector('#settingsSearchResults').children.length > 0`));
    await evaluate(`document.querySelector('#settingsSearchResults button').click()`);
    assert.equal(await evaluate(`document.querySelector('[data-settings-section="advanced"]').classList.contains('active')`), true);
    assert.equal(await evaluate(`document.querySelector('#downloadsSetting').closest('.settings-group-body').hidden`), false);
    assert.equal(await evaluate(`document.querySelector('[data-settings-section="advanced"]').getAttribute('aria-current')`), 'page');
    await evaluate(`document.querySelector('[data-settings-section="general"]').click(); document.querySelector('#homeSetting').value='https://draft.invalid/'; document.querySelector('#homeSetting').dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await evaluate(`document.querySelector('.settings-draft-status').textContent`), 'Máte neuložené zmeny');
    assert.equal(await evaluate(`document.querySelector('.settings-actions').classList.contains('has-changes')`), true);
    const settingsTab = await evaluate('activeTabId');
    await evaluate(`openNewTab(); selectTab(${settingsTab});`);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #homeSetting').value`), 'https://draft.invalid/');
    await evaluate(`window.originalSettingsConfirm = window.confirm; window.confirm = () => false; navigate('linsoft://start');`);
    assert.equal(await evaluate('tabs.get(activeTabId).url'), 'linsoft://settings');
    await evaluate(`closeTab(activeTabId)`);
    assert.equal(await evaluate('tabs.has(activeTabId) && tabs.get(activeTabId).url'), 'linsoft://settings');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #discardSettings').click();`);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #homeSetting').value`), 'linsoft://start');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #themeSetting').value='light'; document.querySelector('.tab-surface:not(.inactive-surface) #themeSetting').dispatchEvent(new Event('change',{bubbles:true}));`);
    assert.equal(await evaluate(`document.body.classList.contains('light-theme')`), false);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #discardSettings').click(); settingsState.downloadFolderPath='custom-folder'; document.querySelector('.tab-surface:not(.inactive-surface) #downloadsSetting').value='Desktop'; document.querySelector('.tab-surface:not(.inactive-surface) #downloadsSetting').dispatchEvent(new Event('change',{bubbles:true}));`);
    assert.equal(await evaluate('settingsState.downloadFolderPath'), 'custom-folder');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #discardSettings').click();`);
    assert.equal(await evaluate('settingsState.downloadFolderPath'), 'custom-folder');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) [data-start-favorite-visible="https://www.google.com"]').click();`);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .settings-actions').classList.contains('has-changes')`), true);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #discardSettings').click();`);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) [data-start-favorite-visible="https://www.google.com"]').checked`), true);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #themeSetting').value='light'; document.querySelector('.tab-surface:not(.inactive-surface) [data-setting-toggle="compact"]').click(); document.querySelector('.tab-surface:not(.inactive-surface) [data-setting-toggle="startShowWeather"]').click(); document.querySelector('.tab-surface:not(.inactive-surface) [data-setting-toggle="startShowFavorites"]').click(); document.querySelector('.tab-surface:not(.inactive-surface) #uiFontScaleSetting').value='large'; document.querySelector('.tab-surface:not(.inactive-surface) #uiFontScaleSetting').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.tab-surface:not(.inactive-surface) #downloadsSetting').value='Desktop'; document.querySelector('.tab-surface:not(.inactive-surface) #downloadsSetting').dispatchEvent(new Event('change',{bubbles:true}));`);
    const favoritesStorageBeforeSettings = await evaluate(`localStorage.getItem('linsoft-start-favorites')`);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) [data-start-favorite-visible="https://www.google.com"]').click(); document.querySelector('.tab-surface:not(.inactive-surface) #homeSetting').value='https://saved.invalid/'; document.querySelector('.tab-surface:not(.inactive-surface) #homeSetting').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.tab-surface:not(.inactive-surface) #saveSettings').click();`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).home`), 'https://saved.invalid/');
    assert.equal(await evaluate(`document.body.classList.contains('light-theme') && JSON.parse(localStorage.getItem('linsoft-settings')).compact`), true);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).startShowWeather`), false);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).startShowFavorites`), false);
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).startHiddenFavorites`), ['https://www.google.com']);
    assert.equal(await evaluate(`localStorage.getItem('linsoft-start-favorites')`), favoritesStorageBeforeSettings);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).uiFontScale`), 'large');
    assert.equal(await evaluate(`getComputedStyle(document.body).getPropertyValue('--ui-font-scale').trim()`), '1.08');
    assert.equal(await evaluate(`document.querySelector('.toolbar').getBoundingClientRect().height`), 48);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).downloadFolderPath`), '');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).downloads`), 'Desktop');
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .settings-draft-status').textContent`), 'Zmeny sú uložené');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) #homeSetting').value='https://discarded.invalid/'; document.querySelector('.tab-surface:not(.inactive-surface) #homeSetting').dispatchEvent(new Event('input',{bubbles:true})); window.confirm = () => true; navigate('linsoft://start'); window.confirm=originalSettingsConfirm;`);
    assert.equal(await evaluate('tabs.get(activeTabId).url'), 'linsoft://start');
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .start-weather').hidden && document.querySelector('.tab-surface:not(.inactive-surface) .start-favorites').hidden`), true);
    await evaluate(`settingsState.startShowWeather=true; settingsState.startShowFavorites=true; settingsState.startShowFooter=true; settingsState.uiFontScale='normal'; saveSettings(); startPage();`);
    assert.equal(await evaluate(`![...document.querySelectorAll('.tab-surface:not(.inactive-surface) .start-favorite-open')].some(link=>link.dataset.url==='https://www.google.com')`), true);
    await evaluate(`settingsState.startHiddenFavorites=[]; saveSettings(); startPage();`);
    assert.equal(await evaluate(`[...document.querySelectorAll('.tab-surface:not(.inactive-surface) .start-favorite-open')].some(link=>link.dataset.url==='https://www.google.com')`), true);
    await evaluate(`settingsState.startHiddenFavorites=(startFavorites.length?startFavorites:defaultStartFavorites).map(item=>item.url); saveSettings(); startPage();`);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .start-favorites-empty').textContent.includes('záložky zostanú uložené') && !document.querySelector('.tab-surface:not(.inactive-surface) .start-favorite-open')`), true);
    await evaluate(`settingsState.startHiddenFavorites=[]; saveSettings(); startPage();`);
    await evaluate(`settingsState.downloadFolderPath=${JSON.stringify(profile)}; settingsState.askDownload=false; saveSettings(); navigate(${JSON.stringify(`${url}download`)});`);
    await waitFor(() => evaluate(`Array.from(downloadItems.values()).some(item=>item.fileName==='linsoft-test.txt'&&item.status==='Stiahnuté')`));
    const downloadedFile = path.join(profile, 'linsoft-test.txt');
    assert.equal(fs.readFileSync(downloadedFile, 'utf8'), 'Linsoft download test');
    assert.equal(await evaluate(`document.querySelector('[data-download-status="completed"] progress').value`), 100);
    assert.equal(await evaluate(`document.querySelectorAll('[data-show-download]').length`), 1);
    assert.match(await evaluate(`document.querySelector('#downloadSummary').textContent`), /Dokončené: 1/);
    const downloadPanelGeometry = await evaluate(`(() => {
      const panel = document.querySelector('#downloadPanel');
      const bounds = panel.getBoundingClientRect();
      const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
      const bookmarksBar = document.querySelector('#bookmarksBar');
      const bookmarksBottom = bookmarksBar.hidden ? 0 : bookmarksBar.getBoundingClientRect().bottom;
      return {
        hidden: panel.hidden,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        toolbarBottom,
        bookmarksBottom,
        maxHeight: parseFloat(getComputedStyle(panel).maxHeight)
      };
    })()`);
    assert.equal(downloadPanelGeometry.hidden, false);
    assert.ok(downloadPanelGeometry.top >= Math.max(downloadPanelGeometry.toolbarBottom, downloadPanelGeometry.bookmarksBottom));
    assert.ok(downloadPanelGeometry.right <= downloadPanelGeometry.viewportWidth);
    assert.ok(downloadPanelGeometry.bottom <= downloadPanelGeometry.viewportHeight);
    assert.ok(downloadPanelGeometry.maxHeight <= downloadPanelGeometry.viewportHeight - downloadPanelGeometry.top - 11);
    await evaluate(`document.querySelector('#downloadPanel').hidden = true; document.querySelector('#downloadsButton').click();`);
    assert.equal(await evaluate(`document.querySelector('#downloadPanel').hidden`), false);
    await evaluate(`document.querySelector('#closeDownload').click();`);
    assert.equal(await evaluate(`document.querySelector('#downloadPanel').hidden`), true);
    await evaluate(`document.querySelector('#downloadSearch').value='LINSOFT-TEST'; document.querySelector('#downloadSearch').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`document.querySelectorAll('#downloadList .download-item').length`), 1);
    await evaluate(`document.querySelector('#downloadSearch').value='does-not-exist'; document.querySelector('#downloadSearch').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`document.querySelector('#downloadList .downloads-empty strong').textContent`), 'Žiadny zodpovedajúci súbor');
    assert.equal(await evaluate(`document.querySelector('[data-download-total="completed"] strong').textContent`), '1');
    await evaluate(`document.querySelector('#downloadSearch').value=''; document.querySelector('#downloadSearch').dispatchEvent(new Event('input'));`);
    await evaluate(`downloadItems.set('unknown-size',{id:'unknown-size',fileName:'unknown.bin',active:true,status:'Sťahuje sa',received:2048,total:0}); renderDownloads();`);
    assert.equal(await evaluate(`document.querySelector('[data-download-id="unknown-size"] progress').hasAttribute('value')`), false);
    assert.match(await evaluate(`document.querySelector('[data-download-id="unknown-size"] .download-item-body span').textContent`), /neznáma veľkosť/);
    await evaluate(`downloadItems.set('failed-test',{id:'failed-test',fileName:'failed.bin',active:true,status:'Sťahovanie zlyhalo: Controlled error',received:0,total:0}); document.querySelector('#downloadFilter').value='active'; renderDownloads();`);
    assert.equal(await evaluate(`document.querySelectorAll('#downloadList .download-item').length`), 1);
    assert.match(await evaluate(`document.querySelector('#downloadSummary').textContent`), /Aktívne: 1/);
    await evaluate(`document.querySelector('#downloadFilter').value='failed'; renderDownloads();`);
    assert.equal(await evaluate(`document.querySelector('#downloadList .download-item').dataset.downloadId`), 'failed-test');
    assert.equal(await evaluate(`document.querySelector('#downloadList .download-item-percent').textContent`), 'Chyba');
    await evaluate(`document.querySelector('#downloadSearch').value='unknown'; document.querySelector('#downloadSearch').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`document.querySelectorAll('#downloadList .download-item').length`), 0);
    await evaluate(`document.querySelector('#downloadSearch').value=''; document.querySelector('#downloadSearch').dispatchEvent(new Event('input'));`);
    await evaluate(`downloadItems.delete('unknown-size'); downloadItems.delete('failed-test'); document.querySelector('#downloadFilter').value='all'; renderDownloads();`);
    assert.equal(await evaluate(`document.querySelector('#clearDownloads').disabled`), false);
    await evaluate(`downloadItems.set('active-clear-test',{id:'active-clear-test',fileName:'active.bin',active:true,status:'Sťahuje sa',received:10,total:100}); renderDownloads(); window.__originalDownloadConfirm=window.confirm; window.confirm=()=>false; document.querySelector('#clearDownloads').click();`);
    assert.equal(await evaluate(`downloadItems.has('active-clear-test') && downloadItems.has([...downloadItems.keys()].find(id=>downloadItems.get(id).status==='Stiahnuté'))`), true);
    await evaluate(`window.confirm=()=>true; document.querySelector('#clearDownloads').click();`);
    await waitFor(() => evaluate(`![...downloadItems.values()].some(item=>item.status==='Stiahnuté')`));
    assert.equal(await evaluate(`downloadItems.has('active-clear-test') && ![...downloadItems.values()].some(item=>item.status==='Stiahnuté')`), true);
    await evaluate(`window.confirm=window.__originalDownloadConfirm; delete window.__originalDownloadConfirm; downloadItems.delete('active-clear-test'); renderDownloads();`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-settings')).home`), 'https://saved.invalid/');
    const previousTab = await evaluate('activeTabId');
    const keyboardTab = await evaluate(`openNewTab('linsoft://start'); activeTabId`);
    const nextKeyboardTab = await evaluate(`openNewTab('linsoft://start'); activeTabId`);
    await evaluate(`selectTab(${keyboardTab}); document.querySelector('.managed-tab.active').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
    assert.equal(await evaluate('activeTabId'), nextKeyboardTab);
    assert.equal(await evaluate(`Number(document.activeElement.dataset.tabId)`), nextKeyboardTab);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));`);
    assert.equal(await evaluate(`document.activeElement === document.querySelector('.managed-tab')`), true);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));`);
    assert.equal(await evaluate('activeTabId'), nextKeyboardTab);
    await evaluate(`toggleTabLock(${nextKeyboardTab}); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));`);
    assert.equal(await evaluate(`tabs.has(${nextKeyboardTab})`), true);
    assert.match(await evaluate(`document.querySelector('.managed-tab.active').getAttribute('aria-label')`), /Zamknutá/);
    await evaluate(`toggleTabLock(${nextKeyboardTab}); togglePinnedTab(${nextKeyboardTab}); document.querySelector('.managed-tab.active').dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true}));`);
    assert.equal(await evaluate(`tabs.has(${nextKeyboardTab})`), true);
    await evaluate(`togglePinnedTab(${nextKeyboardTab}); document.querySelector('.managed-tab.active').dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true}));`);
    assert.equal(await evaluate(`tabs.has(${nextKeyboardTab})`), false);
    await evaluate(`selectTab(${keyboardTab}); document.querySelector('.managed-tab.active').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));`);
    assert.equal(await evaluate(`tabs.has(${keyboardTab})`), false);
    assert.equal(await evaluate(`Number(document.activeElement.dataset.tabId) === activeTabId`), true);
    await evaluate(`selectTab(${previousTab});`);
    await evaluate(`window.uiHistoryBackup=localStorage.getItem('linsoft-history'); window.uiBookmarksBackup=savedBookmarks; window.uiBookmarksBarBackup=settingsState.showBookmarksBar; savedBookmarks=[{title:'Žltá stránka',url:'https://z.invalid/'},{title:'Alfa stránka',url:'https://a.invalid/'}]; settingsState.showBookmarksBar=true; updateBookmarksBar(); renderSavedBookmarks(); localStorage.setItem('linsoft-history',JSON.stringify([{title:'Žltá návšteva',url:'https://z.invalid/',visitedAt:1700000000000},{title:'Alfa návšteva',url:'https://a.invalid/',visitedAt:1700000001000}])); openLibrary('bookmarks');`);
    assert.equal(await evaluate(`document.querySelectorAll('#bookmarkItems .saved-bookmark').length`), 2);
    assert.equal(await evaluate(`document.querySelector('#bookmarksBar').hidden`), false);
    assert.equal(await evaluate(`document.querySelector('#bookmarkItems .saved-bookmark').getAttribute('aria-label')`), 'Otvoriť záložku Žltá stránka');
    assert.equal(await evaluate(`document.querySelector('#bookmarkBarEmpty').hidden`), true);
    await evaluate(`savedBookmarks=Array.from({length:18},(_,index)=>({title:'Záložka s dlhým názvom '+index,url:'https://z.invalid/'})); renderSavedBookmarks();`);
    await waitFor(() => evaluate(`!document.querySelector('#bookmarkScrollRight').hidden && !document.querySelector('#bookmarkScrollRight').disabled`));
    await evaluate(`document.querySelector('#bookmarkScrollRight').click();`);
    await waitFor(() => evaluate(`bookmarkItems.scrollLeft > 0 && !document.querySelector('#bookmarkScrollLeft').disabled`));
    await evaluate(`savedBookmarks=[{title:'Žltá stránka',url:'https://z.invalid/'},{title:'Alfa stránka',url:'https://a.invalid/'}]; renderSavedBookmarks();`);
    assert.equal(await evaluate(`document.querySelector('#bookmarkScrollLeft').hidden && document.querySelector('#bookmarkScrollRight').hidden`), true);
    assert.equal(await evaluate(`document.querySelector('.bookmarks-library-page h1').textContent`), 'Moje záložky');
    assert.equal(await evaluate(`document.querySelector('.bookmark-library-grid') !== null`), true);
    assert.equal(await evaluate(`document.querySelector('.library-total strong').textContent`), '2');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-tools select').value='name'; document.querySelector('.tab-surface:not(.inactive-surface) .library-tools select').dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-row .library-open strong').textContent`), 'Alfa stránka');
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-bookmark-row .library-site').textContent`), 'a.invalid');
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-tools input').value='zlta'; document.querySelector('.tab-surface:not(.inactive-surface) .library-tools input').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`document.querySelectorAll('.tab-surface:not(.inactive-surface) .library-row:not([hidden])').length`), 1);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-row:not([hidden]) .library-delete').click();`);
    assert.equal(await evaluate(`savedBookmarks[0].title`), 'Alfa stránka');
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-tools input').value`), 'zlta');
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .library-no-results') !== null`), true);
    await evaluate(`savedBookmarks=[]; renderSavedBookmarks(); openLibrary('bookmarks');`);
    assert.equal(await evaluate(`document.querySelector('.library-empty-bookmarks strong').textContent`), 'Zatiaľ tu nemáš žiadne záložky');
    assert.equal(await evaluate(`document.querySelector('#bookmarkBarEmpty').hidden`), false);
    await evaluate(`savedBookmarks=uiBookmarksBackup; settingsState.showBookmarksBar=uiBookmarksBarBackup; updateBookmarksBar(); renderSavedBookmarks(); openLibrary('history'); document.querySelector('.tab-surface:not(.inactive-surface) .library-tools input').value='alfa'; document.querySelector('.tab-surface:not(.inactive-surface) .library-tools input').dispatchEvent(new Event('input')); document.querySelector('.tab-surface:not(.inactive-surface) .library-row:not([hidden]) .library-delete').click();`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-history')).length`), 1);
    await evaluate(`window.uiWeatherBackup=localStorage.getItem('linsoft-weather-location'); localStorage.removeItem('linsoft-weather-location'); window.weatherTestFail=false; window.weatherLocationCalls=0; window.weatherTestFetch=window.fetch; window.fetch=async (input)=>{const url=String(input); if(url.startsWith('https://api.open-meteo.com/')) {if(!url.includes('latitude=48.15')||!url.includes('longitude=17.11'))throw new Error('Incorrect rounded weather coordinates');if(weatherTestFail)throw new Error('offline test');return {ok:true,json:async()=>({current:{temperature_2m:18,apparent_temperature:17,relative_humidity_2m:62,is_day:1,wind_speed_10m:9,weather_code:2},daily:{temperature_2m_max:[21],temperature_2m_min:[12]}})};} throw new Error('Unexpected weather test URL');}; Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(success){weatherLocationCalls++;success({coords:{latitude:48.1486,longitude:17.1077}});}}}); startPage();`);
    assert.equal(await evaluate(`document.querySelectorAll('.tab-surface:not(.inactive-surface) [data-start-shortcut], .tab-surface:not(.inactive-surface) .recent-sites').length`), 0);
    assert.match(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-first-use').textContent`), /Zistiť počasie.*povoľ prístup k polohe/s);
    assert.match(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-privacy').textContent`), /Open-Meteo/);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) [data-weather-action]').click();`);
    await waitFor(() => evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-temperature').textContent==='18°'`));
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-first-use')`), null);
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-place').textContent`), 'Tvoja poloha');
    assert.equal(await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-range').textContent`), 'Najvyššia 21° · Najnižšia 12°');
    await evaluate(`weatherTestFail=true; document.querySelector('.tab-surface:not(.inactive-surface) [data-weather-action]').click();`);
    await waitFor(() => evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-status').textContent.includes('zobrazené uložené údaje')`));
    await evaluate(`weatherTestFail=false; document.querySelector('.tab-surface:not(.inactive-surface) [data-weather-action]').click();`);
    await waitFor(() => evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-temperature').textContent==='18°'`));
    assert.deepEqual(await evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('linsoft-weather-location'));return {latitude:saved.latitude,longitude:saved.longitude,name:saved.name,temperature:saved.weather.temperature,weatherCode:saved.weather.weatherCode}})()`), { latitude: 48.15, longitude: 17.11, name: 'Tvoja poloha', temperature: 18, weatherCode: 2 });
    await evaluate(`weatherLocationCalls=0; startPage();`);
    await waitFor(() => evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-status').textContent.includes('Open-Meteo')`));
    assert.equal(await evaluate(`weatherLocationCalls`), 0);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) [data-weather-action]').click();`);
    await waitFor(() => evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) .weather-temperature').textContent==='18°'`));
    assert.equal(await evaluate(`weatherLocationCalls`), 0);
    await evaluate(`document.querySelector('.tab-surface:not(.inactive-surface) [data-weather-location]').click();`);
    await waitFor(() => evaluate(`weatherLocationCalls===1 && !document.querySelector('.tab-surface:not(.inactive-surface) [data-weather-location]').disabled`));
    await evaluate(`renderAddressSuggestions('zlta');`);
    assert.equal(await evaluate(`addressSuggestionItems.length`), 1);
    assert.match(await evaluate(`document.querySelector('.address-suggestion-copy small').textContent`), /História/);
    await evaluate(`closeAddressSuggestions(); searchOpenTabs(); document.querySelector('#tabSearchDialog input').value='linsoft'; document.querySelector('#tabSearchDialog input').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`document.querySelector('#tabSearchDialog').open`), true);
    assert.equal(await evaluate(`document.querySelectorAll('[data-select-search-tab]').length > 0`), true);
    await evaluate(`document.querySelector('#tabSearchDialog input').value='no-match-xyz'; document.querySelector('#tabSearchDialog input').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`document.querySelectorAll('[data-select-search-tab]').length`), 0);
    await evaluate(`document.querySelector('#tabSearchDialog input').value=''; document.querySelector('#tabSearchDialog input').dispatchEvent(new Event('input')); document.querySelector('[data-select-search-tab]').click();`);
    await waitFor(() => evaluate(`document.querySelector('#tabSearchDialog') === null`));
    await evaluate(`document.querySelector('#menuButton').click();`);
    assert.equal(await evaluate(`document.querySelector('#menuButton').getAttribute('aria-expanded')`), 'true');
    assert.equal(await evaluate(`document.querySelector('#browserMenu').getBoundingClientRect().top >= document.querySelector('.toolbar').getBoundingClientRect().bottom`), true);
    assert.equal(await evaluate(`document.querySelector('#browserMenu').getBoundingClientRect().right <= innerWidth`), true);
    assert.equal(await evaluate(`document.querySelectorAll('.browser-menu-group').length`), 4);
    assert.equal(await evaluate(`document.querySelectorAll('#browserMenu [data-app-url]').length`), 0);
    assert.equal(await evaluate(`document.querySelector('#menuAppCenter') !== null && document.querySelector('#menuInstallApp').hidden && document.querySelector('#menuClearData').hidden`), true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#menuInstallApp')).display === 'none' && getComputedStyle(document.querySelector('#menuClearData')).display === 'none'`), true);
    assert.equal(await evaluate(`!document.querySelector('#browserMenu .browser-menu-group #menuInstallApp') && !document.querySelector('#browserMenu .browser-menu-group #menuClearData')`), true);
    assert.equal(await evaluate(`document.querySelector('#menuSearchTabs kbd').textContent`), 'Ctrl+Shift+A');
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
    assert.equal(await evaluate(`document.querySelector('#browserMenu').hidden && document.activeElement === document.querySelector('#menuButton')`), true);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true}));`);
    assert.equal(await evaluate(`document.querySelector('#tabSearchDialog').open`), true);
    await evaluate(`document.querySelector('#tabSearchDialog input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); updateConnectionIndicator('http://plain.invalid/');`);
    await waitFor(() => evaluate(`document.querySelector('#tabSearchDialog') === null`));
    assert.match(await evaluate(`document.querySelector('#securityExplanation').textContent`), /nie je šifrovaný/);
    assert.equal(await evaluate(`document.querySelector('#securityOrigin').textContent`), 'plain.invalid');
    await evaluate(`updateConnectionIndicator('linsoft://start');`);
    assert.equal(await evaluate(`document.querySelector('#securityButton').getAttribute('aria-label')`), 'Interná stránka Linsoft');
    assert.equal(await evaluate(`document.querySelector('#securityTitle').textContent`), 'Interná stránka Linsoft');
    assert.equal(await evaluate(`document.querySelector('#securityOrigin').textContent`), 'Interná stránka Linsoft');
    assert.doesNotMatch(await evaluate(`document.querySelector('#securityExplanation').textContent`), /nešifrovaný|nezabezpečený/i);
    await evaluate(`updateConnectionIndicator('https://encrypted.invalid/');`);
    assert.match(await evaluate(`document.querySelector('#securityExplanation').textContent`), /nezaručuje dôveryhodnosť/);
    await evaluate(`if(uiHistoryBackup===null)localStorage.removeItem('linsoft-history');else localStorage.setItem('linsoft-history',uiHistoryBackup);if(uiWeatherBackup===null)localStorage.removeItem('linsoft-weather-location');else localStorage.setItem('linsoft-weather-location',uiWeatherBackup);window.fetch=weatherTestFetch;selectTab(${previousTab});`);
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: library search/sort/deletion, location-based weather, clean start page, address matching, grouped menu and tab overview passed`);
    await waitFor(() => evaluate(`window.linsoftBrowser.getWindowControlState().then(state=>!state.alwaysOnTop)`));
    const initialMaximized = await evaluate(`window.linsoftBrowser.getWindowControlState().then(state=>state.maximized)`);
    assert.equal(await evaluate(`document.querySelector('#maximizeWindow').getAttribute('aria-pressed')`), String(initialMaximized));
    assert.equal(await evaluate(`['minimizeWindow','maximizeWindow','fullscreenWindow','pinWindow','closeWindow'].every(id=>Boolean(document.querySelector('#'+id).getAttribute('aria-label')))`), true);
    await evaluate(`document.querySelector('#maximizeWindow').click();`);
    await waitFor(() => evaluate(`window.linsoftBrowser.getWindowControlState().then(state=>state.maximized!==${initialMaximized})`));
    await waitFor(() => evaluate(`document.querySelector('#maximizeWindow').getAttribute('aria-pressed') === ${JSON.stringify(String(!initialMaximized))}`));
    await waitFor(() => evaluate(`document.querySelector('#maximizeWindow use').getAttribute('href') === ${JSON.stringify(initialMaximized ? '#icon-maximize' : '#icon-window-restore')}`));
    await evaluate(`document.querySelector('#maximizeWindow').click();`);
    await waitFor(() => evaluate(`window.linsoftBrowser.getWindowControlState().then(state=>state.maximized===${initialMaximized})`));
    await evaluate(`document.querySelector('#pinWindow').click();`);
    await waitFor(() => evaluate(`document.querySelector('#pinWindow').getAttribute('aria-pressed')==='true'`));
    assert.equal(await evaluate(`document.querySelector('#pinWindow use').getAttribute('href')`), '#icon-pin');
    await evaluate(`document.querySelector('#pinWindow').click();`);
    await waitFor(() => evaluate(`document.querySelector('#pinWindow').getAttribute('aria-pressed')==='false'`));
    await evaluate(`document.querySelector('#fullscreenWindow').click();`);
    await waitFor(() => evaluate(`window.linsoftBrowser.getWindowControlState().then(state=>state.fullscreen)`));
    await waitFor(() => evaluate(`document.querySelector('#fullscreenWindow').getAttribute('aria-pressed')==='true'`));
    await evaluate(`document.querySelector('#fullscreenWindow').click();`);
    await waitFor(() => evaluate(`document.querySelector('#fullscreenWindow').getAttribute('aria-pressed')==='false'`));
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: actual maximize/restore, always-on-top and full-screen window state synchronization passed`);
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: tab keyboard navigation, middle-click closing and pinned/locked protection passed`);
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: settings search, draft preservation, departure/close guards, save/discard and VPN status passed`);
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: VPN button gating, remembered groups, real local download and unknown-size progress passed`);
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: 15-second warning, stop, tab isolation, Home, error details, Tor states and cancellation passed`);

    const transferUrl = `${url}transfer`;
    const transferTabId = await evaluate(`openNewTab(${JSON.stringify(transferUrl)})`);
    await waitFor(() => evaluate(`tabs.get(${transferTabId})?.url === ${JSON.stringify(transferUrl)} && !document.querySelector('.managed-tab[data-tab-id="${transferTabId}"].loading')`));
    await evaluate(`Object.assign(tabs.get(${transferTabId}),{pinned:true,muted:true,group:'blue',groupName:'Transfer'});updateTabLabel(document.querySelector('.managed-tab[data-tab-id="${transferTabId}"]'));saveSession();`);
    const transferToken = await evaluate(`(()=>{
      const button=document.querySelector('.managed-tab[data-tab-id="${transferTabId}"]');
      const values=new Map();
      const dataTransfer={dropEffect:'none',effectAllowed:'',setData(type,value){values.set(type,value);},getData(type){return values.get(type)||'';}};
      const dispatch=(type,coordinates)=>{
        const event=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperties(event,{dataTransfer:{value:dataTransfer},clientX:{value:coordinates.clientX},clientY:{value:coordinates.clientY},screenX:{value:coordinates.screenX},screenY:{value:coordinates.screenY}});
        button.dispatchEvent(event);
      };
      const tabBounds=button.getBoundingClientRect();
      dispatch('dragstart',{clientX:tabBounds.left+8,clientY:tabBounds.top+8,screenX:window.screenX+tabBounds.left+8,screenY:window.screenY+tabBounds.top+8});
      const token=values.get('application/x-linsoft-tab-transfer');
      dispatch('dragend',{clientX:tabBounds.left+8,clientY:tabBounds.top+8,screenX:window.screenX+window.outerWidth+60,screenY:window.screenY+tabBounds.top+8});
      return token;
    })()`);
    assert.match(transferToken, /^[0-9a-f-]{36}$/i);
    let detachedTarget;
    await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      detachedTarget = targets.find((item) => item.type === 'page' && item.url.includes('index.html') && item.url.includes(`transfer=${transferToken}`) && item.id !== target.id);
      return Boolean(detachedTarget);
    });
    const detachedPage = await connectPage(detachedTarget);
    try {
      await waitFor(() => detachedPage.evaluate(`document.readyState === 'complete' && typeof receiveTabTransfer === 'function'`));
      await waitFor(() => detachedPage.evaluate(`[...tabs.values()].some(tab=>tab.url===${JSON.stringify(transferUrl)})`));
      await waitFor(() => evaluate(`!tabs.has(${transferTabId})`));
      assert.equal(await detachedPage.evaluate(`windowSessionId !== 'main'`), true);
      assert.equal(await detachedPage.evaluate(`tabs.size`), 1);
      assert.equal(await detachedPage.evaluate(`document.querySelectorAll('.managed-tab').length`), 1);
      assert.equal(await detachedPage.evaluate(`[...tabs.values()].some(tab=>tab.url===${JSON.stringify(transferUrl)})`), true);
      assert.equal(await detachedPage.evaluate(`(()=>{const tab=[...tabs.values()].find(item=>item.url===${JSON.stringify(transferUrl)});return Boolean(tab?.pinned&&tab.muted&&tab.group==='blue'&&tab.groupName==='Transfer')})()`), true);
    } finally {
      detachedPage.socket.close();
    }
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: cross-window transfer preserves URL/history/metadata and closes its source after confirmation`);

    const recentlyClosedUrl = `${url}recently-closed`;
    const recentlyClosedId = await evaluate(`openNewTab(${JSON.stringify(recentlyClosedUrl)})`);
    await waitFor(() => evaluate(`tabs.get(${recentlyClosedId})?.url === ${JSON.stringify(recentlyClosedUrl)} && !document.querySelector('.managed-tab[data-tab-id="${recentlyClosedId}"].loading')`));
    await evaluate(`closeTab(${recentlyClosedId})`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('linsoft-closed-tabs')).some(tab=>tab.url===${JSON.stringify(recentlyClosedUrl)})`), true);
    assert.equal(await evaluate(`document.querySelector('#restoreClosedTab').disabled`), false);
    await evaluate('restoreClosedTab()');
    await waitFor(() => evaluate(`tabs.get(activeTabId)?.url === ${JSON.stringify(recentlyClosedUrl)}`));
    assert.equal(await evaluate(`document.querySelector('#restoreClosedTab').disabled`), false);
    assert.equal(await evaluate(`tabs.get(activeTabId).history.includes(${JSON.stringify(recentlyClosedUrl)})`), true);
    console.log(`${nativeTabs ? 'Native tabs' : 'Webview'}: recently closed tabs persist and restore their navigation history`);
  } finally {
    socket?.close();
    child.kill();
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/pending' || req.url === '/headers') return;
  if (req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4c9acf"/><text x="8" y="23" fill="#fff" font-size="21">T</text></svg>');
  }
  if (req.url === '/fullscreen') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><title>Video fullscreen test</title><style>body{margin:0;background:#111}video{width:640px;height:360px;background:#000}button{position:fixed;left:280px;top:380px;width:120px;height:60px;z-index:1}</style><video id="video"></video><button onclick="video.requestFullscreen()">Fullscreen</button><script>document.addEventListener('keydown',event=>{if(event.key.toLowerCase()==='f'){event.preventDefault();document.fullscreenElement?document.exitFullscreen():video.requestFullscreen()}else if(event.key==='Escape'&&document.fullscreenElement){document.exitFullscreen()}})</script>`);
  }
  if (req.url === '/download') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="linsoft-test.txt"', 'Content-Length': Buffer.byteLength('Linsoft download test') });
    return res.end('Linsoft download test');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Navigation UI test</title><h1>Loaded website</h1>${req.url === '/slow' ? '<img src="/pending">' : ''}`);
});
(async () => {
  const port = await listen(server);
  try { await testEngine(true, port); await testEngine(false, port); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
