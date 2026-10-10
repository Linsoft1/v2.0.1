const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeTabManager } = require('../lib/native-tab-manager.cjs');

class FakeWebContents extends EventEmitter {
  loadURL(url) { this.url = url; return Promise.resolve(); }
  setAudioMuted(muted) { this.muted = muted; }
  close() { this.closed = true; }
}

class FakeWebContentsView {
  constructor() { this.webContents = new FakeWebContents(); }
  setBounds(bounds) { this.bounds = bounds; }
}

test('native tab manager signals document readiness for scroll restoration', () => {
  const events = [];
  const window = { contentView: { addChildView() {}, removeChildView() {} } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: (...event) => events.push(event) });
  const view = manager.load(1, 'https://example.com/');
  view.webContents.emit('did-finish-load');
  assert.deepEqual(events, [[1, 'ready']]);
});
test('native tab manager activates one view and preserves its bounds', () => {
  const children = new Set();
  const removed = [];
  const window = { contentView: {
    addChildView: (view) => children.add(view),
    removeChildView: (view) => { removed.push(view); children.delete(view); }
  } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: () => {} });
  manager.setBounds({ x: 0, y: 100, width: 800, height: 600 });
  const first = manager.load(1, 'https://example.com');
  manager.activate(1);
  assert.equal(first.webContents.url, 'https://example.com');
  assert.deepEqual(first.bounds, { x: 0, y: 100, width: 800, height: 600 });
  manager.activate(1);
  assert.deepEqual(removed, []);
  manager.load(2, 'https://example.org');
  manager.activate(2);
  assert.equal(children.size, 1);
  assert.deepEqual(removed, [first]);
  manager.destroy(2);
  assert.equal(children.size, 0);
  assert.equal(manager.activeTabId, null);
  assert.equal(manager.views.size, 1);
  assert.equal(first.webContents.closed, undefined);
  assert.equal(manager.views.get(2), undefined);
});

test('native tab manager destroys detached views without removing them from the window', () => {
  let removeCount = 0;
  const window = { contentView: { addChildView() {}, removeChildView() { removeCount += 1; } } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: () => {} });
  const first = manager.load(1, 'https://example.com');
  const second = manager.load(2, 'https://example.org');
  manager.activate(1);
  manager.destroy(2);
  assert.equal(removeCount, 0);
  assert.equal(second.webContents.closed, true);
  manager.destroyAll();
  manager.destroyAll();
  assert.equal(removeCount, 1);
  assert.equal(first.webContents.closed, true);
  assert.equal(manager.views.size, 0);
  assert.equal(manager.activeTabId, null);
});

test('native tab manager suspends detached tabs and refuses to suspend the active tab', () => {
  let removeCount = 0;
  const window = { contentView: { addChildView() {}, removeChildView() { removeCount += 1; } } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: () => {} });
  const first = manager.load(1, 'https://example.com');
  manager.load(2, 'https://example.org');
  manager.activate(1);
  assert.equal(manager.suspend(1), false);
  assert.equal(manager.suspend(2), true);
  assert.equal(manager.views.has(2), false);
  assert.equal(manager.views.has(1), true);
  assert.equal(first.webContents.closed, undefined);
  assert.equal(removeCount, 0);
});

test('native tab manager reports main-frame navigation failures', () => {
  const events = [];
  const window = { contentView: { addChildView() {}, removeChildView() {} } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: (...event) => events.push(event) });
  const view = manager.load(1, 'https://example.com');
  view.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.com', true);
  view.webContents.emit('did-fail-load', {}, -3, 'ABORTED', 'https://example.com', false);
  assert.deepEqual(events.at(-1), [1, 'failed', { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://example.com' }]);
});

test('native tab manager applies mute state and forwards media playback events', () => {
  const events = [];
  const window = { contentView: { addChildView() {}, removeChildView() {} } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: (...event) => events.push(event) });
  const view = manager.load(1, 'https://example.com', { muted: true });
  view.webContents.emit('media-started-playing');
  view.webContents.emit('media-paused');
  assert.equal(view.webContents.muted, true);
  assert.deepEqual(events.slice(-2), [[1, 'media-started-playing'], [1, 'media-paused']]);
});

test('native tab manager recreates a view when the required document plugin mode changes', () => {
  const manager = new NativeTabManager({
    window: { contentView: { addChildView() {}, removeChildView() {} } },
    WebContentsView: FakeWebContentsView,
    createWebPreferences: (url) => ({ plugins: /\.pdf$/i.test(url || '') }),
    onEvent: () => {}
  });
  const webView = manager.load(1, 'https://example.com');
  const pdfView = manager.load(1, 'file:///document.pdf');
  assert.notEqual(webView, pdfView);
  assert.equal(webView.webContents.closed, true);
  assert.equal(pdfView.__pdfPluginMode, true);
  const nextWebView = manager.load(1, 'https://example.org');
  assert.notEqual(pdfView, nextWebView);
  assert.equal(pdfView.webContents.closed, true);
  assert.equal(nextWebView.__pdfPluginMode, false);
});

test('native tab manager reports load rejections without duplicating did-fail-load', async () => {
  const events = [];
  class RejectingView extends FakeWebContentsView {
    constructor() {
      super();
      this.webContents.loadURL = (url) => {
        this.webContents.url = url;
        return Promise.resolve().then(() => {
          this.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', url, true);
          throw new Error('NAME_NOT_RESOLVED');
        });
      };
    }
  }
  const window = { contentView: { addChildView() {}, removeChildView() {} } };
  const manager = new NativeTabManager({ window, WebContentsView: RejectingView, createWebPreferences: () => ({}), onEvent: (...event) => events.push(event) });
  manager.load(1, 'https://example.com');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event[1] === 'failed'), [
    [1, 'failed', { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://example.com' }]
  ]);
});

test('native tab manager reports load promise failures without a did-fail-load event', async () => {
  const events = [];
  class RejectingView extends FakeWebContentsView {
    constructor() {
      super();
      this.webContents.loadURL = async (url) => {
        this.webContents.url = url;
        throw new Error('Load was rejected');
      };
    }
  }
  const window = { contentView: { addChildView() {}, removeChildView() {} } };
  const manager = new NativeTabManager({ window, WebContentsView: RejectingView, createWebPreferences: () => ({}), onEvent: (...event) => events.push(event) });
  manager.load(1, 'https://example.com');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event[1] === 'failed'), [
    [1, 'failed', { errorCode: -2, errorDescription: 'Load was rejected', validatedURL: 'https://example.com' }]
  ]);
});

test('native tab manager detaches and destroys crashed tabs before reporting the crash', () => {
  const events = [];
  const children = new Set();
  const window = { contentView: { addChildView: (view) => children.add(view), removeChildView: (view) => children.delete(view) } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: (...event) => events.push(event) });
  const view = manager.load(1, 'https://example.com');
  manager.activate(1);
  view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(manager.views.has(1), false);
  assert.equal(manager.activeTabId, null);
  assert.equal(view.webContents.closed, true);
  assert.equal(children.size, 0);
  assert.deepEqual(events.at(-1), [1, 'crashed', { reason: 'crashed' }]);
});