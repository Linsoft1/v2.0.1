const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAddress, rankAddressSuggestions, createSuggestionIndex, searchSuggestionIndex, normalizeSuggestionLearning, recordSuggestionSelection, suspensionDelay, rankSuspensionCandidates, canSuspendTab, tabActivityScript, tabInspectionScript, scrollRestorationScript } = require('../lib/browser-algorithms.js');
const pageGlobals = { location: { href: 'https://example.com/' }, scrollX: 0, scrollY: 0 };

test('addresses support local servers, IPs, IDNs, paths, queries and fragments', () => {
  for (const [input, expected] of [
    ['example.com', 'https://example.com/'],
    ['EXAMPLE.COM/docs?q=one#two', 'https://example.com/docs?q=one#two'],
    ['localhost:8080?q=one', 'http://localhost:8080/?q=one'],
    ['127.0.0.1:3000#test', 'http://127.0.0.1:3000/#test'],
    ['[::1]:8080/path', 'http://[::1]:8080/path'],
    ['::1', 'http://[::1]/'],
    ['münich.de', 'https://xn--mnich-kva.de/'],
    [`${'a'.repeat(56)}.onion`, `http://${'a'.repeat(56)}.onion/`],
    ['https://example.com/a b', 'https://example.com/a%20b']
  ]) assert.deepEqual(resolveAddress(input), { kind: 'url', url: expected }, input);
});

test('search phrases and dotted non-address text are not mistaken for domains', () => {
  for (const query of ['pocasie Bratislava', 'example.com reviews', 'node.js tutorial', 'v2.0.26', 'hello..world', 'report.pdf notes', '']) {
    assert.deepEqual(resolveAddress(query), { kind: 'search', query }, query);
  }
});

test('invalid explicit addresses, ports, IPs and dangerous schemes are blocked', () => {
  for (const input of ['https://', 'https://user:pass@example.com', 'localhost:99999', '999.1.2.3', '[:::1]', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)']) {
    assert.equal(resolveAddress(input).kind, 'blocked', input);
  }
});

test('suggestions prioritize match strength, then bookmarks, recency and frequency', () => {
  const now = 2000000000000;
  const history = [
    { url: 'https://example.org/', title: 'Example site', visitedAt: now },
    { url: 'https://example.com/', title: 'Exact host', visitedAt: now - 86400000 },
    { url: 'https://weather.test/old', title: 'Počasie Bratislava', visitedAt: now - 864000000, visitCount: 1 },
    { url: 'https://weather.test/new', title: 'Počasie Bratislava', visitedAt: now, visitCount: 20 }
  ];
  const bookmarks = [{ url: 'https://elsewhere.test/', title: 'Article about example.com' }];
  assert.equal(rankAddressSuggestions('example.com', bookmarks, history, now)[0].url, 'https://example.com/');
  assert.equal(rankAddressSuggestions('pocasie bratislava', bookmarks, history, now)[0].url, 'https://weather.test/new');
  assert.equal(rankAddressSuggestions('no match', bookmarks, history, now).length, 0);
});

test('suggestions merge canonical duplicates, keep bookmark titles and reject unsafe entries', () => {
  const bookmarks = [{ url: 'https://example.com', title: 'My bookmark' }, { url: 'javascript:alert(1)', title: 'Unsafe' }];
  const history = [{ url: 'https://example.com/', title: 'Website', visitedAt: 100, visitCount: 3 }, { url: 'https://user:pass@example.com', title: 'Unsafe' }];
  const result = rankAddressSuggestions('', bookmarks, history, 100);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'My bookmark');
  assert.equal(result[0].hasHistory, true);
  assert.equal(result[0].source, 'bookmark');
  assert.equal(result[0].visitCount, 3);
  assert.equal(bookmarks[0].url, 'https://example.com');
  assert.equal(rankAddressSuggestions('', [], Array.from({ length: 20 }, (_, index) => ({ url: `https://example.com/${index}` }))).length, 6);
});

