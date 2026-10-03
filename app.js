const addressInput = document.getElementById('addressInput');
const content = document.getElementById('content');
const tabTitle = document.getElementById('tabTitle');
const isGuestWindow = new URLSearchParams(window.location.search).has('guest');
const isNativeTabs = new URLSearchParams(window.location.search).has('nativeTabs');
document.getElementById('guestIndicator').hidden = !isGuestWindow;
const torChatUi = { role: '', onion: '', invite: '', key: null, lastId: 0, messages: [], pollTimer: null, polling: false, busy: false, generation: 0, status: 'stopped', statusMessage: 'Onion chat je vypnutý.' };
async function importTorChatKey(encodedKey) { return window.linsoftTorChatCrypto.importKey(encodedKey); }
async function encryptTorChatMessage(text) { return window.linsoftTorChatCrypto.encrypt(torChatUi.key, text); }
async function decryptTorChatMessage(message) { return window.linsoftTorChatCrypto.decrypt(torChatUi.key, message); }
function renderTorChatMessages() {
  for (const list of document.querySelectorAll('.tor-chat-messages')) {
    list.replaceChildren();
    for (const message of torChatUi.messages) {
      const bubble = document.createElement('article');
      bubble.className = `tor-chat-message${message.sender === torChatUi.role ? ' own' : ''}`;
      const meta = document.createElement('small');
      meta.textContent = `${message.sender === torChatUi.role ? 'Ty' : 'Kontakt'} · ${new Date(message.sentAt).toLocaleTimeString()}`;
      const content = document.createElement('p');
      content.textContent = message.text;
      bubble.append(meta, content);
      list.appendChild(bubble);
    }
    list.scrollTop = list.scrollHeight;
  }
}
function renderTorChatState() {
  const active = Boolean(torChatUi.role);
  for (const panel of document.querySelectorAll('.tor-chat-section')) {
    const query = (selector) => panel.querySelector(selector);
    const status = query('#torChatStatus');
    if (!status) continue;
    status.textContent = torChatUi.statusMessage;
    query('#torChatDot').dataset.status = torChatUi.status;
    query('#torChatHost').disabled = torChatUi.busy || active;
    query('#torChatJoin').disabled = torChatUi.busy || active;
    query('#torChatEnd').disabled = !active && !torChatUi.busy;
    query('#torChatInvitePanel').hidden = torChatUi.role !== 'host';
    query('#torChatInviteValue').value = torChatUi.invite;
    query('#torChatJoinPanel').hidden = active;
    query('#torChatConversation').hidden = !active;
    query('#torChatMessage').disabled = !active;
    query('#torChatSend').disabled = !active;
  }
  renderTorChatMessages();
}
function stopTorChatPolling() {
  if (torChatUi.pollTimer) clearTimeout(torChatUi.pollTimer);
  torChatUi.pollTimer = null;
}
function scheduleTorChatPoll(delay = 2500) {
  stopTorChatPolling();
  if (torChatUi.role) torChatUi.pollTimer = setTimeout(pollTorChatMessages, delay);
}
async function pollTorChatMessages() {
  if (!torChatUi.role || torChatUi.polling) return;
  torChatUi.polling = true;
  try {
    const result = await window.linsoftBrowser?.pollTorChat?.(torChatUi.lastId);
    if (!result?.ok) throw new Error(result?.message || 'Tor chat sa odpojil.');
    for (const message of result.messages || []) {
      if (message.id <= torChatUi.lastId) continue;
      torChatUi.lastId = message.id;
      try {
        const text = await decryptTorChatMessage(message);
        torChatUi.messages.push({ sender: message.sender, sentAt: message.sentAt, text });
        if (torChatUi.messages.length > 200) torChatUi.messages.shift();
      } catch {
        torChatUi.messages.push({ sender: message.sender, sentAt: message.sentAt, text: '[Správu sa nepodarilo dešifrovať.]' });
      }
    }
    torChatUi.status = 'running';
    torChatUi.statusMessage = `Šifrovaný onion chat je pripojený${torChatUi.role === 'host' ? ' · Čaká sa na účastníka' : ''}.`;
    renderTorChatState();
  } catch (error) {
    torChatUi.status = 'error';
    torChatUi.statusMessage = error instanceof Error ? error.message : 'Spojenie s onion chatom zlyhalo.';
    renderTorChatState();
  } finally {
    torChatUi.polling = false;
    scheduleTorChatPoll(torChatUi.status === 'error' ? 5000 : 2500);
  }
}
function clearTorChatUi() {
  stopTorChatPolling();
  torChatUi.role = '';
  torChatUi.onion = '';
  torChatUi.invite = '';
  torChatUi.key = null;
  torChatUi.lastId = 0;
  torChatUi.messages = [];
  torChatUi.polling = false;
  torChatUi.busy = false;
  torChatUi.status = 'stopped';
  torChatUi.statusMessage = 'Onion chat je vypnutý.';
  renderTorChatMessages();
}
const historyStack = ['linsoft://start'];
let historyIndex = 0;
let activeTabId = 1;
let nextTabId = 2;
const tabs = new Map([[1, { id: 1, url: 'linsoft://start', title: 'Linsoft Browser', history: ['linsoft://start'], historyIndex: 0 }]]);
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
let startFavorites = [];
try {
  const storedStartFavorites = JSON.parse(localStorage.getItem('linsoft-start-favorites') || '[]');
  startFavorites = Array.isArray(storedStartFavorites) ? storedStartFavorites.filter((item) => {
    try { return item && typeof item.title === 'string' && ['http:', 'https:'].includes(new URL(item.url).protocol); }
    catch { return false; }
  }) : [];
} catch {
  localStorage.removeItem('linsoft-start-favorites');
}
function normalizeInstalledApp(item, fallbackOrder = 0) {
  if (!item || typeof item !== 'object') return null;
  try {
    const url = new URL(String(item.url || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return { title: String(item.title || item.name || url.hostname).slice(0, 60), url: url.href, installedAt: Number(item.installedAt) || Date.now(), favorite: item.favorite === true, sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : fallbackOrder, ...(Number(item.lastOpenedAt) ? { lastOpenedAt: Number(item.lastOpenedAt) } : {}) };
  } catch { return null; }
}
let installedApps = [];
try {
  const storedApps = JSON.parse(localStorage.getItem('linsoft-apps') || '[]');
  installedApps = Array.isArray(storedApps) ? storedApps.map((item, index) => normalizeInstalledApp(item, index)).filter(Boolean) : [];
} catch { installedApps = []; }
const appCatalog = [
  ['Google', 'https://www.google.com', 'work'], ['Gmail', 'https://mail.google.com', 'work'], ['Google Drive', 'https://drive.google.com', 'work'], ['Google Calendar', 'https://calendar.google.com', 'work'],
  ['Microsoft 365', 'https://www.office.com', 'work'], ['Outlook', 'https://outlook.live.com', 'work'], ['GitHub', 'https://github.com', 'work'], ['Slack', 'https://app.slack.com', 'social'],
  ['Discord', 'https://discord.com/app', 'social'], ['Zoom', 'https://app.zoom.us', 'social'], ['Notion', 'https://www.notion.so', 'work'], ['Trello', 'https://trello.com', 'work'],
  ['Figma', 'https://www.figma.com', 'creative'], ['Canva', 'https://www.canva.com', 'creative'], ['Adobe Express', 'https://express.adobe.com', 'creative'], ['YouTube', 'https://www.youtube.com', 'media'],
  ['Spotify', 'https://open.spotify.com', 'media'], ['Netflix', 'https://www.netflix.com', 'media'], ['Twitch', 'https://www.twitch.tv', 'media'], ['Reddit', 'https://www.reddit.com', 'social'],
  ['Chess.com', 'https://www.chess.com', 'games'], ['Lichess', 'https://lichess.org', 'games'], ['Poki', 'https://poki.com', 'games'], ['CrazyGames', 'https://www.crazygames.com', 'games'],
  ['Miniclip', 'https://www.miniclip.com', 'games'], ['skribbl.io', 'https://skribbl.io', 'games'], ['Agar.io', 'https://agar.io', 'games'], ['Slither.io', 'https://slither.io', 'games'],
  ['GeoGuessr', 'https://www.geoguessr.com', 'games'], ['itch.io', 'https://itch.io', 'games'], ['Board Game Arena', 'https://boardgamearena.com', 'games'], ['Kahoot!', 'https://kahoot.it', 'games'],
  ['ChatGPT', 'https://chatgpt.com', 'work'], ['Claude', 'https://claude.ai', 'work'], ['Perplexity', 'https://www.perplexity.ai', 'work'], ['Microsoft Teams', 'https://teams.microsoft.com', 'social'],
  ['Asana', 'https://app.asana.com', 'work'], ['Jira', 'https://www.atlassian.com/software/jira', 'work'], ['Linear', 'https://linear.app', 'work'], ['Dropbox', 'https://www.dropbox.com', 'work'],
  ['OneDrive', 'https://onedrive.live.com', 'work'], ['Miro', 'https://miro.com', 'creative'], ['GitLab', 'https://gitlab.com', 'work'], ['Google Meet', 'https://meet.google.com', 'social'],
  ['Telegram Web', 'https://web.telegram.org', 'social'], ['Messenger', 'https://www.messenger.com', 'social'], ['Instagram', 'https://www.instagram.com', 'social'], ['LinkedIn', 'https://www.linkedin.com', 'social'],
  ['TikTok', 'https://www.tiktok.com', 'media'], ['Disney+', 'https://www.disneyplus.com', 'media'], ['Prime Video', 'https://www.primevideo.com', 'media'], ['SoundCloud', 'https://soundcloud.com', 'media'],
  ['Deezer', 'https://www.deezer.com', 'media'], ['Roblox', 'https://www.roblox.com', 'games'], ['Steam', 'https://store.steampowered.com', 'games'], ['Epic Games Store', 'https://store.epicgames.com', 'games'],
  ['Monday.com', 'https://monday.com', 'work'], ['ClickUp', 'https://app.clickup.com', 'work'], ['Airtable', 'https://airtable.com', 'work'], ['Todoist', 'https://todoist.com', 'work'], ['Calendly', 'https://calendly.com', 'work'],
  ['Photopea', 'https://www.photopea.com', 'creative'], ['Pixlr', 'https://pixlr.com', 'creative'], ['Spline', 'https://spline.design', 'creative'], ['Framer', 'https://www.framer.com', 'creative'], ['Excalidraw', 'https://excalidraw.com', 'creative'],
  ['WhatsApp Web', 'https://web.whatsapp.com', 'social'], ['Google Chat', 'https://chat.google.com', 'social'], ['Signal', 'https://signal.org', 'social'], ['Webex', 'https://web.webex.com', 'social'],
  ['Apple Music', 'https://music.apple.com', 'media'], ['Max', 'https://www.max.com', 'media'], ['Crunchyroll', 'https://www.crunchyroll.com', 'media'], ['Pinterest', 'https://www.pinterest.com', 'social'],
  ['GeForce NOW', 'https://play.geforcenow.com', 'games'], ['Xbox Cloud Gaming', 'https://www.xbox.com/play', 'games'], ['Roblox Creator Hub', 'https://create.roblox.com', 'games'],
  ['Google Translate', 'https://translate.google.com', 'tools'], ['DeepL', 'https://www.deepl.com/translator', 'tools'], ['PDF24 Tools', 'https://tools.pdf24.org', 'tools'], ['Smallpdf', 'https://smallpdf.com', 'tools'],
  ['iLovePDF', 'https://www.ilovepdf.com', 'tools'], ['Speedtest', 'https://www.speedtest.net', 'tools'], ['VirusTotal', 'https://www.virustotal.com', 'tools'], ['QR Code Generator', 'https://www.qr-code-generator.com', 'tools'], ['Remove.bg', 'https://www.remove.bg', 'tools'],
  ['JSON Formatter', 'https://jsonformatter.org', 'tools'], ['JSONLint', 'https://jsonlint.com', 'tools'], ['Regex101', 'https://regex101.com', 'tools'], ['CodePen', 'https://codepen.io', 'tools'],
  ['JSFiddle', 'https://jsfiddle.net', 'tools'], ['StackBlitz', 'https://stackblitz.com', 'tools'], ['Replit', 'https://replit.com', 'tools'], ['CodeSandbox', 'https://codesandbox.io', 'tools'], ['OnlineGDB', 'https://www.onlinegdb.com', 'tools'],
  ['Stack Overflow', 'https://stackoverflow.com', 'tools'], ['diagrams.net', 'https://app.diagrams.net', 'tools'], ['Mermaid Live', 'https://mermaid.live', 'tools'], ['Google Fonts', 'https://fonts.google.com', 'tools'], ['Coolors', 'https://coolors.co', 'tools'],
  ['PageSpeed Insights', 'https://pagespeed.web.dev', 'tools'], ['GTmetrix', 'https://gtmetrix.com', 'tools'], ['DNSChecker', 'https://dnschecker.org', 'tools'], ['urlscan.io', 'https://urlscan.io', 'tools'], ['Have I Been Pwned', 'https://haveibeenpwned.com', 'tools'],
  ['CloudConvert', 'https://cloudconvert.com', 'tools'], ['Convertio', 'https://convertio.co', 'tools'], ['TinyWow', 'https://tinywow.com', 'tools'], ['Squoosh', 'https://squoosh.app', 'tools'], ['Sejda PDF', 'https://www.sejda.com', 'tools'],
  ['Desmos', 'https://www.desmos.com/calculator', 'tools'], ['WolframAlpha', 'https://www.wolframalpha.com', 'tools'], ['GeoGebra', 'https://www.geogebra.org/calculator', 'tools'], ['Reverso', 'https://www.reverso.net/text-translation', 'tools'], ['QR Code Monkey', 'https://www.qrcode-monkey.com', 'tools'],
  ['UptimeRobot', 'https://uptimerobot.com', 'tools'], ['web.dev Measure', 'https://pagespeed.web.dev', 'tools'], ['WebAIM Contrast Checker', 'https://webaim.org/resources/contrastchecker', 'tools']
];
const defaultSettings = { theme: 'dark', startup: 'start', home: 'linsoft://start', search: 'Google', safe: true, popups: true, tracking: false, trackingProtection: true, downloads: 'Downloads', downloadFolderPath: '', askDownload: false, adBlock: true, clearExit: false, restoreTabs: true, suspendInactiveTabs: true, confirmClose: true, camera: false, microphone: false, webNotifications: false, showBookmarksBar: false, showToolbarTools: false, spellcheckLanguages: null, autoUpdateCheck: true };
let settingsFromStorage = {};
try { settingsFromStorage = JSON.parse(localStorage.getItem('linsoft-settings') || '{}'); } catch { settingsFromStorage = {}; }
const settingsState = Object.assign({}, defaultSettings, settingsFromStorage);
const pageLoadStarts = new Map();
let recentPageLoadMetrics = [];
try {
  const storedPageLoadMetrics = JSON.parse(localStorage.getItem('linsoft-page-load-metrics') || '[]');
  if (Array.isArray(storedPageLoadMetrics)) recentPageLoadMetrics = storedPageLoadMetrics.slice(0, 50);
} catch { localStorage.removeItem('linsoft-page-load-metrics'); }
let siteZooms = {};
try {
  const storedSiteZooms = JSON.parse(localStorage.getItem('linsoft-site-zooms') || '{}');
  if (storedSiteZooms && typeof storedSiteZooms === 'object' && !Array.isArray(storedSiteZooms)) siteZooms = storedSiteZooms;
} catch { localStorage.removeItem('linsoft-site-zooms'); }
if (!localStorage.getItem('linsoft-glass-blue-selected')) {
  settingsState.theme = 'glass-blue';
  localStorage.setItem('linsoft-glass-blue-selected', '1');
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
}
if (Number(settingsFromStorage.downloadBehaviorVersion || 0) < 2) {
  settingsState.askDownload = false;
  settingsState.downloadBehaviorVersion = 2;
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function bookmarkFaviconUrl(value) {
  try { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(value).hostname)}&sz=32`; }
  catch { return ''; }
}

let toastTimeout = null;
function showToast(message, actionLabel = '', onAction = null) {
  const toast = document.getElementById('toastNotice');
  if (!toast) return;
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = String(message || '');
  toast.replaceChildren(text);
  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.className = 'toast-action';
    action.type = 'button';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      clearTimeout(toastTimeout);
      toast.hidden = true;
      onAction();
    }, { once: true });
    toast.appendChild(action);
  }
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3600);
}

function beginPageLoadMeasurement(tabId, url) {
  let hostname = '';
  try { hostname = new URL(url || tabs.get(tabId)?.url || '').hostname; } catch {}
  pageLoadStarts.set(tabId, { startedAt: performance.now(), hostname, adBlock: settingsState.adBlock === true });
}

function finishPageLoadMeasurement(tabId) {
  const started = pageLoadStarts.get(tabId);
  if (!started) return;
  pageLoadStarts.delete(tabId);
  let hostname = '';
  try { hostname = new URL(tabs.get(tabId)?.url || '').hostname; } catch {}
  recentPageLoadMetrics.unshift({ hostname: hostname || started.hostname || 'neznámy web', durationMs: Math.max(0, Math.round(performance.now() - started.startedAt)), adBlock: started.adBlock, measuredAt: Date.now() });
  recentPageLoadMetrics = recentPageLoadMetrics.slice(0, 50);
  localStorage.setItem('linsoft-page-load-metrics', JSON.stringify(recentPageLoadMetrics));
  renderPageLoadMetrics();
}

function renderPageLoadMetrics() {
  const summary = document.getElementById('pageLoadMetricsSummary');
  const list = document.getElementById('pageLoadMetricsList');
  if (!summary || !list) return;
  const byHost = new Map();
  recentPageLoadMetrics.forEach((metric) => {
    if (!byHost.has(metric.hostname)) byHost.set(metric.hostname, { enabled: [], disabled: [] });
    byHost.get(metric.hostname)[metric.adBlock ? 'enabled' : 'disabled'].push(metric.durationMs);
  });
  const formatAverage = (samples) => samples.length ? `${(samples.reduce((sum, value) => sum + value, 0) / samples.length / 1000).toFixed(2)} s` : '—';
  const comparisons = [...byHost.entries()].slice(0, 4).map(([hostname, samples]) => `${hostname}: zapnutý ${formatAverage(samples.enabled)} / vypnutý ${formatAverage(samples.disabled)}`);
  summary.textContent = comparisons.length ? `Priemer pre rovnaký web · ${comparisons.join(' · ')}` : 'Meraj rovnaké weby s AdBlockom zapnutým aj vypnutým.';
  list.innerHTML = recentPageLoadMetrics.slice(0, 8).map((metric) => `<div class="page-load-metric"><strong>${escapeHtml(metric.hostname)}</strong><span>${(metric.durationMs / 1000).toFixed(2)} s</span><small>AdBlock ${metric.adBlock ? 'zapnutý' : 'vypnutý'}</small></div>`).join('') || '<small class="update-note">Zatiaľ nie sú zaznamenané načítania.</small>';
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

function setTabIcon(id, iconUrl = '', brandIcon = false) { const icon = document.querySelector(`.managed-tab[data-tab-id="${id}"] .tab-logo`); if (!icon) return; icon.textContent = iconUrl || brandIcon ? '' : 'L'; icon.style.backgroundImage = iconUrl ? `url("${iconUrl}")` : brandIcon ? 'url("assets/linsoft-icon.svg")' : ''; }

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
  if (tab.url === 'linsoft://start') setTabIcon(tab.id, '', true);
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
  const closeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', closeFromOutside, true); document.removeEventListener('click', closeFromOutside, true); document.removeEventListener('keydown', closeFromEscape, true); };
  menu.closeContextMenu = closeMenu;
  const closeFromOutside = (event) => { if (!menu.contains(event.target)) closeMenu(); };
  const closeFromEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('click', closeFromOutside, true);
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
  if (input === addressInput) closeAddressSuggestions();
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
  const closeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', closeFromOutside, true); document.removeEventListener('click', closeFromOutside, true); document.removeEventListener('keydown', closeFromEscape, true); };
  menu.closeContextMenu = closeMenu;
  const closeFromOutside = (event) => { if (!menu.contains(event.target)) closeMenu(); };
  const closeFromEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('click', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
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
  savedBookmarks.forEach((bookmark) => {
    const button = document.createElement('button');
    button.className = 'saved-bookmark';
    const title = String(bookmark.title || bookmark.url);
    const iconUrl = bookmarkFaviconUrl(bookmark.url);
    button.innerHTML = `${iconUrl ? `<img class="saved-bookmark-icon" src="${escapeHtml(iconUrl)}" alt="">` : ''}<span class="saved-bookmark-title">${escapeHtml(title)}</span><span class="saved-bookmark-fallback" hidden>${escapeHtml(title.slice(0, 1).toUpperCase())}</span>`;
    const icon = button.querySelector('.saved-bookmark-icon');
    icon?.addEventListener('error', () => { icon.hidden = true; button.querySelector('.saved-bookmark-fallback').hidden = false; });
    button.dataset.url = bookmark.url;
    button.addEventListener('click', () => navigate(bookmark.url));
    button.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      openBackgroundTab(bookmark.url);
    });
    bar.insertBefore(button, spacer);
  });
}

function updateBookmarksBar() {
  const bar = document.getElementById('bookmarksBar');
  const toggle = document.getElementById('toggleBookmarksBar');
  if (bar) bar.hidden = !settingsState.showBookmarksBar;
  if (toggle) toggle.innerHTML = `<svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-bookmark"></use></svg><span>${settingsState.showBookmarksBar ? 'Skryť' : 'Zobraziť'} lištu záložiek</span>`;
}

function addTab(initialUrl = 'linsoft://start') {
  const id = nextTabId++;
  const initialTitle = initialUrl === 'linsoft://start' ? 'Linsoft Browser' : initialUrl.replace(/^https?:\/\//, '').split('/')[0];
  tabs.set(id, { id, url: initialUrl, title: initialTitle, history: [initialUrl], historyIndex: 0 });
  const button = createTabButton({ id, url: initialUrl, title: initialTitle, pinned: false });
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

function closeTab(id) { const tab = tabs.get(id); if (!tab || tab.pinned || tab.locked) return; const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`); if (isNativeTabs) window.linsoftBrowser?.destroyNativeTab?.(id); else surface?.querySelectorAll('webview').forEach((viewer) => viewer.remove()); if (tabs.size === 1) { activeTabId = id; tabs.get(id).url = 'linsoft://start'; tabs.get(id).title = 'Linsoft Browser'; tabs.get(id).history = ['linsoft://start']; tabs.get(id).historyIndex = 0; startPage(); return; } closedTabs.unshift({ ...tab }); closedTabs.splice(10); const ids = [...tabs.keys()]; const closedIndex = ids.indexOf(id); const fallbackId = ids[Math.max(0, closedIndex - 1)]; surface?.remove(); document.querySelector(`.managed-tab[data-tab-id="${id}"]`)?.remove(); tabs.delete(id); updateTabDensity(); saveSession(); if (activeTabId === id) selectTab(fallbackId); }

function restoreClosedTab() { const tab = closedTabs.shift(); if (!tab) return; const id = nextTabId++; tab.id = id; tabs.set(id, tab); createTabButton(tab); activeTabId = id; navigate(tab.url, false); saveSession(); }

function activeViewer() { return isNativeTabs ? null : content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`); }
function ensureActiveTabLoaded() { const tab = tabs.get(activeTabId); if (tab && suspendedTabs.has(activeTabId)) { suspendedTabs.delete(activeTabId); tab.suspended = false; navigate(tab.url, false); return null; } return activeViewer(); }
function updateNavigationButtons() { const tab = tabs.get(activeTabId); const viewer = activeViewer(); const back = document.getElementById('backButton'); const forward = document.getElementById('forwardButton'); if (back) back.disabled = !(viewer?.canGoBack?.() || (tab?.historyIndex > 0)); if (forward) forward.disabled = !(viewer?.canGoForward?.() || (tab && tab.historyIndex < tab.history.length - 1)); }
async function navigateTabHistory(direction) {
  const tab = tabs.get(activeTabId);
  const viewer = ensureActiveTabLoaded();
  if (!tab) return;
  if (viewer) {
    const canNavigate = direction < 0 ? viewer.canGoBack?.() : viewer.canGoForward?.();
    if (canNavigate) {
      if (direction < 0) viewer.goBack();
      else viewer.goForward();
      return;
    }
  }
  if (isNativeTabs) {
    const result = await window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: direction < 0 ? 'back' : 'forward' });
    if (result?.ok) return;
  }
  const nextIndex = tab.historyIndex + direction;
  if (nextIndex >= 0 && nextIndex < tab.history.length) {
    tab.historyIndex = nextIndex;
    navigate(tab.history[nextIndex], false);
  }
}
function navigationErrorMessage(errorCode, description = '') { const messages = { '-105': 'Server sa nenašiel (DNS).', '-106': 'Nie ste pripojení k internetu.', '-102': 'Server odmietol pripojenie.', '-118': 'Pripojenie vypršalo.', '-116': 'Spojenie bolo odmietnuté.' }; return messages[String(errorCode)] || (description ? `Načítanie zlyhalo: ${description}.` : 'Stránku sa nepodarilo načítať.'); }
function httpFallbackForTlsError(errorCode, failedUrl) {
  if (![-107, -113].includes(Number(errorCode))) return '';
  try {
    const url = new URL(failedUrl);
    if (url.protocol !== 'https:') return '';
    url.protocol = 'http:';
    return url.href;
  } catch { return ''; }
}
function httpsFallbackForIpConnectionRefused(errorCode, failedUrl) {
  if (Number(errorCode) !== -102) return '';
  try {
    const url = new URL(failedUrl);
    const hostname = url.hostname.toLowerCase();
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) && hostname.split('.').every((part) => Number(part) <= 255);
    const ipv6 = /^\[[0-9a-f:]+\]$/i.test(hostname);
    if (url.protocol !== 'http:' || (hostname !== 'localhost' && !ipv4 && !ipv6)) return '';
    if (url.port === '80') url.port = '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}
function replaceFailedUrlInTabHistory(tab, failedUrl, fallbackUrl) {
  const failedIndex = tab.history.indexOf(failedUrl);
  if (failedIndex >= 0) {
    tab.history[failedIndex] = fallbackUrl;
    tab.historyIndex = failedIndex;
  } else {
    tab.history.splice(tab.historyIndex + 1);
    tab.history.push(fallbackUrl);
    tab.historyIndex = tab.history.length - 1;
  }
  tab.url = fallbackUrl;
}

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
  tabTitle.textContent = 'Linsoft Browser';
  setInstallAppAvailable(false);
  updateActiveTab('linsoft://start', 'Linsoft Browser');
  updateNavigationButtons();
  setTabIcon(activeTabId, '', true);
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  const defaultFavorites = [
    { title: 'Google', url: 'https://www.google.com' },
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'GitHub', url: 'https://github.com' },
    { title: 'Správy', url: 'https://news.google.com' }
  ];
  const favorites = startFavorites.length ? startFavorites : defaultFavorites;
  const siteMarkup = (item) => {
    const title = String(item.title || item.url);
    const faviconUrl = bookmarkFaviconUrl(item.url);
    const iconMarkup = `${faviconUrl ? `<img class="start-site-favicon" src="${escapeHtml(faviconUrl)}" alt="">` : ''}<span class="start-site-fallback"${faviconUrl ? ' hidden' : ''}>${escapeHtml(title.slice(0, 1).toUpperCase())}</span>`;
    return `<div class="start-favorite"${startFavorites.length ? ` draggable="true" data-start-favorite-index="${startFavorites.indexOf(item)}"` : ''}><button class="start-favorite-open" data-url="${escapeHtml(item.url)}" title="${escapeHtml(title)}"><span class="start-favorite-icon">${iconMarkup}</span><span>${escapeHtml(title)}</span></button>${startFavorites.length ? `<button class="start-favorite-remove" data-start-favorite-remove="${startFavorites.indexOf(item)}" aria-label="Odopnúť ${escapeHtml(title)}" title="Odopnúť zo štartu"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-x"></use></svg></button>` : ''}</div>`;
  };
  surface.innerHTML = `<div class="start"><div class="start-kicker">LINSOFT BROWSER <span></span></div><div class="logo"><span class="logo-l">L</span>in<span>soft</span><i>•</i></div><p>${isGuestWindow ? 'Okno hosťa: história, cookies a údaje stránok sa po zatvorení nezachovajú.' : 'Rýchly, súkromný a skutočný webový prehliadač pre Windows a Linux Debian.'}</p><form class="start-form" role="search"><div class="start-search"><span>⌕</span><input class="start-input" aria-label="Hľadať na webe alebo zadať adresu" placeholder="Hľadať na webe alebo zadať adresu" autocomplete="off" /></div></form><section class="start-favorites"><div class="start-section-heading"><h2>${startFavorites.length ? 'Pripnuté stránky' : 'Rýchly prístup'}</h2><button type="button" data-library="bookmarks">${startFavorites.length ? 'Upraviť poradie' : 'Pripnúť záložku'}</button></div><div class="quick">${favorites.map((item) => siteMarkup(item)).join('')}</div></section><div class="start-footer"><span>● ${isGuestWindow ? 'Režim hosťa aktívny' : 'Chránené prehliadanie aktívne'}</span><span>Linsoft Browser 2.0 • Windows + Linux</span></div></div>`;
  surface.querySelectorAll('.start-site-favicon').forEach((icon) => icon.addEventListener('error', () => { icon.hidden = true; icon.nextElementSibling.hidden = false; }));
  surface.querySelector('.start-form').addEventListener('submit', (event) => { event.preventDefault(); navigate(surface.querySelector('.start-input').value); });
  surface.querySelector('.start-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); navigate(event.currentTarget.value); } });
  surface.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.url)));
  surface.querySelectorAll('[data-library]').forEach((button) => button.addEventListener('click', () => openLibrary(button.dataset.library)));
  surface.querySelectorAll('[data-start-favorite-remove]').forEach((button) => button.addEventListener('click', () => {
    startFavorites.splice(Number(button.dataset.startFavoriteRemove), 1);
    localStorage.setItem('linsoft-start-favorites', JSON.stringify(startFavorites));
    startPage();
  }));
  const quickLinks = surface.querySelector('.quick');
  let draggedFavoriteIndex = -1;
  quickLinks?.addEventListener('dragstart', (event) => {
    const tile = event.target.closest('[data-start-favorite-index]');
    if (!tile) return;
    draggedFavoriteIndex = Number(tile.dataset.startFavoriteIndex);
    event.dataTransfer?.setData('text/plain', String(draggedFavoriteIndex));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  quickLinks?.addEventListener('dragover', (event) => { if (event.target.closest('[data-start-favorite-index]')) event.preventDefault(); });
  quickLinks?.addEventListener('drop', (event) => {
    const target = event.target.closest('[data-start-favorite-index]');
    const targetIndex = Number(target?.dataset.startFavoriteIndex);
    if (!target || draggedFavoriteIndex < 0 || targetIndex === draggedFavoriteIndex) return;
    event.preventDefault();
    const [favorite] = startFavorites.splice(draggedFavoriteIndex, 1);
    startFavorites.splice(targetIndex, 0, favorite);
    localStorage.setItem('linsoft-start-favorites', JSON.stringify(startFavorites));
    startPage();
  });
}

function searchUrl(query) {
  const encoded = encodeURIComponent(query);
  if (settingsState.search === 'Bing') return `https://www.bing.com/search?q=${encoded}`;
  if (settingsState.search === 'DuckDuckGo') return `https://duckduckgo.com/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
}

function translateWebPage(value = tabs.get(activeTabId)?.url || addressInput.value) {
  let pageUrl;
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported');
    pageUrl = parsed.href;
  } catch {
    showToast('Prekladať možno iba webovú stránku HTTP alebo HTTPS.');
    return;
  }
  navigate(`https://translate.google.com/translate?sl=auto&tl=sk&u=${encodeURIComponent(pageUrl)}`);
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

function installOverlayCloseFallback(viewer) {
  if (!viewer) return;
  viewer.executeJavaScript(`(() => {
    if (window.__linsoftOverlayCloseFallbackInstalled) return;
    window.__linsoftOverlayCloseFallbackInstalled = true;
    const closeLabels = /^(?:zavrie(?:ť|t)|zatvoriť|close|dismiss)(?:\\s+(?:reklamu|advertisement|ad|okno|window))?$/i;
    document.addEventListener('click', (event) => {
      const path = event.composedPath?.() || [event.target];
      const closeControl = path.find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent].filter(Boolean).join(' ').trim().replace(/\\s+/g, ' ');
        return closeLabels.test(label) && (node.matches('button, a, [role="button"], [aria-label], [title]') || getComputedStyle(node).cursor === 'pointer');
      });
      if (!closeControl) return;
      let overlay = null;
      for (let parent = closeControl; parent instanceof HTMLElement && parent !== document.body; parent = parent.parentElement) {
        const bounds = parent.getBoundingClientRect();
        const style = getComputedStyle(parent);
        const dialog = parent.matches('dialog, [role="dialog"], [aria-modal="true"]');
        const floatingPanel = style.position === 'fixed' && Number.parseInt(style.zIndex, 10) > 10 && bounds.width > innerWidth * .35 && bounds.height > innerHeight * .15;
        if (dialog || floatingPanel) overlay = parent;
      }
      if (!overlay) return;
      window.setTimeout(() => {
        if (!overlay.isConnected) return;
        const style = getComputedStyle(overlay);
        if (overlay.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
        overlay.style.setProperty('display', 'none', 'important');
      }, 350);
    });
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
  surface.innerHTML = `<div class="app-center-page"><div class="app-center-hero"><div><span class="settings-eyebrow">LINSOFT / WORKSPACE</span><h1>App Centrum</h1><p>Weby na prácu, tvorbu, komunikáciu aj zábavu. Otvárajú sa priamo v kartách browsera.</p></div><div class="app-center-mark">L<span>•</span></div></div><section class="app-center-workspace"><div class="app-center-toolbar"><div><strong id="appCenterCount"></strong><small> vo vašom pracovnom priestore</small></div><div class="app-center-actions"><button class="settings-control" id="appCenterImport" type="button">Importovať</button><button class="settings-control" id="appCenterExport" type="button">Exportovať</button><button class="app-center-add" id="appCenterNewApp" type="button">+ Pridať web</button><input id="appCenterImportFile" type="file" accept="application/json" hidden></div></div><div class="app-center-list" id="appCenterInstalled"></div></section><section class="app-center-catalog"><div class="app-center-catalog-head"><div><p class="settings-label">OBJAVUJ</p><h2>Katalóg webov</h2></div><input class="app-center-search" id="appCenterSearch" type="search" placeholder="Hľadať aplikáciu alebo web…" aria-label="Hľadať v katalógu"></div><div class="app-center-filters" id="appCenterFilters"><button class="active" data-category="all" type="button">Všetky</button><button data-category="work" type="button">Práca</button><button data-category="creative" type="button">Tvorba</button><button data-category="social" type="button">Komunikácia</button><button data-category="media" type="button">Médiá</button><button data-category="games" type="button">Hry</button><button data-category="tools" type="button">Nástroje</button></div><div class="app-center-catalog-grid" id="appCenterCatalog"></div></section><div class="app-center-dialog-backdrop" id="appCenterDialog" hidden><form class="app-center-add-dialog" id="appCenterForm"><button class="app-center-dialog-close" id="appCenterDialogClose" type="button" aria-label="Zavrieť">×</button><p class="settings-eyebrow">NOVÝ WEB</p><h2>Pridať do App Centra</h2><label>Názov<input id="appCenterName" maxlength="60" placeholder="napr. Môj projekt" required></label><label>Webová adresa<input id="appCenterUrl" type="url" placeholder="https://example.com" required></label><div class="app-center-dialog-actions"><button class="settings-control" id="appCenterCancel" type="button">Zrušiť</button><button class="app-center-add" type="submit">Pridať</button></div></form></div></div>`;

  let activeCategory = 'all';
  const installedList = surface.querySelector('#appCenterInstalled');
  const catalogGrid = surface.querySelector('#appCenterCatalog');
  const queryInput = surface.querySelector('#appCenterSearch');
  const savedSortMode = localStorage.getItem('linsoft-app-center-sort');
  let appSortMode = ['manual', 'name', 'recent'].includes(savedSortMode) ? savedSortMode : 'manual';
  const saveApps = () => localStorage.setItem('linsoft-apps', JSON.stringify(installedApps));
  const faviconFor = (url) => { try { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=64`; } catch { return ''; } };
  const sortedInstalledApps = () => installedApps.map((app, index) => ({ app, index })).sort((left, right) => {
    if (Boolean(left.app.favorite) !== Boolean(right.app.favorite)) return Number(right.app.favorite) - Number(left.app.favorite);
    if (appSortMode === 'name') return left.app.title.localeCompare(right.app.title, 'sk');
    if (appSortMode === 'recent') return (Number(right.app.lastOpenedAt) || 0) - (Number(left.app.lastOpenedAt) || 0) || left.app.title.localeCompare(right.app.title, 'sk');
    const leftOrder = Number.isFinite(Number(left.app.sortOrder)) ? Number(left.app.sortOrder) : left.index;
    const rightOrder = Number.isFinite(Number(right.app.sortOrder)) ? Number(right.app.sortOrder) : right.index;
    return leftOrder - rightOrder || left.index - right.index;
  });
  const renderInstalledApps = () => {
    surface.querySelector('#appCenterCount').textContent = `${installedApps.length} ${installedApps.length === 1 ? 'aplikácia' : 'aplikácií'}`;
    const orderedApps = sortedInstalledApps();
    installedList.innerHTML = orderedApps.map(({ app: item, index }) => {
      const icon = faviconFor(item.url);
      const fallback = escapeHtml((item.title || item.url).slice(0, 1).toUpperCase());
      return `<article class="app-center-card"><div class="app-center-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${fallback}</span>` : fallback}</div><div class="app-center-info"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.url)}</small></div><button class="app-center-favorite ${item.favorite ? 'active' : ''}" data-favorite-app="${escapeHtml(item.url)}" type="button" title="${item.favorite ? 'Odopnúť obľúbenú aplikáciu' : 'Pripnúť medzi obľúbené'}" aria-label="${item.favorite ? 'Odopnúť obľúbenú aplikáciu' : 'Pripnúť medzi obľúbené'}">${item.favorite ? '★' : '☆'}</button>${appSortMode === 'manual' ? `<div class="app-center-order"><button data-move-app="${escapeHtml(item.url)}" data-direction="-1" type="button" title="Posunúť vyššie" aria-label="Posunúť ${escapeHtml(item.title)} vyššie">↑</button><button data-move-app="${escapeHtml(item.url)}" data-direction="1" type="button" title="Posunúť nižšie" aria-label="Posunúť ${escapeHtml(item.title)} nižšie">↓</button></div>` : ''}<button class="app-center-open" data-open-app="${index}" type="button">Otvoriť</button><button class="app-center-remove" data-remove-app="${index}" type="button">Odstrániť</button></article>`;
    }).join('') || '<div class="app-center-empty"><strong>Zatiaľ tu nie sú uložené weby</strong><small>Pridaj vlastnú adresu alebo vyber web z katalógu nižšie.</small></div>';
    installedList.querySelectorAll('[data-favorite-app]').forEach((button) => button.addEventListener('click', () => {
      const item = installedApps.find((app) => app.url === button.dataset.favoriteApp);
      if (!item) return;
      item.favorite = !item.favorite;
      saveApps();
      renderInstalledApps();
    }));
    installedList.querySelectorAll('[data-move-app]').forEach((button) => button.addEventListener('click', () => {
      const ordered = sortedInstalledApps().map(({ app }) => app);
      const index = ordered.findIndex((app) => app.url === button.dataset.moveApp);
      const nextIndex = index + Number(button.dataset.direction);
      if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length || ordered[index].favorite !== ordered[nextIndex].favorite) return;
      [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
      ordered.forEach((app, order) => { app.sortOrder = order; });
      saveApps();
      renderInstalledApps();
    }));
    installedList.querySelectorAll('[data-open-app]').forEach((button) => button.addEventListener('click', () => {
      const item = installedApps[Number(button.dataset.openApp)];
      if (!item) return;
      item.lastOpenedAt = Date.now();
      saveApps();
      navigate(item.url);
    }));
    installedList.querySelectorAll('[data-remove-app]').forEach((button) => button.addEventListener('click', async () => {
      const item = installedApps[Number(button.dataset.removeApp)];
      if (!item || !window.confirm(`Odstrániť ${item.title} z App Centra?`)) return;
      const result = await window.linsoftBrowser?.uninstallWebApp?.(item.url, item.title);
      if (result && !result.ok) return showToast(result.message || 'Web sa nepodarilo odstrániť.');
      installedApps.splice(Number(button.dataset.removeApp), 1);
      saveApps();
      renderInstalledApps();
      renderCatalog();
    }));
  };
  const renderCatalog = () => {
    const query = queryInput.value.trim().toLowerCase();
    const items = appCatalog.filter(([name, url, category]) => (activeCategory === 'all' || category === activeCategory) && (!query || `${name} ${url}`.toLowerCase().includes(query)));
    catalogGrid.innerHTML = items.map(([name, url, category]) => {
      const installed = installedApps.some((item) => item.url === url);
      const icon = faviconFor(url);
      return `<article class="catalog-card"><div class="app-center-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${escapeHtml(name.slice(0, 1))}</span>` : escapeHtml(name.slice(0, 1))}</div><div class="app-center-info"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(new URL(url).hostname)}</small></div><button class="catalog-install ${installed ? 'installed' : ''}" data-catalog-url="${escapeHtml(url)}" data-catalog-name="${escapeHtml(name)}" type="button"${installed ? ' disabled' : ''}>${installed ? 'Nainštalované' : 'Nainštalovať'}</button></article>`;
    }).join('') || '<div class="catalog-empty">Nenašiel sa žiadny web.</div>';
    catalogGrid.querySelectorAll('[data-catalog-url]').forEach((button) => button.addEventListener('click', async () => {
      const app = normalizeInstalledApp({ title: button.dataset.catalogName, url: button.dataset.catalogUrl });
      if (!app || installedApps.some((item) => item.url === app.url)) return;
      button.disabled = true;
      button.textContent = 'Inštalujem…';
      const result = await window.linsoftBrowser?.installWebApp?.(app.url, app.title);
      if (!result?.ok) {
        button.disabled = false;
        button.textContent = 'Nainštalovať';
        showToast(result?.message || 'Aplikáciu sa nepodarilo nainštalovať.');
        return;
      }
      installedApps.unshift(app);
      saveApps();
      renderInstalledApps();
      renderCatalog();
      showToast(`${app.title} bol nainštalovaný do Linsoft Browsera.`);
    }));
  };

  const sortAppsSelect = document.createElement('select');
  sortAppsSelect.id = 'appCenterSort';
  sortAppsSelect.className = 'app-center-sort';
  sortAppsSelect.setAttribute('aria-label', 'Zoradiť aplikácie');
  sortAppsSelect.innerHTML = '<option value="manual">Moje poradie</option><option value="name">Podľa názvu</option><option value="recent">Nedávno použité</option>';
  surface.querySelector('.app-center-actions').insertAdjacentElement('beforebegin', sortAppsSelect);
  sortAppsSelect.value = appSortMode;
  sortAppsSelect.addEventListener('change', () => { appSortMode = sortAppsSelect.value; localStorage.setItem('linsoft-app-center-sort', appSortMode); renderInstalledApps(); });
  renderInstalledApps();
  renderCatalog();
  surface.querySelector('#appCenterFilters').querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
    activeCategory = button.dataset.category;
    surface.querySelectorAll('#appCenterFilters [data-category]').forEach((filter) => filter.classList.toggle('active', filter === button));
    renderCatalog();
  }));
  let searchTimer;
  queryInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderCatalog, 120); });
  surface.querySelector('#appCenterNewApp').addEventListener('click', () => { closeBrowserMenu(); surface.querySelector('#appCenterDialog').hidden = false; surface.querySelector('#appCenterName').focus(); });
  const dialog = surface.querySelector('#appCenterDialog');
  const closeDialog = () => { dialog.hidden = true; surface.querySelector('#appCenterForm').reset(); };
  surface.querySelector('#appCenterDialogClose').addEventListener('click', closeDialog);
  surface.querySelector('#appCenterCancel').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
  surface.querySelector('#appCenterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const app = normalizeInstalledApp({ title: surface.querySelector('#appCenterName').value.trim(), url: surface.querySelector('#appCenterUrl').value });
    if (!app) return showToast('Zadaj platnú adresu stránky HTTP alebo HTTPS.');
    if (installedApps.some((item) => item.url === app.url)) return showToast('Tento web už je v App Centre.');
    installedApps.unshift(app);
    saveApps();
    closeDialog();
    renderInstalledApps();
    renderCatalog();
  });
  const importInput = surface.querySelector('#appCenterImportFile');
  surface.querySelector('#appCenterImport').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported)) throw new Error('invalid');
      const normalized = imported.map(normalizeInstalledApp).filter(Boolean);
      let added = 0;
      normalized.forEach((item) => { if (!installedApps.some((current) => current.url === item.url)) { installedApps.push(item); added += 1; } });
      saveApps();
      renderInstalledApps();
      renderCatalog();
      showToast(`Importovaných webov: ${added}.`);
    } catch { showToast('Súbor nemá platný zoznam webov.'); }
    finally { importInput.value = ''; }
  });
  surface.querySelector('#appCenterExport').addEventListener('click', () => {
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(installedApps, null, 2)], { type: 'application/json' }));
    link.href = objectUrl;
    link.download = 'linsoft-apps.json';
    link.click();
    URL.revokeObjectURL(objectUrl);
  });
}

