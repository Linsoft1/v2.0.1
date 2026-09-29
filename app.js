const addressInput = document.getElementById('addressInput');
const content = document.getElementById('content');
const tabTitle = document.getElementById('tabTitle');
const isGuestWindow = new URLSearchParams(window.location.search).has('guest');
const isNativeTabs = new URLSearchParams(window.location.search).has('nativeTabs');
document.getElementById('guestIndicator').hidden = !isGuestWindow;
const historyStack = ['linsoft://start'];
let historyIndex = 0;
let activeTabId = 1;
let nextTabId = 2;
const tabs = new Map([[1, { id: 1, url: 'linsoft://start', title: 'Nová karta', history: ['linsoft://start'], historyIndex: 0 }]]);
const closedTabs = [];
const tabGroupColors = ['', 'blue', 'green', 'orange', 'red'];
const suspendedTabs = new Set();
let lastTabDragPosition = { x: 0, y: 0 };
const boundViewers = new WeakSet();
let savedBookmarks = [];
try {
  const storedBookmarks = JSON.parse(localStorage.getItem('linsoft-bookmarks') || '[]');
  savedBookmarks = Array.isArray(storedBookmarks) ? storedBookmarks.filter((item) => item && typeof item.url === 'string') : [];
} catch {
  localStorage.removeItem('linsoft-bookmarks');
}
let installedApps = [];
try { installedApps = JSON.parse(localStorage.getItem('linsoft-apps') || '[]'); } catch { installedApps = []; }
const defaultSettings = { theme: 'dark', startup: 'start', home: 'linsoft://start', search: 'Google', safe: true, popups: true, tracking: false, trackingProtection: true, downloads: 'Downloads', downloadFolderPath: '', askDownload: false, adBlock: true, clearExit: false, restoreTabs: true, suspendInactiveTabs: true, confirmClose: true, camera: false, microphone: false, webNotifications: false, showBookmarksBar: false, autoUpdateCheck: true };
let settingsFromStorage = {};
try { settingsFromStorage = JSON.parse(localStorage.getItem('linsoft-settings') || '{}'); } catch { settingsFromStorage = {}; }
const settingsState = Object.assign({}, defaultSettings, settingsFromStorage);
if (Number(settingsFromStorage.downloadBehaviorVersion || 0) < 2) {
  settingsState.askDownload = false;
  settingsState.downloadBehaviorVersion = 2;
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

let toastTimeout = null;
function showToast(message) {
  const toast = document.getElementById('toastNotice');
  if (!toast) return;
  toast.textContent = String(message || '');
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3600);
}

function updateActiveTab(url, title) {
  const tab = tabs.get(activeTabId);
  if (tab) Object.assign(tab, { url, title });
  const active = document.querySelector(`.managed-tab[data-tab-id="${activeTabId}"]`);
  if (active) { active.querySelector('span:nth-child(2)').textContent = title; active.title = `${title} - ${url}`; active.classList.add('active'); }
  document.querySelectorAll('.managed-tab').forEach((item) => item.classList.toggle('active', Number(item.dataset.tabId) === activeTabId));
  updateTabDensity();
}

function updateTabDensity() {
  const count = document.querySelectorAll('.managed-tab').length;
  document.querySelector('.tabs-bar')?.classList.toggle('many-tabs', count >= 7);
}

function setTabIcon(id, iconUrl = '') { const icon = document.querySelector(`.managed-tab[data-tab-id="${id}"] .tab-logo`); if (!icon) return; icon.textContent = iconUrl ? '' : 'L'; icon.style.backgroundImage = iconUrl ? `url("${iconUrl}")` : ''; }

function setTabAudioIcon(id, muted = false, playing = false) { const audio = document.querySelector(`.managed-tab[data-tab-id="${id}"] .tab-audio`); if (!audio) return; audio.textContent = muted ? '🔇' : playing ? '🔊' : ''; audio.title = muted ? 'Zapnúť zvuk' : 'Stlmiť kartu'; audio.setAttribute('aria-label', audio.title); }
function setTabLoading(id, loading) { document.querySelector(`.managed-tab[data-tab-id="${id}"]`)?.classList.toggle('loading', loading); }
function syncNativeTabLayout() {
  if (!isNativeTabs) return;
  const bounds = content.getBoundingClientRect();
  window.linsoftBrowser?.setNativeTabLayout?.({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}
function hideNativeTab() { if (isNativeTabs) window.linsoftBrowser?.deactivateNativeTab?.(); }
new ResizeObserver(syncNativeTabLayout).observe(content);

function bindTabButton(button, id) {
  button.addEventListener('click', (event) => { if (event.target.classList.contains('tab-close')) { event.preventDefault(); event.stopPropagation(); closeTab(id); } else if (event.target.classList.contains('tab-audio')) { event.preventDefault(); event.stopPropagation(); toggleTabMute(id); } else selectTab(id); });
  button.addEventListener('contextmenu', (event) => { event.preventDefault(); selectTab(id); showTabContextMenu(event.clientX, event.clientY, id); });
  bindTabDrag(button, id);
}

function createTabButton(tab) {
  const button = document.createElement('button');
  button.className = `tab managed-tab${tab.pinned ? ' pinned' : ''}${tab.locked ? ' locked' : ''}${tab.group ? ` tab-group-${tab.group}` : ''}`;
  button.dataset.tabId = tab.id;
  button.title = `${tab.groupName ? `${tab.groupName}: ` : ''}${tab.title} - ${tab.url}`;
  button.draggable = true;
  button.innerHTML = `<span class="tab-logo">L</span><span>${escapeHtml(tab.title)}</span><span class="tab-audio" aria-label="${tab.muted ? 'Zapnúť zvuk karty' : 'Stlmiť kartu'}" title="${tab.muted ? 'Zapnúť zvuk karty' : 'Stlmiť kartu'}">${tab.muted ? '🔇' : ''}</span><span class="tab-loading" aria-hidden="true"></span><span class="tab-close" title="${tab.locked ? 'Karta je zamknutá' : 'Zatvoriť kartu'}">${tab.locked ? '🔒' : '×'}</span>`;
  const newTab = document.getElementById('newTab');
  const tabsBar = document.querySelector('.tabs-bar');
  tabsBar.insertBefore(button, newTab);
  updateTabDensity();
  bindTabButton(button, tab.id);
  return button;
}

function movePinnedTab(button) {
  if (!button) return;
  const tabsBar = document.querySelector('.tabs-bar');
  const firstUnpinned = [...tabsBar.querySelectorAll('.managed-tab:not(.pinned)')][0];
  if (button.classList.contains('pinned') && firstUnpinned && firstUnpinned !== button) tabsBar.insertBefore(button, firstUnpinned);
}

function togglePinnedTab(id) {
  const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
  if (!tab || !button) return;
  tab.pinned = !tab.pinned; button.classList.toggle('pinned', tab.pinned); button.title = tab.pinned ? 'Odpnúť kartu' : 'Pripnúť kartu'; movePinnedTab(button); saveSession();
}

function toggleTabMute(id) {
  const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`); const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
  if (!tab || !button) return;
  tab.muted = !tab.muted;
  if (viewer?.setAudioMuted) viewer.setAudioMuted(tab.muted);
  setTabAudioIcon(id, tab.muted, false);
  saveSession();
}

function toggleTabLock(id) { const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`); if (!tab || !button) return; tab.locked = !tab.locked; button.classList.toggle('locked', tab.locked); const close = button.querySelector('.tab-close'); if (close) { close.textContent = tab.locked ? '🔒' : '×'; close.title = tab.locked ? 'Karta je zamknutá' : 'Zatvoriť kartu'; } saveSession(); }

function cycleTabGroup(id) {
  const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
  if (!tab || !button) return;
  const index = tabGroupColors.indexOf(tab.group || ''); tab.group = tabGroupColors[(index + 1) % tabGroupColors.length];
  button.classList.remove(...tabGroupColors.filter(Boolean).map((color) => `tab-group-${color}`));
  if (tab.group) button.classList.add(`tab-group-${tab.group}`);
  saveSession();
}

function setTabGroupName(id) { const tab = tabs.get(id); if (!tab) return; const name = window.prompt('Názov skupiny karty:', tab.groupName || '')?.trim(); if (name === undefined) return; tab.groupName = name.slice(0, 30); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`); if (button) button.title = `${tab.groupName ? `${tab.groupName}: ` : ''}${tab.title} - ${tab.url}`; saveSession(); }

function showTabContextMenu(x, y, id) {
  document.querySelector('.tab-context-menu')?.remove();
  const menu = document.createElement('div'); menu.className = 'tab-context-menu';
  menu.setAttribute('role', 'menu');
  const actions = [['group', 'Zmeniť skupinu/farbu'], ['groupName', 'Pomenovať skupinu'], ['mute', tabs.get(id)?.muted ? 'Zapnúť zvuk karty' : 'Stlmiť kartu'], ['lock', tabs.get(id)?.locked ? 'Odomknúť kartu' : 'Zamknúť kartu'], ['detach', 'Otvoriť kópiu v novom okne'], ['pin', tabs.get(id)?.pinned ? 'Odpnúť kartu' : 'Pripnúť kartu'], ['duplicate', 'Duplikovať kartu'], ['close', 'Zatvoriť kartu'], ['closeOthers', 'Zatvoriť ostatné karty'], ['closeRight', 'Zatvoriť karty napravo']];
  menu.innerHTML = actions.map(([action, label]) => `<button role="menuitem" data-tab-action="${action}">${label}</button>`).join('');
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`; menu.style.top = `${Math.min(y, window.innerHeight - 220)}px`; document.body.appendChild(menu);
  const closeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', closeFromOutside, true); document.removeEventListener('keydown', closeFromEscape, true); };
  const closeFromOutside = (event) => { if (!menu.contains(event.target)) closeMenu(); };
  const closeFromEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  menu.addEventListener('keydown', (event) => {
    const buttons = [...menu.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; buttons[(current + direction + buttons.length) % buttons.length]?.focus(); }
  });
  menu.querySelector('button')?.focus();
  menu.addEventListener('click', (event) => { const action = event.target.closest('[data-tab-action]')?.dataset.tabAction; if (!action) return; closeMenu(); if (action === 'group') cycleTabGroup(id); if (action === 'groupName') setTabGroupName(id); if (action === 'mute') toggleTabMute(id); if (action === 'lock') toggleTabLock(id); if (action === 'detach') detachTab(id); if (action === 'pin') togglePinnedTab(id); if (action === 'duplicate') duplicateTab(id); if (action === 'close') closeTab(id); if (action === 'closeOthers') [...tabs.keys()].filter((tabId) => tabId !== id && !tabs.get(tabId)?.pinned).forEach(closeTab); if (action === 'closeRight') closeTabsRight(id); });
}

function showInputContextMenu(input, x, y) {
  document.querySelector('.input-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu input-context-menu';
  menu.setAttribute('role', 'menu');
  const hasSelection = input.selectionStart !== input.selectionEnd;
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const selectedText = input.value.slice(selectionStart, selectionEnd);
  menu.innerHTML = [
    ['cut', 'Vystrihnúť', !hasSelection || input.readOnly],
    ['copy', 'Kopírovať', !hasSelection],
    ['paste', 'Vložiť', input.readOnly],
    ['selectAll', 'Označiť všetko', input.value.length === 0]
  ].map(([action, label, disabled]) => `<button role="menuitem" data-input-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`).join('');
  menu.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 220))}px`;
  menu.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 190))}px`;
  document.body.appendChild(menu);
  const closeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', closeFromOutside, true); document.removeEventListener('keydown', closeFromEscape, true); };
  const closeFromOutside = (event) => { if (!menu.contains(event.target)) closeMenu(); };
  const closeFromEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  menu.querySelector('button:not(:disabled)')?.focus();
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-input-action]')?.dataset.inputAction;
    if (!action) return;
    input.focus();
    if (action === 'paste') {
      try { const text = await window.linsoftBrowser?.readClipboardText?.(); input.setRangeText(String(text || ''), input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); } catch { showToast('Text sa nepodarilo vložiť zo schránky.'); }
    } else if (action === 'copy' || action === 'cut') {
      const result = await window.linsoftBrowser?.writeClipboardText?.(selectedText);
      if (action === 'cut' && result?.ok) { input.setRangeText('', selectionStart, selectionEnd, 'start'); input.dispatchEvent(new Event('input', { bubbles: true })); }
    } else {
      document.execCommand(action === 'selectAll' ? 'selectAll' : action);
    }
    closeMenu();
  });
}

document.addEventListener('contextmenu', (event) => {
  const input = event.target.closest?.('input, textarea');
  if (!input || input.disabled) return;
  event.preventDefault();
  input.focus();
  showInputContextMenu(input, event.clientX, event.clientY);
});

function duplicateTab(id) { const tab = tabs.get(id); if (tab) openNewTab(tab.url); }
function detachTab(id) {
  const tab = tabs.get(id);
  if (!tab?.url) return;
  const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
  const currentUrl = viewer?.getURL?.() || tab.url;
  tab.url = currentUrl;
  window.linsoftBrowser?.openDetachedWindow(currentUrl);
  saveSession();
}
function closeTabsRight(id) { const ids = [...tabs.keys()]; const index = ids.indexOf(id); ids.slice(index + 1).filter((tabId) => !tabs.get(tabId)?.pinned).forEach(closeTab); }

function searchOpenTabs() {
  const query = window.prompt('Vyhľadať otvorenú kartu:');
  if (!query?.trim()) return;
  const needle = query.toLowerCase();
  const match = [...tabs.values()].find((tab) => `${tab.title} ${tab.url}`.toLowerCase().includes(needle));
  if (!match) return showToast('Karta sa nenašla.');
  selectTab(match.id);
}

function bindTabDrag(button, id) {
  button.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', String(id)); event.dataTransfer.effectAllowed = 'move'; lastTabDragPosition = { x: event.clientX, y: event.clientY }; button.classList.add('dragging'); });
  button.addEventListener('dragend', (event) => {
    button.classList.remove('dragging');
    const draggedTab = tabs.get(id);
    const tabsBar = document.querySelector('.tabs-bar').getBoundingClientRect();
    const y = lastTabDragPosition.y || event.clientY;
    const detached = y > tabsBar.bottom + 40 || y < tabsBar.top - 20 || event.screenY > window.screenY + window.innerHeight - 20 || event.screenY < window.screenY - 20;
    if (detached && draggedTab) detachTab(id);
  });
  button.addEventListener('dragover', (event) => event.preventDefault());
  button.addEventListener('drop', (event) => { event.preventDefault(); const dragged = document.querySelector(`.managed-tab[data-tab-id="${event.dataTransfer.getData('text/plain')}"]`); if (dragged && dragged !== button) button.parentElement.insertBefore(dragged, button); });
}

