const storageKey = 'linsoft-apps';
const grid = document.getElementById('appGrid');
const emptyState = document.getElementById('emptyState');
const count = document.getElementById('appCount');
const dialog = document.getElementById('dialog');
const form = document.getElementById('appForm');
const nameInput = document.getElementById('nameInput');
const urlInput = document.getElementById('urlInput');
let apps = [];
try {
  const storedApps = JSON.parse(localStorage.getItem(storageKey) || '[]');
  apps = Array.isArray(storedApps) ? storedApps.map((app, index) => {
    const url = normalizeUrl(String(app?.url || ''));
    if (!url) return null;
    return { ...app, name: String(app.name || app.title || new URL(url).hostname).slice(0, 60), url, favorite: app.favorite === true, sortOrder: Number.isFinite(Number(app.sortOrder)) ? Number(app.sortOrder) : index };
  }).filter(Boolean) : [];
} catch { apps = []; }
const faviconCache = new Map();
const catalog = [
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
let activeCategory = 'all';
let appSortMode = ['manual', 'name', 'recent'].includes(localStorage.getItem('linsoft-app-center-sort')) ? localStorage.getItem('linsoft-app-center-sort') : 'manual';
const appSortSelect = document.createElement('select');
appSortSelect.id = 'appSortSelect';
appSortSelect.className = 'app-sort-select';
appSortSelect.setAttribute('aria-label', 'Zoradiť aplikácie');
appSortSelect.innerHTML = '<option value="manual">Moje poradie</option><option value="name">Podľa názvu</option><option value="recent">Nedávno použité</option>';
document.querySelector('.workspace-actions').insertAdjacentElement('afterbegin', appSortSelect);
appSortSelect.value = appSortMode;
appSortSelect.addEventListener('change', () => { appSortMode = appSortSelect.value; localStorage.setItem('linsoft-app-center-sort', appSortMode); render(); });

function escapeHtml(value) { return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]); }
function save() { localStorage.setItem(storageKey, JSON.stringify(apps)); }
function normalizeStoredApp(item, index = 0) {
  const url = normalizeUrl(String(item?.url || ''));
  if (!url) return null;
  return { ...item, name: String(item.name || item.title || new URL(url).hostname).slice(0, 60), url, favorite: item.favorite === true, sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index };
}
function nextAppSortOrder() { return apps.reduce((lowest, app) => Math.min(lowest, Number(app.sortOrder) || 0), 0) - 1; }
function sortedApps() {
  return apps.map((app, index) => ({ app, index })).sort((left, right) => {
    if (Boolean(left.app.favorite) !== Boolean(right.app.favorite)) return Number(right.app.favorite) - Number(left.app.favorite);
    if (appSortMode === 'name') return left.app.name.localeCompare(right.app.name, 'sk');
    if (appSortMode === 'recent') return (Number(right.app.lastOpenedAt) || 0) - (Number(left.app.lastOpenedAt) || 0) || left.app.name.localeCompare(right.app.name, 'sk');
    const leftOrder = Number.isFinite(Number(left.app.sortOrder)) ? Number(left.app.sortOrder) : left.index;
    const rightOrder = Number.isFinite(Number(right.app.sortOrder)) ? Number(right.app.sortOrder) : right.index;
    return leftOrder - rightOrder || left.index - right.index;
  });
}
function faviconFor(url) { if (faviconCache.has(url)) return faviconCache.get(url); try { const icon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=64`; faviconCache.set(url, icon); return icon; } catch { faviconCache.set(url, ''); return ''; } }
function normalizeUrl(value) {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '';
    return url.href;
  } catch { return ''; }
}
function showStatus(message, type = 'info') { const status = document.getElementById('catalogStatus'); status.textContent = message; status.dataset.type = type; }
function openDialog() { dialog.hidden = false; nameInput.focus(); }
function closeDialog() { dialog.hidden = true; form.reset(); }
function render() {
  count.textContent = apps.length;
  emptyState.hidden = apps.length > 0;
  grid.innerHTML = sortedApps().map(({ app, index }) => { const icon = faviconFor(app.url); return `<article class="app-card"><div class="app-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${escapeHtml((app.name || app.url).slice(0, 1).toUpperCase())}</span>` : escapeHtml((app.name || app.url).slice(0, 1).toUpperCase())}</div><div class="app-info"><strong>${escapeHtml(app.name)}</strong><small>${escapeHtml(app.url)}</small></div><div class="card-actions"><button class="app-favorite ${app.favorite ? 'active' : ''}" data-favorite="${escapeHtml(app.url)}" type="button" title="${app.favorite ? 'Odopnúť obľúbenú aplikáciu' : 'Pripnúť medzi obľúbené'}" aria-label="${app.favorite ? 'Odopnúť obľúbenú aplikáciu' : 'Pripnúť medzi obľúbené'}">${app.favorite ? '★' : '☆'}</button>${appSortMode === 'manual' ? `<span class="app-order-controls"><button data-move-app="${escapeHtml(app.url)}" data-direction="-1" type="button" title="Posunúť vyššie" aria-label="Posunúť ${escapeHtml(app.name)} vyššie">↑</button><button data-move-app="${escapeHtml(app.url)}" data-direction="1" type="button" title="Posunúť nižšie" aria-label="Posunúť ${escapeHtml(app.name)} nižšie">↓</button></span>` : ''}<button data-open="${index}" type="button">Otvoriť aplikáciu</button><button class="remove" data-remove="${index}" type="button">Odstrániť</button></div></article>`; }).join('');
  grid.querySelectorAll('[data-favorite]').forEach((button) => button.addEventListener('click', () => { const app = apps.find((item) => item.url === button.dataset.favorite); if (!app) return; app.favorite = !app.favorite; save(); render(); }));
  grid.querySelectorAll('[data-move-app]').forEach((button) => button.addEventListener('click', () => {
    const ordered = sortedApps().map(({ app }) => app);
    const index = ordered.findIndex((app) => app.url === button.dataset.moveApp);
    const nextIndex = index + Number(button.dataset.direction);
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length || ordered[index].favorite !== ordered[nextIndex].favorite) return;
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    ordered.forEach((app, order) => { app.sortOrder = order; });
    save();
    render();
  }));
  grid.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => { const app = apps[Number(button.dataset.open)]; app.lastOpenedAt = Date.now(); save(); window.open(app.url, '_blank', 'noopener'); }));
  grid.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { const app = apps[Number(button.dataset.remove)]; if (!window.confirm(`Odinštalovať ${app.name}?`)) return; apps.splice(Number(button.dataset.remove), 1); save(); render(); showStatus(`${app.name} sa odstraňuje z Linsoft Browsera...`, 'success'); window.location.href = `linsoft://uninstall?name=${encodeURIComponent(app.name)}&url=${encodeURIComponent(app.url)}`; }));
}
function renderCatalog() {
  const query = document.getElementById('catalogSearch').value.trim().toLowerCase();
  const items = catalog.filter(([name, url, category]) => (activeCategory === 'all' || category === activeCategory) && (!query || `${name} ${url}`.toLowerCase().includes(query)));
  document.getElementById('catalogGrid').innerHTML = items.map(([name, url, category]) => { const installed = apps.some((app) => app.url === url); return `<article class="catalog-card"><div class="catalog-icon">${escapeHtml(name.slice(0, 1))}</div><div class="catalog-info"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(url.replace(/^https?:\/\//, '').split('/')[0])}</small></div><span class="compatibility">Chrome · Firefox</span><button class="catalog-install ${installed ? 'installed' : ''}" data-catalog-url="${escapeHtml(url)}" data-catalog-name="${escapeHtml(name)}" type="button">${installed ? 'Pridané' : 'Nainštalovať'}</button></article>`; }).join('') || '<div class="catalog-empty">Aplikácia sa nenašla.</div>';
  document.querySelectorAll('[data-catalog-url]').forEach((button) => button.addEventListener('click', () => { const url = normalizeUrl(button.dataset.catalogUrl); const name = button.dataset.catalogName; if (apps.some((app) => app.url === url)) return showStatus(`${name} už je v tvojich aplikáciách.`, 'info'); apps.push({ name, url, installedAt: Date.now(), favorite: false, sortOrder: nextAppSortOrder() }); save(); render(); renderCatalog(); showStatus(`${name} sa odosiela do Linsoft Browsera...`, 'success'); window.location.href = `linsoft://install?name=${encodeURIComponent(name)}&url=${encodeURIComponent(url)}`; }));
}