function applyTheme() {
  document.body.classList.toggle('light-theme', settingsState.theme === 'light');
  document.body.classList.toggle('glass-blue-theme', settingsState.theme === 'glass-blue');
}

function saveSettings() {
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
  applyTheme();
  window.linsoftBrowser?.setBrowserPreferences({ downloads: settingsState.downloads, downloadFolderPath: settingsState.downloadFolderPath || '', askDownload: settingsState.askDownload, adBlock: settingsState.adBlock, trackingProtection: settingsState.trackingProtection, camera: settingsState.camera, microphone: settingsState.microphone, webNotifications: settingsState.webNotifications, spellcheckLanguages: settingsState.spellcheckLanguages, clearExit: settingsState.clearExit, autoUpdateCheck: settingsState.autoUpdateCheck });
  applyDefaultZoomToTabs();
}

function zoomOriginForUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch { return ''; }
}

function pageZoomForUrl(value) {
  const origin = zoomOriginForUrl(value);
  const savedZoom = Number(siteZooms[origin]);
  return Math.max(50, Math.min(200, savedZoom || Number(settingsState.zoom) || 100));
}

function applyTabZoom(tabId, url) {
  const zoom = pageZoomForUrl(url) / 100;
  if (isNativeTabs) {
    window.linsoftBrowser?.nativeTabCommand?.({ tabId, command: 'zoom', value: zoom });
    return;
  }
  content.querySelector(`.tab-surface[data-tab-id="${tabId}"] webview`)?.setZoomFactor?.(zoom);
}

