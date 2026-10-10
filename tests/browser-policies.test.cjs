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

test('automatic update checks only run in eligible packaged Windows states', () => {
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'win32', enabled: true, status: 'idle' }), true);
  assert.equal(canAutoCheckForUpdates({ isPackaged: false, platform: 'win32', enabled: true, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'linux', enabled: true, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'win32', enabled: false, status: 'idle' }), false);
  assert.equal(canAutoCheckForUpdates({ isPackaged: true, platform: 'win32', enabled: true, status: 'downloading' }), false);
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