document.addEventListener('dragover', (event) => { lastTabDragPosition = { x: event.clientX, y: event.clientY }; }, true);

function renderSavedBookmarks() {
  const bar = document.getElementById('bookmarksBar');
  if (!bar) return;
  bar.querySelectorAll('.saved-bookmark').forEach((item) => item.remove());
  const spacer = bar.querySelector('span');
  savedBookmarks.forEach((bookmark) => { const button = document.createElement('button'); button.className = 'saved-bookmark'; button.textContent = bookmark.title || bookmark.url; button.dataset.url = bookmark.url; button.addEventListener('click', () => navigate(bookmark.url)); bar.insertBefore(button, spacer); });
}

function updateBookmarksBar() { const bar = document.getElementById('bookmarksBar'); if (bar) bar.hidden = !settingsState.showBookmarksBar; }

function addTab(initialUrl = 'linsoft://start') {
  const id = nextTabId++;
  const initialTitle = initialUrl === 'linsoft://start' ? 'Nová karta' : initialUrl.replace(/^https?:\/\//, '').split('/')[0];
  tabs.set(id, { id, url: initialUrl, title: initialTitle, history: [initialUrl], historyIndex: 0 });
  const button = createTabButton({ id, title: initialTitle, pinned: false });
  activeTabId = id;
  saveSession();
  initialUrl === 'linsoft://start' ? startPage() : navigate(initialUrl, false);
}

function openNewTab(url = 'linsoft://start') {
  addTab(url);
  const newTab = document.querySelector(`.managed-tab[data-tab-id="${activeTabId}"]`);
  newTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function openBackgroundTab(url) {
  const previousTabId = activeTabId;
  openNewTab(url);
  selectTab(previousTabId);
}

function selectTab(id) { const tab = tabs.get(id); if (!tab) return; activeTabId = id; updateActiveTab(tab.url, tab.title); addressInput.value = tab.url; tabTitle.textContent = tab.title; if (suspendedTabs.has(id) || tab.crashed) { suspendedTabs.delete(id); tab.suspended = false; tab.crashed = false; navigate(tab.url, false); } else if (tab.url === 'linsoft://start' && !content.querySelector(`.tab-surface[data-tab-id="${id}"]`)) { hideNativeTab(); startPage(); } else if (tab.url === 'linsoft://settings') { hideNativeTab(); openSettings(); } else if (tab.url === 'linsoft://apps') { hideNativeTab(); openAppCenter(); } else { activateSurface(id); if (isNativeTabs) { syncNativeTabLayout(); window.linsoftBrowser?.activateNativeTab?.(id); } } updateNavigationButtons(); }

function closeTab(id) { const tab = tabs.get(id); if (!tab || tab.pinned || tab.locked) return; const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`); if (isNativeTabs) window.linsoftBrowser?.destroyNativeTab?.(id); else surface?.querySelectorAll('webview').forEach((viewer) => viewer.remove()); if (tabs.size === 1) { activeTabId = id; tabs.get(id).url = 'linsoft://start'; tabs.get(id).title = 'Nová karta'; tabs.get(id).history = ['linsoft://start']; tabs.get(id).historyIndex = 0; startPage(); return; } closedTabs.unshift({ ...tab }); closedTabs.splice(10); const ids = [...tabs.keys()]; const closedIndex = ids.indexOf(id); const fallbackId = ids[Math.max(0, closedIndex - 1)]; surface?.remove(); document.querySelector(`.managed-tab[data-tab-id="${id}"]`)?.remove(); tabs.delete(id); updateTabDensity(); saveSession(); if (activeTabId === id) selectTab(fallbackId); }

function restoreClosedTab() { const tab = closedTabs.shift(); if (!tab) return; const id = nextTabId++; tab.id = id; tabs.set(id, tab); createTabButton(tab); activeTabId = id; navigate(tab.url, false); saveSession(); }

function activeViewer() { return isNativeTabs ? null : content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`); }
function ensureActiveTabLoaded() { const tab = tabs.get(activeTabId); if (tab && suspendedTabs.has(activeTabId)) { suspendedTabs.delete(activeTabId); tab.suspended = false; navigate(tab.url, false); return null; } return activeViewer(); }
function updateNavigationButtons() { const tab = tabs.get(activeTabId); const viewer = activeViewer(); const back = document.getElementById('backButton'); const forward = document.getElementById('forwardButton'); if (back) back.disabled = !(viewer?.canGoBack?.() || (tab?.historyIndex > 0)); if (forward) forward.disabled = !(viewer?.canGoForward?.() || (tab && tab.historyIndex < tab.history.length - 1)); }
function navigateTabHistory(direction) { const tab = tabs.get(activeTabId); const viewer = ensureActiveTabLoaded(); if (!tab) return; const nextIndex = tab.historyIndex + direction; if (nextIndex >= 0 && nextIndex < tab.history.length) { tab.historyIndex = nextIndex; navigate(tab.history[nextIndex], false); return; } if (viewer && ((direction < 0 && viewer.canGoBack()) || (direction > 0 && viewer.canGoForward()))) { direction < 0 ? viewer.goBack() : viewer.goForward(); return; } if (isNativeTabs) window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: direction < 0 ? 'back' : 'forward' }); }
function navigationErrorMessage(errorCode, description = '') { const messages = { '-105': 'Server sa nenašiel (DNS).', '-106': 'Nie ste pripojení k internetu.', '-102': 'Server odmietol pripojenie.', '-118': 'Pripojenie vypršalo.', '-116': 'Spojenie bolo odmietnuté.' }; return messages[String(errorCode)] || (description ? `Načítanie zlyhalo: ${description}.` : 'Stránku sa nepodarilo načítať.'); }

function activateSurface(id) { content.querySelectorAll('.tab-surface').forEach((surface) => { const active = Number(surface.dataset.tabId) === id; surface.hidden = false; surface.classList.toggle('inactive-surface', !active); }); }

function getActiveSurface() {
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  activateSurface(activeTabId);
  return surface;
}

function saveSession() { localStorage.setItem('linsoft-session', JSON.stringify([...tabs.values()])); localStorage.setItem('linsoft-active-tab', String(activeTabId)); localStorage.setItem('linsoft-session-clean', '0'); updateNavigationButtons(); }

function suspendInactiveTabs() { if (!settingsState.suspendInactiveTabs) return; for (const [id, tab] of tabs) { if (id === activeTabId || tab.pinned || suspendedTabs.has(id) || !tab.url || !/^https?:/i.test(tab.url) || /(?:youtube\.com|youtu\.be)/i.test(tab.url)) continue; const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`); if (!viewer) continue; viewer.executeJavaScript('document.querySelectorAll("video,audio").forEach((media) => media.pause())').catch(() => {}); viewer.remove(); content.querySelector(`.tab-surface[data-tab-id="${id}"]`)?.remove(); suspendedTabs.add(id); tab.suspended = true; } }

function restoreSession() {
  if (!settingsState.restoreTabs) return startPage();
  let sessionTabs = [];
  try { sessionTabs = JSON.parse(localStorage.getItem('linsoft-session') || '[]'); } catch { sessionTabs = []; }
  if (!sessionTabs.length) return startPage();
  const first = sessionTabs[0]; const firstTab = tabs.get(1); Object.assign(firstTab, first, { id: 1 }); const firstButton = document.querySelector('.managed-tab[data-tab-id="1"]'); firstButton?.classList.toggle('pinned', firstTab.pinned === true); if (firstTab.group) firstButton?.classList.add(`tab-group-${firstTab.group}`); if (firstTab.muted) setTabAudioIcon(1, true, false); if (first.url === 'linsoft://start') startPage(); else navigate(first.url, false);
  sessionTabs.slice(1).forEach((tab) => { const id = nextTabId++; const restoredTab = Object.assign({ history: [tab.url], historyIndex: 0, pinned: false, suspended: true }, tab, { id }); tabs.set(id, restoredTab); suspendedTabs.add(id); createTabButton(restoredTab); });
  const savedActiveTab = Number(localStorage.getItem('linsoft-active-tab'));
  if (tabs.has(savedActiveTab)) selectTab(savedActiveTab);
  updateTabDensity();
}

const hadCrash = localStorage.getItem('linsoft-session-clean') === '0';
localStorage.setItem('linsoft-session-clean', '0');
window.addEventListener('beforeunload', () => { saveSession(); localStorage.setItem('linsoft-session-clean', '1'); });
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });
window.setInterval(suspendInactiveTabs, 5 * 60 * 1000);

function startPage() {
  addressInput.value = 'linsoft://start';
  tabTitle.textContent = 'Nová karta';
  setInstallAppAvailable(false);
  updateActiveTab('linsoft://start', 'Nová karta');
  setTabIcon(activeTabId);
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  surface.innerHTML = `<div class="start"><div class="start-kicker">LINSOFT BROWSER <span></span></div><div class="logo"><span class="logo-l">L</span>in<span>soft</span><i>•</i></div><p>${isGuestWindow ? 'Okno hosťa: história, cookies a údaje stránok sa po zatvorení nezachovajú.' : 'Rýchly, súkromný a skutočný webový prehliadač pre Windows a Linux Debian.'}</p><form class="start-form"><div class="start-search"><span>⌕</span><input class="start-input" placeholder="Hľadať na webe alebo zadať adresu" autocomplete="off" /></div><button type="submit">Hľadať</button></form><div class="quick"><button data-url="https://www.google.com">G <span>Google</span></button><button data-url="https://www.youtube.com">▶ <span>YouTube</span></button><button data-url="https://github.com">⌘ <span>GitHub</span></button><button data-url="https://news.google.com">N <span>Správy</span></button></div><div class="start-footer"><span>● ${isGuestWindow ? 'Režim hosťa aktívny' : 'Chránené prehliadanie aktívne'}</span><span>Linsoft Browser 2.0 • Windows + Linux</span></div></div>`;
  surface.querySelector('.start-form').addEventListener('submit', (event) => { event.preventDefault(); navigate(surface.querySelector('.start-input').value); });
  surface.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.url)));
  surface.querySelectorAll('[data-library]').forEach((button) => button.addEventListener('click', () => openLibrary(button.dataset.library)));
}

function searchUrl(query) {
  const encoded = encodeURIComponent(query);
  if (settingsState.search === 'Bing') return `https://www.bing.com/search?q=${encoded}`;
  if (settingsState.search === 'DuckDuckGo') return `https://duckduckgo.com/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
}

function normalizeNetworkAddress(input) {
  const value = String(input || '').trim();
  const localhost = /^localhost(?::(\d+))?(\/.*)?$/i.exec(value);
  if (localhost) return { value: `http://localhost${localhost[1] ? `:${localhost[1]}` : ''}${localhost[2] || ''}`, isIp: true };
  const ipv4 = value.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::(\d+))?(\/.*)?$/);
  if (ipv4) {
    const validPort = !ipv4[2] || Number(ipv4[2]) <= 65535;
    const valid = validPort && ipv4[1].split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
    if (valid) return { value: `http://${ipv4[1]}${ipv4[2] ? `:${ipv4[2]}` : ''}${ipv4[3] || ''}`, isIp: true };
  }
  const bracketedIpv6 = /^\[([0-9a-f:]+)\](?::(\d+))?(\/.*)?$/i.exec(value);
  if (bracketedIpv6 && (!bracketedIpv6[2] || Number(bracketedIpv6[2]) <= 65535)) return { value: `http://[${bracketedIpv6[1]}]${bracketedIpv6[2] ? `:${bracketedIpv6[2]}` : ''}${bracketedIpv6[3] || ''}`, isIp: true };
  const rawIpv6 = /^[0-9a-f:]+$/i.test(value) && value.includes(':');
  if (rawIpv6) return { value: `http://[${value}]`, isIp: true };
  return { value, isIp: false };
}

function updateConnectionIndicator(url) {
  const secure = /^https:\/\//i.test(url);
  const weak = /^http:\/\//i.test(url);
  const button = document.getElementById('securityButton');
  const title = document.getElementById('securityTitle');
  const check = document.querySelector('.security-check');
  if (button) { button.classList.toggle('https-active', secure); button.classList.toggle('http-warning', weak); button.title = secure ? 'Zabezpečené HTTPS pripojenie' : weak ? 'Slabo zabezpečené HTTP pripojenie' : 'Lokálny alebo nešifrovaný obsah'; button.setAttribute('aria-label', button.title); }
  if (check) { check.classList.toggle('warning', weak); check.textContent = weak ? '!' : '✓'; }
  if (title) title.textContent = secure ? 'Pripojenie je zabezpečené' : weak ? 'Slabo zabezpečené HTTP pripojenie' : 'Lokálny obsah';
}

function installYoutubeAdBlock(viewer) {
  if (!settingsState.adBlock || !viewer) return;
  let hostname = '';
  try { hostname = new URL(viewer.getURL?.() || viewer.src || '').hostname; } catch { return; }
  if (!/youtube\.com$/i.test(hostname)) return;
  viewer.executeJavaScript(`(() => {
    if (window.__linsoftYoutubeAdBlock) return;
    window.__linsoftYoutubeAdBlock = true;
    const selectors = [
      '.video-ads', '.ytp-ad-module', '.ytp-ad-overlay-container', '.ytp-ad-text-overlay',
      '.ytp-ad-player-overlay', '.ytp-ad-image-overlay', '.ytp-ad-overlay-slot',
      'ytd-display-ad-renderer', 'ytd-promoted-sparkles-web-renderer',
      'ytd-action-companion-ad-renderer', 'ytd-in-feed-ad-layout-renderer',
      'ytd-banner-promo-renderer', 'ytd-ad-slot-renderer'
    ];
    const clean = () => {
      document.querySelectorAll(selectors.join(',')).forEach((element) => element.remove());
      const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
      if (skip) skip.click();
      const player = document.querySelector('.html5-video-player');
      if (player && player.classList.contains('ad-showing')) {
        const video = player.querySelector('video');
        if (video) { video.currentTime = video.duration || 0; video.play().catch(() => {}); }
      }
    };
    clean();
    new MutationObserver(clean).observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(clean, 2500);
  })()`).catch(() => {});
}