function applyDefaultZoomToTabs() {
  for (const [tabId, tab] of tabs) {
    const origin = zoomOriginForUrl(tab.url);
    if (origin && siteZooms[origin]) continue;
    applyTabZoom(tabId, tab.url);
  }
}

function openLibrary(mode) {
  addressInput.value = `linsoft://${mode}`; tabTitle.textContent = mode === 'bookmarks' ? 'Záložky' : 'História';
  updateActiveTab(`linsoft://${mode}`, mode === 'bookmarks' ? 'Záložky' : 'História');
  saveSession();
  const items = mode === 'bookmarks' ? savedBookmarks : JSON.parse(localStorage.getItem('linsoft-history') || '[]');
  const surface = getActiveSurface();
  surface.innerHTML = `<div class="library-page"><div class="settings-heading"><div><span class="settings-eyebrow">LINSOFT BROWSER</span><h1>${mode === 'bookmarks' ? 'Záložky' : 'História'}</h1><p>${mode === 'bookmarks' ? 'Uložené stránky na jednom mieste.' : 'Nedávno navštívené stránky.'}</p></div><div class="library-actions">${mode === 'history' ? '<button class="danger-button" id="clearHistoryPage">Vymazať históriu</button>' : ''}</div></div><div class="library-list">${items.length ? items.map((item, index) => { const title = String(item.title || item.url); const iconUrl = mode === 'bookmarks' ? bookmarkFaviconUrl(item.url) : ''; const isPinned = mode === 'bookmarks' && startFavorites.some((favorite) => favorite.url === item.url); return `<div class="library-row${mode === 'bookmarks' ? ' library-bookmark-row' : ''}"><button class="library-open" data-url="${escapeHtml(item.url)}">${mode === 'bookmarks' ? `<span class="library-icon library-bookmark-icon">${iconUrl ? `<img class="library-favicon" src="${escapeHtml(iconUrl)}" alt=""><span class="library-favicon-fallback" hidden>${escapeHtml(title.slice(0, 1).toUpperCase())}</span>` : escapeHtml(title.slice(0, 1).toUpperCase())}</span>` : '<span class="library-icon">◷</span>'}<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(item.url)}</small></span><span>→</span></button>${mode === 'bookmarks' ? `<button class="library-pin${isPinned ? ' active' : ''}" data-start-favorite-url="${escapeHtml(item.url)}" aria-label="${isPinned ? 'Odopnúť zo štartovacej stránky' : 'Pripnúť na štartovaciu stránku'}" title="${isPinned ? 'Odopnúť zo štartovacej stránky' : 'Pripnúť na štartovaciu stránku'}"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-bookmark${isPinned ? '-check' : ''}"></use></svg></button><button class="library-delete" data-bookmark-index="${index}" aria-label="Odstrániť záložku">×</button>` : ''}</div>`; }).join('') : '<div class="empty-library">Zatiaľ tu nič nie je.</div>'}</div></div>`;
  surface.querySelectorAll('.library-favicon').forEach((icon) => icon.addEventListener('error', () => { icon.hidden = true; icon.nextElementSibling.hidden = false; }));
  surface.querySelector('#clearHistoryPage')?.addEventListener('click', () => { localStorage.removeItem('linsoft-history'); showToast('História bola vymazaná.'); openLibrary('history'); }); surface.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.url))); surface.querySelectorAll('[data-start-favorite-url]').forEach((button) => button.addEventListener('click', () => { const favoriteUrl = button.dataset.startFavoriteUrl; const index = startFavorites.findIndex((favorite) => favorite.url === favoriteUrl); if (index >= 0) startFavorites.splice(index, 1); else { const bookmark = savedBookmarks.find((item) => item.url === favoriteUrl); if (bookmark) startFavorites.push({ title: String(bookmark.title || bookmark.url), url: bookmark.url }); } localStorage.setItem('linsoft-start-favorites', JSON.stringify(startFavorites)); openLibrary('bookmarks'); })); surface.querySelectorAll('[data-bookmark-index]').forEach((button) => button.addEventListener('click', () => { savedBookmarks.splice(Number(button.dataset.bookmarkIndex), 1); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); openLibrary('bookmarks'); }));
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
  if (!viewer || viewer.isDestroyed?.()) return;
  const currentUrl = viewer.getURL?.() || url;
  if (!currentUrl) return;
  window.setTimeout(() => {
    if (!viewer.isDestroyed?.() && (viewer.getURL?.() || currentUrl) === currentUrl) maybeOfferSavePassword(viewer, currentUrl);
  }, 600);
}

