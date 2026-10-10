const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createGoogleSignInRecovery, findSignInBrowser, isBlockedGoogleSignIn, openSignInWebsite } = require('../lib/google-signin.cjs');

class FakeContents extends EventEmitter {
  constructor(url = '') { super(); this.url = url; this.destroyed = false; }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
}

const rejectedUrl = 'https://accounts.google.com/v3/signin/deniedsigninrejected';
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('Google rejection detection requires the exact secure account origin', () => {
  for (const url of [
    rejectedUrl,
    'https://accounts.google.com/signin/v2/deniedsigninrejected',
    'https://accounts.google.com/o/oauth2/auth?error=disallowed_useragent',
    'https://accounts.google.com/o/oauth2/auth?error=restricted_useragent'
  ]) assert.equal(isBlockedGoogleSignIn(url), true, url);
  for (const url of [
    'https://accounts.google.com/v3/signin/identifier',
    'https://accounts.google.com/o/oauth2/auth?error=access_denied',
    'https://accounts.google.com.evil.example/v3/signin/deniedsigninrejected',
    'https://example.com/?next=' + encodeURIComponent(rejectedUrl),
    'http://accounts.google.com/v3/signin/deniedsigninrejected',
    'https://user@accounts.google.com/v3/signin/deniedsigninrejected',
    'https://accounts.google.com:8443/v3/signin/deniedsigninrejected',
    'javascript:alert(1)'
  ]) assert.equal(isBlockedGoogleSignIn(url), false, url);
});

test('website registration rejection offers its original origin once without secrets', async () => {
  const offers = [];
  const recovery = createGoogleSignInRecovery({ onBlocked: (_contents, url) => offers.push(url), onError: assert.fail });
  const contents = new FakeContents('https://register.example/device?token=private#secret');
  recovery.watch(contents);
  contents.emit('did-redirect-navigation', {}, rejectedUrl, false, false);
  await flush();
  assert.deepEqual(offers, []);
  contents.emit('did-redirect-navigation', {}, rejectedUrl, false, true);
  contents.emit('did-navigate', {}, rejectedUrl);
  await flush();
  assert.deepEqual(offers, ['https://register.example']);
  contents.emit('did-navigate', {}, 'https://second.example/register');
  contents.emit('did-navigate', {}, rejectedUrl);
  await flush();
  assert.deepEqual(offers, ['https://register.example', 'https://second.example']);
});

test('Google popup retains the originating website for its registration fallback', async () => {
  const offers = [];
  const recovery = createGoogleSignInRecovery({ onBlocked: (_contents, url) => offers.push(url), onError: assert.fail });
  const loginUrl = 'https://accounts.google.com/o/oauth2/auth?state=private';
  recovery.rememberPopup(loginUrl, 'https://register.example/device?token=private');
  const popup = new FakeContents();
  recovery.watch(popup);
  popup.emit('did-start-navigation', {}, loginUrl, false, true);
  popup.emit('did-navigate', {}, rejectedUrl);
  await flush();
  assert.deepEqual(offers, ['https://register.example']);
});

test('direct Google sign-in has a token-free fallback and ignores destroyed contents', async () => {
  const offers = [];
  const recovery = createGoogleSignInRecovery({ onBlocked: (_contents, url) => offers.push(url), onError: assert.fail });
  const contents = new FakeContents();
  recovery.watch(contents);
  contents.emit('did-navigate', {}, rejectedUrl + '?continue=private');
  await flush();
  assert.deepEqual(offers, ['https://accounts.google.com/']);
  const closed = new FakeContents('https://register.example');
  recovery.watch(closed);
  closed.destroyed = true;
  closed.emit('did-navigate', {}, rejectedUrl);
  await flush();
  assert.equal(offers.length, 1);
});

test('recovery reports asynchronous failures explicitly', async () => {
  const errors = [];
  const failure = new Error('Dialog failed');
  const recovery = createGoogleSignInRecovery({ onBlocked: async () => { throw failure; }, onError: (error) => errors.push(error) });
  const contents = new FakeContents();
  recovery.watch(contents);
  contents.emit('did-navigate', {}, rejectedUrl);
  await flush();
  assert.deepEqual(errors, [failure]);
});

test('fallback locates a specific installed browser rather than the default Linsoft handler', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' };
  const edgePath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.deepEqual(findSignInBrowser({ platform: 'win32', env, exists: (file) => file === edgePath }), { name: 'Microsoft Edge', executable: edgePath });
  const chromePath = 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findSignInBrowser({ platform: 'win32', env, exists: (file) => file === chromePath }).name, 'Google Chrome');
  assert.equal(findSignInBrowser({ platform: 'linux', exists: (file) => file === '/usr/bin/firefox' }).name, 'Firefox');
  assert.equal(findSignInBrowser({ platform: 'win32', env, exists: () => false }), null);
});

test('external registration starts at the website origin with no shell or OAuth parameters', async () => {
  const launches = [];
  const browser = { name: 'Microsoft Edge', executable: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' };
  await openSignInWebsite(browser, 'https://register.example/device?token=private#secret', (...args) => {
    launches.push(args);
    const child = new EventEmitter();
    setImmediate(() => child.emit('spawn'));
    return child;
  });
  assert.deepEqual(launches, [[browser.executable, ['https://register.example'], { shell: false, stdio: 'ignore' }]]);
  for (const url of ['javascript:alert(1)', 'https://user@register.example']) {
    await assert.rejects(openSignInWebsite(browser, url, () => assert.fail('Invalid URL was launched')));
  }
  await assert.rejects(openSignInWebsite(browser, 'https://register.example', () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('error', new Error('Launch failed')));
    return child;
  }), /Launch failed/);
});