function showExternalPreview(surface, url) {
  surface.innerHTML = `<div class="external-preview"><div class="external-preview-icon">↗</div><p class="settings-eyebrow">WEBOVÁ STRÁNKA</p><h2>${escapeHtml(new URL(url).hostname)}</h2><p>Táto stránka nepovoľuje vloženie do náhľadu. Otvorí sa priamo v novej karte prehliadača.</p><a class="external-preview-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Otvoriť stránku</a></div>`;
  activateSurface(activeTabId);
}

function setInstallAppAvailable(available) { const button = document.getElementById('installAppButton'); if (button) button.hidden = !available; }
function installCurrentApp() { const url = addressInput.value; if (!/^https?:\/\//i.test(url)) return showToast('Táto stránka sa nedá nainštalovať ako webová aplikácia.'); document.getElementById('installDialogTitle').textContent = `Nainštalovať ${tabTitle.textContent}?`; document.getElementById('installDialogUrl').textContent = url; document.getElementById('installDialog').hidden = false; }

function closeInstallDialog() { document.getElementById('installDialog').hidden = true; }

function openAppCenter() {
  addressInput.value = 'linsoft://apps';
  tabTitle.textContent = 'Linsoft App Centrum';
  updateActiveTab('linsoft://apps', 'Linsoft App Centrum');
  saveSession();
  setInstallAppAvailable(false);
  const surface = getActiveSurface();
  const cards = installedApps.map((item, index) => { let icon = ''; try { icon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(item.url).hostname)}&sz=64`; } catch {} return `<article class="app-center-card"><div class="app-center-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${escapeHtml((item.title || item.url).slice(0, 1).toUpperCase())}</span>` : escapeHtml((item.title || item.url).slice(0, 1).toUpperCase())}</div><div class="app-center-info"><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(item.url)}</small></div><button class="app-center-open" data-app-index="${index}">Otvoriť</button><button class="app-center-remove" data-remove-app="${index}" aria-label="Odinštalovať aplikáciu">Odinštalovať</button></article>`; }).join('');
  surface.innerHTML = `<div class="app-center-page"><div class="app-center-hero"><div><span class="settings-eyebrow">LINSOFT / WORKSPACE</span><h1>App Centrum</h1><p>Všetky tvoje webové aplikácie na jednom mieste.</p></div><div class="app-center-mark">L<span>•</span></div></div><div class="app-center-toolbar"><div><strong>${installedApps.length} ${installedApps.length === 1 ? 'aplikácia' : 'aplikácií'}</strong><small> pripravených na otvorenie</small></div><button id="appCenterNewApp">+ Pridať web</button></div><div class="app-center-list">${cards || '<div class="app-center-empty"><div class="app-center-empty-icon">⌘</div><strong>Zatiaľ tu nič nie je</strong><p>Nainštaluj web cez tlačidlo vpravo hore a objaví sa tu ako rýchla aplikácia.</p></div>'}</div></div>`;
  surface.querySelector('#appCenterNewApp').addEventListener('click', () => { closeBrowserMenu(); installCurrentApp(); });
  surface.querySelectorAll('[data-app-index]').forEach((button) => button.addEventListener('click', () => navigate(installedApps[Number(button.dataset.appIndex)].url)));
  surface.querySelectorAll('[data-remove-app]').forEach((button) => button.addEventListener('click', async () => { const item = installedApps[Number(button.dataset.removeApp)]; if (!window.confirm(`Odinštalovať ${item.title || item.url}?`)) return; const result = await window.linsoftBrowser?.uninstallWebApp(item.url, item.title); if (result && !result.ok) return showToast(result.message); installedApps.splice(Number(button.dataset.removeApp), 1); localStorage.setItem('linsoft-apps', JSON.stringify(installedApps)); openAppCenter(); showToast('Webová aplikácia bola odinštalovaná.'); }));
}

function saveSettings() {
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
  document.body.classList.toggle('light-theme', settingsState.theme === 'light');
  window.linsoftBrowser?.setBrowserPreferences({ downloads: settingsState.downloads, downloadFolderPath: settingsState.downloadFolderPath || '', askDownload: settingsState.askDownload, adBlock: settingsState.adBlock, trackingProtection: settingsState.trackingProtection, camera: settingsState.camera, microphone: settingsState.microphone, webNotifications: settingsState.webNotifications, clearExit: settingsState.clearExit, autoUpdateCheck: settingsState.autoUpdateCheck });
}

function openLibrary(mode) {
  addressInput.value = `linsoft://${mode}`; tabTitle.textContent = mode === 'bookmarks' ? 'Záložky' : 'História';
  updateActiveTab(`linsoft://${mode}`, mode === 'bookmarks' ? 'Záložky' : 'História');
  saveSession();
  const items = mode === 'bookmarks' ? savedBookmarks : JSON.parse(localStorage.getItem('linsoft-history') || '[]');
  const surface = getActiveSurface();
  surface.innerHTML = `<div class="library-page"><div class="settings-heading"><div><span class="settings-eyebrow">LINSOFT BROWSER</span><h1>${mode === 'bookmarks' ? 'Záložky' : 'História'}</h1><p>${mode === 'bookmarks' ? 'Uložené stránky na jednom mieste.' : 'Nedávno navštívené stránky.'}</p></div><div class="library-actions">${mode === 'history' ? '<button class="danger-button" id="clearHistoryPage">Vymazať históriu</button>' : ''}</div></div><div class="library-list">${items.length ? items.map((item, index) => `<div class="library-row"><button class="library-open" data-url="${escapeHtml(item.url)}"><span class="library-icon">${mode === 'bookmarks' ? '★' : '◷'}</span><span><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(item.url)}</small></span><span>→</span></button>${mode === 'bookmarks' ? `<button class="library-delete" data-bookmark-index="${index}" aria-label="Odstrániť záložku">×</button>` : ''}</div>`).join('') : '<div class="empty-library">Zatiaľ tu nič nie je.</div>'}</div></div>`;
  surface.querySelector('#clearHistoryPage')?.addEventListener('click', () => { localStorage.removeItem('linsoft-history'); showToast('História bola vymazaná.'); openLibrary('history'); }); surface.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.url))); surface.querySelectorAll('[data-bookmark-index]').forEach((button) => button.addEventListener('click', () => { savedBookmarks.splice(Number(button.dataset.bookmarkIndex), 1); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); openLibrary('bookmarks'); }));
}

const passwordPromptCache = new Map();

async function maybeOfferSavePassword(viewer, url) {
  if (!viewer || typeof viewer.executeJavaScript !== 'function') return;
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const data = await viewer.executeJavaScript(`(() => {
      const usernameField = Array.from(document.querySelectorAll('input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="email" i]'))
        .find((element) => element.offsetParent !== null && !element.disabled && !element.readOnly);
      const passwordField = Array.from(document.querySelectorAll('input[type="password"]'))
        .find((element) => element.offsetParent !== null && !element.disabled && !element.readOnly);
      if (!usernameField || !passwordField) return null;
      const username = (usernameField.value || '').trim();
      const password = (passwordField.value || '').trim();
      if (!username || !password) return null;
      return { username, password };
    })()`, true);
    if (!data || !data.username || !data.password) return;
    const cacheKey = `${hostname}|${data.username.toLowerCase()}`;
    if (passwordPromptCache.has(cacheKey)) return;
    const shouldSave = window.confirm(`Uložiť heslo pre ${hostname} a používateľa ${data.username}?`);
    if (!shouldSave) {
      passwordPromptCache.set(cacheKey, Date.now());
      return;
    }
    const result = await window.linsoftBrowser?.savePassword({ hostname, username: data.username, password: data.password });
    passwordPromptCache.set(cacheKey, Date.now());
    if (result?.ok) showToast('Heslo bolo uložené šifrovane.');
    else showToast(result?.message || 'Heslo sa nepodarilo uložiť.');
  } catch {}
}

function bindPasswordSavePrompt(viewer, url) {
  if (!viewer || viewer.__linsoftPasswordPromptBound) return;
  viewer.__linsoftPasswordPromptBound = true;
  const pollId = window.setInterval(async () => {
    if (viewer.isDestroyed?.()) {
      window.clearInterval(pollId);
      return;
    }
    const currentUrl = viewer.getURL?.() || url;
    if (currentUrl) await maybeOfferSavePassword(viewer, currentUrl);
  }, 2000);
  viewer.addEventListener('destroyed', () => window.clearInterval(pollId));
}

function openSettings(section = 'general') {
  addressInput.value = 'linsoft://settings';
  tabTitle.textContent = 'Nastavenia';
  updateActiveTab('linsoft://settings', 'Nastavenia');
  saveSession();
  const surface = getActiveSurface();
  surface.innerHTML = `<div class="settings-page"><div class="settings-heading"><div><span class="settings-eyebrow">LINSOFT BROWSER</span><h1>Nastavenia</h1><p>Prispôsob si browser podľa svojho spôsobu práce.</p></div></div><div class="settings-layout"><nav class="settings-nav"><button data-settings-section="general">⚙ <span>Všeobecné</span></button><button data-settings-section="appearance">◐ <span>Vzhľad</span></button><button data-settings-section="privacy">♢ <span>Súkromie a bezpečnosť</span></button><button data-settings-section="about">ⓘ <span>O aplikácii</span></button></nav><div class="settings-panels"><section data-settings-panel="general"><p class="settings-label">VŠEOBECNÉ</p><h2>Správanie browsera</h2><div class="setting-card"><div><strong>Pri spustení</strong><small>Vyber, čo sa zobrazí po otvorení Linsoft Browsera.</small></div><select id="startupSetting"><option value="start">Nová karta Linsoft</option><option value="home">Domovská stránka</option></select></div><div class="setting-card"><div><strong>Domovská stránka</strong><small>Adresa, ktorú otvorí tlačidlo Domov.</small></div><input class="settings-input" id="homeSetting" value="${escapeHtml(settingsState.home)}" /></div><div class="setting-card"><div><strong>Vyhľadávač</strong><small>Predvolený vyhľadávač pre otázky v adresnom riadku.</small></div><select id="searchSetting"><option>Google</option><option>Bing</option><option>DuckDuckGo</option></select></div></section><section data-settings-panel="appearance"><p class="settings-label">VZHĽAD</p><h2>Vzhľad aplikácie</h2><div class="setting-card"><div><strong>Farebná téma</strong><small>Vyber, ako má Linsoft Browser vyzerať.</small></div><select id="themeSetting"><option value="dark">Tmavá</option><option value="light">Svetlá</option></select></div><div class="setting-card"><div><strong>Kompaktný panel</strong><small>Zmenší výšku navigačných panelov pre viac priestoru.</small></div><button class="settings-toggle" data-setting-toggle="compact"><i></i></button></div></section><section data-settings-panel="privacy"><p class="settings-label">SÚKROMIE</p><h2>Súkromie a bezpečnosť</h2><div class="setting-card"><div><strong>Bezpečné prehliadanie</strong><small>Upozorní pred známymi nebezpečnými stránkami.</small></div><button class="settings-toggle ${settingsState.safe ? 'on' : ''}" data-setting-toggle="safe"><i></i></button></div><div class="setting-card"><div><strong>Blokovať vyskakovacie okná</strong><small>Obmedzí automatické otváranie nových okien.</small></div><button class="settings-toggle ${settingsState.popups ? 'on' : ''}" data-setting-toggle="popups"><i></i></button></div><div class="setting-card"><div><strong>Posielať požiadavku Do Not Track</strong><small>Požiada weby, aby nesledovali tvoju aktivitu.</small></div><button class="settings-toggle ${settingsState.tracking ? 'on' : ''}" data-setting-toggle="tracking"><i></i></button></div><button class="danger-button" id="clearBrowserData">Vymazať históriu a údaje prehliadania</button></section><section data-settings-panel="about"><p class="settings-label">O APLIKÁCII</p><h2>Linsoft Browser</h2><div class="about-card"><span class="about-logo">L</span><div><strong>Linsoft Browser 1.0.0</strong><small>Desktopový prehliadač pre Windows postavený na Electron + Chromium.</small><small>© 2026 Linsoft</small></div></div></section><div class="settings-actions"><button class="settings-reset" id="resetSettings">Obnoviť predvolené</button><button class="save-settings" id="saveSettings">Uložiť zmeny</button></div></div></div></div>`;
  const startup = surface.querySelector('#startupSetting'); const theme = surface.querySelector('#themeSetting'); const search = surface.querySelector('#searchSetting'); const home = surface.querySelector('#homeSetting');
  startup.value = settingsState.startup; theme.value = settingsState.theme; search.value = settingsState.search;
  addUpdateCheck();
  surface.querySelectorAll('[data-settings-section]').forEach((button) => button.addEventListener('click', () => { surface.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === button)); surface.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.hidden = panel.dataset.settingsPanel !== button.dataset.settingsSection); }));
  surface.querySelector(`[data-settings-section="${section}"]`).click();
  surface.querySelectorAll('[data-setting-toggle]').forEach((toggle) => toggle.addEventListener('click', () => { toggle.classList.toggle('on'); if (toggle.dataset.settingToggle === 'autoUpdateCheck') { settingsState.autoUpdateCheck = toggle.classList.contains('on'); saveSettings(); const note = surface.querySelector('[data-update-note]'); if (note) note.textContent = settingsState.autoUpdateCheck ? 'Automatická kontrola je zapnutá.' : 'Automatická kontrola je vypnutá.'; } }));
  surface.querySelector('#saveSettings').addEventListener('click', () => { settingsState.startup = startup.value; settingsState.theme = theme.value; settingsState.search = search.value; settingsState.home = home.value.trim() || 'linsoft://start'; settingsState.safe = surface.querySelector('[data-setting-toggle="safe"]').classList.contains('on'); settingsState.popups = surface.querySelector('[data-setting-toggle="popups"]').classList.contains('on'); settingsState.tracking = surface.querySelector('[data-setting-toggle="tracking"]').classList.contains('on'); ['camera', 'microphone', 'webNotifications'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (toggle) settingsState[key] = toggle.classList.contains('on'); }); saveSettings(); showToast('Nastavenia boli uložené.'); });
  surface.querySelector('#resetSettings').addEventListener('click', () => { localStorage.removeItem('linsoft-settings'); Object.assign(settingsState, defaultSettings); openSettings(section); showToast('Nastavenia boli obnovené.'); });
  surface.querySelector('#clearBrowserData').addEventListener('click', () => { localStorage.removeItem('linsoft-history'); localStorage.removeItem('linsoft-session'); localStorage.removeItem('linsoft-bookmarks'); localStorage.removeItem('linsoft-apps'); savedBookmarks.splice(0); installedApps.splice(0); renderSavedBookmarks(); showToast('História a údaje boli vymazané.'); });
  addAdvancedSettings();
  addSecuritySettings();
}

