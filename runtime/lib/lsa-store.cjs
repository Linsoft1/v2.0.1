'use strict';
// Installed .lsa applications: <root>/apps/<id>/versions/<version>/ plus state.json
// with the current and previous version. A freshly installed version is "pending"
// until the app reports a healthy start; after repeated failed starts the store
// falls back to the previous version automatically.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LsaError, compareVersions, extractLsaPackage, openLsaPackage, verifyInstalledApp } = require('./lsa-format.cjs');

const MAX_FAILED_LAUNCHES = 2;

function electronMajor(version) {
  return Number(String(version).split('.')[0]);
}

/**
 * @param {{ root: string, trustedKeys: Array<{publicKey: string, name?: string}>, runtimeVersion: string, electronVersion: string }} options
 */
function createLsaStore({ root, trustedKeys, runtimeVersion, electronVersion }) {
  const appDir = (id) => path.join(root, 'apps', id);
  const versionsDir = (id) => path.join(appDir(id), 'versions');
  const versionDir = (id, version) => path.join(versionsDir(id), version);
  const statePath = (id) => path.join(appDir(id), 'state.json');

  function readState(id) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
      return state && typeof state === 'object' ? state : {};
    } catch { return {}; }
  }

  function writeState(id, state) {
    fs.mkdirSync(appDir(id), { recursive: true });
    const temp = `${statePath(id)}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, statePath(id));
  }

  function checkCompatibility(manifest) {
    if (compareVersions(runtimeVersion, manifest.minRuntimeVersion) < 0) {
      throw new LsaError('runtime-too-old', `${manifest.name} ${manifest.version} vyžaduje Linsoft Runtime ${manifest.minRuntimeVersion} alebo novší (máš ${runtimeVersion}).`);
    }
    if (electronMajor(manifest.electron) !== electronMajor(electronVersion)) {
      throw new LsaError('runtime-mismatch', `${manifest.name} ${manifest.version} je zostavený pre Electron ${manifest.electron}, Linsoft Runtime používa ${electronVersion}. Aktualizuj Linsoft Runtime.`);
    }
  }

  /** Reads and verifies a package without installing it (for the confirmation dialog). */
  function inspect(lsaPath) {
    const opened = openLsaPackage(lsaPath, trustedKeys);
    opened.reader.close();
    const state = readState(opened.manifest.id);
    let compatibility = null;
    try { checkCompatibility(opened.manifest); } catch (error) { compatibility = error; }
    return { manifest: opened.manifest, signer: opened.signer, installedVersion: state.current || '', compatibilityError: compatibility };
  }

  function prune(id, keep) {
    let names = [];
    try { names = fs.readdirSync(versionsDir(id)); } catch { return; }
    for (const name of names) {
      if (keep.has(name)) continue;
      try { fs.rmSync(path.join(versionsDir(id), name), { recursive: true, force: true }); } catch {}
    }
  }

  function isInstalledAndValid(id, version) {
    try { verifyInstalledApp(versionDir(id, version), trustedKeys); return true; } catch { return false; }
  }

  /**
   * Installs a package. Returns the manifest and whether anything changed.
   * @param {string} lsaPath
   * @param {{ allowDowngrade?: boolean, expectedId?: string, runningVersion?: string, onProgress?: (fraction: number) => void }} [options]
   */
  function install(lsaPath, { allowDowngrade = false, expectedId = '', runningVersion = '', onProgress } = {}) {
    const opened = openLsaPackage(lsaPath, trustedKeys);
    try {
      const { manifest } = opened;
      if (expectedId && manifest.id !== expectedId) throw new LsaError('wrong-app', `Balík obsahuje inú aplikáciu (${manifest.id}).`);
      checkCompatibility(manifest);
      const id = manifest.id;
      const state = readState(id);
      if (state.current && compareVersions(manifest.version, state.current) < 0 && !allowDowngrade) {
        throw new LsaError('downgrade', `Nainštalovaná je novšia verzia ${state.current}.`);
      }
      const target = versionDir(id, manifest.version);
      const alreadyValid = isInstalledAndValid(id, manifest.version);
      if (!alreadyValid) {
        fs.mkdirSync(versionsDir(id), { recursive: true });
        const temp = path.join(versionsDir(id), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
        try {
          extractLsaPackage(opened, temp, { onProgress });
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
          fs.renameSync(temp, target);
        } catch (error) {
          try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
          throw error;
        }
      }
      const changed = state.current !== manifest.version;
      const next = { ...state, current: manifest.version, installedAt: Date.now() };
      if (changed) {
        if (state.current) next.previous = state.current;
        next.pending = { version: manifest.version, failedLaunches: 0 };
      }
      writeState(id, next);
      prune(id, new Set([next.current, next.previous, runningVersion].filter(Boolean)));
      return { manifest, changed: changed || !alreadyValid };
    } finally {
      opened.reader.close();
    }
  }

  /**
   * Picks the version to start, applying automatic rollback after repeated failed starts.
   * @returns {{ dir: string, manifest: any, rolledBackFrom?: string } | null}
   */
  function resolveLaunch(id) {
    const state = readState(id);
    if (!state.current) return null;
    let rolledBackFrom = '';
    if (state.pending?.version === state.current && state.pending.failedLaunches >= MAX_FAILED_LAUNCHES && state.previous && isInstalledAndValid(id, state.previous)) {
      rolledBackFrom = state.current;
      state.current = state.previous;
      delete state.previous;
      delete state.pending;
      writeState(id, state);
    }
    for (const version of [state.current, state.previous].filter(Boolean)) {
      const dir = versionDir(id, version);
      let manifest;
      try { manifest = verifyInstalledApp(dir, trustedKeys); checkCompatibility(manifest); } catch { continue; }
      if (manifest.id !== id || manifest.version !== version) continue;
      if (version !== state.current) {
        rolledBackFrom = state.current;
        state.current = version;
        delete state.previous;
        delete state.pending;
      }
      if (state.pending?.version === version) state.pending.failedLaunches = (state.pending.failedLaunches || 0) + 1;
      writeState(id, state);
      return { dir, manifest, ...(rolledBackFrom ? { rolledBackFrom } : {}) };
    }
    return null;
  }

  /** Called once the app started successfully; clears the pending (unconfirmed) flag. */
  function markHealthy(id, version) {
    const state = readState(id);
    if (state.pending?.version !== version) return;
    delete state.pending;
    writeState(id, state);
  }

  /** Switches back to the previous version. */
  function rollback(id) {
    const state = readState(id);
    if (!state.previous || !isInstalledAndValid(id, state.previous)) throw new LsaError('no-previous', 'Predchádzajúca verzia nie je k dispozícii.');
    const next = { ...state, current: state.previous, previous: state.current };
    delete next.pending;
    writeState(id, next);
    return next.current;
  }

  return { appDir, versionDir, readState, inspect, install, resolveLaunch, markHealthy, rollback, checkCompatibility };
}

module.exports = { createLsaStore, MAX_FAILED_LAUNCHES };
