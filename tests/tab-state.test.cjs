const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSessionTabs, recordNavigation } = require('../lib/tab-state.js');

test('navigation state tracks back, forward, and new routes without losing forward entries', () => {
  const tab = { url: 'https://a.example/', history: ['https://a.example/', 'https://b.example/'], historyIndex: 1 };
  assert.equal(recordNavigation(tab, 'https://a.example/', { historyIndex: 0 }), true);
  assert.deepEqual(tab.history, ['https://a.example/', 'https://b.example/']);
  assert.equal(tab.historyIndex, 0);
  recordNavigation(tab, 'https://b.example/', { historyIndex: 1 });
  assert.equal(tab.historyIndex, 1);
  recordNavigation(tab, 'https://c.example/');
  assert.deepEqual(tab.history, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
  assert.equal(tab.historyIndex, 2);
});

test('navigation state avoids duplicate current entries and safely branches after back navigation', () => {
  const tab = { url: 'https://b.example/', history: ['https://a.example/', 'https://b.example/', 'https://c.example/'], historyIndex: 1 };
  assert.equal(recordNavigation(tab, 'https://b.example/'), false);
  recordNavigation(tab, 'https://d.example/');
  assert.deepEqual(tab.history, ['https://a.example/', 'https://b.example/', 'https://d.example/']);
  assert.equal(tab.historyIndex, 2);
});

test('same-document navigations append routes and history traversal selects an earlier route', () => {
  const first = 'https://example.com/page#first';
  const second = 'https://example.com/page#second';
  const tab = { url: first, history: [first], historyIndex: 0 };
  recordNavigation(tab, second);
  recordNavigation(tab, first, { historyIndex: 0 });
  assert.deepEqual(tab.history, [first, second]);
  assert.equal(tab.historyIndex, 0);
});

test('navigating directly to a previously visited route appends a new history entry', () => {
  const first = 'https://example.com/first';
  const second = 'https://example.com/second';
  const tab = { url: second, history: [first, second], historyIndex: 1 };

  recordNavigation(tab, first);

  assert.deepEqual(tab.history, [first, second, first]);
  assert.equal(tab.historyIndex, 2);
});

test('history traversal selects the requested matching entry including duplicate URLs', () => {
  const repeated = 'https://example.com/page';
  const next = 'https://example.com/next';
  const tab = { url: repeated, history: [repeated, next, repeated], historyIndex: 2 };

  recordNavigation(tab, repeated, { historyIndex: 0 });

  assert.deepEqual(tab.history, [repeated, next, repeated]);
  assert.equal(tab.historyIndex, 0);
});

test('session restoration filters unsafe entries and normalizes tab identity and history', () => {
  const tabs = normalizeSessionTabs([
    { id: 9, url: 'https://safe.example/', history: ['javascript:alert(1)', 'https://safe.example/'], historyIndex: 99, muted: true, group: 'red', title: 'Safe' },
    { id: 9, url: 'https://other.example/', history: ['https://other.example/'], group: 'unexpected', pinned: 'yes' },
    { id: 12, url: 'javascript:alert(1)' },
    null
  ], (url) => /^https:\/\//.test(url));

  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].id, 1);
  assert.equal(tabs[0].historyIndex, 0);
  assert.deepEqual(tabs[0].history, ['https://safe.example/']);
  assert.equal(tabs[0].muted, true);
  assert.equal(tabs[0].group, 'red');
  assert.equal(tabs[1].id, 9);
  assert.equal(tabs[1].group, '');
  assert.equal(tabs[1].pinned, false);
});

test('session restoration assigns ID 1 to the first valid tab after filtering', () => {
  const tabs = normalizeSessionTabs([
    { id: 4, url: 'javascript:alert(1)' },
    { id: 9, url: 'https://safe.example/' },
    { id: 9, url: 'https://other.example/' }
  ], (url) => /^https:\/\//.test(url));

  assert.deepEqual(tabs.map((tab) => tab.id), [1, 9]);
});

test('session restoration preserves explicit crash recovery without persisting runtime scroll state', () => {
  const result = normalizeSessionTabs([
    { id: 1, url: 'https://example.com/', crashed: true, crashReason: 'crashed', scrollPosition: { y: 900 }, loaded: true },
    { id: 2, url: 'https://other.example/', crashed: 'yes', crashReason: 'wrong' }
  ], url => url.startsWith('https://'));
  assert.equal(result[0].crashed, true);
  assert.equal(result[0].crashReason, 'crashed');
  assert.equal(result[0].scrollPosition, undefined);
  assert.equal(result[0].loaded, undefined);
  assert.equal(result[1].crashed, false);
  assert.equal(result[1].crashReason, '');
});
