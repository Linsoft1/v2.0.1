const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLsaStore, MAX_FAILED_LAUNCHES } = require('../runtime/lib/lsr-store.cjs');
const { createKey, tempDir, writePackage } = require('./lsr-test-helpers.cjs');

const key = createKey();
const ID = 'sk.linsoft.browser';

function setup(options = {}) {
  const dir = tempDir();
  const store = createLsaStore({ root: path.join(dir, 'home'), trustedKeys: [key.trusted], runtimeVersion: '1.0.0', electronVersion: '44.4.5', ...options });
  const pkg = (version, extra = {}) => writePackage(path.join(dir, `${version}-${Math.random()}.lsr`), { key, version, ...extra });
  return { store, pkg };
}

test('installing a package makes it the launch target', () => {
  const { store, pkg } = setup();
  assert.equal(store.resolveLaunch(ID), null);
  const result = store.install(pkg('2.0.32'));
  assert.equal(result.changed, true);
  const launch = store.resolveLaunch(ID);
  assert.equal(launch.manifest.version, '2.0.32');
  assert.ok(fs.existsSync(path.join(launch.dir, 'main.cjs')));
  assert.equal(store.install(pkg('2.0.32')).changed, false);
});

test('an update keeps the previous version for rollback and prunes older ones', () => {
  const { store, pkg } = setup();
  store.install(pkg('2.0.30'));
  store.install(pkg('2.0.31'));
  store.install(pkg('2.0.32'));
  const state = store.readState(ID);
  assert.equal(state.current, '2.0.32');
  assert.equal(state.previous, '2.0.31');
  assert.equal(fs.existsSync(store.versionDir(ID, '2.0.30')), false);
  assert.equal(store.rollback(ID), '2.0.31');
  assert.equal(store.resolveLaunch(ID).manifest.version, '2.0.31');
});

test('the running version is never pruned during an update', () => {
  const { store, pkg } = setup();
  store.install(pkg('2.0.30'));
  store.install(pkg('2.0.31'));
  store.install(pkg('2.0.32'), { runningVersion: '2.0.30' });
  assert.ok(fs.existsSync(store.versionDir(ID, '2.0.30')));
});

test('downgrades need explicit permission', () => {
  const { store, pkg } = setup();
  store.install(pkg('2.0.32'));
  assert.throws(() => store.install(pkg('2.0.31')), { code: 'downgrade' });
  assert.equal(store.install(pkg('2.0.31'), { allowDowngrade: true }).manifest.version, '2.0.31');
});

test('an update for a different app id is refused', () => {
  const { store, pkg } = setup();
  assert.throws(() => store.install(pkg('2.0.33', { id: 'sk.example.other' }), { expectedId: ID }), { code: 'wrong-app' });
});

test('packages for another runtime or Electron major are refused', () => {
  const { store, pkg } = setup();
  assert.throws(() => store.install(pkg('2.1.0', { manifest: { minRuntimeVersion: '2.0.0' } })), { code: 'runtime-too-old' });
  assert.throws(() => store.install(pkg('2.1.0', { manifest: { electron: '45.0.0' } })), { code: 'runtime-mismatch' });
});

test('a new version that keeps failing to start is rolled back automatically', () => {
  const { store, pkg } = setup();
  store.install(pkg('2.0.31'));
  store.markHealthy(ID, '2.0.31');
  store.install(pkg('2.0.32'));
  for (let i = 0; i < MAX_FAILED_LAUNCHES; i += 1) assert.equal(store.resolveLaunch(ID).manifest.version, '2.0.32');
  const launch = store.resolveLaunch(ID);
  assert.equal(launch.manifest.version, '2.0.31');
  assert.equal(launch.rolledBackFrom, '2.0.32');
});

test('a healthy start confirms the new version', () => {
  const { store, pkg } = setup();
  store.install(pkg('2.0.31'));
  store.install(pkg('2.0.32'));
  store.resolveLaunch(ID);
  store.markHealthy(ID, '2.0.32');
  for (let i = 0; i < MAX_FAILED_LAUNCHES + 2; i += 1) assert.equal(store.resolveLaunch(ID).manifest.version, '2.0.32');
});

test('a damaged installation falls back to the previous version', () => {
  const { store, pkg } = setup();
  store.install(pkg('2.0.31'));
  store.install(pkg('2.0.32'));
  fs.rmSync(path.join(store.versionDir(ID, '2.0.32'), 'main.cjs'));
  const launch = store.resolveLaunch(ID);
  assert.equal(launch.manifest.version, '2.0.31');
  assert.equal(launch.rolledBackFrom, '2.0.32');
});

test('a failed installation leaves no partial version behind', () => {
  const { store, pkg } = setup();
  const bad = pkg('2.0.33', { content: { 'main.cjs': 'evil();', 'assets/a.txt': 'hello' }, signedContent: { 'main.cjs': 'ok();;;', 'assets/a.txt': 'hello' } });
  assert.throws(() => store.install(bad), { code: 'tampered' });
  assert.deepEqual(fs.readdirSync(path.join(store.appDir(ID), 'versions')), []);
  assert.equal(store.resolveLaunch(ID), null);
});