function addSecuritySettings() {
  const surface = getActiveSurface();
  const panel = surface.querySelector('[data-settings-panel="privacy"]');
  if (!panel) return;
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">ULOŽENÉ POVOLENIA WEBOV</p><div class="permission-list-toolbar"><input class="settings-input" id="sitePermissionFilter" placeholder="Filtrovať podľa domény" autocomplete="off"><button class="settings-control" id="clearSitePermissions">Odobrať všetko</button></div><div id="sitePermissionList" class="password-list"><small class="update-note">Načítavam povolenia...</small></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">POVOLENIA WEBOV</p><div class="setting-card"><div><strong>Kamera</strong><small>Weby môžu požiadať o prístup ku kamere.</small></div><button class="settings-toggle" data-setting-toggle="camera"><i></i></button></div><div class="setting-card"><div><strong>Mikrofón</strong><small>Weby môžu požiadať o prístup k mikrofónu.</small></div><button class="settings-toggle" data-setting-toggle="microphone"><i></i></button></div><div class="setting-card"><div><strong>Upozornenia</strong><small>Weby môžu zobrazovať systémové upozornenia.</small></div><button class="settings-toggle" data-setting-toggle="webNotifications"><i></i></button></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">ADBLOCK</p><div class="setting-card"><div><strong>Štatistiky blokovania</strong><small id="adBlockStats">Načítavam štatistiky...</small></div><button class="settings-control" id="refreshAdBlockStats">Obnoviť</button></div><div class="setting-card"><div><strong>Výnimka pre aktuálnu stránku</strong><small>Povolí reklamné požiadavky pre doménu otvorenej stránky.</small></div><button class="settings-control" id="toggleAdBlockSite">Povoliť stránku</button></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">HESLÁ</p><div class="setting-card"><div><strong>Uložené prihlasovacie údaje</strong><small>Heslá sa ukladajú šifrovane do systému, nie do histórie prehliadača.</small></div><button class="settings-control" id="refreshPasswords">Obnoviť</button></div><div id="passwordList" class="password-list"></div><div class="password-form"><input class="settings-input" id="passwordHost" placeholder="Doména, napr. example.com" autocomplete="off"><input class="settings-input" id="passwordUsername" placeholder="Používateľ" autocomplete="off"><input class="settings-input" id="passwordValue" type="password" placeholder="Heslo" autocomplete="new-password"><button class="save-settings" id="savePasswordButton">Uložiť heslo</button></div></div>');
  ['camera', 'microphone', 'webNotifications'].forEach((key) => { const toggle = panel.querySelector(`[data-setting-toggle="${key}"]`); toggle.classList.toggle('on', settingsState[key]); toggle.addEventListener('click', () => toggle.classList.toggle('on')); });
  let sitePermissionEntries = [];
  const renderSitePermissions = async (reload = true) => {
    const list = panel.querySelector('#sitePermissionList');
    if (reload) sitePermissionEntries = await window.linsoftBrowser?.listSitePermissions?.() || [];
    const filter = panel.querySelector('#sitePermissionFilter')?.value.trim().toLowerCase() || '';
    const entries = sitePermissionEntries.filter((entry) => entry.origin.toLowerCase().includes(filter));
    if (!list) return;
    list.innerHTML = (entries || []).map((entry) => {
      const permission = entry.permission === 'notifications' ? 'Upozornenia' : `Médiá (${entry.permission})`;
      const decision = entry.decision === 'allow' ? 'Povolené' : 'Blokované';
      return `<div class="password-row"><span><strong>${escapeHtml(entry.origin)}</strong><small>${escapeHtml(permission)} · ${decision}</small></span><button class="settings-control" data-revoke-site-permission="${escapeHtml(entry.key)}">Odvolať</button></div>`;
    }).join('') || '<small class="update-note">Zatiaľ nie sú uložené žiadne povolenia.</small>';
    list.querySelectorAll('[data-revoke-site-permission]').forEach((button) => button.addEventListener('click', async () => {
      const result = await window.linsoftBrowser?.revokeSitePermission?.(button.dataset.revokeSitePermission);
      if (result?.ok) { renderSitePermissions(); showToast('Povolenie stránky bolo odvolané.'); }
      else showToast('Povolenie sa nepodarilo odvolať.');
    }));
  };
  renderSitePermissions();
  panel.querySelector('#sitePermissionFilter').addEventListener('input', () => renderSitePermissions(false));
  panel.querySelector('#clearSitePermissions').addEventListener('click', async () => {
    if (!sitePermissionEntries.length || !window.confirm('Odobrať všetky uložené povolenia webov?')) return;
    const result = await window.linsoftBrowser?.clearSitePermissions?.();
    if (result?.ok) { renderSitePermissions(); showToast('Všetky povolenia webov boli odvolané.'); }
    else showToast('Povolenia sa nepodarilo odvolať.');
  });
  const renderAdBlockStats = async () => { const stats = await window.linsoftBrowser?.getAdblockStats(); const label = panel.querySelector('#adBlockStats'); if (label && stats) label.textContent = `${stats.blocked} zablokovaných požiadaviek · ${stats.learned} naučených hostov · ${stats.allowlisted} výnimiek`; };
  panel.querySelector('#refreshAdBlockStats').addEventListener('click', renderAdBlockStats);
  panel.querySelector('#toggleAdBlockSite').addEventListener('click', async (event) => { let host = ''; try { host = new URL(addressInput.value).hostname; } catch {} if (!host) return showToast('Aktuálna stránka nemá platnú doménu.'); const result = await window.linsoftBrowser?.toggleAdblockSite(host); if (!result?.ok) return showToast(result?.message || 'Výnimku sa nepodarilo nastaviť.'); event.currentTarget.textContent = result.allowlisted ? 'Výnimka zapnutá' : 'Povoliť stránku'; renderAdBlockStats(); showToast(result.allowlisted ? `Reklamy povolené pre ${host}.` : `Výnimka odstránená pre ${host}.`); });
  renderAdBlockStats();
  const passwordList = panel.querySelector('#passwordList');
  const fillPassword = async (id) => { let hostname = ''; try { hostname = new URL(addressInput.value).hostname.toLowerCase(); } catch {} const entry = await window.linsoftBrowser?.getPassword(id); if (!entry || hostname !== entry.hostname) return showToast('Heslo možno vyplniť iba na rovnakej doméne.'); const viewer = activeViewer(); if (!viewer) return showToast('Na aktuálnej stránke nie je prihlasovací formulár.'); const username = JSON.stringify(entry.username); const password = JSON.stringify(entry.password); const filled = await viewer.executeJavaScript(`(() => { const user = document.querySelector('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="login" i]'); const pass = document.querySelector('input[type="password"]'); if (!pass) return false; const set = (element, value) => { if (!element) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }; set(user, ${username}); set(pass, ${password}); return true; })()`, true).catch(() => false); showToast(filled ? 'Prihlasovacie údaje boli vyplnené.' : 'Na stránke sa nenašlo heslové pole.'); };
  const renderPasswords = async () => { const entries = await window.linsoftBrowser?.listPasswords(); passwordList.innerHTML = (entries || []).map((entry) => `<div class="password-row"><span><strong>${escapeHtml(entry.hostname)}</strong><small>${escapeHtml(entry.username)}</small></span><div class="password-row-actions"><button class="settings-control" data-fill-password="${escapeHtml(entry.id)}">Vyplniť</button><button class="settings-control" data-delete-password="${escapeHtml(entry.id)}">Odstrániť</button></div></div>`).join('') || '<small class="update-note">Žiadne uložené heslá.</small>'; passwordList.querySelectorAll('[data-fill-password]').forEach((button) => button.addEventListener('click', () => fillPassword(button.dataset.fillPassword))); passwordList.querySelectorAll('[data-delete-password]').forEach((button) => button.addEventListener('click', async () => { const result = await window.linsoftBrowser?.deletePassword(button.dataset.deletePassword); if (result?.ok) { renderPasswords(); showToast('Heslo bolo odstránené.'); } })); };
  panel.querySelector('#refreshPasswords').addEventListener('click', renderPasswords);
  panel.querySelector('#savePasswordButton').addEventListener('click', async () => { const result = await window.linsoftBrowser?.savePassword({ hostname: panel.querySelector('#passwordHost').value, username: panel.querySelector('#passwordUsername').value, password: panel.querySelector('#passwordValue').value }); if (!result?.ok) return showToast(result?.message || 'Heslo sa nepodarilo uložiť.'); panel.querySelector('#passwordHost').value = ''; panel.querySelector('#passwordUsername').value = ''; panel.querySelector('#passwordValue').value = ''; renderPasswords(); showToast('Heslo bolo uložené šifrovane.'); });
  renderPasswords();
}

function addUpdateCheck() {
  const surface = getActiveSurface();
  const aboutPanel = surface.querySelector('[data-settings-panel="about"]');
  const navigation = surface.querySelector('.settings-nav');
  const panels = surface.querySelector('.settings-panels');
  if (!aboutPanel || !navigation || !panels) return;
  const aboutCard = aboutPanel.querySelector('.about-card');
  if (aboutCard) { const description = aboutCard.querySelector('small'); if (description) description.remove(); aboutCard.querySelector('div').insertAdjacentHTML('beforeend', '<small>Autor: Martin Pastorek</small>'); }
  aboutPanel.insertAdjacentHTML('beforeend', '<div class="license-card"><h3>Licenčné podmienky používania</h3><p>Linsoft Browser je poskytovaný na osobné a interné použitie.</p><p>Je zakázané aplikáciu predávať, meniť, redistribuovať alebo používať na nezákonné účely bez písomného súhlasu autora.</p><p>Aplikácia používa Electron, Chromium a ďalšie komponenty tretích strán, ktoré sa riadia vlastnými licenciami.</p><p>Autor nezodpovedá za obsah webových stránok otvorených v prehliadači ani za škody spôsobené ich používaním.</p></div>');
  navigation.insertAdjacentHTML('beforeend', '<button data-settings-section="updates">↻ <span>Aktualizácie</span></button>');
  panels.insertAdjacentHTML('beforeend', '<section data-settings-panel="updates" hidden><p class="settings-label">AKTUALIZÁCIE</p><h2>Verzia a aktualizácie</h2><div class="about-card"><div class="about-logo">↻</div><div><strong id="settingsAppVersion">Linsoft Browser</strong><small>Kontrola aktualizácií pre túto aplikáciu.</small></div></div><div class="setting-card"><div><strong>Automaticky kontrolovať</strong><small>Kontrolovať pri spustení a pravidelne počas používania.</small></div><button class="settings-toggle" id="autoUpdateCheckToggle" data-setting-toggle="autoUpdateCheck"><i></i></button></div><button class="check-update" data-update-action="check" type="button">Skontrolovať teraz</button><p class="update-note" data-update-note></p></section>');
  const updatePanel = panels.querySelector('[data-settings-panel="updates"]');
  const updateToggle = updatePanel.querySelector('#autoUpdateCheckToggle');
  const updateButton = updatePanel.querySelector('[data-update-action]');
  updateToggle.classList.toggle('on', settingsState.autoUpdateCheck !== false);
  updateButton.addEventListener('click', async () => {
    if (updateButton.dataset.updateAction === 'install') return window.linsoftBrowser?.installUpdate?.();
    updateButton.disabled = true;
    updatePanel.querySelector('[data-update-note]').textContent = 'Kontrolujem aktualizácie...';
    const result = await window.linsoftBrowser?.checkForUpdates?.();
    if (result?.status === 'available') {
      renderSettingsUpdateState({ status: 'available', version: result.version });
      const download = await window.linsoftBrowser?.downloadUpdate?.();
      if (download?.ok) renderSettingsUpdateState({ status: 'downloading', version: result.version, percent: 0 });
      else { updatePanel.querySelector('[data-update-note]').textContent = `Sťahovanie zlyhalo: ${download?.message || 'neznáma chyba'}`; updateButton.disabled = false; }
    } else {
      updatePanel.querySelector('[data-update-note]').textContent = result?.status === 'latest' ? `Používaš najnovšiu verziu Linsoft Browser ${result.version}.` : result?.message || 'Aktualizácie nie sú dostupné.';
      updateButton.disabled = false;
    }
  });
  window.linsoftBrowser?.getVersion?.().then((version) => {
    const versionLabel = updatePanel.querySelector('#settingsAppVersion');
    if (versionLabel) versionLabel.textContent = `Linsoft Browser ${version}`;
    const aboutLabel = aboutCard?.querySelector('strong');
    if (aboutLabel) aboutLabel.textContent = `Linsoft Browser ${version}`;
  }).catch(() => {});
  window.linsoftBrowser?.getUpdateState?.().then(renderSettingsUpdateState).catch(() => {});
}

function renderSettingsUpdateState(state) {
  if (!state) return;
  document.querySelectorAll('[data-settings-panel="updates"]').forEach((panel) => {
    const note = panel.querySelector('[data-update-note]');
    const button = panel.querySelector('[data-update-action]');
    if (!note || !button) return;
    if (state.status === 'available') note.textContent = `Dostupná je verzia ${state.version}.`;
    else if (state.status === 'downloading') note.textContent = `Sťahuje sa aktualizácia: ${Math.max(0, Math.min(100, Number(state.percent) || 0))} %.`;
    else if (state.status === 'downloaded') note.textContent = `Verzia ${state.version} je pripravená na inštaláciu.`;
    else if (state.status === 'latest') note.textContent = `Používaš najnovšiu verziu Linsoft Browser ${state.version}.`;
    else if (state.status === 'error' || state.status === 'unavailable') note.textContent = state.message || 'Aktualizácie sa teraz nedajú overiť.';
    if (state.status === 'downloaded') {
      button.dataset.updateAction = 'install';
      button.textContent = 'Reštartovať a nainštalovať';
      button.disabled = false;
    } else if (state.status === 'downloading') {
      button.dataset.updateAction = 'check';
      button.textContent = 'Sťahuje sa...';
      button.disabled = true;
    } else {
      button.dataset.updateAction = 'check';
      button.textContent = 'Skontrolovať teraz';
      button.disabled = false;
    }
  });
}

