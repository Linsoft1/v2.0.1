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

  create(tabId, webPreferences = this.createWebPreferences()) {
    if (this.views.has(tabId)) return this.views.get(tabId);
    const view = new this.WebContentsView({ webPreferences });
    view.__pdfPluginMode = webPreferences.plugins === true;
    this.configureWebContents?.(tabId, view.webContents);
    this.bindEvents(tabId, view);
    this.views.set(tabId, view);
    return view;
  }

  load(tabId, url, { muted = false } = {}) {
    const webPreferences = this.createWebPreferences(url);
    const existing = this.views.get(tabId);
    if (existing && existing.__pdfPluginMode !== (webPreferences.plugins === true)) this.destroy(tabId);
    const view = this.create(tabId, webPreferences);
    const contents = view.webContents;
    contents.setAudioMuted?.(muted);
    let mainFrameFailed = false;
    const onMainFrameFailure = (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) mainFrameFailed = true;
    };
    contents.on('did-fail-load', onMainFrameFailure);
    try {
      Promise.resolve(contents.loadURL(url))
        .catch((error) => {
          if (mainFrameFailed) return;
          this.onEvent(tabId, 'failed', {
            errorCode: Number.isInteger(error?.errno) ? error.errno : -2,
            errorDescription: error instanceof Error ? error.message : String(error),
            validatedURL: url
          });
        })
        .finally(() => contents.removeListener('did-fail-load', onMainFrameFailure));
    } catch (error) {
      contents.removeListener('did-fail-load', onMainFrameFailure);
      this.onEvent(tabId, 'failed', {
        errorCode: Number.isInteger(error?.errno) ? error.errno : -2,
        errorDescription: error instanceof Error ? error.message : String(error),
        validatedURL: url
      });
    }
    return view;
  }

  activate(tabId) {
    const view = this.views.get(tabId);
    if (!view) return false;
    if (this.activeTabId === tabId) {
      if (this.bounds) view.setBounds(this.bounds);
      return true;
    }
    if (this.activeTabId !== null) {
      const previous = this.views.get(this.activeTabId);
      if (previous) this.window.contentView.removeChildView(previous);
      this.activeTabId = null;
    }
    this.window.contentView.addChildView(view);
    this.activeTabId = tabId;
    if (this.bounds) view.setBounds(this.bounds);
    return true;
  }

  deactivate() {
    if (this.activeTabId === null) return;
    const view = this.views.get(this.activeTabId);
    if (view) this.window.contentView.removeChildView(view);
    this.activeTabId = null;
  }

  suspend(tabId) {
    if (this.activeTabId === tabId || !this.views.has(tabId)) return false;
    this.destroy(tabId);
    return true;
  }

  setBounds(bounds) {
    this.bounds = bounds;
    if (this.activeTabId !== null) this.views.get(this.activeTabId)?.setBounds(bounds);
  }

  destroy(tabId) {
    const view = this.views.get(tabId);
    if (!view) return;
    if (this.activeTabId === tabId) {
      this.window.contentView.removeChildView(view);
      this.activeTabId = null;
    }
    this.views.delete(tabId);
    view.webContents.close();
  }

  destroyAll() {
    for (const tabId of this.views.keys()) this.destroy(tabId);
  }

  bindEvents(tabId, view) {
    const contents = view.webContents;
    contents.on('dom-ready', () => contents.insertCSS('*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }').catch(() => {}));
    contents.on('did-start-loading', () => this.onEvent(tabId, 'loading', { loading: true }));
    contents.on('did-stop-loading', () => this.onEvent(tabId, 'loading', { loading: false }));
    contents.on('did-finish-load', () => this.onEvent(tabId, 'ready'));
    contents.on('did-navigate', (_event, url) => this.onEvent(tabId, 'navigate', { url }));
    contents.on('did-navigate-in-page', (_event, url) => this.onEvent(tabId, 'navigate-in-page', { url }));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => { if (isMainFrame) this.onEvent(tabId, 'failed', { errorCode, errorDescription, validatedURL }); });
    contents.on('page-title-updated', (_event, title) => this.onEvent(tabId, 'title', { title }));
    contents.on('page-favicon-updated', (_event, favicons) => this.onEvent(tabId, 'favicon', { favicon: favicons[0] || '' }));
    contents.on('media-started-playing', () => this.onEvent(tabId, 'media-started-playing'));
    contents.on('media-paused', () => this.onEvent(tabId, 'media-paused'));
    contents.on('render-process-gone', (_event, details) => {
      if (this.views.get(tabId) === view) this.destroy(tabId);
      this.onEvent(tabId, 'crashed', { reason: details.reason });
    });
  }
}

module.exports = { NativeTabManager };