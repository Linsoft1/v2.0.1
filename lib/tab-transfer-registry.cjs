class TabTransferRegistry {
  constructor({ ttlMs = 30000, maxEntries = 128, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  register(token, { sourceId, tabId, tab } = {}) {
    this.prune();
    if (!/^[0-9a-f-]{36}$/i.test(token || '') || !Number.isSafeInteger(sourceId) || !Number.isSafeInteger(tabId) || !tab || this.entries.has(token) || this.entries.size >= this.maxEntries) return false;
    this.entries.set(token, { sourceId, tabId, tab, expiresAt: this.now() + this.ttlMs, targetId: null });
    return true;
  }

  claim(token, targetId) {
    this.prune();
    const entry = this.entries.get(token);
    if (!entry || !Number.isSafeInteger(targetId) || targetId === entry.sourceId || (entry.targetId !== null && entry.targetId !== targetId)) return null;
    entry.targetId = targetId;
    return entry.tab;
  }

  complete(token, targetId) {
    this.prune();
    const entry = this.entries.get(token);
    if (!entry || entry.targetId !== targetId) return null;
    this.entries.delete(token);
    return { sourceId: entry.sourceId, tabId: entry.tabId, url: entry.tab.url };
  }

  prune() {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}

module.exports = { TabTransferRegistry };
