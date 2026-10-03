const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linsoftBrowser', {
  isDesktopApp: true,
  appName: 'Linsoft Browser',
  windowControl: (action) => ipcRenderer.send('window-control', action),
  onWindowCloseRequest: (callback) => ipcRenderer.on('window-close-request', (_event, data) => callback(data)),
  confirmWindowClose: () => ipcRenderer.send('confirm-window-close'),
  onDownload: (callback) => ipcRenderer.on('download-update', (_event, data) => callback(data)),
  listDownloads: () => ipcRenderer.invoke('download-list'),
  removeDownload: (id) => ipcRenderer.invoke('download-remove', id),
  clearDownloads: () => ipcRenderer.invoke('download-clear'),
  openDownloads: () => ipcRenderer.send('open-downloads'),
  selectDownloadFolder: () => ipcRenderer.invoke('select-download-folder'),
  openDownloadFile: (filePath) => ipcRenderer.send('open-download-file', filePath),
  showDownloadFile: (filePath) => ipcRenderer.send('show-download-file', filePath),
  cancelDownload: (fileName) => ipcRenderer.send('cancel-download', fileName),
  pauseDownload: (id) => ipcRenderer.send('pause-download', id),
  resumeDownload: (id) => ipcRenderer.send('resume-download', id),
  setBrowserPreferences: (preferences) => ipcRenderer.send('set-browser-preferences', preferences),
  getSpellcheckerLanguages: () => ipcRenderer.invoke('spellchecker-languages'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  listSitePermissions: () => ipcRenderer.invoke('site-permission-list'),
  revokeSitePermission: (key) => ipcRenderer.invoke('site-permission-revoke', key),
  clearSitePermissions: () => ipcRenderer.invoke('site-permission-clear'),
  getUpdateState: () => ipcRenderer.invoke('update-state'),
  onUpdateState: (callback) => ipcRenderer.on('update-state', (_event, state) => callback(state)),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate: () => ipcRenderer.send('update-install'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
    savePagePdf: (webContentsId) => ipcRenderer.invoke('save-page-pdf', webContentsId),
    capturePage: (webContentsId) => ipcRenderer.invoke('capture-page', webContentsId),
    capturePageToClipboard: (webContentsId) => ipcRenderer.invoke('capture-page-to-clipboard', webContentsId),
    editCommand: (webContentsId, command) => ipcRenderer.invoke('edit-command', webContentsId, command),
    readClipboardText: () => ipcRenderer.invoke('clipboard-read-text'),
    writeClipboardText: (value) => ipcRenderer.invoke('clipboard-write-text', value),
    copyClipboardSelection: (selectedText) => ipcRenderer.invoke('clipboard-copy-selection', selectedText),
    writeClipboardImage: (url) => ipcRenderer.invoke('clipboard-write-image', url),
    getPageSource: () => ipcRenderer.invoke('page-source'),
  listPasswords: () => ipcRenderer.invoke('password-list'),
  getPassword: (id) => ipcRenderer.invoke('password-get', id),
  savePassword: (entry) => ipcRenderer.invoke('password-save', entry),
  deletePassword: (id) => ipcRenderer.invoke('password-delete', id),
  getAdblockStats: () => ipcRenderer.invoke('adblock-stats'),
  toggleAdblockSite: (hostname) => ipcRenderer.invoke('adblock-toggle-site', hostname),
  updateAdblockList: () => ipcRenderer.invoke('adblock-update-list'),
  onExternalUrl: (callback) => ipcRenderer.on('open-external-url', (_event, url) => callback(url)),
    onOpenAppCenter: (callback) => ipcRenderer.on('open-app-center', () => callback()),
  onInstallExternalApp: (callback) => ipcRenderer.on('install-external-app', (_event, data) => callback(data)),
  openBrowserWindow: (url) => ipcRenderer.send('open-browser-window', url),
  openDetachedWindow: (url) => ipcRenderer.send('open-detached-window', url),
  openGuestWindow: () => ipcRenderer.send('open-guest-window'),
  nativeTabsEnabled: () => ipcRenderer.invoke('native-tabs-enabled'),
  setNativeTabLayout: (bounds) => ipcRenderer.send('native-tab-layout', bounds),
  loadNativeTab: (tab) => ipcRenderer.invoke('native-tab-load', tab),
  activateNativeTab: (tabId) => ipcRenderer.invoke('native-tab-activate', tabId),
  deactivateNativeTab: () => ipcRenderer.invoke('native-tab-deactivate'),
  destroyNativeTab: (tabId) => ipcRenderer.invoke('native-tab-destroy', tabId),
  nativeTabCommand: (command) => ipcRenderer.invoke('native-tab-command', command),
  onNativeTabEvent: (callback) => ipcRenderer.on('native-tab-event', (_event, data) => callback(data)),
  onLinkInTab: (callback) => ipcRenderer.on('open-link-in-tab', (_event, url) => callback(url)),
  onLinkInWindow: (callback) => ipcRenderer.on('open-link-in-window', (_event, url) => callback(url)),
  onBrowserShortcut: (callback) => ipcRenderer.on('browser-shortcut', (_event, data) => callback(data)),
  onDismissWebviewOverlay: (callback) => ipcRenderer.on('dismiss-webview-overlay', () => callback()),
  onWebviewFullscreen: (callback) => ipcRenderer.on('webview-fullscreen', (_event, active) => callback(Boolean(active))),
  onWebviewContextMenu: (callback) => ipcRenderer.on('webview-context-menu', (_event, data) => callback(data)),
  onTranslatePage: (callback) => ipcRenderer.on('translate-page', (_event, url) => callback(url)),
  installWebApp: (url, title) => ipcRenderer.invoke('install-web-app', { url, title }),
    uninstallWebApp: (url, title) => ipcRenderer.invoke('uninstall-web-app', { url, title }),
    onUninstallExternalApp: (callback) => ipcRenderer.on('uninstall-external-app', (_event, data) => callback(data)),
  selectOpenVpnProfile: () => ipcRenderer.invoke('openvpn-select-profile'),
  connectOpenVpn: (profile) => ipcRenderer.send('openvpn-connect', profile),
  disconnectOpenVpn: () => ipcRenderer.send('openvpn-disconnect'),
  onOpenVpnStatus: (callback) => ipcRenderer.on('openvpn-status', (_event, status) => callback(status)),
  getOpenVpnPath: () => ipcRenderer.invoke('openvpn-path')
  ,getTorStatus: () => ipcRenderer.invoke('tor-status')
  ,selectTorFolder: () => ipcRenderer.invoke('tor-select-folder')
  ,startTorHosting: (folder) => ipcRenderer.invoke('tor-start-hosting', folder)
  ,stopTorHosting: () => ipcRenderer.invoke('tor-stop-hosting')
  ,enableTorProxy: () => ipcRenderer.invoke('tor-enable-proxy')
  ,disableTorProxy: () => ipcRenderer.invoke('tor-disable-proxy')
  ,setManualProxy: (settings) => ipcRenderer.invoke('set-manual-proxy', settings)
  ,onTorStatus: (callback) => ipcRenderer.on('tor-status', (_event, status) => callback(status))
  ,onTorNavigationError: (callback) => ipcRenderer.on('tor-navigation-error', (_event, message) => callback(message))
  ,getTorDefaultFolder: () => ipcRenderer.invoke('tor-default-folder')
  ,startTorChatHost: () => ipcRenderer.invoke('tor-chat-host-start')
  ,renewTorChatHost: () => ipcRenderer.invoke('tor-chat-host-renew')
  ,createTorChatInviteQr: (invitation) => ipcRenderer.invoke('tor-chat-invite-qr', invitation)
  ,authorizeTorChatCamera: (purpose) => ipcRenderer.invoke('tor-chat-camera-authorize', purpose)
  ,releaseTorChatCamera: () => ipcRenderer.invoke('tor-chat-camera-release')
  ,joinTorChat: (invite) => ipcRenderer.invoke('tor-chat-join', invite)
  ,pollTorChat: (afterId) => ipcRenderer.invoke('tor-chat-poll', afterId)
  ,markTorChatMessagesRead: (ids) => ipcRenderer.invoke('tor-chat-read', ids)
  ,sendTorChat: (envelope) => ipcRenderer.invoke('tor-chat-send', envelope)
  ,pollTorChatVideo: (afterId) => ipcRenderer.invoke('tor-chat-video-poll', afterId)
  ,sendTorChatVideoFrame: (envelope) => ipcRenderer.invoke('tor-chat-video-send', envelope)
  ,stopTorChatVideo: () => ipcRenderer.invoke('tor-chat-video-stop')
  ,sendTorChatFileChunk: (chunk) => ipcRenderer.invoke('tor-chat-file-chunk', chunk)
  ,pollTorChatFiles: (afterIndex) => ipcRenderer.invoke('tor-chat-files-poll', afterIndex)
  ,completeTorChatFile: (fileId) => ipcRenderer.invoke('tor-chat-file-complete', fileId)
  ,cancelTorChatFileTransfer: (fileId) => ipcRenderer.invoke('tor-chat-file-cancel', fileId)
  ,saveTorChatFile: (file) => ipcRenderer.invoke('tor-chat-file-save', file)
  ,stopTorChat: () => ipcRenderer.invoke('tor-chat-stop')
});