test('suspension requires ten minutes of inactivity and excludes protected tabs', () => {
  const tab = { id: 2, url: 'https://example.com/', inactiveSince: 0 };
  const options = { activeTabId: 1, now: 600000 };
  assert.equal(canSuspendTab(tab, options), true);
  assert.equal(canSuspendTab(tab, { ...options, now: 599999 }), false);
  assert.equal(canSuspendTab({ ...tab, inactiveSince: undefined }, options), false);
  for (const flag of ['pinned', 'locked', 'loading', 'suspended']) assert.equal(canSuspendTab({ ...tab, [flag]: true }, options), false);
  for (const change of [{ activeTabId: 2 }, { playing: true }, { pending: true }]) assert.equal(canSuspendTab(tab, { ...options, ...change }), false);
  for (const url of ['linsoft://settings', 'https://youtube.com/watch?v=x', 'https://docs.google.com/document/d/x', 'https://office.com/', 'https://linsoft.ddns.net/linsoft-offiece/?editor=x', 'https://linsoft.ddns.net/linsoft-chat/']) {
    assert.equal(canSuspendTab({ ...tab, url }, options), false, url);
  }
  assert.equal(canSuspendTab({ ...tab, url: 'https://notyoutube.com/' }, options), true);
});

test('page activity check protects media, capture, editable documents and form data', () => {
  const busy = (media, elements) => vm.runInNewContext(tabActivityScript, { ...pageGlobals, document: { querySelectorAll: selector => selector === 'video,audio' ? media : selector === 'iframe,frame' ? [] : elements } });
  assert.equal(busy([], []), false);
  assert.equal(busy([{ paused: false }], []), true);
  assert.equal(busy([{ paused: true, srcObject: { getTracks: () => [{ readyState: 'live' }] } }], []), true);
  for (const element of [
    { isContentEditable: true },
    { tagName: 'TEXTAREA', value: 'draft' },
    { tagName: 'INPUT', type: 'text', value: 'draft' },
    { tagName: 'INPUT', type: 'checkbox', checked: true, defaultChecked: false },
    { tagName: 'SELECT', options: [{ selected: true, defaultSelected: false }] }
  ]) assert.equal(busy([], [element]), true);
  assert.equal(busy([{ paused: true }], [{ tagName: 'INPUT', type: 'hidden', value: 'csrf' }]), false);
});

test('suggestions tolerate one edit or transposition without outranking literal matches', () => {
  const bookmarks = [{ url: 'https://youtube.com/', title: 'YouTube' }, { url: 'https://literal.test/', title: 'youtbe' }];
  for (const query of ['youtbe', 'youttube', 'youtubr', 'yuotube']) {
    assert.equal(rankAddressSuggestions(query, [bookmarks[0]], [])[0].url, bookmarks[0].url);
  }
  assert.equal(rankAddressSuggestions('youtbe', bookmarks, [])[0].url, bookmarks[1].url);
  assert.equal(rankAddressSuggestions('yt', [bookmarks[0]], []).length, 0);
  assert.equal(rankAddressSuggestions('yozbe', [bookmarks[0]], []).length, 0);
  assert.deepEqual(resolveAddress('youtbe'), { kind: 'search', query: 'youtbe' });
});

test('prepared index is reusable and merges open tabs without inventing history', () => {
  const index = createSuggestionIndex([{ url: 'https://example.com', title: 'Bookmark' }], []);
  const before = JSON.stringify(index);
  const tabs = [
    { id: 1, url: 'https://active.test/', title: 'Active' },
    { id: 2, url: 'https://example.com/', title: 'Page' },
    { id: 3, url: 'https://example.com/', title: 'Duplicate' },
    { id: 4, url: 'javascript:alert(1)', title: 'Unsafe' }
  ];
  const result = searchSuggestionIndex('bookmark', index, 100, tabs, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].tabId, 2);
  assert.equal(result[0].hasHistory, false);
  assert.equal(result[0].title, 'Bookmark');
  assert.equal(searchSuggestionIndex('active', index, 100, tabs, 1).length, 0);
  assert.equal(JSON.stringify(index), before);
  const history = createSuggestionIndex([], [{ url: 'https://example.com/', title: 'Page' }]);
  assert.equal(searchSuggestionIndex('page', history, 100, tabs, 1)[0].hasHistory, true);
  const large = createSuggestionIndex([], Array.from({ length: 10000 }, (_, id) => ({ url: `https://example.com/${id}`, title: `Article ${id}` })));
  assert.equal(searchSuggestionIndex('article 9999', large)[0].url, 'https://example.com/9999');
});

test('memory policy applies exact 5, 10 and 20 minute boundaries and rejects invalid measurements', () => {
  for (const [free, delay] of [[14, 300000], [15, 600000], [39, 600000], [40, 1200000], [100, 1200000]]) {
    assert.equal(suspensionDelay({ total: 100, free }), delay);
    const tab = { id: 2, url: 'https://example.com/', inactiveSince: 0 };
    assert.equal(canSuspendTab(tab, { activeTabId: 1, delay, now: delay - 1 }), false);
    assert.equal(canSuspendTab(tab, { activeTabId: 1, delay, now: delay }), true);
    assert.equal(canSuspendTab(tab, { activeTabId: 1, delay, now: delay, protectedOrigins: ['https://example.com'] }), false);
    assert.equal(canSuspendTab(tab, { activeTabId: 1, delay, now: delay, protectedOrigins: ['https://other.test'] }), true);
  }
  for (const memory of [null, {}, { total: 0, free: 0 }, { total: 100, free: -1 }, { total: 100, free: 101 }, { total: Infinity, free: 10 }]) assert.throws(() => suspensionDelay(memory));
});