function openSettings(section = 'general') {
  addressInput.value = 'linsoft://settings';
  tabTitle.textContent = 'Nastavenia';
  updateActiveTab('linsoft://settings', 'Nastavenia');
  saveSession();
  const surface = getActiveSurface();
  surface.innerHTML = `<div class="settings-page"><div class="settings-heading"><div><span class="settings-eyebrow">LINSOFT BROWSER</span><h1>Nastavenia</h1><p>Prispôsob si browser podľa svojho spôsobu práce.</p></div></div><div class="settings-layout"><nav class="settings-nav"><button data-settings-section="general">⚙ <span>Všeobecné</span></button><button data-settings-section="appearance">◐ <span>Vzhľad</span></button><button data-settings-section="privacy">♢ <span>Súkromie a bezpečnosť</span></button><button data-settings-section="about">ⓘ <span>O aplikácii</span></button></nav><div class="settings-panels"><section data-settings-panel="general"><p class="settings-label">VŠEOBECNÉ</p><h2>Správanie browsera</h2><div class="setting-card"><div><strong>Pri spustení</strong><small>Vyber, čo sa zobrazí po otvorení Linsoft Browsera.</small></div><select id="startupSetting"><option value="start">Nová karta Linsoft</option><option value="home">Domovská stránka</option></select></div><div class="setting-card"><div><strong>Domovská stránka</strong><small>Adresa, ktorú otvorí tlačidlo Domov.</small></div><input class="settings-input" id="homeSetting" value="${escapeHtml(settingsState.home)}" /></div><div class="setting-card"><div><strong>Vyhľadávač</strong><small>Predvolený vyhľadávač pre otázky v adresnom riadku.</small></div><select id="searchSetting"><option>Google</option><option>Bing</option><option>DuckDuckGo</option></select></div></section><section data-settings-panel="appearance"><p class="settings-label">VZHĽAD</p><h2>Vzhľad aplikácie</h2><div class="setting-card"><div><strong>Farebná téma</strong><small>Vyber, ako má Linsoft Browser vyzerať.</small></div><select id="themeSetting"><option value="dark">Tmavá</option><option value="light">Svetlá</option></select></div><div class="setting-card"><div><strong>Kompaktný panel</strong><small>Zmenší výšku navigačných panelov pre viac priestoru.</small></div><button class="settings-toggle" data-setting-toggle="compact"><i></i></button></div></section><section data-settings-panel="privacy"><p class="settings-label">SÚKROMIE</p><h2>Súkromie a bezpečnosť</h2><div class="setting-card"><div><strong>Bezpečné prehliadanie</strong><small>Upozorní pred známymi nebezpečnými stránkami.</small></div><button class="settings-toggle ${settingsState.safe ? 'on' : ''}" data-setting-toggle="safe"><i></i></button></div><div class="setting-card"><div><strong>Blokovať vyskakovacie okná</strong><small>Obmedzí automatické otváranie nových okien.</small></div><button class="settings-toggle ${settingsState.popups ? 'on' : ''}" data-setting-toggle="popups"><i></i></button></div><div class="setting-card"><div><strong>Posielať požiadavku Do Not Track</strong><small>Požiada weby, aby nesledovali tvoju aktivitu.</small></div><button class="settings-toggle ${settingsState.tracking ? 'on' : ''}" data-setting-toggle="tracking"><i></i></button></div><button class="danger-button" id="clearBrowserData">Vymazať históriu a údaje prehliadania</button></section><section data-settings-panel="about"><p class="settings-label">O APLIKÁCII</p><h2>Linsoft Browser</h2><div class="about-card"><span class="about-logo">L</span><div><strong>Linsoft Browser 1.0.0</strong><small>Desktopový prehliadač pre Windows postavený na Electron + Chromium.</small><small>© 2026 Linsoft</small></div></div></section><div class="settings-actions"><button class="settings-reset" id="resetSettings">Obnoviť predvolené</button><button class="save-settings" id="saveSettings">Uložiť zmeny</button></div></div></div></div>`;
  const startup = surface.querySelector('#startupSetting'); const theme = surface.querySelector('#themeSetting'); const search = surface.querySelector('#searchSetting'); const home = surface.querySelector('#homeSetting');
  theme.insertAdjacentHTML('beforeend', '<option value="glass-blue">Glass Blue</option>');
  startup.value = settingsState.startup; theme.value = settingsState.theme; search.value = settingsState.search;
  theme.addEventListener('change', () => { settingsState.theme = theme.value; applyTheme(); });
  addUpdateCheck();
  surface.querySelectorAll('[data-settings-section]').forEach((button) => button.addEventListener('click', () => { surface.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === button)); surface.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.hidden = panel.dataset.settingsPanel !== button.dataset.settingsSection); }));
  surface.querySelector(`[data-settings-section="${section}"]`).click();
  surface.querySelectorAll('[data-setting-toggle]').forEach((toggle) => toggle.addEventListener('click', () => { toggle.classList.toggle('on'); if (toggle.dataset.settingToggle === 'autoUpdateCheck') { settingsState.autoUpdateCheck = toggle.classList.contains('on'); saveSettings(); const note = surface.querySelector('[data-update-note]'); if (note) note.textContent = settingsState.autoUpdateCheck ? 'Automatická kontrola je zapnutá.' : 'Automatická kontrola je vypnutá.'; } }));
  surface.querySelector('#saveSettings').addEventListener('click', () => { settingsState.startup = startup.value; settingsState.theme = theme.value; settingsState.search = search.value; settingsState.home = home.value.trim() || 'linsoft://start'; settingsState.safe = surface.querySelector('[data-setting-toggle="safe"]').classList.contains('on'); settingsState.popups = surface.querySelector('[data-setting-toggle="popups"]').classList.contains('on'); settingsState.tracking = surface.querySelector('[data-setting-toggle="tracking"]').classList.contains('on'); ['camera', 'microphone', 'webNotifications'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (toggle) settingsState[key] = toggle.classList.contains('on'); }); const spellcheckOptions = surface.querySelector('#spellcheckLanguageOptions'); if (spellcheckOptions?.dataset.ready === 'true') settingsState.spellcheckLanguages = [...spellcheckOptions.querySelectorAll('input:checked')].map((input) => input.value); saveSettings(); showToast('Nastavenia boli uložené.'); });
  surface.querySelector('#resetSettings').addEventListener('click', () => { localStorage.removeItem('linsoft-settings'); Object.assign(settingsState, defaultSettings); saveSettings(); openSettings(section); showToast('Nastavenia boli obnovené.'); });
  surface.querySelector('#clearBrowserData').addEventListener('click', () => { localStorage.removeItem('linsoft-history'); localStorage.removeItem('linsoft-session'); localStorage.removeItem('linsoft-bookmarks'); localStorage.removeItem('linsoft-start-favorites'); localStorage.removeItem('linsoft-apps'); savedBookmarks.splice(0); startFavorites.splice(0); installedApps.splice(0); renderSavedBookmarks(); showToast('História a údaje boli vymazané.'); });
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
  advancedPanel.insertAdjacentHTML('afterbegin', '<div class="security-subsection"><p class="settings-label">KONTROLA PRAVOPISU</p><div class="setting-card"><div><strong>Jazyky kontroly</strong><small>Označ slovenčinu alebo angličtinu. Dostupné sú iba slovníky nainštalované v systéme.</small></div><div class="spellcheck-language-options" id="spellcheckLanguageOptions"><small>Načítavam slovníky...</small></div></div></div>');
  const spellcheckOptions = advancedPanel.querySelector('#spellcheckLanguageOptions');
  window.linsoftBrowser?.getSpellcheckerLanguages?.().then((result) => {
    const available = Array.isArray(result?.available) ? result.available : [];
    const languages = [
      { label: 'Slovenčina', prefix: 'sk' },
      { label: 'Angličtina', prefix: 'en' }
    ].map((language) => ({ ...language, code: available.find((code) => code.toLowerCase() === language.prefix) || available.find((code) => code.toLowerCase().startsWith(`${language.prefix}-`)) })).filter((language) => language.code);
    if (!languages.length) spellcheckOptions.innerHTML = '<small>V systéme nie sú dostupné slovníky pravopisu.</small>';
    else {
      const selected = Array.isArray(settingsState.spellcheckLanguages) ? new Set(settingsState.spellcheckLanguages) : new Set(languages.map((language) => language.code));
      spellcheckOptions.innerHTML = languages.map((language) => `<label class="spellcheck-language-option"><input type="checkbox" value="${escapeHtml(language.code)}"${selected.has(language.code) ? ' checked' : ''}><span>${language.label}</span></label>`).join('');
    }
    spellcheckOptions.dataset.ready = 'true';
  }).catch(() => { spellcheckOptions.innerHTML = '<small>Slovníky pravopisu sa nepodarilo načítať.</small>'; spellcheckOptions.dataset.ready = 'false'; });
  spellcheckOptions.closest('.security-subsection').insertAdjacentHTML('afterend', '<div class="security-subsection"><p class="settings-label">MERANIE RÝCHLOSTI</p><div class="setting-card page-load-metrics-card"><div><strong>Načítanie stránok</strong><small id="pageLoadMetricsSummary">Meranie začne pri ďalšom načítaní stránky.</small><div id="pageLoadMetricsList" class="page-load-metrics-list"></div></div><button class="settings-control" id="clearPageLoadMetrics">Vymazať merania</button></div></div>');
  renderPageLoadMetrics();
  advancedPanel.querySelector('#clearPageLoadMetrics').addEventListener('click', () => {
    recentPageLoadMetrics = [];
    localStorage.removeItem('linsoft-page-load-metrics');
    renderPageLoadMetrics();
    showToast('Merania načítania boli vymazané.');
  });
  advancedPanel.insertAdjacentHTML('beforeend', '<div class="security-subsection tor-hosting-section"><p class="settings-label">TOR HOSTING</p><div class="setting-card"><div><strong>Hostovať web cez Tor</strong><small id="torHostingStatus">Tor hosting je vypnutý.</small></div><span class="vpn-status-dot" id="torHostingDot"></span></div><div class="setting-card"><div><strong>Priečinok webu</strong><small id="torHostingFolder">Nie je vybraný priečinok.</small></div><button class="settings-control" id="chooseTorFolder">Vybrať priečinok</button></div><div class="vpn-actions"><button class="save-settings" id="startTorHosting">Spustiť hosting</button><button class="settings-reset" id="stopTorHosting">Zastaviť</button></div><div class="vpn-log-wrap"><div class="vpn-log-title">Onion adresa</div><pre id="torHostingAddress">Zatiaľ nie je vytvorená.</pre><button class="settings-control" id="copyTorAddress" disabled>Kopírovať adresu</button></div></div>');
  advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('afterbegin', '<div class="setting-card"><div><strong>Prehliadať cez Tor</strong><small id="torProxyStatus">Tor proxy je vypnutá.</small></div><button class="settings-control" id="toggleTorProxy">Zapnúť Tor</button></div>');
  advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('afterbegin', '<div class="setting-card manual-proxy-card"><div><strong>Manuálna proxy</strong><small>Vyber SOCKS4 alebo SOCKS5 a zadaj hostiteľa s portom.</small></div><select class="settings-input" id="manualProxyProtocol"><option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option></select><input class="settings-input" id="manualProxyHost" placeholder="Hostiteľ" value="127.0.0.1"><input class="settings-input" id="manualProxyPort" placeholder="Port" value="9150" inputmode="numeric"><button class="settings-control" id="applyManualProxy">Použiť proxy</button><button class="settings-reset" id="disableManualProxy">Vypnúť proxy</button></div>');
  advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('beforeend', '<div class="security-subsection tor-chat-section"><p class="settings-label">ONION CHAT 1:1</p><div class="setting-card"><div><strong>Šifrovaný chat cez Tor</strong><small id="torChatStatus">Onion chat je vypnutý.</small></div><span class="vpn-status-dot" id="torChatDot" data-status="stopped"></span></div><div class="vpn-actions"><button class="save-settings" id="torChatHost" type="button">Vytvoriť pozvánku</button><button class="settings-reset" id="torChatEnd" type="button" disabled>Ukončiť chat</button></div><div class="tor-chat-invite" id="torChatInvitePanel" hidden><label for="torChatInviteValue">Pozvánka pre druhého účastníka</label><textarea class="settings-input" id="torChatInviteValue" rows="2" readonly></textarea><button class="settings-control" id="copyTorChatInvite" type="button">Kopírovať pozvánku</button></div><div class="tor-chat-join-row" id="torChatJoinPanel"><input class="settings-input" id="torChatInviteInput" type="text" placeholder="Vlož onion pozvánku" autocomplete="off"><button class="settings-control" id="torChatJoin" type="button">Pripojiť</button></div><div class="tor-chat-conversation" id="torChatConversation" hidden><div class="tor-chat-messages" id="torChatMessages" role="log" aria-live="polite" aria-label="Správy onion chatu"></div><form class="tor-chat-compose" id="torChatForm"><textarea class="settings-input" id="torChatMessage" rows="2" maxlength="2000" placeholder="Napíš správu..." disabled></textarea><button class="save-settings" id="torChatSend" type="submit" disabled>Odoslať</button></form></div></div>');
  let torFolder = '';
  let currentTorStatus = { status: 'stopped', proxyStatus: 'stopped', proxyEnabled: false };
  const renderTorStatus = (update) => { currentTorStatus = { ...currentTorStatus, ...update }; const status = currentTorStatus; if (typeof status.folder === 'string' && status.folder) torFolder = status.folder; const label = surface.querySelector('#torHostingStatus'); const proxyLabel = surface.querySelector('#torProxyStatus'); const proxyButton = surface.querySelector('#toggleTorProxy'); const folderLabel = surface.querySelector('#torHostingFolder'); const dot = surface.querySelector('#torHostingDot'); const address = surface.querySelector('#torHostingAddress'); const start = surface.querySelector('#startTorHosting'); const stop = surface.querySelector('#stopTorHosting'); const copy = surface.querySelector('#copyTorAddress'); if (!label) return; const requestInfo = Number(status.requestCount) > 0 ? ` · Požiadavky: ${status.requestCount}` : ''; label.textContent = `${status.message || 'Tor hosting je vypnutý.'}${requestInfo}`; proxyLabel.textContent = status.proxyMessage || (status.proxyEnabled ? 'Tor proxy je pripojená.' : 'Tor proxy je vypnutá.'); proxyButton.textContent = status.proxyStatus === 'manual' ? 'Vypnúť proxy' : status.proxyEnabled ? 'Vypnúť Tor' : 'Zapnúť Tor'; proxyButton.disabled = status.proxyStatus === 'connecting'; folderLabel.textContent = status.folder || torFolder || 'Nie je vybraný priečinok.'; dot.dataset.status = status.status || 'stopped'; address.textContent = status.onion || 'Zatiaľ nie je vytvorená.'; start.disabled = status.status === 'starting' || status.status === 'running'; stop.disabled = status.status !== 'starting' && status.status !== 'running'; copy.disabled = !status.onion; };
  surface.querySelector('#toggleTorProxy').addEventListener('click', async () => { const current = await window.linsoftBrowser?.getTorStatus?.(); const result = current?.proxyEnabled ? await window.linsoftBrowser?.disableTorProxy?.() : await window.linsoftBrowser?.enableTorProxy?.(); renderTorStatus(result?.ok ? result : { proxyStatus: 'error', proxyMessage: result?.message || 'Tor proxy sa nepodarilo prepnúť.' }); });
  surface.querySelector('#applyManualProxy').addEventListener('click', async () => { const result = await window.linsoftBrowser?.setManualProxy?.({ protocol: surface.querySelector('#manualProxyProtocol').value, host: surface.querySelector('#manualProxyHost').value, port: surface.querySelector('#manualProxyPort').value }); renderTorStatus(result?.ok ? result : { proxyStatus: 'error', proxyMessage: result?.message || 'Manuálnu proxy sa nepodarilo zapnúť.' }); });
  surface.querySelector('#disableManualProxy').addEventListener('click', async () => { const result = await window.linsoftBrowser?.setManualProxy?.({ host: '', port: '' }); renderTorStatus(result || { proxyStatus: 'stopped', proxyEnabled: false, proxyMessage: 'Proxy je vypnutá.' }); });
  surface.querySelector('#chooseTorFolder').addEventListener('click', async () => { torFolder = await window.linsoftBrowser?.selectTorFolder?.() || ''; renderTorStatus({ folder: torFolder }); });
  surface.querySelector('#startTorHosting').addEventListener('click', async () => { if (!torFolder) torFolder = await window.linsoftBrowser?.getTorDefaultFolder?.() || ''; if (!torFolder) return; const result = await window.linsoftBrowser?.startTorHosting?.(torFolder); renderTorStatus(result || { status: 'error', message: 'Tor hosting sa nepodarilo spustiť.' }); });
  surface.querySelector('#stopTorHosting').addEventListener('click', async () => { const result = await window.linsoftBrowser?.stopTorHosting?.(); renderTorStatus(result || { status: 'stopped', message: 'Tor hosting je vypnutý.' }); });
  surface.querySelector('#copyTorAddress').addEventListener('click', async () => { const address = surface.querySelector('#torHostingAddress').textContent; await window.linsoftBrowser?.writeClipboardText?.(address); showToast('Onion adresa bola skopírovaná.'); });
  window.linsoftBrowser?.onTorStatus?.(renderTorStatus); window.linsoftBrowser?.getTorStatus?.().then(renderTorStatus).catch(() => {});
  renderTorChatState();
  surface.querySelector('#torChatHost').addEventListener('click', async () => {
    if (torChatUi.busy || torChatUi.role) return;
    const generation = ++torChatUi.generation;
    torChatUi.busy = true;
    torChatUi.status = 'starting';
    torChatUi.statusMessage = 'Vytváram onion chat...';
    renderTorChatState();
    try {
      const generatedKey = await window.linsoftTorChatCrypto.generateKey();
      const encodedKey = generatedKey.encoded;
      const key = generatedKey.key;
      const result = await window.linsoftBrowser?.startTorChatHost?.();
      if (generation !== torChatUi.generation) return;
      if (!result?.ok) {
        torChatUi.busy = false;
        torChatUi.status = result?.cancelled ? 'stopped' : 'error';
        torChatUi.statusMessage = result?.message || (result?.cancelled ? 'Vytváranie chatu bolo zrušené.' : 'Onion chat sa nepodarilo spustiť.');
        renderTorChatState();
        return;
      }
      torChatUi.role = 'host';
      torChatUi.onion = result.onion;
      torChatUi.key = key;
      torChatUi.invite = `${result.onion}#${result.token}.${encodedKey}`;
      torChatUi.lastId = 0;
      torChatUi.messages = [];
      torChatUi.busy = false;
      torChatUi.status = 'running';
      torChatUi.statusMessage = 'Chat čaká na druhého účastníka. Zdieľaj pozvánku súkromne.';
      renderTorChatState();
      scheduleTorChatPoll(0);
    } catch (error) {
      if (generation !== torChatUi.generation) return;
      torChatUi.busy = false;
      torChatUi.status = 'error';
      torChatUi.statusMessage = error instanceof Error ? error.message : 'Onion chat sa nepodarilo spustiť.';
      renderTorChatState();
    }
  });
  surface.querySelector('#torChatJoin').addEventListener('click', async () => {
    if (torChatUi.busy || torChatUi.role) return;
    const inviteText = surface.querySelector('#torChatInviteInput').value.trim();
    const generation = ++torChatUi.generation;
    torChatUi.busy = true;
    torChatUi.status = 'starting';
    torChatUi.statusMessage = 'Pripájam sa k onion chatu cez Tor...';
    renderTorChatState();
    try {
      const invite = new URL(inviteText);
      const [token, encodedKey, extra] = invite.hash.slice(1).split('.');
      if (invite.protocol !== 'http:' || !/^[a-z2-7]{56}\.onion$/i.test(invite.hostname) || invite.username || invite.password || invite.pathname !== '/' || invite.search || extra !== undefined || !/^[A-Za-z0-9_-]{32}$/.test(token || '')) throw new Error('Vlož platnú onion pozvánku od druhého účastníka.');
      const key = await importTorChatKey(encodedKey || '');
      const result = await window.linsoftBrowser?.joinTorChat?.({ address: `${invite.origin}/`, token });
      if (generation !== torChatUi.generation) return;
      if (!result?.ok) throw new Error(result?.message || 'K onion chatu sa nepodarilo pripojiť.');
      torChatUi.role = 'guest';
      torChatUi.onion = result.onion;
      torChatUi.invite = '';
      torChatUi.key = key;
      torChatUi.lastId = 0;
      torChatUi.messages = [];
      torChatUi.busy = false;
      torChatUi.status = 'running';
      torChatUi.statusMessage = 'Pripojené k onion chatu. Správy sú šifrované.';
      renderTorChatState();
      scheduleTorChatPoll(0);
    } catch (error) {
      if (generation !== torChatUi.generation) return;
      torChatUi.busy = false;
      torChatUi.status = 'error';
      torChatUi.statusMessage = error instanceof Error ? error.message : 'K onion chatu sa nepodarilo pripojiť.';
      renderTorChatState();
    }
  });
  surface.querySelector('#torChatEnd').addEventListener('click', async () => {
    torChatUi.generation += 1;
    torChatUi.busy = true;
    torChatUi.statusMessage = 'Ukončujem onion chat...';
    renderTorChatState();
    await window.linsoftBrowser?.stopTorChat?.();
    clearTorChatUi();
    renderTorChatState();
  });
  surface.querySelector('#copyTorChatInvite').addEventListener('click', async () => {
    const result = await window.linsoftBrowser?.writeClipboardText?.(torChatUi.invite);
    showToast(result?.ok ? 'Onion pozvánka bola skopírovaná.' : (result?.message || 'Pozvánku sa nepodarilo skopírovať.'));
  });
  surface.querySelector('#torChatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = surface.querySelector('#torChatMessage');
    const text = input.value.trim();
    if (!text || text.length > 2000 || !torChatUi.role || !torChatUi.key) return;
    const send = surface.querySelector('#torChatSend');
    send.disabled = true;
    try {
      const envelope = await encryptTorChatMessage(text);
      const result = await window.linsoftBrowser?.sendTorChat?.(envelope);
      if (!result?.ok) throw new Error(result?.message || 'Správu sa nepodarilo odoslať cez Tor.');
      input.value = '';
      await pollTorChatMessages();
    } catch (error) {
      torChatUi.status = 'error';
      torChatUi.statusMessage = error instanceof Error ? error.message : 'Správu sa nepodarilo odoslať.';
      renderTorChatState();
    } finally {
      send.disabled = !torChatUi.role;
      input.focus();
    }
  });
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

