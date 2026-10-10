(function exposeTabState(root) {
  const internalUrls = new Set([
    'linsoft://apps',
    'linsoft://bookmarks',
    'linsoft://history',
    'linsoft://settings',
    'linsoft://start',
    'linsoft://tor-chat'
  ]);

  function recordNavigation(tab, url, { historyIndex: expectedHistoryIndex } = {}) {
    if (!tab || typeof url !== 'string' || !url) return false;
    const history = Array.isArray(tab.history) ? tab.history.filter((entry) => typeof entry === 'string' && entry) : [];
    let historyIndex = Number.isInteger(tab.historyIndex) ? tab.historyIndex : history.length - 1;
    historyIndex = Math.max(-1, Math.min(historyIndex, history.length - 1));

    if (Number.isInteger(expectedHistoryIndex) && expectedHistoryIndex >= 0 && expectedHistoryIndex < history.length && history[expectedHistoryIndex] === url) {
      const changed = historyIndex !== expectedHistoryIndex;
      tab.history = history;
      tab.historyIndex = expectedHistoryIndex;
      tab.url = url;
      return changed;
    }

    if (history[historyIndex] === url) {
      tab.url = url;
      return false;
    }

    history.splice(historyIndex + 1);
    history.push(url);
    historyIndex = history.length - 1;

    tab.history = history;
    tab.historyIndex = historyIndex;
    tab.url = url;
    return true;
  }

  function normalizeSessionTabs(storedTabs, isValidUrl) {
    if (!Array.isArray(storedTabs) || typeof isValidUrl !== 'function') return [];
    const candidates = storedTabs.filter((tab) => tab && typeof tab === 'object' && !Array.isArray(tab));
    const usedIds = new Set();
    let nextId = 2;
    for (const tab of candidates) {
      if (Number.isSafeInteger(tab.id) && tab.id > 0 && tab.id < Number.MAX_SAFE_INTEGER) nextId = Math.max(nextId, tab.id + 1);
    }

    return candidates.flatMap((saved) => {
      const url = typeof saved.url === 'string' && isValidUrl(saved.url) ? saved.url : '';
      if (!url) return [];

      const savedId = Number.isSafeInteger(saved.id) && saved.id > 0 && saved.id < Number.MAX_SAFE_INTEGER ? saved.id : null;
      let id = usedIds.size === 0 ? 1 : savedId && !usedIds.has(savedId) ? savedId : nextId;
      while (usedIds.has(id) || (usedIds.size > 0 && id === 1)) id = nextId++;
      usedIds.add(id);
      nextId = Math.max(nextId, id + 1);

      const history = Array.isArray(saved.history) ? saved.history.filter((entry) => typeof entry === 'string' && isValidUrl(entry)) : [];
      if (!history.length) history.push(url);
      let historyIndex = Number.isInteger(saved.historyIndex) ? saved.historyIndex : history.length - 1;
      historyIndex = Math.max(0, Math.min(historyIndex, history.length - 1));
      if (history[historyIndex] !== url) {
        const urlIndex = history.lastIndexOf(url);
        if (urlIndex >= 0) historyIndex = urlIndex;
        else {
          history.splice(historyIndex + 1);
          history.push(url);
          historyIndex = history.length - 1;
        }
      }

      const group = ['blue', 'green', 'orange', 'red'].includes(saved.group) ? saved.group : '';
      let icon = '';
      try {
        const parsedIcon = new URL(saved.icon);
        if (['http:', 'https:'].includes(parsedIcon.protocol) && parsedIcon.hostname && !parsedIcon.username && !parsedIcon.password) icon = parsedIcon.href;
      } catch {}
      return [{
        id,
        url,
        title: typeof saved.title === 'string' && saved.title.trim() ? saved.title.slice(0, 300) : url,
        history,
        historyIndex,
        pinned: saved.pinned === true,
        locked: saved.locked === true,
        crashed: saved.crashed === true,
        crashReason: saved.crashed === true && typeof saved.crashReason === 'string' ? saved.crashReason.slice(0, 80) : '',
        muted: saved.muted === true,
        group,
        groupName: typeof saved.groupName === 'string' ? saved.groupName.slice(0, 80) : '',
        icon
      }];
    });
  }

  const api = { internalUrls, normalizeSessionTabs, recordNavigation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LinsoftTabState = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