test('activity checks inspect same-origin frames and protect inaccessible frames and edited pages', () => {
  const doc = (frames = [], edited = false, elements = []) => ({
    documentElement: { hasAttribute: () => edited },
    querySelectorAll: selector => selector === 'iframe,frame' ? frames : selector === 'video,audio' ? [] : elements
  });
  const busy = document => vm.runInNewContext(tabActivityScript, { ...pageGlobals, document });
  assert.equal(busy(doc([{ contentDocument: doc() }])), false);
  assert.equal(busy(doc([{ contentDocument: doc([], false, [{ tagName: 'TEXTAREA', value: 'draft' }]) }])), true);
  assert.equal(busy(doc([{ contentDocument: null }])), true);
  assert.equal(busy(doc([{ get contentDocument() { throw new Error('Cross origin'); } }])), true);
  assert.equal(busy(doc([], true)), true);
});

test('activity preload remembers trusted edits even after fields are cleared, without exposing APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'page-activity-preload.cjs'), 'utf8');
  for (const protocol of ['https:', 'http:', 'file:']) {
    const listeners = {};
    let marked = false;
    vm.runInNewContext(source, {
      require: () => ({ contextBridge: { executeInMainWorld() {} }, ipcRenderer: { send() {} } }),
      location: { protocol },
      document: {
        addEventListener: (name, callback) => { listeners[name] = callback; },
        documentElement: {
          setAttribute: (name) => { assert.equal(name, 'data-linsoft-edited'); marked = true; },
          hasAttribute: name => name === 'data-linsoft-edited' && marked
        }
      }
    });
    if (protocol === 'file:') { assert.deepEqual(listeners, {}); continue; }
    const target = { matches: () => true };
    listeners.input({ isTrusted: false, target });
    assert.equal(marked, false);
    listeners.change({ isTrusted: true, target });
    assert.equal(marked, true);
  }
});

test('learning is bounded, canonical, query-specific and cannot outrank stronger literal matches', () => {
  const now = 2000000000000;
  const bookmarks = [{ url: 'https://one.test/', title: 'Weather forecast' }, { url: 'https://two.test/', title: 'Weather forecast' }];
  const index = createSuggestionIndex(bookmarks, []);
  const baseline = searchSuggestionIndex('weather', index, now);
  const chosen = baseline[1].url;
  let learned = recordSuggestionSelection([], 'Wéather', chosen, now);
  learned = recordSuggestionSelection(learned, 'weather', chosen, now);
  assert.equal(learned[0].count, 2);
  assert.equal(searchSuggestionIndex('weather', index, now, [], null, learned)[0].url, chosen);
  assert.equal(searchSuggestionIndex('forecast', index, now, [], null, learned)[0].url, baseline[0].url);
  const stronger = createSuggestionIndex([...bookmarks, { url: 'https://exact.test/', title: 'weather' }], []);
  assert.equal(searchSuggestionIndex('weather', stronger, now, [], null, learned)[0].url, 'https://exact.test/');
  assert.equal(normalizeSuggestionLearning([{ query: 'x', url: 'javascript:alert(1)', count: 1, selectedAt: now }]).length, 0);
  assert.equal(normalizeSuggestionLearning([{ query: 'x', url: 'https://example.com/', count: Infinity, selectedAt: now }]).length, 0);
  for (let i = 0; i < 250; i++) learned = recordSuggestionSelection(learned, `query ${i}`, 'https://example.com', now + i);
  assert.equal(learned.length, 200);
  assert.equal(learned[0].query, 'query 249');
  assert.equal(learned[0].url, 'https://example.com/');
  assert.deepEqual(recordSuggestionSelection(learned, '', 'https://example.com/'), learned);
});

