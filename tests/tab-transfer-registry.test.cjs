const test = require('node:test');
const assert = require('node:assert/strict');
const { TabTransferRegistry } = require('../lib/tab-transfer-registry.cjs');

const token = '12345678-1234-1234-1234-123456789abc';

test('tab transfer can only be claimed and completed by a different claiming window', () => {
  const registry = new TabTransferRegistry();
  const tab = { url: 'https://example.com/' };
  assert.equal(registry.register(token, { sourceId: 1, tabId: 7, tab }), true);
  assert.equal(registry.claim(token, 1), null);
  assert.deepEqual(registry.claim(token, 2), tab);
  assert.equal(registry.claim(token, 3), null);
  assert.equal(registry.complete(token, 3), null);
  assert.deepEqual(registry.complete(token, 2), { sourceId: 1, tabId: 7, url: tab.url });
  assert.equal(registry.claim(token, 2), null);
});

test('tab transfer registrations expire and registry capacity is bounded', () => {
  let now = 100;
  const registry = new TabTransferRegistry({ ttlMs: 50, maxEntries: 1, now: () => now });
  assert.equal(registry.register(token, { sourceId: 1, tabId: 2, tab: { url: 'https://example.com/' } }), true);
  assert.equal(registry.register('22345678-1234-1234-1234-123456789abc', { sourceId: 1, tabId: 3, tab: { url: 'https://example.org/' } }), false);
  now = 151;
  assert.equal(registry.claim(token, 2), null);
  assert.equal(registry.register('22345678-1234-1234-1234-123456789abc', { sourceId: 1, tabId: 3, tab: { url: 'https://example.org/' } }), true);
});
