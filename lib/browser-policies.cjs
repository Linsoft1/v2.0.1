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
  return isPackaged === true && platform === 'win32' && enabled !== false && !['downloading', 'downloaded'].includes(status);
}

module.exports = {
  canAutoCheckForUpdates,
  formatUpdateFailure,
  getPermissionDecision,
  getUpdateStatus,
  isSafeLocalDocumentUrl,
  isSafeLocalHtmlUrl,
  isSafeLocalPdfUrl,
  isSafeWebUrl,
  normalizePermissionOrigin
};