document.getElementById('exportButton').addEventListener('click', () => { const blob = new Blob([JSON.stringify(apps, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'linsoft-apps.json'; link.click(); URL.revokeObjectURL(link.href); showStatus('Zoznam aplikácií bol exportovaný.', 'success'); });
document.getElementById('importButton').addEventListener('click', () => document.getElementById('importInput').click());
document.getElementById('importInput').addEventListener('change', async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const imported = JSON.parse(await file.text()); if (!Array.isArray(imported)) throw new Error('Neplatný formát'); const valid = imported.filter((item) => item && typeof (item.name || item.title) === 'string' && normalizeUrl(item.url)).map((item, index) => ({ name: String(item.name || item.title).slice(0, 60), url: normalizeUrl(item.url), installedAt: Number(item.installedAt) || Date.now(), favorite: item.favorite === true, sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : apps.length + index, ...(item.lastOpenedAt ? { lastOpenedAt: Number(item.lastOpenedAt) } : {}) })); apps = [...apps, ...valid.filter((item) => !apps.some((current) => current.url === item.url))]; save(); render(); renderCatalog(); showStatus(`Importovaných aplikácií: ${valid.length}.`, 'success'); } catch { showStatus('Importovaný súbor nemá platný formát.', 'error'); } finally { event.target.value = ''; } });

document.getElementById('addButton').addEventListener('click', openDialog);
document.getElementById('emptyAddButton').addEventListener('click', openDialog);
document.getElementById('refreshButton').addEventListener('click', () => { render(); renderCatalog(); });
document.getElementById('themeButton').addEventListener('click', () => { document.body.classList.toggle('light-theme'); const light = document.body.classList.contains('light-theme'); localStorage.setItem('linsoft-theme', light ? 'light' : 'dark'); document.getElementById('themeButton').textContent = light ? 'Tmavý vzhľad' : 'Svetlý vzhľad'; });
let searchTimer;
document.getElementById('catalogSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderCatalog, 120); });
document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => { activeCategory = button.dataset.category; document.querySelectorAll('[data-category]').forEach((item) => item.classList.toggle('active', item === button)); renderCatalog(); }));
document.getElementById('closeDialog').addEventListener('click', closeDialog);
document.getElementById('cancelButton').addEventListener('click', closeDialog);
dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !dialog.hidden) closeDialog(); });
form.addEventListener('submit', (event) => { event.preventDefault(); const url = normalizeUrl(urlInput.value); if (!url) return showStatus('Zadaj platnú webovú adresu začínajúcu na http:// alebo https://.', 'error'); const name = nameInput.value.trim() || new URL(url).hostname; const existing = apps.find((app) => app.url === url); if (existing) { closeDialog(); return showStatus(`${name} už je v tvojich aplikáciách.`, 'info'); } apps.push({ name, url, installedAt: Date.now(), favorite: false, sortOrder: nextAppSortOrder() }); save(); render(); closeDialog(); showStatus(`${name} bola pridaná.`, 'success'); });
window.addEventListener('storage', (event) => {
  if (event.key !== storageKey) return;
  try {
    const storedApps = JSON.parse(event.newValue || '[]');
    apps = Array.isArray(storedApps) ? storedApps.map(normalizeStoredApp).filter(Boolean) : [];
    render();
    renderCatalog();
  } catch { showStatus('Zdieľané aplikácie sa nepodarilo načítať.', 'error'); }
});
render();
renderCatalog();
if (localStorage.getItem('linsoft-theme') === 'light') { document.body.classList.add('light-theme'); document.getElementById('themeButton').textContent = 'Tmavý vzhľad'; }