function addAdvancedSettings() {
  const surface = getActiveSurface();
  const navigation = surface.querySelector('.settings-nav');
  const panels = surface.querySelector('.settings-panels');
  navigation.insertAdjacentHTML('beforeend', '<button data-settings-section="advanced">⌘ <span>Pokročilé</span></button>');
  panels.insertAdjacentHTML('beforeend', '<section data-settings-panel="advanced" hidden><p class="settings-label">POKROČILÉ</p><h2>Ďalšie možnosti</h2><div class="setting-card"><div><strong>Blokovanie reklám</strong><small>Blokuje reklamné siete a učí sa z opakovaných reklamných požiadaviek lokálne.</small></div><button class="settings-toggle" data-setting-toggle="adBlock"><i></i></button></div><div class="setting-card"><div><strong>Ochrana proti sledovaniu</strong><small>Obmedzí trackery, analytické pixely a odošle signál Do Not Track.</small></div><button class="settings-toggle" data-setting-toggle="trackingProtection"><i></i></button></div><div class="setting-card"><div><strong>Priečinok na stiahnuté súbory</strong><small>Miesto, kam Linsoft Browser ukladá stiahnuté súbory.</small></div><select id="downloadsSetting"><option value="Downloads">Downloads</option><option value="Desktop">Plocha</option><option value="Documents">Dokumenty</option></select></div><div class="setting-card"><div><strong>Vždy sa opýtať pred stiahnutím</strong><small>Zobrazí potvrdenie pred každým stiahnutím.</small></div><button class="settings-toggle" data-setting-toggle="askDownload"><i></i></button></div><div class="setting-card"><div><strong>Obnoviť karty po spustení</strong><small>Po otvorení obnoví poslednú pracovnú reláciu.</small></div><button class="settings-toggle" data-setting-toggle="restoreTabs"><i></i></button></div><div class="setting-card"><div><strong>Predvolené priblíženie</strong><small>Veľkosť obsahu webových stránok.</small></div><select id="zoomSetting"><option value="80">80 %</option><option value="90">90 %</option><option value="100">100 %</option><option value="110">110 %</option><option value="125">125 %</option></select></div><div class="setting-card"><div><strong>Vymazať údaje pri ukončení</strong><small>Po zatvorení browsera vymaže lokálnu históriu.</small></div><button class="settings-toggle" data-setting-toggle="clearExit"><i></i></button></div><div class="setting-card"><div><strong>Aktualizovať reklamný zoznam</strong><small>Stiahne nový zoznam reklamných domén z verejného zdroja.</small></div><button class="settings-control" id="updateAdblockList">Aktualizovať</button></div></section>');
  navigation.insertAdjacentHTML('beforeend', '<button data-settings-section="vpn">⌁ <span>OpenVPN</span></button>');
  panels.insertAdjacentHTML('beforeend', '<section data-settings-panel="vpn" hidden><p class="settings-label">OPENVPN</p><h2>VPN pripojenie</h2><div class="vpn-card"><div><strong>OpenVPN profil</strong><small id="openVpnProfileName">Nie je vybraný žiadny .ovpn súbor.</small></div><button class="settings-control" id="chooseOpenVpn">Vybrať profil</button></div><div class="vpn-card"><div><strong>Stav pripojenia</strong><small id="openVpnStatus">VPN je odpojená.</small></div><span class="vpn-status-dot" id="openVpnDot"></span></div><div class="vpn-actions"><button class="save-settings" id="connectOpenVpn">Pripojiť VPN</button><button class="settings-reset" id="disconnectOpenVpn">Odpojiť</button></div><div class="vpn-log-wrap"><div class="vpn-log-title">Živý log</div><pre id="openVpnLog">Čaká sa na operáciu...</pre></div><p class="update-note">Vyžaduje nainštalovaný OpenVPN klient vo Windowse a platný .ovpn profil.</p></section>');
  panels.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">SPRÁVA A VÝKON</p><div class="setting-card"><div><strong>Potvrdiť zatvorenie viacerých kariet</strong><small>Zobrazí potvrdenie pred zatvorením okna s viacerými kartami.</small></div><button class="settings-toggle" data-setting-toggle="confirmClose"><i></i></button></div><div class="setting-card"><div><strong>Pozastavovať neaktívne karty</strong><small>Šetrí pamäť; aktívne, pripnuté a YouTube karty zostanú aktívne.</small></div><button class="settings-toggle" data-setting-toggle="suspendInactiveTabs"><i></i></button></div><div class="setting-card"><div><strong>Vymazať cache</strong><small>Vyčistí dočasné Chromium dáta bez odstránenia záložiek a kariet.</small></div><button class="settings-control" id="clearCacheButton">Vymazať</button></div></div>');
  const advancedButton = navigation.querySelector('[data-settings-section="advanced"]'); const advancedPanel = panels.querySelector('[data-settings-panel="advanced"]'); const downloads = surface.querySelector('#downloadsSetting'); const zoom = surface.querySelector('#zoomSetting'); downloads.value = settingsState.downloads; zoom.value = settingsState.zoom;
  const downloadFolderRow = downloads.closest('.setting-card'); downloadFolderRow.insertAdjacentHTML('beforeend', `<button class="settings-control" id="chooseDownloadFolder">${settingsState.downloadFolderPath ? 'Zmeniť vlastný priečinok' : 'Vybrať vlastný priečinok'}</button><small class="download-folder-name" id="downloadFolderName">${settingsState.downloadFolderPath ? escapeHtml(settingsState.downloadFolderPath) : 'Používa sa predvolený systémový priečinok.'}</small>`);
  downloads.addEventListener('change', () => { settingsState.downloadFolderPath = ''; surface.querySelector('#downloadFolderName').textContent = 'Používa sa predvolený systémový priečinok.'; surface.querySelector('#chooseDownloadFolder').textContent = 'Vybrať vlastný priečinok'; });
  surface.querySelector('#chooseDownloadFolder').addEventListener('click', async () => { const folder = await window.linsoftBrowser?.selectDownloadFolder?.(); if (!folder) return; settingsState.downloadFolderPath = folder; surface.querySelector('#downloadFolderName').textContent = folder; surface.querySelector('#chooseDownloadFolder').textContent = 'Zmeniť vlastný priečinok'; saveSettings(); });
  const vpnButton = navigation.querySelector('[data-settings-section="vpn"]'); const vpnPanel = panels.querySelector('[data-settings-panel="vpn"]'); let vpnProfile = settingsState.openvpnProfile || '';
  const showVpnStatus = (data) => { const label = surface.querySelector('#openVpnStatus'); const dot = surface.querySelector('#openVpnDot'); const log = surface.querySelector('#openVpnLog'); if (label) label.textContent = data.message || (data.status === 'connected' ? 'VPN je pripojená.' : data.status === 'connecting' ? 'OpenVPN sa pripája...' : 'VPN je odpojená.'); if (dot) dot.dataset.status = data.status; if (log && data.message) { log.textContent = `${log.textContent === 'Čaká sa na operáciu...' ? '' : `${log.textContent}\n`}${new Date().toLocaleTimeString()}  ${data.message}`.slice(-4000); log.scrollTop = log.scrollHeight; } };
  surface.querySelector('#chooseOpenVpn').addEventListener('click', async () => { vpnProfile = await window.linsoftBrowser?.selectOpenVpnProfile(); settingsState.openvpnProfile = vpnProfile || ''; surface.querySelector('#openVpnProfileName').textContent = vpnProfile ? vpnProfile.split(/[\\/]/).pop() : 'Nie je vybraný žiadny .ovpn súbor.'; saveSettings(); });
  surface.querySelector('#connectOpenVpn').addEventListener('click', () => window.linsoftBrowser?.connectOpenVpn(vpnProfile));
  surface.querySelector('#disconnectOpenVpn').addEventListener('click', () => window.linsoftBrowser?.disconnectOpenVpn()); window.linsoftBrowser?.onOpenVpnStatus(showVpnStatus);
  vpnButton.addEventListener('click', () => { navigation.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === vpnButton)); panels.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel !== vpnPanel; }); });
  ['adBlock', 'trackingProtection', 'askDownload', 'restoreTabs', 'clearExit', 'confirmClose', 'suspendInactiveTabs'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (!toggle) return; toggle.classList.toggle('on', settingsState[key]); toggle.addEventListener('click', () => toggle.classList.toggle('on')); });
  advancedButton.addEventListener('click', () => { navigation.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === advancedButton)); panels.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel !== advancedPanel; }); });
  surface.querySelector('#updateAdblockList').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; button.textContent = 'Aktualizujem...'; const result = await window.linsoftBrowser?.updateAdblockList(); button.disabled = false; button.textContent = 'Aktualizovať'; showToast(result?.ok ? `Zoznam aktualizovaný: ${result.count} domén.` : `Aktualizácia zlyhala: ${result?.message || 'neznáma chyba'}`); });
  surface.querySelector('#clearCacheButton').addEventListener('click', async () => { const result = await window.linsoftBrowser?.clearCache(); showToast(result?.ok ? 'Cache bola vymazaná.' : `Cache sa nepodarilo vymazať: ${result?.message || 'neznáma chyba'}`); });
  surface.querySelector('#saveSettings').addEventListener('click', () => { settingsState.downloads = downloads.value; settingsState.zoom = zoom.value; ['adBlock', 'trackingProtection', 'askDownload', 'restoreTabs', 'clearExit', 'confirmClose', 'suspendInactiveTabs'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (toggle) settingsState[key] = toggle.classList.contains('on'); }); saveSettings(); });
}