function navigate(value, addHistory = true, skipTorProxy = false) {
  const input = value.trim();
  const explicitFile = /^file:\/\//i.test(input);
  let localFileUrl = '';
  if (explicitFile) {
    try {
      const parsedFileUrl = new URL(input);
      if (!/\.html?$/i.test(decodeURIComponent(parsedFileUrl.pathname))) throw new Error('Unsupported local file type');
      localFileUrl = parsedFileUrl.href;
    } catch {
      showToast('Otvoriť možno iba platný HTML dokument.');
      return;
    }
  }
  if (!skipTorProxy && /^https?:\/\/[^/]+\.onion(?:\/|$)/i.test(input)) {
    window.linsoftBrowser?.enableTorProxy?.().then((result) => { if (result?.ok) navigate(input, addHistory, true); else showToast(result?.message || 'Tor proxy sa nepodarilo spustiť.'); }).catch(() => showToast('Tor proxy sa nepodarilo spustiť.'));
    return;
  }
  if (input.toLowerCase() === 'linsoft://apps') { hideNativeTab(); openAppCenter(); return; }
  if (input.toLowerCase() === 'linsoft://settings') { hideNativeTab(); openSettings(); return; }
  if (input.toLowerCase() === 'linsoft://bookmarks') { hideNativeTab(); openLibrary('bookmarks'); return; }
  if (input.toLowerCase() === 'linsoft://history') { hideNativeTab(); openLibrary('history'); return; }
  if (!input || input === 'linsoft://start' || input.toLowerCase() === 'home') { hideNativeTab(); startPage(); return; }
  if (/^(javascript|data|vbscript):/i.test(input)) { showToast('Tento typ adresy je z bezpečnostných dôvodov zablokovaný.'); return; }
  const explicitHttp = /^https?:\/\//i.test(input);
  const networkAddress = normalizeNetworkAddress(input);
  const looksLikeUrl = explicitHttp || explicitFile || networkAddress.isIp || /^[^\s]+\.[^\s]+$/.test(input);
  const requestedUrl = explicitFile ? localFileUrl : looksLikeUrl ? (explicitHttp ? input : networkAddress.isIp ? networkAddress.value : `https://${input}`) : searchUrl(input);
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
  const viewer = window.linsoftBrowser ? `<webview class="webview" src="${escapeHtml(url)}" allowpopups allowfullscreen zoom-factor="${pageZoomForUrl(url) / 100}"></webview>` : `<iframe class="webview" src="${escapeHtml(url)}" title="Web page" allowfullscreen></iframe>`;
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
    activeViewer.addEventListener('did-start-loading', () => { beginPageLoadMeasurement(viewerTabId, activeViewer.getURL?.() || tabs.get(viewerTabId)?.url); loadingTrack.classList.add('loading'); setTabLoading(viewerTabId, true); document.getElementById('securityButton').classList.add('address-loading'); });
    activeViewer.addEventListener('media-started-playing', () => setTabAudioIcon(viewerTabId, tabs.get(viewerTabId)?.muted, true));
    activeViewer.addEventListener('media-paused', () => setTabAudioIcon(viewerTabId, tabs.get(viewerTabId)?.muted, false));
    activeViewer.addEventListener('did-stop-loading', () => { finishPageLoadMeasurement(viewerTabId); loadingTrack.classList.remove('loading'); setTabLoading(viewerTabId, false); document.getElementById('securityButton').classList.remove('address-loading'); });
    activeViewer.addEventListener('render-process-gone', () => { const tab = tabs.get(viewerTabId); if (tab) { tab.crashed = true; saveSession(); showToast('Karta sa neočakávane ukončila. Klikni na kartu pre obnovenie.'); } });
    activeViewer.addEventListener('dom-ready', () => {
      activeViewer.insertCSS('*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }').catch(() => {});
      setInstallAppAvailable(/^https?:\/\//i.test(activeViewer.getURL?.() || addressInput.value));
      bindPasswordSavePrompt(activeViewer, activeViewer.getURL?.() || addressInput.value);
    });
    activeViewer.addEventListener('dom-ready', () => window.setTimeout(() => installYoutubeAdBlock(activeViewer), 350));
    activeViewer.addEventListener('dom-ready', () => installOverlayCloseFallback(activeViewer));
    activeViewer.addEventListener('did-navigate', (event) => applyTabZoom(viewerTabId, event.url));
    activeViewer.addEventListener('did-navigate', (event) => { const label = event.url.replace(/^https?:\/\//, '').split('/')[0]; const tab = tabs.get(viewerTabId); if (!tab) return; tab.url = event.url; tab.title = label; tab.history = tab.history || [event.url]; const knownIndex = tab.history.indexOf(event.url); if (knownIndex >= 0) tab.historyIndex = knownIndex; else { tab.history.splice(tab.historyIndex + 1); tab.history.push(event.url); tab.historyIndex = tab.history.length - 1; } if (viewerTabId === activeTabId) { addressInput.value = event.url; tabTitle.textContent = label; updateActiveTab(event.url, label); updateConnectionIndicator(event.url); } try { tab.icon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(event.url).hostname)}&sz=32`; } catch {} setTabIcon(viewerTabId, tab.icon); saveSession(); });
    activeViewer.addEventListener('did-navigate-in-page', (event) => { const url = event.url; const label = url.replace(/^https?:\/\//, '').split('/')[0]; const tab = tabs.get(viewerTabId); if (!tab || !url) return; tab.url = url; tab.title = label; tab.history = tab.history || [url]; const knownIndex = tab.history.indexOf(url); if (knownIndex >= 0) tab.historyIndex = knownIndex; else { tab.history.splice(tab.historyIndex + 1); tab.history.push(url); tab.historyIndex = tab.history.length - 1; } if (viewerTabId === activeTabId) { addressInput.value = url; tabTitle.textContent = label; updateActiveTab(url, label); updateConnectionIndicator(url); } saveSession(); });
    activeViewer.addEventListener('page-favicon-updated', (event) => { const iconUrl = event.favicons?.[0] || ''; const tab = tabs.get(viewerTabId); if (tab) tab.icon = iconUrl; setTabIcon(viewerTabId, iconUrl); saveSession(); });
    activeViewer.addEventListener('page-title-updated', (event) => { const tab = tabs.get(viewerTabId); if (event.title && tab) { tab.title = event.title; if (viewerTabId === activeTabId) { tabTitle.textContent = event.title; updateActiveTab(tab.url, event.title); } saveSession(); } });
    activeViewer.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3) return;
      const failedUrl = event.validatedURL || activeViewer.getURL?.() || '';
      const fallbackUrl = httpFallbackForTlsError(event.errorCode, failedUrl) || httpsFallbackForIpConnectionRefused(event.errorCode, failedUrl);
      if (fallbackUrl) {
        const tab = tabs.get(viewerTabId);
        if (tab) { replaceFailedUrlInTabHistory(tab, failedUrl, fallbackUrl); saveSession(); }
        if (viewerTabId === activeTabId) {
          addressInput.value = fallbackUrl;
          updateConnectionIndicator(fallbackUrl);
          showToast(fallbackUrl.startsWith('https:') ? 'HTTP pripojenie odmietnuté; skúšam HTTPS.' : [-200, -201, -202].includes(Number(event.errorCode)) ? 'Certifikát súkromnej IP adresy nie je dôveryhodný; skúšam HTTP.' : 'Web nepodporuje HTTPS; otváram nezabezpečené HTTP pripojenie.');
        }
        activeViewer.src = fallbackUrl;
        return;
      }
      showToast(navigationErrorMessage(event.errorCode, event.errorDescription));
    });
  }
}

const addressSuggestions = document.getElementById('addressSuggestions');
let addressSuggestionItems = [];
let activeAddressSuggestion = -1;
let currentAddressSuggestionQuery = '';
function closeAddressSuggestions() {
  addressSuggestions.hidden = true;
  addressInput.setAttribute('aria-expanded', 'false');
  addressInput.removeAttribute('aria-activedescendant');
  activeAddressSuggestion = -1;
}
function renderAddressSuggestions(queryOverride) {
  if (isGuestWindow) return closeAddressSuggestions();
  const query = String(queryOverride ?? addressInput.value).trim().toLocaleLowerCase();
  currentAddressSuggestionQuery = query;
  activeAddressSuggestion = -1;
  addressInput.removeAttribute('aria-activedescendant');
  let history = [];
  try { history = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch {}
  const historyItems = (Array.isArray(history) ? history : [])
    .filter((item) => { try { return item && typeof item.url === 'string' && ['http:', 'https:'].includes(new URL(item.url).protocol); } catch { return false; } });
  const candidates = new Map();
  savedBookmarks.forEach((bookmark) => {
    try {
      if (!['http:', 'https:'].includes(new URL(bookmark.url).protocol)) return;
      candidates.set(bookmark.url, { ...bookmark, source: 'bookmark', hasHistory: false, visitedAt: 0 });
    } catch {}
  });
  historyItems.forEach((item) => {
    const bookmark = candidates.get(item.url);
    candidates.set(item.url, { ...item, title: bookmark?.title || item.title || item.url, source: bookmark ? 'bookmark' : 'history', hasHistory: true, visitedAt: Number(item.visitedAt) || 0 });
  });
  const queryParts = query.split(/\s+/).filter(Boolean);
  const matchScore = (item) => {
    if (!query) return item.source === 'bookmark' ? 0 : 1;
    const title = String(item.title || '').toLocaleLowerCase();
    const url = item.url.toLocaleLowerCase();
    const hostname = new URL(item.url).hostname.toLocaleLowerCase();
    if (url === query) return 0;
    if (hostname === query) return 1;
    if (title === query) return 2;
    if (item.source === 'bookmark') return 3;
    if (hostname.startsWith(query)) return 4;
    if (title.startsWith(query)) return 5;
    if (url.startsWith(query)) return 6;
    return 7;
  };
  addressSuggestionItems = [...candidates.values()]
    .filter((item) => {
      const searchable = `${item.title || ''} ${item.url} ${new URL(item.url).hostname}`.toLocaleLowerCase();
      return queryParts.every((part) => searchable.includes(part));
    })
    .sort((left, right) => matchScore(left) - matchScore(right) || Number(right.visitedAt) - Number(left.visitedAt))
    .slice(0, 6);
  const clearButton = historyItems.length ? '<button type="button" data-clear-address-history>Vymazať</button>' : '';
  const emptyState = query ? 'Nenašli sa žiadne zodpovedajúce stránky.' : 'Zatiaľ tu nie sú žiadne návštevy ani záložky.';
  const resultMarkup = addressSuggestionItems.length ? addressSuggestionItems.map((item, index) => {
    const title = String(item.title || item.url);
    const hostname = new URL(item.url).hostname;
    const favicon = bookmarkFaviconUrl(item.url);
    const historyLabel = item.source === 'bookmark' ? `${hostname} · Záložka` : hostname;
    const removeButton = item.hasHistory ? `<button type="button" class="address-suggestion-remove" data-remove-address-suggestion="${index}" aria-label="Odstrániť z histórie: ${escapeHtml(title)}" title="Odstrániť z histórie"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-x"></use></svg></button>` : '';
    return `<div class="address-suggestion-row"><button type="button" role="option" id="address-suggestion-${index}" aria-selected="false" data-address-suggestion="${index}"><span class="address-suggestion-icon">${favicon ? `<img src="${escapeHtml(favicon)}" alt="">` : escapeHtml(title.slice(0, 1).toUpperCase())}</span><span class="address-suggestion-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(historyLabel)}</small></span></button>${removeButton}</div>`;
  }).join('') : `<div class="address-suggestions-empty">${emptyState}</div><button type="button" class="address-suggestions-open-history" data-open-address-history>Otvoriť históriu</button>`;
  addressSuggestions.innerHTML = `<div class="address-suggestions-heading"><span>Návrhy stránok</span>${clearButton}</div>${resultMarkup}`;
  const rect = document.getElementById('addressForm').getBoundingClientRect();
  const width = Math.min(Math.max(220, rect.width), window.innerWidth - 16);
  addressSuggestions.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  addressSuggestions.style.top = `${rect.bottom + 6}px`;
  addressSuggestions.style.width = `${width}px`;
  addressSuggestions.hidden = false;
  addressInput.setAttribute('aria-expanded', 'true');
  const clearHistoryButton = addressSuggestions.querySelector('[data-clear-address-history]');
  clearHistoryButton?.addEventListener('mousedown', (event) => event.preventDefault());
  clearHistoryButton?.addEventListener('click', () => {
    localStorage.removeItem('linsoft-history');
    addressSuggestionItems = [];
    closeAddressSuggestions();
    showToast('História bola vymazaná.', 'Vrátiť späť', () => restoreAddressHistory(historyItems, 0));
  });
  const openHistoryButton = addressSuggestions.querySelector('[data-open-address-history]');
  openHistoryButton?.addEventListener('mousedown', (event) => event.preventDefault());
  openHistoryButton?.addEventListener('click', () => { closeAddressSuggestions(); openLibrary('history'); });
  addressSuggestions.querySelectorAll('[data-remove-address-suggestion]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = addressSuggestionItems[Number(button.dataset.removeAddressSuggestion)];
      if (!item) return;
      let history = [];
      try { history = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch {}
      const historyItems = Array.isArray(history) ? history : [];
      const historyIndex = historyItems.findIndex((entry) => entry?.url === item.url);
      localStorage.setItem('linsoft-history', JSON.stringify(historyItems.filter((entry) => entry?.url !== item.url)));
      const previousHistory = historyIndex >= 0 ? [historyItems[historyIndex]] : [];
      showToast('Návšteva odstránená z histórie.', 'Vrátiť späť', () => restoreAddressHistory(previousHistory, historyIndex));
      renderAddressSuggestions(currentAddressSuggestionQuery);
    });
  });
  addressSuggestions.querySelectorAll('[data-address-suggestion]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      const item = addressSuggestionItems[Number(button.dataset.addressSuggestion)];
      closeAddressSuggestions();
      if (item) navigate(item.url);
    });
    button.querySelector('img')?.addEventListener('error', (event) => {
      const fallback = document.createElement('span');
      fallback.textContent = String(button.querySelector('strong')?.textContent || '?').slice(0, 1).toUpperCase();
      event.currentTarget.replaceWith(fallback);
    });
  });
}
function restoreAddressHistory(entries, insertAt) {
  let currentHistory = [];
  try { currentHistory = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch {}
  const restoredUrls = new Set(entries.map((item) => item.url));
  const restoredHistory = (Array.isArray(currentHistory) ? currentHistory : []).filter((item) => !restoredUrls.has(item.url));
  entries.forEach((item, index) => restoredHistory.splice(Math.min((insertAt ?? index) + index, restoredHistory.length), 0, item));
  localStorage.setItem('linsoft-history', JSON.stringify(restoredHistory.slice(0, 200)));
  renderAddressSuggestions(currentAddressSuggestionQuery);
}
function setActiveAddressSuggestion(index) {
  if (!addressSuggestionItems.length) return;
  activeAddressSuggestion = (index + addressSuggestionItems.length) % addressSuggestionItems.length;
  addressSuggestions.querySelectorAll('[data-address-suggestion]').forEach((button, buttonIndex) => {
    button.setAttribute('aria-selected', String(buttonIndex === activeAddressSuggestion));
  });
  addressInput.setAttribute('aria-activedescendant', `address-suggestion-${activeAddressSuggestion}`);
}
document.getElementById('addressForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const item = addressSuggestionItems[activeAddressSuggestion];
  closeAddressSuggestions();
  navigate(item?.url || addressInput.value);
});
addressInput.addEventListener('focus', () => { addressInput.select(); renderAddressSuggestions(''); });
addressInput.addEventListener('input', renderAddressSuggestions);
addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && !addressSuggestions.hidden) { event.preventDefault(); setActiveAddressSuggestion(activeAddressSuggestion + 1); }
  else if (event.key === 'ArrowUp' && !addressSuggestions.hidden) { event.preventDefault(); setActiveAddressSuggestion(activeAddressSuggestion < 0 ? addressSuggestionItems.length - 1 : activeAddressSuggestion - 1); }
  else if (event.key === 'Escape' && !addressSuggestions.hidden) { event.preventDefault(); closeAddressSuggestions(); }
});
addressInput.addEventListener('blur', () => window.setTimeout(() => { if (document.activeElement !== addressInput) closeAddressSuggestions(); }, 120));
document.getElementById('clearAddress').addEventListener('click', () => { addressInput.value = ''; addressInput.focus(); renderAddressSuggestions(); });
document.getElementById('installAppButton').addEventListener('click', installCurrentApp);
document.getElementById('cancelInstall').addEventListener('click', closeInstallDialog); document.getElementById('cancelInstallButton').addEventListener('click', closeInstallDialog); document.getElementById('confirmInstall').addEventListener('click', async () => { const button = document.getElementById('confirmInstall'); const url = addressInput.value; const title = tabTitle.textContent; button.disabled = true; const result = await window.linsoftBrowser?.installWebApp(url, title); button.disabled = false; closeInstallDialog(); if (!result?.ok) return showToast(result?.message || 'Webovú aplikáciu sa nepodarilo nainštalovať.'); const existing = installedApps.find((item) => item.url === url); if (existing) existing.title = title; else installedApps.push({ url, title, installedAt: Date.now() }); localStorage.setItem('linsoft-apps', JSON.stringify(installedApps)); showToast('Aplikácia bola pridaná do Linsoft App Centra.'); openAppCenter(); });
const securityPanel = document.getElementById('securityPanel'); const publicIp = document.getElementById('publicIp'); const publicNetwork = document.getElementById('publicNetwork'); const ipNote = document.getElementById('ipNote'); let ipLoaded = false;
document.getElementById('securityButton').addEventListener('click', async (event) => { event.preventDefault(); event.stopPropagation(); securityPanel.hidden = !securityPanel.hidden; if (securityPanel.hidden || ipLoaded) return; publicIp.textContent = 'Načítavam...'; publicNetwork.textContent = 'Načítavam...'; const endpoints = [{ url: 'https://ipapi.co/json/', parse: (data) => ({ ip: data.ip, network: `${data.org || 'Neznáma sieť'} · ${data.country_name || 'Neznáma krajina'}` }) }, { url: 'https://ipwho.is/', parse: (data) => ({ ip: data.ip, network: `${data.connection?.isp || 'Neznáma sieť'} · ${data.country || 'Neznáma krajina'}` }) }, { url: 'https://api.ipify.org?format=json', parse: (data) => ({ ip: data.ip, network: 'Sieť a krajina nie sú dostupné' }) }]; let lastError = 'IP služby neodpovedali'; for (const endpoint of endpoints) { try { const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 7000); const response = await fetch(endpoint.url, { cache: 'no-store', signal: controller.signal }); window.clearTimeout(timeout); if (!response.ok) throw new Error(`HTTP ${response.status}`); const result = endpoint.parse(await response.json()); if (!result.ip) throw new Error('Prázdna odpoveď'); publicIp.textContent = result.ip; publicNetwork.textContent = result.network; ipNote.textContent = 'Verejná IP podľa aktuálneho internetového pripojenia.'; ipLoaded = true; return; } catch (error) { lastError = error.name === 'AbortError' ? 'Časový limit vypršal' : error.message; } } publicIp.textContent = 'Nepodarilo sa načítať'; publicNetwork.textContent = 'Neznáme'; ipNote.textContent = `${lastError}. Skontroluj internet, VPN alebo firewall a skús znova.`; }); document.getElementById('closeSecurity').addEventListener('click', () => { securityPanel.hidden = true; }); securityPanel.addEventListener('click', (event) => event.stopPropagation()); document.addEventListener('click', () => { securityPanel.hidden = true; });
document.getElementById('homeButton').addEventListener('click', () => {
  const homeUrl = String(settingsState.home || defaultSettings.home).trim() || 'linsoft://start';
  navigate(homeUrl);
});
async function activeEditCommand(command, fromContextMenu = false) {
  const viewer = ensureActiveTabLoaded();
  if (isNativeTabs) {
    const result = await window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command, fromContextMenu });
    if (result?.ok && command === 'paste' && fromContextMenu) showToast('Vloženie bolo odoslané.');
    else if (!result?.ok) showToast(result?.message || 'Táto akcia nie je dostupná na tejto stránke.');
    return;
  }
  const webContentsId = viewer?.getWebContentsId?.();
  const result = webContentsId ? await window.linsoftBrowser?.editCommand?.(webContentsId, command) : null;
  if (result?.ok) { if (command === 'paste' && fromContextMenu) showToast('Vloženie bolo odoslané.'); return; }
  if (command === 'paste' && fromContextMenu) { showToast(result?.message || 'Vloženie zlyhalo. Klikni najprv do textového poľa.'); return; }
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
  const tab = tabs.get(activeTabId);
  const url = tab?.url || addressInput.value;
  const origin = zoomOriginForUrl(url);
  if (!origin) return showToast('Priblíženie je dostupné iba na webových stránkach.');
  const zoom = Math.max(50, Math.min(200, pageZoomForUrl(url) + delta));
  siteZooms[origin] = zoom;
  localStorage.setItem('linsoft-site-zooms', JSON.stringify(siteZooms));
  applyTabZoom(activeTabId, url);
  showToast(`Priblíženie pre ${new URL(origin).hostname}: ${zoom} %`);
}
function resetPageZoom() {
  const tab = tabs.get(activeTabId);
  const url = tab?.url || addressInput.value;
  const origin = zoomOriginForUrl(url);
  if (!origin) return showToast('Priblíženie je dostupné iba na webových stránkach.');
  delete siteZooms[origin];
  localStorage.setItem('linsoft-site-zooms', JSON.stringify(siteZooms));
  applyTabZoom(activeTabId, url);
  showToast(`Predvolené priblíženie pre ${new URL(origin).hostname}: ${pageZoomForUrl(url)} %`);
}
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
  document.querySelector('.webview-context-menu')?.closeContextMenu?.();
  document.querySelector('.webview-context-menu')?.remove();
  const dismissLayer = document.createElement('div');
  dismissLayer.className = 'context-menu-dismiss-layer';
  const menu = document.createElement('div');
  menu.className = 'webview-context-menu';
  menu.setAttribute('role', 'menu');
  const viewer = activeViewer();
  const hasSelection = Boolean(data.selectionText);
  const hasLink = /^https?:\/\//i.test(data.linkURL || '');
  const hasImage = data.mediaType === 'image' && /^https?:\/\//i.test(data.srcURL || '');
  let selectedUrl = '';
  try {
    const parsedSelection = new URL(String(data.selectionText || '').trim());
    if (parsedSelection.protocol === 'http:' || parsedSelection.protocol === 'https:') selectedUrl = parsedSelection.href;
  } catch {}
  const actions = [
    ['paste', 'clipboard-paste', 'Vložiť', false, 'Ctrl+V'], ['copy', 'copy', 'Kopírovať', false, 'Ctrl+C'], ['cut', 'scissors', 'Vystrihnúť', !data.isEditable, 'Ctrl+X'], ['divider'],
    ['search', 'search', 'Vyhľadať výber', !hasSelection], ['translate', 'languages', 'Preložiť výber', !hasSelection], ['translate-page', 'languages', 'Preložiť stránku do slovenčiny']
  ];
  if (selectedUrl) actions.push(['divider'], ['open-selected-url', 'external-link', 'Otvoriť adresu vo výbere v novej karte'], ['open-selected-url-background', 'external-link', 'Otvoriť adresu vo výbere na pozadí']);
  if (hasLink) actions.push(['divider'], ['open-link', 'external-link', 'Otvoriť odkaz v novej karte'], ['open-link-background', 'external-link', 'Otvoriť odkaz na pozadí'], ['open-window', 'layout-grid', 'Otvoriť odkaz v novom okne'], ['copy-link', 'link', 'Kopírovať adresu odkazu']);
  if (hasImage) actions.push(['divider'], ['open-image', 'image', 'Otvoriť obrázok v novej karte'], ['save-image', 'download', 'Uložiť obrázok'], ['copy-image', 'image', 'Kopírovať obrázok'], ['copy-image-url', 'link', 'Kopírovať adresu obrázka']);
  actions.push(['divider'], ['view-source', 'file-code', 'Zobraziť HTML kód stránky'], ['bookmark-page', 'bookmark', 'Pridať medzi záložky', false, 'Ctrl+D'], ['copy-page', 'link', 'Kopírovať adresu stránky'], ['open-page-tab', 'plus', 'Otvoriť stránku v novej karte'], ['screenshot', 'camera', 'Urobiť snímku webu'], ['copy-screenshot', 'camera', 'Kopírovať snímku'], ['divider'], ['back', 'arrow-left', 'Späť', !viewer?.canGoBack?.()], ['forward', 'arrow-right', 'Dopredu', !viewer?.canGoForward?.()], ['reload', 'rotate-cw', 'Obnoviť', false, 'Ctrl+R'], ['print', 'printer', 'Tlačiť', false, 'Ctrl+P']);
  menu.innerHTML = actions.map((entry) => entry[0] === 'divider' ? '<div class="context-menu-divider" role="separator"></div>' : `<button role="menuitem" data-context-action="${entry[0]}"${entry[3] ? ' disabled' : ''}><svg class="context-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${entry[1]}"></use></svg>${entry[2]}${entry[4] ? `<kbd>${entry[4]}</kbd>` : ''}</button>`).join('');
  document.body.appendChild(dismissLayer);
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(Math.max(8, Number(data.x) || 8), Math.max(8, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(Math.max(80, Number(data.y) || 80), Math.max(80, window.innerHeight - menu.offsetHeight - 8))}px`;
  const closeMenu = () => {
    dismissLayer.remove();
    menu.remove();
    document.removeEventListener('pointerdown', closeFromOutside, true);
    document.removeEventListener('click', closeFromOutside, true);
    document.removeEventListener('keydown', closeFromEscape, true);
  };
  menu.closeContextMenu = closeMenu;
  dismissLayer.addEventListener('pointerdown', closeMenu, { once: true });
  dismissLayer.addEventListener('click', closeMenu, { once: true });
  const closeFromOutside = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
  const closeFromEscape = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('click', closeFromOutside, true);
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
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if (!action) return;
    closeMenu();
    if (action === 'paste') await activeEditCommand('paste', true);
    if (action === 'cut') await activeEditCommand('cut');
    if (action === 'copy') {
      const result = await window.linsoftBrowser?.copyClipboardSelection?.(data.selectionText);
      showToast(result?.ok ? 'Text bol skopírovaný.' : (result?.message || 'Text sa nepodarilo skopírovať.'));
    }
    if (action === 'search' && data.selectionText) navigate(searchUrl(data.selectionText));
    if (action === 'translate' && data.selectionText) openNewTab(`https://translate.google.com/?sl=auto&tl=sk&text=${encodeURIComponent(data.selectionText)}&op=translate`);
    if (action === 'translate-page') translateWebPage(data.pageURL || tabs.get(activeTabId)?.url || addressInput.value);
    if (action === 'open-selected-url' && selectedUrl) openNewTab(selectedUrl);
    if (action === 'open-selected-url-background' && selectedUrl) openBackgroundTab(selectedUrl);
    if (action === 'open-link' && data.linkURL) openNewTab(data.linkURL);
    if (action === 'open-link-background' && data.linkURL) openBackgroundTab(data.linkURL);
    if (action === 'open-window' && data.linkURL) window.linsoftBrowser?.openBrowserWindow?.(data.linkURL);
    if (action === 'copy-link') { const result = await window.linsoftBrowser?.writeClipboardText?.(data.linkURL); showToast(result?.ok ? 'Adresa odkazu bola skopírovaná.' : (result?.message || 'Adresu odkazu sa nepodarilo skopírovať.')); }
    if (action === 'open-image' && data.srcURL) openNewTab(data.srcURL);
    if (action === 'save-image' && data.srcURL) { activeViewer()?.downloadURL?.(data.srcURL); showToast('Obrázok sa pridáva do sťahovaní.'); }
    if (action === 'copy-image' && data.srcURL) { const result = await window.linsoftBrowser?.writeClipboardImage?.(data.srcURL); if (result?.ok) showToast('Obrázok bol skopírovaný.'); else showToast(result?.message || 'Obrázok sa nepodarilo skopírovať.'); }
    if (action === 'copy-image-url' && data.srcURL) { const result = await window.linsoftBrowser?.writeClipboardText?.(data.srcURL); showToast(result?.ok ? 'Adresa obrázka bola skopírovaná.' : (result?.message || 'Adresu obrázka sa nepodarilo skopírovať.')); }
    if (action === 'bookmark-page') document.getElementById('bookmarkButton').click();
    if (action === 'copy-page') { const result = await window.linsoftBrowser?.writeClipboardText?.(addressInput.value); showToast(result?.ok ? 'Adresa stránky bola skopírovaná.' : (result?.message || 'Adresu stránky sa nepodarilo skopírovať.')); }
    if (action === 'view-source') await showPageSourcePreview();
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
const toolbarElement = document.querySelector('.toolbar');
const toolbarToolsToggle = document.getElementById('toolbarToolsToggle');
toolbarElement.classList.toggle('tools-collapsed', !settingsState.showToolbarTools);
toolbarToolsToggle.setAttribute('aria-expanded', String(settingsState.showToolbarTools));
toolbarToolsToggle.title = settingsState.showToolbarTools ? 'Skryť nástroje' : 'Zobraziť nástroje';
toolbarToolsToggle.setAttribute('aria-label', toolbarToolsToggle.title);
toolbarToolsToggle.querySelector('use').setAttribute('href', settingsState.showToolbarTools ? '#icon-chevron-up' : '#icon-chevron-down');
toolbarToolsToggle.addEventListener('click', () => {
  settingsState.showToolbarTools = toolbarElement.classList.toggle('tools-collapsed') === false;
  toolbarToolsToggle.setAttribute('aria-expanded', String(settingsState.showToolbarTools));
  toolbarToolsToggle.title = settingsState.showToolbarTools ? 'Skryť nástroje' : 'Zobraziť nástroje';
  toolbarToolsToggle.setAttribute('aria-label', toolbarToolsToggle.title);
  toolbarToolsToggle.querySelector('use').setAttribute('href', settingsState.showToolbarTools ? '#icon-chevron-up' : '#icon-chevron-down');
  saveSettings();
});
document.getElementById('newTab').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openNewTab(); });
document.getElementById('reloadButton').addEventListener('click', () => { const viewer = ensureActiveTabLoaded(); if (isNativeTabs) window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: 'reload' }); else if (viewer) viewer.reload(); else if (tabs.get(activeTabId)?.url === 'linsoft://start') startPage(); });
document.getElementById('backButton').addEventListener('click', () => navigateTabHistory(-1));
document.getElementById('forwardButton').addEventListener('click', () => navigateTabHistory(1));
document.getElementById('bookmarkButton').addEventListener('click', (event) => { const url = addressInput.value; if (!url || url.startsWith('linsoft://')) return showToast('Na domovskú stránku sa záložka nepridáva.'); if (!savedBookmarks.some((item) => item.url === url)) { savedBookmarks.push({ url, title: tabTitle.textContent }); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); } event.currentTarget.querySelector('use').setAttribute('href', '#icon-bookmark-check'); event.currentTarget.classList.add('active'); event.currentTarget.setAttribute('aria-label', 'Záložka uložená'); showToast('Záložka uložená.'); });
const adBlockButton = document.getElementById('adBlockButton');
const updateAdBlockButton = () => { adBlockButton.classList.toggle('active', settingsState.adBlock); adBlockButton.querySelector('use').setAttribute('href', settingsState.adBlock ? '#icon-shield-check' : '#icon-shield-off'); adBlockButton.title = settingsState.adBlock ? 'AdBlock zapnutý' : 'AdBlock vypnutý'; adBlockButton.setAttribute('aria-label', adBlockButton.title); };
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
const pageSourceDialog = document.getElementById('pageSourceDialog');
const pageSourceCode = document.getElementById('pageSourceCode');
let currentPageSource = '';
function closePageSourcePreview() { pageSourceDialog.hidden = true; }
async function showPageSourcePreview() {
  const result = await window.linsoftBrowser?.getPageSource?.();
  if (!result?.ok) return showToast(result?.message || 'HTML kód stránky sa nepodarilo načítať.');
  currentPageSource = String(result.source || '');
  document.getElementById('pageSourceAddress').textContent = result.url || addressInput.value;
  pageSourceCode.textContent = currentPageSource || '(Stránka neobsahuje HTML kód.)';
  pageSourceDialog.hidden = false;
  pageSourceCode.focus();
}
document.getElementById('closePageSource').addEventListener('click', closePageSourcePreview);
document.getElementById('copyPageSource').addEventListener('click', async () => {
  const result = await window.linsoftBrowser?.writeClipboardText?.(currentPageSource);
  showToast(result?.ok ? 'HTML kód bol skopírovaný.' : (result?.message || 'HTML kód sa nepodarilo skopírovať.'));
});
pageSourceDialog.addEventListener('click', (event) => { if (event.target === pageSourceDialog) closePageSourcePreview(); });
const closeContextMenus = () => {
  document.querySelectorAll('.tab-context-menu, .webview-context-menu').forEach((menu) => {
    if (menu.closeContextMenu) menu.closeContextMenu();
    else menu.remove();
  });
};
let browserMenuDismissLayer = null;
const closeBrowserMenu = () => {
  browserMenu.hidden = true;
  browserMenuDismissLayer?.remove();
  browserMenuDismissLayer = null;
  closeContextMenus();
};
const closeTransientPanels = () => { closeBrowserMenu(); downloadPanel.hidden = true; securityPanel.hidden = true; };
browserMenu.setAttribute('role', 'menu');
browserMenu.insertAdjacentHTML('beforeend', '<div class="menu-divider"></div><button id="menuTranslatePage">文 <span>Preložiť stránku do slovenčiny</span></button>');
const menuButton = document.getElementById('menuButton');
menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!browserMenu.hidden) return closeBrowserMenu();
  browserMenu.hidden = false;
  browserMenuDismissLayer = document.createElement('div');
  browserMenuDismissLayer.className = 'browser-menu-dismiss-layer';
  browserMenuDismissLayer.addEventListener('pointerdown', closeBrowserMenu, { once: true });
  browserMenuDismissLayer.addEventListener('click', closeBrowserMenu, { once: true });
  document.body.appendChild(browserMenuDismissLayer);
  browserMenu.querySelector('button')?.focus();
});
document.addEventListener('pointerdown', (event) => {
  if (browserMenu.hidden || browserMenu.contains(event.target) || menuButton.contains(event.target)) return;
  closeBrowserMenu();
}, true);
document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (target.closest?.('#browserMenu, #downloadPanel, #securityPanel, #pageSourceDialog, .tab-context-menu, .webview-context-menu')) return;
  if (target.closest?.('#menuButton')) {
    downloadPanel.hidden = true;
    securityPanel.hidden = true;
    closeContextMenus();
    return;
  }
  closeTransientPanels();
}, true);
document.addEventListener('click', closeBrowserMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeTransientPanels(); closePageSourcePreview(); } });
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
const browserMenuIcons = { menuAppCenter: 'layout-grid', menuInstallApp: 'plus', menuNewTab: 'plus', menuGuestWindow: 'user-round', menuSearchTabs: 'search', menuBookmarks: 'bookmark', menuHistory: 'history', menuSettings: 'settings', menuDownloads: 'download', menuClearData: 'trash-2', menuAbout: 'info', menuTranslatePage: 'languages' };
Object.entries(browserMenuIcons).forEach(([id, iconName]) => {
  const button = document.getElementById(id);
  if (!button) return;
  const label = button.textContent.trim().replace(/^[^\p{L}\p{N}]+/u, '');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'menu-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${iconName}`);
  icon.append(use);
  button.replaceChildren(icon, document.createTextNode(label));
});
document.getElementById('menuNewTab').addEventListener('click', () => { closeBrowserMenu(); addTab(); }); document.getElementById('menuBookmarks').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://bookmarks'); }); document.getElementById('menuHistory').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://history'); }); document.getElementById('menuSettings').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://settings'); }); document.getElementById('menuDownloads').addEventListener('click', () => { closeBrowserMenu(); document.getElementById('downloadsButton').click(); }); document.getElementById('menuClearData').addEventListener('click', () => { closeBrowserMenu(); localStorage.clear(); showToast('Údaje prehliadania boli vymazané.'); }); document.getElementById('menuAbout').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://settings'); });
document.getElementById('menuTranslatePage').addEventListener('click', () => { closeBrowserMenu(); translateWebPage(); });
document.getElementById('menuInstallApp').addEventListener('click', () => { closeBrowserMenu(); installCurrentApp(); }); document.getElementById('menuAppCenter').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://apps'); });
document.getElementById('menuGuestWindow').addEventListener('click', () => { closeBrowserMenu(); window.linsoftBrowser?.openGuestWindow?.(); });
document.getElementById('menuSearchTabs').addEventListener('click', () => { closeBrowserMenu(); searchOpenTabs(); });
document.getElementById('toggleBookmarksBar').addEventListener('click', () => { settingsState.showBookmarksBar = !settingsState.showBookmarksBar; saveSettings(); updateBookmarksBar(); closeBrowserMenu(); });
document.getElementById('hideBookmarksBar').addEventListener('click', () => { settingsState.showBookmarksBar = false; saveSettings(); updateBookmarksBar(); });
document.querySelectorAll('[data-app-url]').forEach((button) => button.addEventListener('click', () => { closeBrowserMenu(); openNewTab(button.dataset.appUrl); }));
document.querySelectorAll('.managed-tab').forEach((button) => bindTabButton(button, Number(button.dataset.tabId))); renderSavedBookmarks(); updateBookmarksBar();
document.querySelector('.tabs-bar').addEventListener('auxclick', (event) => { const tab = event.target.closest('.managed-tab'); if (event.button === 1 && tab) closeTab(Number(tab.dataset.tabId)); });
document.querySelector('.tabs-bar').addEventListener('wheel', (event) => {
  if (!event.target.closest('.managed-tab')) return;
  const delta = event.deltaY || event.deltaX;
  const tabIds = [...document.querySelectorAll('.tabs-bar .managed-tab')].map((tab) => Number(tab.dataset.tabId));
  const currentIndex = tabIds.indexOf(activeTabId);
  if (!delta || tabIds.length < 2 || currentIndex < 0) return;
  event.preventDefault();
  const direction = delta > 0 ? 1 : -1;
  selectTab(tabIds[(currentIndex + direction + tabIds.length) % tabIds.length]);
}, { passive: false });
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

function formatDownloadBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDownloadDuration(seconds) {
  const duration = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (duration < 60) return `${duration} s`;
  const minutes = Math.ceil(duration / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
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
    const size = item.total ? `${formatDownloadBytes(item.received)} / ${formatDownloadBytes(item.total)}` : '';
    const elapsedSeconds = item.startedAt ? Math.max(1, (Date.now() - item.startedAt) / 1000) : 0;
    const bytesPerSecond = item.received && elapsedSeconds ? item.received / elapsedSeconds : 0;
    const speed = bytesPerSecond ? `${formatDownloadBytes(bytesPerSecond)}/s` : '';
    const isInProgress = item.active === true && (item.status === 'Sťahuje sa' || item.status === 'Sťahovanie začalo' || item.status === 'Pripravuje sa' || item.status === 'Pozastavené');
    const isPaused = item.status === 'Pozastavené';
    const remaining = isInProgress && !isPaused && item.total > item.received && bytesPerSecond ? `Zostáva približne ${formatDownloadDuration((item.total - item.received) / bytesPerSecond)}` : '';
    const completedAt = item.status === 'Stiahnuté' && item.completedAt ? `Dokončené ${new Date(item.completedAt).toLocaleString()}` : '';
    const effectiveId = String(item.id || item.fileName || 'download');
    const percent = Math.max(0, Math.min(100, Number(item.percent) || 0));

    const progressAction = isPaused ? `<button data-resume-download="${escapeHtml(effectiveId)}">Pokračovať</button>` : `<button data-pause-download="${escapeHtml(effectiveId)}">Pozastaviť</button>`;
    const destination = item.filePath ? `<small title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath)}</small>` : '';
    const retryAction = !isInProgress && item.status !== 'Stiahnuté' && /^https?:\/\//i.test(item.sourceUrl || '') ? `<button data-retry-download="${escapeHtml(effectiveId)}">Stiahnuť znova</button>` : '';
    return `<div class="download-item" data-download-id="${escapeHtml(effectiveId)}"><span class="download-file-icon">${item.status === 'Stiahnuté' ? '✓' : isPaused ? 'Ⅱ' : '↓'}</span><div class="download-item-body"><strong>${escapeHtml(item.fileName)}</strong><span>${escapeHtml(item.status)}${size ? ` · ${size}` : ''}${speed && !isPaused ? ` · ${speed}` : ''}</span>${remaining ? `<small>${remaining}</small>` : ''}${completedAt ? `<small>${escapeHtml(completedAt)}</small>` : ''}${destination}<div class="download-item-progress"><i style="width:${percent}%"></i></div><div class="download-item-actions">${item.status === 'Stiahnuté' ? `<button data-open-download="${escapeHtml(item.filePath || '')}">Otvoriť</button><button data-show-download="${escapeHtml(item.filePath || '')}">Zobraziť v priečinku</button>` : isInProgress ? `${progressAction}<button data-cancel-download="${escapeHtml(effectiveId)}">Zrušiť</button>` : retryAction}<button data-remove-download="${escapeHtml(effectiveId)}">Odstrániť</button></div></div><span class="download-item-percent">${percent}%</span></div>`;
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
window.linsoftBrowser?.onTranslatePage?.(translateWebPage);
window.addEventListener('storage', (event) => {
  if (event.key !== 'linsoft-apps') return;
  try {
    const storedApps = JSON.parse(event.newValue || '[]');
    installedApps = Array.isArray(storedApps) ? storedApps.map(normalizeInstalledApp).filter(Boolean) : [];
    if (addressInput.value === 'linsoft://apps') openAppCenter();
  } catch {}
});
window.linsoftBrowser?.onNativeTabEvent?.((event) => {
  if (!isNativeTabs) return;
  const tab = tabs.get(event.tabId);
  if (!tab) return;
  if (event.type === 'loading') {
    if (event.loading) beginPageLoadMeasurement(event.tabId, tab.url);
    else finishPageLoadMeasurement(event.tabId);
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
    const failedUrl = event.validatedURL || tab.url;
    const fallbackUrl = httpFallbackForTlsError(event.errorCode, failedUrl) || httpsFallbackForIpConnectionRefused(event.errorCode, failedUrl);
    if (fallbackUrl) {
      replaceFailedUrlInTabHistory(tab, failedUrl, fallbackUrl);
      saveSession();
      if (event.tabId === activeTabId) {
        addressInput.value = fallbackUrl;
        updateConnectionIndicator(fallbackUrl);
        showToast(fallbackUrl.startsWith('https:') ? 'HTTP pripojenie odmietnuté; skúšam HTTPS.' : [-200, -201, -202].includes(Number(event.errorCode)) ? 'Certifikát súkromnej IP adresy nie je dôveryhodný; skúšam HTTP.' : 'Web nepodporuje HTTPS; otváram nezabezpečené HTTP pripojenie.');
      }
      window.linsoftBrowser?.loadNativeTab?.({ tabId: event.tabId, url: fallbackUrl });
      return;
    }
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
    applyTabZoom(event.tabId, event.url);
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
  closeContextMenus();
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
window.linsoftBrowser?.onOpenAppCenter(() => openNewTab('linsoft://apps'));
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
applyTheme();
updateAdBlockButton();
  window.linsoftBrowser?.setBrowserPreferences({ downloads: settingsState.downloads, downloadFolderPath: settingsState.downloadFolderPath || '', askDownload: settingsState.askDownload, adBlock: settingsState.adBlock, trackingProtection: settingsState.trackingProtection, camera: settingsState.camera, microphone: settingsState.microphone, webNotifications: settingsState.webNotifications, spellcheckLanguages: settingsState.spellcheckLanguages, clearExit: settingsState.clearExit, autoUpdateCheck: settingsState.autoUpdateCheck });
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
