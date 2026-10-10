const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isSafeWebUrl } = require('./browser-policies.cjs');

function googleAccountUrl(value) {
  if (!isSafeWebUrl(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.port ? url : null;
}

function isBlockedGoogleSignIn(value) {
  const url = googleAccountUrl(value);
  return Boolean(url && (url.pathname.split('/').includes('deniedsigninrejected') ||
    ['disallowed_useragent', 'restricted_useragent'].includes(url.searchParams.get('error'))));
}

function websiteOrigin(value) {
  if (!isSafeWebUrl(value) || googleAccountUrl(value)) return '';
  return new URL(value).origin;
}

function createGoogleSignInRecovery({ onBlocked, onError }) {
  const popupOrigins = new Map();
  return {
    rememberPopup(url, sourceUrl) {
      const origin = websiteOrigin(sourceUrl);
      if (!googleAccountUrl(url) || !origin) return;
      popupOrigins.set(url, origin);
      if (popupOrigins.size > 32) popupOrigins.delete(popupOrigins.keys().next().value);
    },
    watch(contents) {
      let sourceOrigin = websiteOrigin(contents.getURL());
      let notified = false;
      const observe = (url) => {
        const origin = websiteOrigin(url);
        if (origin) { sourceOrigin = origin; notified = false; }
        if (popupOrigins.has(url)) {
          sourceOrigin = popupOrigins.get(url);
          popupOrigins.delete(url);
        }
        if (!isBlockedGoogleSignIn(url) || notified || contents.isDestroyed()) return;
        notified = true;
        Promise.resolve().then(() => onBlocked(contents, sourceOrigin || 'https://accounts.google.com/')).catch(onError);
      };
      contents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => { if (isMainFrame) observe(url); });
      contents.on('did-navigate', (_event, url) => observe(url));
      contents.on('did-redirect-navigation', (_event, url, _inPlace, isMainFrame) => { if (isMainFrame) observe(url); });
    }
  };
}

function findSignInBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  let candidates = [];
  if (platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean))];
    for (const [name, relativePath] of [
      ['Microsoft Edge', ['Microsoft', 'Edge', 'Application', 'msedge.exe']],
      ['Google Chrome', ['Google', 'Chrome', 'Application', 'chrome.exe']]
    ]) {
      for (const root of roots) candidates.push({ name, executable: path.win32.join(root, ...relativePath) });
    }
  } else if (platform === 'linux') {
    candidates = [
      { name: 'Google Chrome', executable: '/usr/bin/google-chrome' },
      { name: 'Firefox', executable: '/usr/bin/firefox' },
      { name: 'Microsoft Edge', executable: '/usr/bin/microsoft-edge' }
    ];
  }
  return candidates.find((candidate) => exists(candidate.executable)) || null;
}

function openSignInWebsite(browser, url, spawnProcess = spawn) {
  if (!browser || !isSafeWebUrl(url)) return Promise.reject(new Error('Invalid sign-in browser or website'));
  const safeOrigin = new URL(url).origin;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(browser.executable, [safeOrigin], { shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', resolve);
  });
}

module.exports = { createGoogleSignInRecovery, findSignInBrowser, isBlockedGoogleSignIn, openSignInWebsite };