test('suspension prioritizes measured memory fairly for shared processes, then age', () => {
  const tabs = [{ id: 1, inactiveSince: 10 }, { id: 2, inactiveSince: 20 }, { id: 3, inactiveSince: 0 }];
  const measured = [{ tabId: 1, memoryBytes: 200, sharedTabs: 4 }, { tabId: 2, memoryBytes: 100, sharedTabs: 1 }];
  assert.deepEqual(rankSuspensionCandidates(tabs, measured).map(tab => tab.id), [2, 1, 3]);
  assert.deepEqual(rankSuspensionCandidates(tabs).map(tab => tab.id), [3, 1, 2]);
  assert.equal(tabs[0].id, 1);
});

test('scroll restoration waits for layout, rejects invalid positions and respects navigation/user input', async () => {
  const target = { url: pageGlobals.location.href, x: 0, y: 800 };
  for (const mode of ['layout', 'navigation', 'input', 'timeout']) {
    let time = 0;
    const listeners = new Map();
    const context = {
      ...pageGlobals, location: { ...pageGlobals.location }, Date: { now: () => time },
      document: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
      window: { scrollTo: position => { context.scrollY = mode === 'layout' && time >= 200 ? position.top : 0; } },
      setTimeout: callback => {
        time += 100;
        if (mode === 'navigation') context.location.href = 'https://different.test/';
        if (mode === 'input') listeners.get('wheel')();
        callback();
      }
    };
    assert.equal(await vm.runInNewContext(scrollRestorationScript(target), context), mode === 'layout' ? true : mode === 'input' ? null : false);
    assert.equal(listeners.size, 0);
    if (mode === 'layout') assert.equal(context.scrollY, 800);
  }
  for (const target of [null, { url: 'https://example.com', x: -1, y: 1 }, { url: 'https://example.com', x: 0, y: Infinity }]) assert.throws(() => scrollRestorationScript(target));
});

test('inspection returns call, capture, transfer and scroll details without changing the page', () => {
  for (const reason of ['call', 'capture', 'transfer']) {
    const result = vm.runInNewContext(tabInspectionScript, {
      ...pageGlobals, scrollY: 700,
      document: { documentElement: { hasAttribute: name => name === `data-linsoft-${reason}` }, querySelectorAll: () => [] }
    });
    assert.equal(result.reason, reason);
    assert.equal(result.y, 700);
    assert.equal(result.url, pageGlobals.location.href);
  }
});

test('main-world tracking protects peers, capture and uploads and releases finished activity', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'page-activity-preload.cjs'), 'utf8');
  const listeners = new Map();
  const attributes = new Set();
  const reports = [];
  let resolveFetch;
  let resolveCapture;
  class Peer {
    constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.listeners = {}; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    close() { this.signalingState = 'closed'; }
  }
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
  class Request { constructor() { this.method = 'POST'; } }
  class Xhr {
    constructor() { this.listeners = {}; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    removeEventListener(name) { delete this.listeners[name]; }
    send() {}
  }
  const context = vm.createContext({
    location: { protocol: 'https:' }, Event: class { constructor(type) { this.type = type; } }, Request,
    window: { RTCPeerConnection: Peer, XMLHttpRequest: Xhr, fetch: () => new Promise(resolve => { resolveFetch = resolve; }) },
    navigator: { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { resolveCapture = resolve; }) } },
    document: {
      documentElement: {
        toggleAttribute: (name, enabled) => enabled ? attributes.add(name) : attributes.delete(name),
        hasAttribute: name => attributes.has(name)
      },
      addEventListener: (name, fn) => listeners.set(name, fn),
      dispatchEvent: event => listeners.get(event.type)?.()
    },
    require: () => ({
      contextBridge: { executeInMainWorld: ({ func }) => vm.runInContext(`(${func.toString()})()`, context) },
      ipcRenderer: { send: (_channel, state) => reports.push(state) }
    })
  });
  vm.runInContext(source, context);
  const peer = new context.window.RTCPeerConnection();
  assert.equal(reports.at(-1).call, true);
  peer.close();
  assert.equal(reports.at(-1).call, false);
  const capture = context.navigator.mediaDevices.getDisplayMedia();
  assert.equal(reports.at(-1).capture, true);
  resolveCapture({ getTracks: () => [track] });
  await capture;
  assert.equal(reports.at(-1).capture, true);
  track.stop();
  assert.equal(reports.at(-1).capture, false);
  const upload = context.window.fetch('https://example.com/', { method: 'POST' });
  assert.equal(reports.at(-1).transfer, true);
  resolveFetch('ok');
  assert.equal(await upload, 'ok');
  assert.equal(reports.at(-1).transfer, false);
  const xhr = new context.window.XMLHttpRequest();
  xhr.send();
  assert.equal(reports.at(-1).transfer, true);
  xhr.listeners.loadend();
  assert.equal(reports.at(-1).transfer, false);
});
