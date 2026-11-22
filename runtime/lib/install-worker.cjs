'use strict';
// Runs a package installation off the Electron main thread so the progress window stays responsive.
const { parentPort, workerData } = require('node:worker_threads');
const { createLsaStore } = require('./lsa-store.cjs');

let lastReported = -1;
try {
  const store = createLsaStore(workerData.storeOptions);
  const result = store.install(workerData.file, {
    ...workerData.installOptions,
    onProgress: (fraction) => {
      const percent = Math.floor(fraction * 100);
      if (percent !== lastReported) { lastReported = percent; parentPort.postMessage({ type: 'progress', percent }); }
    }
  });
  const { id, name, version } = result.manifest;
  parentPort.postMessage({ type: 'done', manifest: { id, name, version }, changed: result.changed });
} catch (error) {
  parentPort.postMessage({ type: 'error', code: error?.code || 'error', message: error instanceof Error ? error.message : String(error) });
}
