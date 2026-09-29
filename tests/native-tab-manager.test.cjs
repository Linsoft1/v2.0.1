const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeTabManager } = require('../lib/native-tab-manager.cjs');

class FakeWebContents extends EventEmitter {
  loadURL(url) { this.url = url; }
  close() { this.closed = true; }
}

class FakeWebContentsView {
  constructor() { this.webContents = new FakeWebContents(); }
  setBounds(bounds) { this.bounds = bounds; }
}

test('native tab manager activates one view and preserves its bounds', () => {
  const children = new Set();
  const window = { contentView: { addChildView: (view) => children.add(view), removeChildView: (view) => children.delete(view) } };
  const manager = new NativeTabManager({ window, WebContentsView: FakeWebContentsView, createWebPreferences: () => ({}), onEvent: () => {} });
  manager.setBounds({ x: 0, y: 100, width: 800, height: 600 });
  const first = manager.load(1, 'https://example.com');
  manager.activate(1);
  assert.equal(first.webContents.url, 'https://example.com');
  assert.deepEqual(first.bounds, { x: 0, y: 100, width: 800, height: 600 });
  manager.load(2, 'https://example.org');
  manager.activate(2);
  assert.equal(children.size, 1);
  manager.destroy(2);
  assert.equal(children.size, 0);
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