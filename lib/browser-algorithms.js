(function exposeBrowserAlgorithms(root) {
  function resolveAddress(value) {
    const input = String(value || '').trim();
    if (!input) return { kind: 'search', query: input };
    if (/^(?:javascript|data|vbscript):/i.test(input)) return { kind: 'blocked', message: 'Tento typ adresy je z bezpečnostných dôvodov zablokovaný.' };
    const explicit = /^https?:\/\//i.test(input);
    const authority = input.split(/[/?#]/, 1)[0];
    const local = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?$/i.test(authority);
    const rawIpv6 = /^[\da-f:]+$/i.test(input) && input.includes(':');
    const domain = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]+)(?::\d+)?$/iu.test(authority);
    const onion = /^[a-z2-7]{56}\.onion(?::\d+)?$/i.test(authority);
    if (!explicit && !local && !rawIpv6 && !domain) return { kind: 'search', query: input };
    if (/\s/.test(authority) || (!explicit && /\s/.test(input))) return { kind: 'search', query: input };
    try {
      const parsed = new URL(explicit ? input : rawIpv6 ? `http://[${input}]` : `${local || onion ? 'http' : 'https'}://${input}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('Invalid URL');
      return { kind: 'url', url: parsed.href };
    } catch {
      return { kind: 'blocked', message: 'Webová adresa nie je platná. Skontroluj doménu, IP adresu a port.' };
    }
  }

  function foldText(value) {
    return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  }

  function createSuggestionIndex(bookmarks, history) {
    const candidates = new Map();
    const add = (item, bookmarked) => {
      if (!item || typeof item.url !== 'string') return;
      let url;
      try {
        url = new URL(item.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      } catch { return; }
      const existing = candidates.get(url.href);
      const isBookmark = bookmarked || existing?.source === 'bookmark';
      candidates.set(url.href, {
        url: !bookmarked ? item.url : existing?.hasHistory ? existing.url : item.url,
        title: bookmarked ? String(item.title || url.href) : existing?.source === 'bookmark' ? existing.title : String(item.title || url.href),
        source: isBookmark ? 'bookmark' : 'history',
        hasHistory: !bookmarked || existing?.hasHistory === true,
        visitedAt: Math.max(existing?.visitedAt || 0, Number.isFinite(Number(item.visitedAt)) ? Number(item.visitedAt) : 0),
        visitCount: Math.max(existing?.visitCount || 0, Number.isFinite(Number(item.visitCount)) ? Number(item.visitCount) : 0),
        hostname: url.hostname.replace(/^www\./, ''),
        canonicalUrl: url.href
      });
    };
    if (Array.isArray(bookmarks)) bookmarks.forEach((item) => add(item, true));
    if (Array.isArray(history)) history.forEach((item) => add(item, false));
    return [...candidates.values()].map(item => ({
      ...item, foldedTitle: foldText(item.title), foldedUrl: foldText(item.url),
      foldedHost: foldText(item.hostname), words: foldText(`${item.title} ${item.hostname}`).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    }));
  }

  function oneEditApart(left, right) {
    if (left.length < 4 || Math.abs(left.length - right.length) > 1) return false;
    if (left.length === right.length) {
      const differences = [...left].flatMap((letter, index) => letter !== right[index] ? [index] : []);
      return differences.length <= 1 || differences.length === 2 &&
        differences[1] === differences[0] + 1 &&
        left[differences[0]] === right[differences[1]] && left[differences[1]] === right[differences[0]];
    }
    const shorter = left.length < right.length ? left : right;
    const longer = left.length < right.length ? right : left;
    let index = 0;
    while (index < shorter.length && shorter[index] === longer[index]) index += 1;
    return shorter.slice(index) === longer.slice(index + 1);
  }

  function searchSuggestionIndex(query, index, now = Date.now(), openTabs = [], activeTabId, learned = []) {
    const candidates = new Map(index.map(item => [item.canonicalUrl, item]));
    for (const tab of openTabs) {
      if (tab.id === activeTabId) continue;
      const item = createSuggestionIndex([], [tab])[0];
      if (!item) continue;
      const key = item.canonicalUrl;
      if (candidates.get(key)?.tabId !== undefined) continue;
      candidates.set(key, { ...item, hasHistory: false, ...candidates.get(key), tabId: tab.id });
    }
    const normalized = foldText(query).trim();
    const preferences = normalizeSuggestionLearning(learned).filter(entry => entry.query === normalized);
    const parts = normalized.split(/\s+/).filter(Boolean);
    return [...candidates.values()].flatMap((item) => {
      const { foldedTitle: title, foldedUrl: url, foldedHost: hostname } = item;
      const text = `${title} ${url} ${hostname}`;
      const exactParts = parts.every(part => text.includes(part));
      if (!exactParts && !parts.every(part => text.includes(part) || item.words.some(word => oneEditApart(part, word)))) return [];
      const match = !exactParts ? 100 : !normalized ? 0 : url === normalized || hostname === normalized ? 1000 : title === normalized ? 900 : hostname.startsWith(normalized) ? 800 : title.startsWith(normalized) ? 700 : url.startsWith(normalized) ? 600 : 400;
      const ageDays = Math.max(0, now - item.visitedAt) / 86400000;
      const preference = preferences.find(entry => entry.url === item.canonicalUrl);
      const learningBonus = preference ? Math.min(80, Math.log2(1 + preference.count) * 20) / (1 + Math.max(0, now - preference.selectedAt) / (90 * 86400000)) : 0;
      const score = match + learningBonus + (item.tabId !== undefined ? 40 : 0) + (item.source === 'bookmark' ? 35 : 0) + 30 / (1 + ageDays) + Math.min(25, Math.log2(1 + Math.max(0, item.visitCount)) * 5);
      return [{ ...item, score, matchStrength: match, typo: !exactParts }];
    }).sort((left, right) => right.matchStrength - left.matchStrength || right.score - left.score || right.visitedAt - left.visitedAt || left.url.localeCompare(right.url)).slice(0, 6);
  }

  function normalizeSuggestionLearning(entries) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    return entries.flatMap(entry => {
      if (!entry || typeof entry.query !== 'string' || !entry.query.trim() || entry.query.length > 200 || !Number.isFinite(entry.count) || entry.count < 1 || !Number.isFinite(entry.selectedAt) || entry.selectedAt < 0) return [];
      let url;
      try {
        url = new URL(entry.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      } catch { return []; }
      const query = foldText(entry.query).trim();
      const key = JSON.stringify([query, url.href]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ query, url: url.href, count: Math.min(1000, Math.floor(entry.count)), selectedAt: entry.selectedAt }];
    }).sort((left, right) => right.selectedAt - left.selectedAt).slice(0, 200);
  }

  function recordSuggestionSelection(entries, query, url, now = Date.now()) {
    const normalized = foldText(query).trim();
    const current = normalizeSuggestionLearning(entries);
    if (!normalized || normalized.length > 200) return current;
    const candidate = normalizeSuggestionLearning([{ query: normalized, url, count: 1, selectedAt: now }])[0];
    if (!candidate) return current;
    const existing = current.find(entry => entry.query === normalized && entry.url === candidate.url);
    candidate.count = Math.min(1000, (existing?.count || 0) + 1);
    return [candidate, ...current.filter(entry => entry !== existing)].slice(0, 200);
  }

  function rankAddressSuggestions(query, bookmarks, history, now = Date.now()) {
    return searchSuggestionIndex(query, createSuggestionIndex(bookmarks, history), now);
  }

  const tabInspectionScript = `(() => {
    const reason = (doc) => {
      if (doc.documentElement?.hasAttribute('data-linsoft-edited')) return 'edited';
      for (const kind of ['call', 'capture', 'transfer']) {
        if (doc.documentElement?.hasAttribute('data-linsoft-' + kind)) return kind;
      }
      const playing = [...doc.querySelectorAll('video,audio')].some(media =>
        !media.paused || media.srcObject?.getTracks?.().some(track => track.readyState === 'live'));
      const editing = [...doc.querySelectorAll('input,textarea,select,[contenteditable]')].some(element =>
        element.isContentEditable || element.tagName === 'TEXTAREA' && element.value ||
        element.tagName === 'SELECT' && [...element.options].some(option => option.selected !== option.defaultSelected) ||
        element.tagName === 'INPUT' && ['checkbox','radio'].includes(element.type) && element.checked !== element.defaultChecked ||
        element.tagName === 'INPUT' && !['hidden','button','submit','reset','checkbox','radio'].includes(element.type) && element.value);
      if (playing) return 'media';
      if (editing) return 'form';
      for (const frame of doc.querySelectorAll('iframe,frame')) {
        try {
          if (!frame.contentDocument) return 'frame';
          const nested = reason(frame.contentDocument);
          if (nested) return nested;
        } catch { return 'frame'; }
      }
      return '';
    };
    return { reason: reason(document), url: location.href, x: scrollX, y: scrollY };
  })()`;
  const tabActivityScript = `Boolean((${tabInspectionScript}).reason)`;

  function scrollRestorationScript(position) {
    if (!position || typeof position.url !== 'string' || !Number.isFinite(position.x) || !Number.isFinite(position.y) || position.x < 0 || position.y < 0 || position.x > 100000000 || position.y > 100000000) throw new Error('Invalid scroll position');
    return `(async () => {
      const target = ${JSON.stringify({ url: position.url, x: position.x, y: position.y })};
      const deadline = Date.now() + 3000;
      let cancelled = false;
      const cancel = () => { cancelled = true; };
      const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
      events.forEach(name => document.addEventListener(name, cancel, { once: true, capture: true }));
      try {
        while (!cancelled && location.href === target.url && Date.now() < deadline) {
          window.scrollTo({ left: target.x, top: target.y, behavior: 'instant' });
          if (Math.abs(scrollX - target.x) <= 2 && Math.abs(scrollY - target.y) <= 2) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return cancelled ? null : false;
      } finally {
        events.forEach(name => document.removeEventListener(name, cancel, true));
      }
    })()`;
  }

  function rankSuspensionCandidates(tabs, measurements = []) {
    const byId = new Map(measurements.map(item => [item.tabId, item]));
    return [...tabs].sort((left, right) => {
      const a = byId.get(left.id);
      const b = byId.get(right.id);
      const memoryA = Number.isFinite(a?.memoryBytes) ? a.memoryBytes / Math.max(1, a.sharedTabs || 1) : 0;
      const memoryB = Number.isFinite(b?.memoryBytes) ? b.memoryBytes / Math.max(1, b.sharedTabs || 1) : 0;
      return memoryB - memoryA || left.inactiveSince - right.inactiveSince || left.id - right.id;
    });
  }

  function suspensionDelay(memory) {
    if (!memory || !Number.isFinite(memory.free) || !Number.isFinite(memory.total) || memory.total <= 0 || memory.free < 0 || memory.free > memory.total) throw new Error('Invalid memory measurement');
    const ratio = memory.free / memory.total;
    return (ratio < 0.15 ? 5 : ratio >= 0.4 ? 20 : 10) * 60000;
  }

  function canSuspendTab(tab, { activeTabId, now = Date.now(), playing = false, pending = false, delay = 600000, protectedOrigins = [] } = {}) {
    if (!tab || tab.id === activeTabId || tab.pinned || tab.locked || tab.suspended || tab.loading || playing || pending) return false;
    if (!Number.isFinite(delay) || delay < 300000 || !Number.isFinite(tab.inactiveSince) || now - tab.inactiveSince < delay) return false;
    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (protectedOrigins.includes(url.origin)) return false;
      const host = url.hostname;
      if (['youtube.com', 'youtu.be', 'docs.google.com', 'office.com', 'office.live.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) return false;
      if (host === 'linsoft.ddns.net' && /^\/(?:linsoft-offiece|linsoft-chat)(?:\/|$)/.test(url.pathname)) return false;
      return true;
    } catch { return false; }
  }

  const api = { resolveAddress, rankAddressSuggestions, createSuggestionIndex, searchSuggestionIndex, normalizeSuggestionLearning, recordSuggestionSelection, suspensionDelay, rankSuspensionCandidates, canSuspendTab, tabActivityScript, tabInspectionScript, scrollRestorationScript };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LinsoftBrowserAlgorithms = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
