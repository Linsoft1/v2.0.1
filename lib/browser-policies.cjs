const fs = require('node:fs');
const { fileURLToPath } = require('node:url');

function getUpdateStatus(currentVersion, updateInfo) {
  const version = typeof updateInfo?.version === 'string' ? updateInfo.version.trim() : '';
  if (!version || version === currentVersion) return { status: 'latest', version: currentVersion };
  return { status: 'available', version };
}

function formatUpdateFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/Unable to find latest version on GitHub|ensure a production release exists|releases\/latest/i.test(detail)) {
    return { ok: false, status: 'unavailable', message: 'Zatiaľ nie je zverejnené stabilné vydanie aktualizácie. Skús to znova neskôr.' };
  }
  if (detail.length > 220) return { ok: false, status: 'error', message: 'Kontrola aktualizácií zlyhala. Skús to znova neskôr.' };
  return { ok: false, status: 'error', message: detail };
}

function normalizePermissionOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function linsoftSearchQueryFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.origin !== 'https://linsoft.ddns.net' || url.pathname !== '/linsoft-search/' || url.username || url.password) return '';
    return url.searchParams.get('q')?.trim() || '';
  } catch {
    return '';
  }
}

function linsoftSearchInitializationScript(value) {
  const query = linsoftSearchQueryFromUrl(value);
  if (!query) throw new Error('Invalid Linsoft Search query URL');
  return `(async () => {
    const query = ${JSON.stringify(query)};
    const isSearchPage = () => {
      try {
        const current = new URL(location.href);
        return current.origin === 'https://linsoft.ddns.net' && current.pathname === '/linsoft-search/'
          && current.searchParams.get('q')?.trim() === query;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 10000;
    const isVisible = element => Boolean(element && !element.hidden && !element.classList?.contains('hidden') && element.getAttribute?.('aria-hidden') !== 'true');
    const verifyResults = () => {
      const error = document.getElementById('search-error');
      if (isVisible(error)) throw new Error(error.querySelector?.('#search-error-message')?.textContent?.trim() || 'Linsoft Search nahlásil chybu.');
      if (isVisible(document.getElementById('no-results'))) throw new Error('Linsoft Search nenašiel žiadne výsledky.');
      const results = document.getElementById('results-container') || document.getElementById('results-content');
      if (!results || !results.children?.length || !String(results.textContent || results.innerText || '').trim()) {
        throw new Error('Linsoft Search nezobrazil žiadne výsledky.');
      }
    };
    let submitted = false;
    while (Date.now() < deadline) {
      if (!isSearchPage()) return false;
      const home = document.getElementById('home-view');
      const results = document.getElementById('results-input') || document.getElementById('results-search-input');
      if (home?.classList.contains('hidden') && results?.value === query) break;
      const input = document.getElementById('search-input');
      if (!submitted && input) {
        if (typeof doSearch === 'function') {
          submitted = true;
          input.value = query;
          await doSearch(query);
          break;
        } else if (input.form && typeof input.form.requestSubmit === 'function') {
          submitted = true;
          input.value = query;
          input.form.requestSubmit();
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!submitted && Date.now() >= deadline && !(document.getElementById('home-view')?.classList.contains('hidden')
      && (document.getElementById('results-input') || document.getElementById('results-search-input'))?.value === query)) {
      throw new Error('Linsoft Search did not accept the query within 10 seconds.');
    }
    const resultsDeadline = Date.now() + 25000;
    while (Date.now() < resultsDeadline) {
      if (!isSearchPage()) return false;
      const results = document.getElementById('results-container') || document.getElementById('results-content');
      const loading = document.getElementById('loading');
      if (!isVisible(loading) && results?.getAttribute?.('aria-busy') !== 'true') {
        verifyResults();
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Linsoft Search nedokončil načítanie výsledkov včas.');
  })()`;
}

function isSafeWebUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isSafeLocalHtmlUrl(value) {
  const filePath = localFilePath(value);
  return isExistingLocalFileWithExtension(filePath, /\.html?$/i);
}

function isSafeLocalPdfUrl(value) {
  const filePath = localFilePath(value);
  return isExistingLocalFileWithExtension(filePath, /\.pdf$/i);
}

function isSafeLocalDocumentUrl(value) {
  return isSafeLocalHtmlUrl(value) || isSafeLocalPdfUrl(value);
}

function localFilePath(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'file:') return false;
    return fileURLToPath(url);
  } catch {
    return '';
  }
}

function isExistingLocalFileWithExtension(filePath, extension) {
  try { return Boolean(filePath && extension.test(filePath) && fs.statSync(filePath).isFile()); }
  catch { return false; }
}

function permissionTypesForRequest(permission, mediaTypes = []) {
  if (permission === 'notifications') return ['webNotifications'];
  if (permission !== 'media' || !Array.isArray(mediaTypes) || mediaTypes.length === 0) return null;

  const preferenceByMediaType = { audio: 'microphone', video: 'camera' };
  const preferences = [...new Set(mediaTypes.map((type) => preferenceByMediaType[type]))];
  return preferences.every(Boolean) ? preferences : null;
}

function getPermissionDecision({ permission, mediaTypes, requestingUrl, preferences, decisions }) {
  const origin = normalizePermissionOrigin(requestingUrl);
  const preferenceKeys = permissionTypesForRequest(permission, mediaTypes);
  if (!origin || !preferenceKeys || preferenceKeys.some((key) => preferences?.[key] !== true)) {
    return { decision: 'deny', origin, preferenceKeys: preferenceKeys || [] };
  }

  const key = `${origin}|${permission === 'media' ? [...mediaTypes].sort().join(',') : permission}`;
  const remembered = decisions?.[key];
  if (remembered === 'allow' || remembered === 'deny') return { decision: remembered, origin, preferenceKeys, key };
  return { decision: 'prompt', origin, preferenceKeys, key };
}

function canAutoCheckForUpdates({ isPackaged, platform, enabled, status }) {
  return isPackaged === true && ['win32', 'linux'].includes(platform) && enabled !== false && !['downloading', 'downloaded'].includes(status);
}

function getStorageTypesToClearOnExit() {
  return ['cookies', 'shadercache'];
}

module.exports = {
  canAutoCheckForUpdates,
  formatUpdateFailure,
  getPermissionDecision,
  linsoftSearchQueryFromUrl,
  linsoftSearchInitializationScript,
  getStorageTypesToClearOnExit,
  getUpdateStatus,
  isSafeLocalDocumentUrl,
  isSafeLocalHtmlUrl,
  isSafeLocalPdfUrl,
  isSafeWebUrl,
  normalizePermissionOrigin
};