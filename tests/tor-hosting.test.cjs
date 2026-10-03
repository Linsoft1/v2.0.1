const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { loadSavedTorHostingState, probeOnionService, requestOnionService, resolveHostedFile, saveTorHostingFolder, waitForOnionService } = require('../lib/tor-hosting.cjs');

test('hosted files stay inside the selected directory', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-host-root-'));
  const root = path.join(temporaryDirectory, 'public');
  fs.mkdirSync(root);
  const indexPath = path.join(root, 'index.html');
  fs.writeFileSync(indexPath, 'public page');
  try {
    assert.equal(resolveHostedFile(root, 'index.html'), fs.realpathSync(indexPath));
    assert.equal(resolveHostedFile(root, '../secret.txt'), null);
    assert.equal(resolveHostedFile(root, 'missing.html'), null);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('hosted files reject symlinks that resolve outside the selected directory', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-host-link-'));
  const root = path.join(temporaryDirectory, 'public');
  const outside = path.join(temporaryDirectory, 'private');
  const secret = path.join(outside, 'secret.txt');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(secret, 'private');
  const link = path.join(root, 'private-link');
  try {
    try { fs.symlinkSync(outside, link, 'junction'); } catch (error) {
      if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error.code)) {
        context.skip('The current Windows account cannot create a directory junction.');
        return;
      }
      throw error;
    }
    assert.equal(resolveHostedFile(root, 'private-link/secret.txt'), null);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('onion probe retries until the hidden service responds successfully', async () => {
  const requests = [];
  const server = net.createServer((socket) => {
    let stage = 'greeting';
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === 'greeting' && buffered.length >= 3) {
        buffered = buffered.subarray(3);
        stage = 'connect';
        socket.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'connect' && buffered.length >= 5) {
        const requestLength = 7 + buffered[4];
        if (buffered.length < requestLength) return;
        buffered = buffered.subarray(requestLength);
        stage = 'http';
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
      }
      if (stage === 'http' && buffered.includes('\r\n\r\n')) {
        stage = 'done';
        requests.push(buffered.toString('utf8'));
        const statusCode = ++requestCount === 1 ? 503 : 200;
        const statusText = statusCode === 200 ? 'OK' : 'Service Unavailable';
        socket.end(`HTTP/1.1 ${statusCode} ${statusText}\r\nContent-Length: 2\r\n\r\nOK`);
      }
    });
  });
  let requestCount = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(await waitForOnionService('http://test-service.onion/', address.port, { timeoutMs: 1500, attemptTimeoutMs: 500, retryDelayMs: 5 }), 200);
    assert.equal(requestCount, 2);
    const payload = JSON.stringify({ iv: 'abcdefghijklmnop', ciphertext: 'opaque-payload' });
    const response = await requestOnionService('http://test-service.onion/messages', address.port, {
      method: 'POST',
      headers: { Authorization: 'Bearer one-time-token', 'Content-Type': 'application/json' },
      body: payload,
      timeoutMs: 500
    });
    assert.equal(response.statusCode, 200);
    assert.equal(requests.length, 3);
    assert.match(requests[2], /^POST \/messages HTTP\/1\.1/);
    assert.match(requests[2], /Authorization: Bearer one-time-token/i);
    assert.ok(requests[2].endsWith(payload));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('saved onion state is restored as stopped without starting Tor', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-host-state-'));
  const root = path.join(temporaryDirectory, 'public');
  const statePath = path.join(temporaryDirectory, 'tor-hosting-state.json');
  const hostnamePath = path.join(temporaryDirectory, 'hidden-service', 'hostname');
  fs.mkdirSync(root);
  fs.mkdirSync(path.dirname(hostnamePath), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), 'public page');
  const hostname = `${'a'.repeat(56)}.onion`;
  fs.writeFileSync(hostnamePath, `${hostname}\n`);
  try {
    saveTorHostingFolder(statePath, root);
    const state = loadSavedTorHostingState(statePath, hostnamePath);
    assert.equal(state.status, 'stopped');
    assert.equal(state.folder, fs.realpathSync(root));
    assert.equal(state.onion, `http://${hostname}/`);
    assert.match(state.message, /ručn/);
    assert.equal(state.proxyEnabled, undefined);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});