function navigate(value, addHistory = true) {
  const input = value.trim();
  if (input.toLowerCase() === 'linsoft://apps') { hideNativeTab(); openAppCenter(); return; }
  if (input.toLowerCase() === 'linsoft://settings') { hideNativeTab(); openSettings(); return; }
  if (input.toLowerCase() === 'linsoft://bookmarks') { hideNativeTab(); openLibrary('bookmarks'); return; }
  if (input.toLowerCase() === 'linsoft://history') { hideNativeTab(); openLibrary('history'); return; }
  if (!input || input === 'linsoft://start' || input.toLowerCase() === 'home') { hideNativeTab(); startPage(); return; }
  if (/^(javascript|data|vbscript):/i.test(input)) { showToast('Tento typ adresy je z bezpečnostných dôvodov zablokovaný.'); return; }
  const explicitHttp = /^https?:\/\//i.test(input);
  const networkAddress = normalizeNetworkAddress(input);
  const looksLikeUrl = explicitHttp || networkAddress.isIp || /^[^\s]+\.[^\s]+$/.test(input);
  const requestedUrl = looksLikeUrl ? (explicitHttp ? input : networkAddress.isIp ? networkAddress.value : `https://${input}`) : searchUrl(input);
  const url = requestedUrl;
  const currentTab = tabs.get(activeTabId);
  if (addHistory && currentTab) { currentTab.history = currentTab.history || [currentTab.url]; currentTab.history.splice(currentTab.historyIndex + 1); currentTab.history.push(url); currentTab.historyIndex = currentTab.history.length - 1; }
  if (addHistory) {
    let visitHistory = [];
    try { visitHistory = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch { visitHistory = []; }
    visitHistory = [{ url, title: url.replace(/^https?:\/\//, '').split('/')[0], visitedAt: Date.now() }, ...visitHistory.filter((item) => item.url !== url)].slice(0, 200);
    localStorage.setItem('linsoft-history', JSON.stringify(visitHistory));
  }
  addressInput.value = url;
  updateConnectionIndicator(url);
  const tabLabel = url.replace(/^https?:\/\//, '').split('/')[0]; tabTitle.textContent = tabLabel; updateActiveTab(url, tabLabel); saveSession();
  const viewer = window.linsoftBrowser ? `<webview class="webview" src="${escapeHtml(url)}" allowpopups allowfullscreen zoom-factor="${Number(settingsState.zoom) / 100}"></webview>` : `<iframe class="webview" src="${escapeHtml(url)}" title="Web page" allowfullscreen></iframe>`;
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  if (isNativeTabs) {
    surface.innerHTML = '<div class="native-view-placeholder" aria-hidden="true"></div>';
    activateSurface(activeTabId);
    syncNativeTabLayout();
    window.linsoftBrowser?.loadNativeTab?.({ tabId: activeTabId, url });
    return;
  }
  if (!window.linsoftBrowser && /^https?:\/\//i.test(url)) { showExternalPreview(surface, url); return; }
  if (!surface.querySelector('.webview')) surface.innerHTML = viewer;
  else surface.querySelector('.webview').src = url;
  activateSurface(activeTabId);
  const activeViewer = surface.querySelector('webview');
  const activeTab = tabs.get(activeTabId);
  if (activeViewer?.setAudioMuted && activeTab?.muted) activeViewer.setAudioMuted(true);
  if (activeViewer && !boundViewers.has(activeViewer)) {
    const viewerTabId = activeTabId;
    boundViewers.add(activeViewer);
    const loadingTrack = document.getElementById('loadingTrack');
    activeViewer.addEventListener('did-start-loading', () => { loadingTrack.classList.add('loading'); setTabLoading(viewerTabId, true); document.getElementById('securityButton').classList.add('address-loading'); });
    activeViewer.addEventListener('media-started-playing', () => setTabAudioIcon(viewerTabId, tabs.get(viewerTabId)?.muted, true));
    activeViewer.addEventListener('media-paused', () => setTabAudioIcon(viewerTabId, tabs.get(viewerTabId)?.muted, false));
    activeViewer.addEventListener('did-stop-loading', () => { loadingTrack.classList.remove('loading'); setTabLoading(viewerTabId, false); document.getElementById('securityButton').classList.remove('address-loading'); });
    activeViewer.addEventListener('render-process-gone', () => { const tab = tabs.get(viewerTabId); if (tab) { tab.crashed = true; saveSession(); showToast('Karta sa neočakávane ukončila. Klikni na kartu pre obnovenie.'); } });
    activeViewer.addEventListener('dom-ready', () => {
      activeViewer.insertCSS('*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }').catch(() => {});
      setInstallAppAvailable(/^https?:\/\//i.test(activeViewer.getURL?.() || addressInput.value));
      bindPasswordSavePrompt(activeViewer, activeViewer.getURL?.() || addressInput.value);
    });
    activeViewer.addEventListener('dom-ready', () => window.setTimeout(() => installYoutubeAdBlock(activeViewer), 350));
    activeViewer.addEventListener('did-navigate', (event) => { const label = event.url.replace(/^https?:\/\//, '').split('/')[0]; const tab = tabs.get(viewerTabId); if (!tab) return; tab.url = event.url; tab.title = label; tab.history = tab.history || [event.url]; const knownIndex = tab.history.indexOf(event.url); if (knownIndex >= 0) tab.historyIndex = knownIndex; else { tab.history.splice(tab.historyIndex + 1); tab.history.push(event.url); tab.historyIndex = tab.history.length - 1; } if (viewerTabId === activeTabId) { addressInput.value = event.url; tabTitle.textContent = label; updateActiveTab(event.url, label); updateConnectionIndicator(event.url); } try { tab.icon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(event.url).hostname)}&sz=32`; } catch {} setTabIcon(viewerTabId, tab.icon); saveSession(); });
    activeViewer.addEventListener('did-navigate-in-page', (event) => { const url = event.url; const label = url.replace(/^https?:\/\//, '').split('/')[0]; const tab = tabs.get(viewerTabId); if (!tab || !url) return; tab.url = url; tab.title = label; tab.history = tab.history || [url]; const knownIndex = tab.history.indexOf(url); if (knownIndex >= 0) tab.historyIndex = knownIndex; else { tab.history.splice(tab.historyIndex + 1); tab.history.push(url); tab.historyIndex = tab.history.length - 1; } if (viewerTabId === activeTabId) { addressInput.value = url; tabTitle.textContent = label; updateActiveTab(url, label); updateConnectionIndicator(url); } saveSession(); });
    activeViewer.addEventListener('page-favicon-updated', (event) => { const iconUrl = event.favicons?.[0] || ''; const tab = tabs.get(viewerTabId); if (tab) tab.icon = iconUrl; setTabIcon(viewerTabId, iconUrl); saveSession(); });
    activeViewer.addEventListener('page-title-updated', (event) => { const tab = tabs.get(viewerTabId); if (event.title && tab) { tab.title = event.title; if (viewerTabId === activeTabId) { tabTitle.textContent = event.title; updateActiveTab(tab.url, event.title); } saveSession(); } });
    activeViewer.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3) return;
      const failedUrl = event.validatedURL || activeViewer.getURL?.() || '';
      const anyHttpAddress = /^http:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost)(?::\d+)?(?:\/|$)/i.test(failedUrl);
      if (anyHttpAddress) {
        activeViewer.src = failedUrl.replace(/^http:/i, 'https:');
        return;
      }
      showToast(navigationErrorMessage(event.errorCode, event.errorDescription));
    });
  }
}

document.getElementById('addressForm').addEventListener('submit', (event) => { event.preventDefault(); navigate(addressInput.value); });
document.getElementById('clearAddress').addEventListener('click', () => { addressInput.value = ''; addressInput.focus(); });
document.getElementById('installAppButton').addEventListener('click', installCurrentApp);
document.getElementById('cancelInstall').addEventListener('click', closeInstallDialog); document.getElementById('cancelInstallButton').addEventListener('click', closeInstallDialog); document.getElementById('confirmInstall').addEventListener('click', async () => { const button = document.getElementById('confirmInstall'); const url = addressInput.value; const title = tabTitle.textContent; button.disabled = true; const result = await window.linsoftBrowser?.installWebApp(url, title); button.disabled = false; closeInstallDialog(); if (!result?.ok) return showToast(result?.message || 'Webovú aplikáciu sa nepodarilo nainštalovať.'); const existing = installedApps.find((item) => item.url === url); if (existing) existing.title = title; else installedApps.push({ url, title, installedAt: Date.now() }); localStorage.setItem('linsoft-apps', JSON.stringify(installedApps)); showToast('Aplikácia bola pridaná do Linsoft App Centra.'); openAppCenter(); });
const securityPanel = document.getElementById('securityPanel'); const publicIp = document.getElementById('publicIp'); const publicNetwork = document.getElementById('publicNetwork'); const ipNote = document.getElementById('ipNote'); let ipLoaded = false;
document.getElementById('securityButton').addEventListener('click', async (event) => { event.preventDefault(); event.stopPropagation(); securityPanel.hidden = !securityPanel.hidden; if (securityPanel.hidden || ipLoaded) return; publicIp.textContent = 'Načítavam...'; publicNetwork.textContent = 'Načítavam...'; const endpoints = [{ url: 'https://ipapi.co/json/', parse: (data) => ({ ip: data.ip, network: `${data.org || 'Neznáma sieť'} · ${data.country_name || 'Neznáma krajina'}` }) }, { url: 'https://ipwho.is/', parse: (data) => ({ ip: data.ip, network: `${data.connection?.isp || 'Neznáma sieť'} · ${data.country || 'Neznáma krajina'}` }) }, { url: 'https://api.ipify.org?format=json', parse: (data) => ({ ip: data.ip, network: 'Sieť a krajina nie sú dostupné' }) }]; let lastError = 'IP služby neodpovedali'; for (const endpoint of endpoints) { try { const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 7000); const response = await fetch(endpoint.url, { cache: 'no-store', signal: controller.signal }); window.clearTimeout(timeout); if (!response.ok) throw new Error(`HTTP ${response.status}`); const result = endpoint.parse(await response.json()); if (!result.ip) throw new Error('Prázdna odpoveď'); publicIp.textContent = result.ip; publicNetwork.textContent = result.network; ipNote.textContent = 'Verejná IP podľa aktuálneho internetového pripojenia.'; ipLoaded = true; return; } catch (error) { lastError = error.name === 'AbortError' ? 'Časový limit vypršal' : error.message; } } publicIp.textContent = 'Nepodarilo sa načítať'; publicNetwork.textContent = 'Neznáme'; ipNote.textContent = `${lastError}. Skontroluj internet, VPN alebo firewall a skús znova.`; }); document.getElementById('closeSecurity').addEventListener('click', () => { securityPanel.hidden = true; }); securityPanel.addEventListener('click', (event) => event.stopPropagation()); document.addEventListener('click', () => { securityPanel.hidden = true; });
document.getElementById('homeButton').addEventListener('click', () => { navigate(settingsState.home); });
async function activeEditCommand(command) {
  const viewer = ensureActiveTabLoaded();
  if (command === 'paste' && viewer?.executeJavaScript) {
    try {
      const text = String(await window.linsoftBrowser?.readClipboardText?.() || '');
      const inserted = await viewer.executeJavaScript(`(() => {
        const field = document.activeElement?.matches?.('input, textarea, [contenteditable="true"]') ? document.activeElement : document.querySelector('textarea.gLFyf, input[name="q"], input[type="search"], textarea, input:not([type="hidden"])');
        if (!field) return false;
        field.focus();
        if ('value' in field) {
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          field.setRangeText(${JSON.stringify(text)}, start, end, 'end');
          field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
        } else document.execCommand('insertText', false, ${JSON.stringify(text)});
        return true;
      })()`, true);
      if (inserted) return;
    } catch {}
  }
  if (isNativeTabs) {
    const result = await window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command });
    if (!result?.ok) showToast(result?.message || 'Táto akcia nie je dostupná na tejto stránke.');
    return;
  }
  const webContentsId = viewer?.getWebContentsId?.();
  const result = webContentsId ? await window.linsoftBrowser?.editCommand?.(webContentsId, command) : null;
  if (result?.ok) return;
  if (viewer && typeof viewer[command] === 'function') { viewer[command](); return; }
  if (viewer?.executeJavaScript && ['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'].includes(command)) {
    try { await viewer.executeJavaScript(`document.execCommand(${JSON.stringify(command)})`); return; } catch {}
  }
  showToast(result?.message || 'Táto akcia nie je dostupná na tejto stránke.');
}
function findOnPage() {
  const viewer = ensureActiveTabLoaded();
  if (!viewer?.findInPage) return showToast('Vyhľadávanie nie je dostupné na tejto stránke.');
  const query = window.prompt('Hľadať na stránke:');
  if (query) viewer.findInPage(query);
}
function changePageZoom(delta) {
  const viewer = ensureActiveTabLoaded();
  settingsState.zoom = Math.max(50, Math.min(200, Number(settingsState.zoom || 100) + delta));
  if (isNativeTabs) window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: 'zoom', value: Number(settingsState.zoom) / 100 });
  else if (viewer?.setZoomFactor) viewer.setZoomFactor(Number(settingsState.zoom) / 100);
  else return;
  saveSettings();
  showToast(`Priblíženie: ${settingsState.zoom} %`);
}
function resetPageZoom() { const viewer = ensureActiveTabLoaded(); settingsState.zoom = 100; if (isNativeTabs) window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: 'zoom', value: 1 }); else viewer?.setZoomFactor?.(1); saveSettings(); showToast('Priblíženie: 100 %'); }
function printCurrentPage() { const viewer = ensureActiveTabLoaded(); if (!viewer?.print) return showToast('Tlač nie je dostupná na tejto stránke.'); viewer.print(); }
async function toggleReaderMode() {
  const viewer = ensureActiveTabLoaded();
  if (!viewer?.executeJavaScript) return showToast('Čitateľský režim nie je dostupný na tejto stránke.');
  await viewer.executeJavaScript(`(() => { const existing = document.getElementById('linsoft-reader-mode'); if (existing) { existing.remove(); return false; } const style = document.createElement('style'); style.id = 'linsoft-reader-mode'; style.textContent = 'body { background: #f7f3ea !important; color: #252525 !important; } body > * { max-width: 760px !important; margin-left: auto !important; margin-right: auto !important; } nav, header, aside, footer, [role="banner"], [role="navigation"], [role="complementary"], .ad, .ads, .advert, [class*="advert" i], [id*="advert" i] { display: none !important; } p, li { font-size: 18px !important; line-height: 1.75 !important; }'; document.head.appendChild(style); return true; })()`).then((enabled) => showToast(enabled ? 'Čitateľský režim zapnutý.' : 'Čitateľský režim vypnutý.')).catch(() => showToast('Čitateľský režim sa nedá použiť na tejto stránke.'));
}
async function saveCurrentPagePdf() { const viewer = ensureActiveTabLoaded(); const webContentsId = viewer?.getWebContentsId?.(); if (!webContentsId) return showToast('PDF nie je dostupné na tejto stránke.'); const result = await window.linsoftBrowser?.savePagePdf?.(webContentsId); if (result?.ok) showToast('Stránka bola uložená ako PDF.'); else if (!result?.canceled) showToast(result?.message || 'PDF sa nepodarilo uložiť.'); }
async function captureCurrentPage() { const viewer = ensureActiveTabLoaded(); const webContentsId = viewer?.getWebContentsId?.(); if (!webContentsId) return showToast('Snímka nie je dostupná na tejto stránke.'); const result = await window.linsoftBrowser?.capturePage?.(webContentsId); if (result?.ok) showToast('Snímka webu bola uložená.'); else if (!result?.canceled) showToast(result?.message || 'Snímku sa nepodarilo uložiť.'); }
async function copyCurrentPageScreenshot() { const viewer = ensureActiveTabLoaded(); const webContentsId = viewer?.getWebContentsId?.(); if (!webContentsId) return showToast('Snímka nie je dostupná na tejto stránke.'); const result = await window.linsoftBrowser?.capturePageToClipboard?.(webContentsId); showToast(result?.ok ? 'Snímka bola skopírovaná do schránky.' : (result?.message || 'Snímku sa nepodarilo skopírovať.')); }
window.linsoftBrowser?.onWebviewContextMenu?.((data) => {
  document.querySelector('.webview-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'webview-context-menu';
  menu.setAttribute('role', 'menu');
  const viewer = activeViewer();
  const hasSelection = Boolean(data.selectionText);
  const hasLink = /^https?:\/\//i.test(data.linkURL || '');
  const hasImage = data.mediaType === 'image' && /^https?:\/\//i.test(data.srcURL || '');
  const actions = [
    ['paste', '▤', 'Vložiť', false, 'Ctrl+V'], ['copy', '▣', 'Kopírovať', false, 'Ctrl+C'], ['cut', '✂', 'Vystrihnúť', !data.isEditable, 'Ctrl+X'], ['divider'],
    ['search', '⌕', 'Vyhľadať výber', !hasSelection], ['translate', 'A', 'Preložiť výber', !hasSelection]
  ];
  if (hasLink) actions.push(['divider'], ['open-link', '↗', 'Otvoriť odkaz v novej karte'], ['open-link-background', '▣', 'Otvoriť odkaz na pozadí'], ['open-window', '□', 'Otvoriť odkaz v novom okne'], ['copy-link', '↗', 'Kopírovať adresu odkazu']);
  if (hasImage) actions.push(['divider'], ['open-image', '▧', 'Otvoriť obrázok v novej karte'], ['save-image', '⇩', 'Uložiť obrázok'], ['copy-image', '▧', 'Kopírovať obrázok']);
  actions.push(['divider'], ['bookmark-page', '★', 'Pridať medzi záložky', false, 'Ctrl+D'], ['copy-page', '↗', 'Kopírovať adresu stránky'], ['open-page-tab', '+', 'Otvoriť stránku v novej karte'], ['screenshot', '▧', 'Urobiť snímku webu'], ['copy-screenshot', '▣', 'Kopírovať snímku'], ['divider'], ['back', '‹', 'Späť', !viewer?.canGoBack?.()], ['forward', '›', 'Dopredu', !viewer?.canGoForward?.()], ['reload', '↻', 'Obnoviť', false, 'Ctrl+R'], ['print', '▣', 'Tlačiť', false, 'Ctrl+P']);
  menu.innerHTML = actions.map((entry) => entry[0] === 'divider' ? '<div class="context-menu-divider" role="separator"></div>' : `<button role="menuitem" data-context-action="${entry[0]}"${entry[3] ? ' disabled' : ''}><span class="context-menu-icon">${entry[1]}</span>${entry[2]}${entry[4] ? `<kbd>${entry[4]}</kbd>` : ''}</button>`).join('');
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(Math.max(8, Number(data.x) || 8), Math.max(8, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(Math.max(80, Number(data.y) || 80), Math.max(80, window.innerHeight - menu.offsetHeight - 8))}px`;
  const closeMenu = () => {
    menu.remove();
    document.removeEventListener('pointerdown', closeFromOutside, true);
    document.removeEventListener('keydown', closeFromEscape, true);
  };
  menu.closeContextMenu = closeMenu;
  const closeFromOutside = (event) => {
    if (event.button === 0 && !menu.contains(event.target)) closeMenu();
  };
  const closeFromEscape = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  menu.addEventListener('keydown', (event) => {
    const enabledButtons = [...menu.querySelectorAll('button:not(:disabled)')];
    const currentIndex = enabledButtons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      enabledButtons[(currentIndex + direction + enabledButtons.length) % enabledButtons.length]?.focus();
    }
  });
  menu.querySelector('button:not(:disabled)')?.focus();
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if (!action) return;
    closeMenu();
    if (action === 'paste') await activeEditCommand('paste');
    if (action === 'cut') await activeEditCommand('cut');
    if (action === 'copy') {
      const result = data.selectionText ? await window.linsoftBrowser?.writeClipboardText?.(data.selectionText) : await window.linsoftBrowser?.copyClipboardSelection?.();
      showToast(result?.ok ? 'Text bol skopírovaný.' : (result?.message || 'Text sa nepodarilo skopírovať.'));
    }
    if (action === 'search' && data.selectionText) navigate(searchUrl(data.selectionText));
    if (action === 'translate' && data.selectionText) openNewTab(`https://translate.google.com/?sl=auto&tl=sk&text=${encodeURIComponent(data.selectionText)}&op=translate`);
    if (action === 'open-link' && data.linkURL) openNewTab(data.linkURL);
    if (action === 'open-link-background' && data.linkURL) openBackgroundTab(data.linkURL);
    if (action === 'open-window' && data.linkURL) window.linsoftBrowser?.openBrowserWindow?.(data.linkURL);
    if (action === 'copy-link') await navigator.clipboard?.writeText(data.linkURL);
    if (action === 'open-image' && data.srcURL) openNewTab(data.srcURL);
    if (action === 'save-image' && data.srcURL) { activeViewer()?.downloadURL?.(data.srcURL); showToast('Obrázok sa pridáva do sťahovaní.'); }
    if (action === 'copy-image' && data.srcURL) { const result = await window.linsoftBrowser?.writeClipboardImage?.(data.srcURL); if (result?.ok) showToast('Obrázok bol skopírovaný.'); else showToast(result?.message || 'Obrázok sa nepodarilo skopírovať.'); }
    if (action === 'bookmark-page') document.getElementById('bookmarkButton').click();
    if (action === 'copy-page') await navigator.clipboard?.writeText(addressInput.value);
    if (action === 'open-page-tab') openNewTab(addressInput.value);
    if (action === 'back') navigateTabHistory(-1);
    if (action === 'forward') navigateTabHistory(1);
    if (action === 'reload') document.getElementById('reloadButton').click();
    if (action === 'print') printCurrentPage();
    if (action === 'screenshot') captureCurrentPage();
      if (action === 'copy-screenshot') copyCurrentPageScreenshot();
  });
});
document.getElementById('findPageButton').addEventListener('click', findOnPage);
document.getElementById('zoomOutButton').addEventListener('click', () => changePageZoom(-10));
document.getElementById('zoomInButton').addEventListener('click', () => changePageZoom(10));
document.getElementById('printButton').addEventListener('click', printCurrentPage);
document.getElementById('savePdfButton').addEventListener('click', saveCurrentPagePdf);
document.getElementById('capturePageButton').addEventListener('click', captureCurrentPage);
const readerModeButton = document.createElement('button'); readerModeButton.id = 'readerModeButton'; readerModeButton.title = 'Čitateľský režim'; readerModeButton.setAttribute('aria-label', 'Čitateľský režim'); readerModeButton.textContent = 'Aa'; document.querySelector('.toolbar')?.insertBefore(readerModeButton, document.getElementById('downloadsButton')); readerModeButton.addEventListener('click', toggleReaderMode);
document.getElementById('newTab').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openNewTab(); });
document.getElementById('reloadButton').addEventListener('click', () => { const viewer = ensureActiveTabLoaded(); if (isNativeTabs) window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: 'reload' }); else if (viewer) viewer.reload(); else if (tabs.get(activeTabId)?.url === 'linsoft://start') startPage(); });
document.getElementById('backButton').addEventListener('click', () => navigateTabHistory(-1));
document.getElementById('forwardButton').addEventListener('click', () => navigateTabHistory(1));
document.getElementById('bookmarkButton').addEventListener('click', (event) => { const url = addressInput.value; if (!url || url.startsWith('linsoft://')) return showToast('Na domovskú stránku sa záložka nepridáva.'); if (!savedBookmarks.some((item) => item.url === url)) { savedBookmarks.push({ url, title: tabTitle.textContent }); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); } event.currentTarget.textContent = '★'; showToast('Záložka uložená.'); });
const adBlockButton = document.getElementById('adBlockButton');
const updateAdBlockButton = () => { adBlockButton.classList.toggle('active', settingsState.adBlock); adBlockButton.textContent = settingsState.adBlock ? '🛡' : '◌'; adBlockButton.title = settingsState.adBlock ? 'AdBlock zapnutý' : 'AdBlock vypnutý'; adBlockButton.setAttribute('aria-label', adBlockButton.title); };
adBlockButton.addEventListener('click', () => { settingsState.adBlock = !settingsState.adBlock; saveSettings(); updateAdBlockButton(); showToast(settingsState.adBlock ? 'AdBlock je zapnutý.' : 'AdBlock je vypnutý.'); });
document.getElementById('minimizeWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('minimize'));
document.getElementById('maximizeWindow').addEventListener('click', () => {
  const button = document.getElementById('maximizeWindow');
  const shouldRestore = button.dataset.state === 'maximized';
  button.dataset.state = shouldRestore ? 'restored' : 'maximized';
  button.textContent = shouldRestore ? '□' : '❐';
  if (shouldRestore) window.linsoftBrowser?.windowControl('restore');
  else window.linsoftBrowser?.windowControl('maximize');
});
document.getElementById('fullscreenWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('fullscreen'));
document.getElementById('pinWindow').addEventListener('click', () => {
  const button = document.getElementById('pinWindow');
  const nextState = !button.classList.contains('active');
  button.classList.toggle('active', nextState);
  button.title = nextState ? 'Odopnúť vždy navrchu' : 'Pripnúť navrchu';
  button.textContent = nextState ? '📍' : '📌';
  window.linsoftBrowser?.windowControl('toggle-always-on-top');
});
document.getElementById('closeWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('close'));
const browserMenu = document.getElementById('browserMenu');
const downloadPanel = document.getElementById('downloadPanel');
const closeBrowserMenu = () => { browserMenu.hidden = true; document.querySelector('.tab-context-menu')?.remove(); };
const closeTransientPanels = () => { closeBrowserMenu(); downloadPanel.hidden = true; securityPanel.hidden = true; };
browserMenu.setAttribute('role', 'menu');
document.getElementById('menuButton').addEventListener('click', (event) => {
  event.stopPropagation();
  browserMenu.hidden = !browserMenu.hidden;
  if (!browserMenu.hidden) browserMenu.querySelector('button')?.focus();
});
document.addEventListener('click', closeBrowserMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTransientPanels(); });
browserMenu.addEventListener('click', (event) => event.stopPropagation());
browserMenu.addEventListener('keydown', (event) => {
  const buttons = [...browserMenu.querySelectorAll('button:not(:disabled)')];
  const current = buttons.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  }
});
document.getElementById('menuNewTab').addEventListener('click', () => { closeBrowserMenu(); addTab(); }); document.getElementById('menuBookmarks').addEventListener('click', () => { closeBrowserMenu(); openLibrary('bookmarks'); }); document.getElementById('menuHistory').addEventListener('click', () => { closeBrowserMenu(); openLibrary('history'); }); document.getElementById('menuSettings').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://settings'); }); document.getElementById('menuDownloads').addEventListener('click', () => { closeBrowserMenu(); document.getElementById('downloadsButton').click(); }); document.getElementById('menuClearData').addEventListener('click', () => { closeBrowserMenu(); localStorage.clear(); showToast('Údaje prehliadania boli vymazané.'); }); document.getElementById('menuAbout').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://settings'); });
document.getElementById('menuInstallApp').addEventListener('click', () => { closeBrowserMenu(); installCurrentApp(); }); document.getElementById('menuAppCenter').addEventListener('click', () => { closeBrowserMenu(); openAppCenter(); });
document.getElementById('menuGuestWindow').addEventListener('click', () => { closeBrowserMenu(); window.linsoftBrowser?.openGuestWindow?.(); });
document.getElementById('menuSearchTabs').addEventListener('click', () => { closeBrowserMenu(); searchOpenTabs(); });
document.getElementById('toggleBookmarksBar').addEventListener('click', () => { settingsState.showBookmarksBar = !settingsState.showBookmarksBar; saveSettings(); updateBookmarksBar(); closeBrowserMenu(); });
document.querySelectorAll('[data-app-url]').forEach((button) => button.addEventListener('click', () => { closeBrowserMenu(); openNewTab(button.dataset.appUrl); }));
document.querySelectorAll('.managed-tab').forEach((button) => bindTabButton(button, Number(button.dataset.tabId))); renderSavedBookmarks(); updateBookmarksBar();
document.querySelector('.tabs-bar').addEventListener('auxclick', (event) => { const tab = event.target.closest('.managed-tab'); if (event.button === 1 && tab) closeTab(Number(tab.dataset.tabId)); });
const downloadItems = new Map();
browserMenu.insertAdjacentHTML('afterbegin', '<div class="menu-section-label">ZÁLOŽKY</div><button id="menuExportBookmarks">Exportovať záložky</button><button id="menuImportBookmarks">Importovať záložky</button><div class="menu-divider"></div>');
document.getElementById('menuExportBookmarks').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(savedBookmarks, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'linsoft-bookmarks.json'; link.click(); URL.revokeObjectURL(link.href); closeBrowserMenu();
});
document.getElementById('menuImportBookmarks').addEventListener('click', () => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.addEventListener('change', () => { const file = input.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const imported = JSON.parse(String(reader.result)); if (!Array.isArray(imported)) throw new Error('invalid'); savedBookmarks = [...savedBookmarks, ...imported.filter((item) => item?.url && /^https?:\/\//i.test(item.url))].filter((item, index, list) => list.findIndex((candidate) => candidate.url === item.url) === index); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); showToast('Záložky boli importované.'); } catch { showToast('Súbor záložiek nie je platný.'); } }; reader.readAsText(file); }); input.click(); closeBrowserMenu();
});
const activeDownloadStatuses = new Set(['Pripravuje sa', 'Sťahovanie začalo', 'Sťahuje sa', 'Pozastavené']);

function updateDownloadButton() {
  const button = document.getElementById('downloadsButton');
  if (!button) return;
  const active = [...downloadItems.values()].some((download) => activeDownloadStatuses.has(download.status));
  button.classList.toggle('active', active);
  button.title = active ? 'Sťahovanie prebieha - otvoriť históriu' : 'Sťahovania - otvoriť históriu';
  button.setAttribute('aria-label', active ? 'Sťahovanie prebieha, otvoriť históriu' : 'Otvoriť históriu sťahovaní');
}

function renderDownloads() {
  const list = document.getElementById('downloadList');
  const filter = document.getElementById('downloadFilter')?.value || 'all';
  const items = [...downloadItems.values()].filter((item) => {
    const active = item.active === true && !['Stiahnuté', 'Zrušené', 'Sťahovanie zlyhalo'].includes(item.status);
    if (filter === 'active') return active;
    if (filter === 'completed') return item.status === 'Stiahnuté';
    if (filter === 'failed') return ['Zrušené', 'Sťahovanie zlyhalo'].includes(item.status) || item.status.startsWith('Sťahovanie zlyhalo:');
    return true;
  }).sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0));

  list.innerHTML = items.map((item) => {
    const size = item.total ? `${(item.received / 1048576).toFixed(1)} / ${(item.total / 1048576).toFixed(1)} MB` : '';
    const speed = item.received && item.startedAt ? `${((item.received / 1048576) / Math.max(1, (Date.now() - item.startedAt) / 1000)).toFixed(1)} MB/s` : '';
    const isInProgress = item.active === true && (item.status === 'Sťahuje sa' || item.status === 'Sťahovanie začalo' || item.status === 'Pripravuje sa' || item.status === 'Pozastavené');
    const isPaused = item.status === 'Pozastavené';
    const effectiveId = String(item.id || item.fileName || 'download');
    const percent = Math.max(0, Math.min(100, Number(item.percent) || 0));

    const progressAction = isPaused ? `<button data-resume-download="${escapeHtml(effectiveId)}">Pokračovať</button>` : `<button data-pause-download="${escapeHtml(effectiveId)}">Pozastaviť</button>`;
    const destination = item.filePath ? `<small title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath)}</small>` : '';
    const retryAction = !isInProgress && item.status !== 'Stiahnuté' && /^https?:\/\//i.test(item.sourceUrl || '') ? `<button data-retry-download="${escapeHtml(effectiveId)}">Stiahnuť znova</button>` : '';
    return `<div class="download-item" data-download-id="${escapeHtml(effectiveId)}"><span class="download-file-icon">${item.status === 'Stiahnuté' ? '✓' : isPaused ? 'Ⅱ' : '↓'}</span><div class="download-item-body"><strong>${escapeHtml(item.fileName)}</strong><span>${escapeHtml(item.status)}${size ? ` · ${size}` : ''}${speed && !isPaused ? ` · ${speed}` : ''}</span>${destination}<div class="download-item-progress"><i style="width:${percent}%"></i></div><div class="download-item-actions">${item.status === 'Stiahnuté' ? `<button data-open-download="${escapeHtml(item.filePath || '')}">Otvoriť</button><button data-show-download="${escapeHtml(item.filePath || '')}">Zobraziť v priečinku</button>` : isInProgress ? `${progressAction}<button data-cancel-download="${escapeHtml(effectiveId)}">Zrušiť</button>` : retryAction}<button data-remove-download="${escapeHtml(effectiveId)}">Odstrániť</button></div></div><span class="download-item-percent">${percent}%</span></div>`;
  }).join('') || '<div class="downloads-empty"><span>↓</span><strong>Žiadne sťahovania</strong><small>Stiahnuté súbory sa zobrazia tu.</small></div>';

  list.querySelectorAll('[data-open-download]').forEach((button) => button.addEventListener('click', () => window.linsoftBrowser?.openDownloadFile(button.dataset.openDownload)));
  list.querySelectorAll('[data-show-download]').forEach((button) => button.addEventListener('click', () => window.linsoftBrowser?.showDownloadFile(button.dataset.showDownload)));
  list.querySelectorAll('[data-pause-download]').forEach((button) => button.addEventListener('click', () => {
    const item = downloadItems.get(button.dataset.pauseDownload);
    if (item) item.status = 'Pozastavené';
    window.linsoftBrowser?.pauseDownload(button.dataset.pauseDownload);
    renderDownloads();
  }));
  list.querySelectorAll('[data-resume-download]').forEach((button) => button.addEventListener('click', () => {
    const item = downloadItems.get(button.dataset.resumeDownload);
    if (item) item.status = 'Sťahuje sa';
    window.linsoftBrowser?.resumeDownload(button.dataset.resumeDownload);
    renderDownloads();
  }));
  list.querySelectorAll('[data-cancel-download]').forEach((button) => button.addEventListener('click', () => {
    const item = downloadItems.get(button.dataset.cancelDownload);
    if (item) item.status = 'Zrušené';
    window.linsoftBrowser?.cancelDownload(button.dataset.cancelDownload);
    renderDownloads();
  }));
  list.querySelectorAll('[data-remove-download]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.removeDownload;
    if (id) downloadItems.delete(id);
    window.linsoftBrowser?.removeDownload?.(id);
    renderDownloads();
  }));
  list.querySelectorAll('[data-retry-download]').forEach((button) => button.addEventListener('click', () => {
    const sourceUrl = downloadItems.get(button.dataset.retryDownload)?.sourceUrl;
    const viewer = activeViewer();
    if (!/^https?:\/\//i.test(sourceUrl || '') || !viewer?.downloadURL) return showToast('Tento súbor sa nedá znova stiahnuť.');
    viewer.downloadURL(sourceUrl);
  }));
  updateDownloadButton();
}

