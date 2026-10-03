const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  canAutoCheckForUpdates,
  formatUpdateFailure,
  getPermissionDecision,
  getUpdateStatus,
  isSafeLocalHtmlUrl,
  isSafeWebUrl,
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

test('local document URLs accept only existing HTML files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-html-'));
  const htmlPath = path.join(directory, 'sample page.html');
  const textPath = path.join(directory, 'notes.txt');
  fs.writeFileSync(htmlPath, '<!doctype html><title>Local page</title>');
  fs.writeFileSync(textPath, 'not HTML');
  try {
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(htmlPath).href), true);
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(textPath).href), false);
    assert.equal(isSafeLocalHtmlUrl(pathToFileURL(path.join(directory, 'missing.html')).href), false);
    assert.equal(isSafeLocalHtmlUrl('https://example.com/index.html'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});