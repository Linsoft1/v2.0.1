const storageKey = 'linsoft-apps';
const grid = document.getElementById('appGrid');
const emptyState = document.getElementById('emptyState');
const count = document.getElementById('appCount');
const dialog = document.getElementById('dialog');
const form = document.getElementById('appForm');
const nameInput = document.getElementById('nameInput');
const urlInput = document.getElementById('urlInput');
let apps = [];
try { apps = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { apps = []; }
const faviconCache = new Map();
const catalog = [
  ['Google', 'https://www.google.com', 'work'], ['Gmail', 'https://mail.google.com', 'work'], ['Google Drive', 'https://drive.google.com', 'work'], ['Google Calendar', 'https://calendar.google.com', 'work'],
  ['Microsoft 365', 'https://www.office.com', 'work'], ['Outlook', 'https://outlook.live.com', 'work'], ['GitHub', 'https://github.com', 'work'], ['Slack', 'https://app.slack.com', 'social'],
  ['Discord', 'https://discord.com/app', 'social'], ['Zoom', 'https://app.zoom.us', 'social'], ['Notion', 'https://www.notion.so', 'work'], ['Trello', 'https://trello.com', 'work'],
  ['Figma', 'https://www.figma.com', 'creative'], ['Canva', 'https://www.canva.com', 'creative'], ['Adobe Express', 'https://express.adobe.com', 'creative'], ['YouTube', 'https://www.youtube.com', 'media'],
  ['Spotify', 'https://open.spotify.com', 'media'], ['Netflix', 'https://www.netflix.com', 'media'], ['Twitch', 'https://www.twitch.tv', 'media'], ['Reddit', 'https://www.reddit.com', 'social'],
  ['Chess.com', 'https://www.chess.com', 'games'], ['Lichess', 'https://lichess.org', 'games'], ['Poki', 'https://poki.com', 'games'], ['CrazyGames', 'https://www.crazygames.com', 'games'],
  ['Miniclip', 'https://www.miniclip.com', 'games'], ['skribbl.io', 'https://skribbl.io', 'games'], ['Agar.io', 'https://agar.io', 'games'], ['Slither.io', 'https://slither.io', 'games'],
  ['GeoGuessr', 'https://www.geoguessr.com', 'games'], ['itch.io', 'https://itch.io', 'games'], ['Board Game Arena', 'https://boardgamearena.com', 'games'], ['Kahoot!', 'https://kahoot.it', 'games']
];
let activeCategory = 'all';

function escapeHtml(value) { return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]); }
function save() { localStorage.setItem(storageKey, JSON.stringify(apps)); }
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
  grid.innerHTML = apps.map((app, index) => { const icon = faviconFor(app.url); return `<article class="app-card"><div class="app-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${escapeHtml((app.name || app.url).slice(0, 1).toUpperCase())}</span>` : escapeHtml((app.name || app.url).slice(0, 1).toUpperCase())}</div><div class="app-info"><strong>${escapeHtml(app.name)}</strong><small>${escapeHtml(app.url)}</small></div><div class="card-actions"><button data-open="${index}" type="button">Otvoriť aplikáciu</button><button class="remove" data-remove="${index}" type="button">Odinštalovať</button></div></article>`; }).join('');
  grid.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => { const app = apps[Number(button.dataset.open)]; app.lastOpenedAt = Date.now(); save(); window.open(app.url, '_blank', 'noopener'); }));
  grid.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { const app = apps[Number(button.dataset.remove)]; if (!window.confirm(`Odinštalovať ${app.name}?`)) return; apps.splice(Number(button.dataset.remove), 1); save(); render(); showStatus(`${app.name} sa odstraňuje z Linsoft Browsera...`, 'success'); window.location.href = `linsoft://uninstall?name=${encodeURIComponent(app.name)}&url=${encodeURIComponent(app.url)}`; }));
}
function renderCatalog() {
  const query = document.getElementById('catalogSearch').value.trim().toLowerCase();
  const items = catalog.filter(([name, url, category]) => (activeCategory === 'all' || category === activeCategory) && (!query || `${name} ${url}`.toLowerCase().includes(query)));
  document.getElementById('catalogGrid').innerHTML = items.map(([name, url, category]) => { const installed = apps.some((app) => app.url === url); return `<article class="catalog-card"><div class="catalog-icon">${escapeHtml(name.slice(0, 1))}</div><div class="catalog-info"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(url.replace(/^https?:\/\//, '').split('/')[0])}</small></div><span class="compatibility">Chrome · Firefox</span><button class="catalog-install ${installed ? 'installed' : ''}" data-catalog-url="${escapeHtml(url)}" data-catalog-name="${escapeHtml(name)}" type="button">${installed ? 'Pridané' : 'Nainštalovať'}</button></article>`; }).join('') || '<div class="catalog-empty">Aplikácia sa nenašla.</div>';
  document.querySelectorAll('[data-catalog-url]').forEach((button) => button.addEventListener('click', () => { const url = normalizeUrl(button.dataset.catalogUrl); const name = button.dataset.catalogName; if (apps.some((app) => app.url === url)) return showStatus(`${name} už je v tvojich aplikáciách.`, 'info'); apps.push({ name, url, installedAt: Date.now() }); save(); render(); renderCatalog(); showStatus(`${name} sa odosiela do Linsoft Browsera...`, 'success'); window.location.href = `linsoft://install?name=${encodeURIComponent(name)}&url=${encodeURIComponent(url)}`; }));
}

document.getElementById('exportButton').addEventListener('click', () => { const blob = new Blob([JSON.stringify(apps, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'linsoft-apps.json'; link.click(); URL.revokeObjectURL(link.href); showStatus('Zoznam aplikácií bol exportovaný.', 'success'); });
document.getElementById('importButton').addEventListener('click', () => document.getElementById('importInput').click());
document.getElementById('importInput').addEventListener('change', async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const imported = JSON.parse(await file.text()); if (!Array.isArray(imported)) throw new Error('Neplatný formát'); const valid = imported.filter((item) => item && typeof item.name === 'string' && normalizeUrl(item.url)).map((item) => ({ name: item.name.slice(0, 60), url: normalizeUrl(item.url), installedAt: Number(item.installedAt) || Date.now(), ...(item.lastOpenedAt ? { lastOpenedAt: Number(item.lastOpenedAt) } : {}) })); apps = [...apps, ...valid.filter((item) => !apps.some((current) => current.url === item.url))]; save(); render(); renderCatalog(); showStatus(`Importovaných aplikácií: ${valid.length}.`, 'success'); } catch { showStatus('Importovaný súbor nemá platný formát.', 'error'); } finally { event.target.value = ''; } });

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
form.addEventListener('submit', (event) => { event.preventDefault(); const url = normalizeUrl(urlInput.value); if (!url) return showStatus('Zadaj platnú webovú adresu začínajúcu na http:// alebo https://.', 'error'); const name = nameInput.value.trim() || new URL(url).hostname; const existing = apps.find((app) => app.url === url); if (existing) { closeDialog(); return showStatus(`${name} už je v tvojich aplikáciách.`, 'info'); } apps.push({ name, url, installedAt: Date.now() }); save(); render(); closeDialog(); showStatus(`${name} bola pridaná.`, 'success'); });
render();
renderCatalog();
if (localStorage.getItem('linsoft-theme') === 'light') { document.body.classList.add('light-theme'); document.getElementById('themeButton').textContent = 'Tmavý vzhľad'; }