renderDownloads();

document.getElementById('closeDownload').addEventListener('click', () => { document.getElementById('downloadPanel').hidden = true; });
document.getElementById('downloadsButton').addEventListener('click', (event) => {
  event.stopPropagation();
  const panel = document.getElementById('downloadPanel');
  panel.hidden = !panel.hidden;
  updateDownloadButton();
});
document.getElementById('openDownloads').addEventListener('click', () => window.linsoftBrowser?.openDownloads());
document.getElementById('clearDownloads').addEventListener('click', async () => {
  await window.linsoftBrowser?.clearDownloads?.();
  downloadItems.clear();
  renderDownloads();
});
document.getElementById('downloadPanel').addEventListener('click', (event) => event.stopPropagation());
document.getElementById('downloadFilter').addEventListener('change', renderDownloads);

window.linsoftBrowser?.onDownload((download) => {
  const id = String(download.id || download.fileName || `${Date.now()}-${Math.random()}`);
  const isNewDownload = !downloadItems.has(id);
  downloadItems.set(id, { ...download, id, active: !['Stiahnuté', 'Zrušené', 'Sťahovanie zlyhalo'].includes(download.status), percent: Number(download.percent) || 0, received: Number(download.received) || 0, total: Number(download.total) || 0 });
  const panel = document.getElementById('downloadPanel');
  if (isNewDownload) panel.hidden = false;
  renderDownloads();
  updateDownloadButton();
});

