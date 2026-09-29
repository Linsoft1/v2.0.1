class NativeTabManager {
  constructor({ window, WebContentsView, createWebPreferences, configureWebContents, onEvent }) {
    this.window = window;
    this.WebContentsView = WebContentsView;
    this.createWebPreferences = createWebPreferences;
    this.configureWebContents = configureWebContents;
    this.onEvent = onEvent;
    this.views = new Map();
    this.activeTabId = null;
    this.bounds = null;
  }

  create(tabId) {
    if (this.views.has(tabId)) return this.views.get(tabId);
    const view = new this.WebContentsView({ webPreferences: this.createWebPreferences() });
    this.configureWebContents?.(tabId, view.webContents);
    this.bindEvents(tabId, view);
    this.views.set(tabId, view);
    return view;
  }

  load(tabId, url) {
    const view = this.create(tabId);
    view.webContents.loadURL(url);
    return view;
  }

  activate(tabId) {
    if (!this.views.has(tabId)) return false;
    if (this.activeTabId !== null) {
      const previous = this.views.get(this.activeTabId);
      if (previous) this.window.contentView.removeChildView(previous);
    }
    const view = this.views.get(tabId);
    this.window.contentView.addChildView(view);
    if (this.bounds) view.setBounds(this.bounds);
    this.activeTabId = tabId;
    return true;
  }

  deactivate() {
    if (this.activeTabId === null) return;
    const view = this.views.get(this.activeTabId);
    if (view) this.window.contentView.removeChildView(view);
    this.activeTabId = null;
  }

  setBounds(bounds) {
    this.bounds = bounds;
    if (this.activeTabId !== null) this.views.get(this.activeTabId)?.setBounds(bounds);
  }

  destroy(tabId) {
    const view = this.views.get(tabId);
    if (!view) return;
    this.window.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
  }

  destroyAll() {
    for (const tabId of this.views.keys()) this.destroy(tabId);
  }

  bindEvents(tabId, view) {
    const contents = view.webContents;
    contents.on('dom-ready', () => contents.insertCSS('*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }').catch(() => {}));
    contents.on('did-start-loading', () => this.onEvent(tabId, 'loading', { loading: true }));
    contents.on('did-stop-loading', () => this.onEvent(tabId, 'loading', { loading: false }));
    contents.on('did-navigate', (_event, url) => this.onEvent(tabId, 'navigate', { url }));
    contents.on('did-navigate-in-page', (_event, url) => this.onEvent(tabId, 'navigate', { url }));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => { if (isMainFrame) this.onEvent(tabId, 'failed', { errorCode, errorDescription, validatedURL }); });
    contents.on('page-title-updated', (_event, title) => this.onEvent(tabId, 'title', { title }));
    contents.on('page-favicon-updated', (_event, favicons) => this.onEvent(tabId, 'favicon', { favicon: favicons[0] || '' }));
    contents.on('render-process-gone', (_event, details) => this.onEvent(tabId, 'crashed', { reason: details.reason }));
  }
}

module.exports = { NativeTabManager };