window.linsoftBrowser?.listDownloads?.().then((downloads) => {
  (downloads || []).forEach((download) => {
    const id = String(download.id || download.fileName || `${Date.now()}-${Math.random()}`);
    downloadItems.set(id, { ...download, id, active: false, percent: Number(download.percent) || 0, received: Number(download.received) || 0, total: Number(download.total) || 0 });
  });
  renderDownloads();
}).catch(() => renderDownloads());

document.addEventListener('click', () => { document.getElementById('downloadPanel').hidden = true; });

window.linsoftBrowser?.onExternalUrl((url) => navigate(url));
window.linsoftBrowser?.onNativeTabEvent?.((event) => {
  if (!isNativeTabs) return;
  const tab = tabs.get(event.tabId);
  if (!tab) return;
  if (event.type === 'loading') {
    setTabLoading(event.tabId, event.loading);
    document.getElementById('loadingTrack').classList.toggle('loading', event.loading && event.tabId === activeTabId);
    return;
  }
  if (event.type === 'crashed') {
    tab.crashed = true;
    saveSession();
    if (event.tabId === activeTabId) showToast('Karta sa neočakávane ukončila. Klikni na kartu pre obnovenie.');
    return;
  }
  if (event.type === 'failed') {
    if (event.errorCode !== -3 && event.tabId === activeTabId) showToast(navigationErrorMessage(event.errorCode, event.errorDescription));
    return;
  }
  if (event.type === 'favicon' && event.favicon) {
    tab.icon = event.favicon;
    setTabIcon(event.tabId, event.favicon);
    saveSession();
    return;
  }
  if (event.type === 'title' && event.title) {
    tab.title = event.title;
    if (event.tabId === activeTabId) { tabTitle.textContent = event.title; updateActiveTab(tab.url, event.title); }
    saveSession();
    return;
  }
  if (event.type === 'navigate' && /^https?:\/\//i.test(event.url || '')) {
    const label = event.url.replace(/^https?:\/\//, '').split('/')[0];
    tab.url = event.url;
    tab.history = tab.history || [event.url];
    const knownIndex = tab.history.indexOf(event.url);
    if (knownIndex >= 0) tab.historyIndex = knownIndex;
    else { tab.history.splice(tab.historyIndex + 1); tab.history.push(event.url); tab.historyIndex = tab.history.length - 1; }
    if (event.tabId === activeTabId) {
      addressInput.value = event.url;
      tabTitle.textContent = tab.title || label;
      updateActiveTab(event.url, tab.title || label);
      updateConnectionIndicator(event.url);
      setInstallAppAvailable(true);
    }
    saveSession();
  }
});
window.linsoftBrowser?.onDismissWebviewOverlay?.(() => {
  document.querySelector('.webview-context-menu')?.closeContextMenu?.();
  closeTransientPanels();
});
window.linsoftBrowser?.onWebviewFullscreen?.((active) => document.querySelector('.browser-window')?.classList.toggle('webview-fullscreen', active));
window.linsoftBrowser?.onBrowserShortcut?.(({ key, shift }) => {
  if (key === 'escape') { document.querySelector('.webview-context-menu')?.closeContextMenu?.(); closeTransientPanels(); return; }
  if (key === 'l' || key === 'k') { addressInput.focus(); addressInput.select(); return; }
  if (key === 'r') { document.getElementById('reloadButton').click(); return; }
  if (key === 't' && shift) { restoreClosedTab(); return; }
  if (key === 't') { openNewTab(); return; }
  if (key === 'w') { closeTab(activeTabId); return; }
  if (key === 'tab') { const ids = [...tabs.keys()]; const current = ids.indexOf(activeTabId); const next = shift ? (current - 1 + ids.length) % ids.length : (current + 1) % ids.length; selectTab(ids[next]); return; }
  if (key === 'arrowleft') { document.getElementById('backButton').click(); return; }
  if (key === 'arrowright') { document.getElementById('forwardButton').click(); return; }
  if (/^[1-9]$/.test(key)) { const tabId = [...tabs.keys()][Number(key) - 1]; if (tabId) selectTab(tabId); return; }
  if (['c', 'x', 'v', 'a', 'z', 'y'].includes(key)) { activeEditCommand({ c: 'copy', x: 'cut', v: 'paste', a: 'selectAll', z: 'undo', y: 'redo' }[key]); return; }
  if (key === 'f') { findOnPage(); return; }
  if (key === 'p') { printCurrentPage(); return; }
  if (key === '0') { resetPageZoom(); return; }
  if (key === '-') { changePageZoom(-10); return; }
  if (key === '=') { changePageZoom(10); return; }
  if (key === 's' && shift) { captureCurrentPage(); return; }
  if (key === 'i' && shift) content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`)?.openDevTools?.();
});
window.linsoftBrowser?.onWindowCloseRequest(() => { if (!settingsState.confirmClose || tabs.size <= 1 || window.confirm(`Zatvoriť Linsoft Browser s ${tabs.size} otvorenými kartami?`)) window.linsoftBrowser.confirmWindowClose(); });
window.linsoftBrowser?.onOpenAppCenter(() => openAppCenter());
window.linsoftBrowser?.onInstallExternalApp(async (data) => { if (!data?.url || !/^https?:\/\//i.test(data.url)) return showToast('Webová adresa nie je platná.'); const result = await window.linsoftBrowser.installWebApp(data.url, data.name || new URL(data.url).hostname);
  if (!result?.ok) return showToast(result?.message || 'Web sa nepodarilo nainštalovať.');
  const existing = installedApps.find((item) => item.url === data.url);
  if (existing) existing.title = data.name || existing.title;
  else installedApps.push({ url: data.url, title: data.name || new URL(data.url).hostname, installedAt: Date.now() });
  localStorage.setItem('linsoft-apps', JSON.stringify(installedApps));
  showToast('Web bol nainštalovaný do Linsoft App Centra.');
  openAppCenter(); });
window.linsoftBrowser?.onUninstallExternalApp(async (data) => { const index = installedApps.findIndex((item) => item.url === data?.url);
  const item = index >= 0 ? installedApps[index] : { title: data?.name || '' };
  const result = await window.linsoftBrowser.uninstallWebApp(data?.url, item.title);
  if (result && !result.ok) return showToast(result.message);
  if (index >= 0) installedApps.splice(index, 1);
  localStorage.setItem('linsoft-apps', JSON.stringify(installedApps));
  showToast('Webová aplikácia bola odinštalovaná.');
  openAppCenter(); });
window.linsoftBrowser?.onLinkInTab((url) => { if (settingsState.popups) openNewTab(url); else showToast('Vyskakovacie okno bolo zablokované.'); });
window.linsoftBrowser?.onLinkInWindow?.((url) => { if (settingsState.popups) window.linsoftBrowser.openDetachedWindow(url); else showToast('Vyskakovacie okno bolo zablokované.'); });
document.body.classList.toggle('light-theme', settingsState.theme === 'light');
updateAdBlockButton();
  window.linsoftBrowser?.setBrowserPreferences({ downloads: settingsState.downloads, downloadFolderPath: settingsState.downloadFolderPath || '', askDownload: settingsState.askDownload, adBlock: settingsState.adBlock, trackingProtection: settingsState.trackingProtection, camera: settingsState.camera, microphone: settingsState.microphone, webNotifications: settingsState.webNotifications, clearExit: settingsState.clearExit, autoUpdateCheck: settingsState.autoUpdateCheck });
document.addEventListener('keydown', (event) => { const command = event.ctrlKey || event.metaKey; if (command && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`)?.openDevTools?.(); return; } if (command && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); restoreClosedTab(); return; } if (command && (event.key.toLowerCase() === 'l' || event.key.toLowerCase() === 'k')) { event.preventDefault(); addressInput.focus(); addressInput.select(); return; } if (command && event.key.toLowerCase() === 'r') { event.preventDefault(); document.getElementById('reloadButton').click(); return; } if (command && event.key.toLowerCase() === 't') { event.preventDefault(); openNewTab(); return; } if (command && event.key.toLowerCase() === 'w') { event.preventDefault(); closeTab(activeTabId); return; } if (command && event.key === 'Tab') { event.preventDefault(); const ids = [...tabs.keys()]; const current = ids.indexOf(activeTabId); const next = event.shiftKey ? (current - 1 + ids.length) % ids.length : (current + 1) % ids.length; selectTab(ids[next]); return; } if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); document.getElementById('backButton').click(); return; } if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); document.getElementById('forwardButton').click(); } });
restoreSession();
if (hadCrash) showToast('Obnovené karty po neočakávanom ukončení.');
if (addressInput.value === 'linsoft://apps') openAppCenter();
if (settingsState.startup === 'home' && settingsState.home !== 'linsoft://start') navigate(settingsState.home);

const updateNotice = document.getElementById('updateNotice');
const updateNoticeTitle = document.getElementById('updateNoticeTitle');
const updateNoticeText = document.getElementById('updateNoticeText');
const updateNoticeAction = document.getElementById('updateNoticeAction');
const updateNoticeDismiss = document.getElementById('updateNoticeDismiss');
const updateProgress = document.getElementById('updateProgress');
const updateProgressBar = document.getElementById('updateProgressBar');
let visibleUpdateState = null;

function renderUpdateNotice(state) {
  if (!updateNotice || !state) return;
  visibleUpdateState = state;
  if (!['available', 'downloading', 'downloaded'].includes(state.status)) {
    updateNotice.hidden = true;
    return;
  }
  const version = String(state.version || '');
  if (state.status === 'available' && sessionStorage.getItem('linsoft-dismissed-update') === version) {
    updateNotice.hidden = true;
    return;
  }
  updateNotice.hidden = false;
  updateNoticeTitle.textContent = state.status === 'downloaded' ? 'Aktualizácia je pripravená' : 'Nová verzia Linsoft Browser';
  updateNoticeText.textContent = state.status === 'available'
    ? `Verzia ${version} je dostupná.`
    : state.status === 'downloading'
      ? `Sťahuje sa verzia ${version}: ${Math.max(0, Math.min(100, Number(state.percent) || 0))} %.`
      : `Verzia ${version} sa nainštaluje po reštarte.`;
  updateProgress.hidden = state.status !== 'downloading';
  updateProgressBar.style.width = `${Math.max(0, Math.min(100, Number(state.percent) || 0))}%`;
  updateNoticeAction.textContent = state.status === 'downloaded' ? 'Reštartovať' : state.status === 'downloading' ? 'Sťahuje sa' : 'Stiahnuť';
  updateNoticeAction.disabled = state.status === 'downloading';
}

updateNoticeAction.addEventListener('click', async () => {
  if (visibleUpdateState?.status === 'downloaded') {
    window.linsoftBrowser?.installUpdate?.();
    return;
  }
  if (visibleUpdateState?.status !== 'available') return;
  updateNoticeAction.disabled = true;
  const result = await window.linsoftBrowser?.downloadUpdate?.();
  if (!result?.ok) {
    updateNoticeAction.disabled = false;
    updateNoticeText.textContent = `Sťahovanie zlyhalo: ${result?.message || 'skús to znova.'}`;
  }
});

updateNoticeDismiss.addEventListener('click', () => {
  if (visibleUpdateState?.status === 'available') sessionStorage.setItem('linsoft-dismissed-update', String(visibleUpdateState.version || ''));
  updateNotice.hidden = true;
});

window.linsoftBrowser?.onUpdateState?.((state) => { renderUpdateNotice(state); renderSettingsUpdateState(state); });
window.linsoftBrowser?.getUpdateState?.().then(renderUpdateNotice).catch(() => {});
