const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { requestOnionService, waitForOnionService } = require('../lib/tor-hosting.cjs');
const { clearTorChatFileTransfer, createTorChatRoom, createTorChatServer, enqueueTorChatFileChunk, enqueueTorChatMessage, enqueueTorChatVideoFrame, getTorChatFileChunks, getTorChatVideoState } = require('../lib/tor-chat-protocol.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-tor-test-'));
const dataDir = path.join(os.tmpdir(), 'linsoft-tor-test-cache');
const serviceDir = path.join(root, 'hidden-service');
const configPath = path.join(root, 'torrc');
const sitePath = path.join(root, 'index.html');
const torPath = process.platform === 'win32'
  ? path.resolve('assets/tor/windows/tor/tor.exe')
  : path.resolve('assets/tor/linux/tor/tor');
const proxyPort = 29150;
let server;
let chatServer;
let tor;

function waitForFile(filePath, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() - started > timeout) return reject(new Error(`Timed out waiting for ${filePath}`));
      setTimeout(check, 250);
    };
    check();
  });
}

function waitForPort(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const net = require('node:net');
    const check = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => { socket.destroy(); if (Date.now() - started > timeout) reject(new Error(`Timed out waiting for port ${port}`)); else setTimeout(check, 250); });
    };
    check();
  });
}

async function runGuestClient() {
  const onion = process.env.LINSOFT_TOR_TEST_ONION;
  const token = process.env.LINSOFT_TOR_TEST_TOKEN;
  const proxyPort = Number(process.env.LINSOFT_TOR_TEST_PROXY_PORT);
  const clientId = crypto.randomBytes(18).toString('base64url');
  const headers = { Authorization: `Bearer ${token}`, 'X-Linsoft-Chat-Client': clientId };
  const baseUrl = `http://${onion}:81/_linsoft/chat/v1`;
  const initial = await requestOnionService(`${baseUrl}/messages?after=0`, proxyPort, { headers, timeoutMs: 30000 });
  if (initial.statusCode !== 200 || JSON.parse(initial.body).messages.length !== 0) throw new Error('Guest process did not receive an empty initial conversation.');
  const encryptedMessage = { iv: 'abcdefghijklmnop', ciphertext: 'guest-process-ciphertext' };
  const sent = await requestOnionService(`${baseUrl}/messages`, proxyPort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(encryptedMessage), timeoutMs: 30000 });
  if (sent.statusCode !== 201) throw new Error(`Guest process send failed with HTTP ${sent.statusCode}.`);
  const videoFrame = { iv: 'qrstuvwxyzABCDEF', ciphertext: 'guest-encrypted-video-frame' };
  const videoSent = await requestOnionService(`${baseUrl}/video`, proxyPort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(videoFrame), timeoutMs: 30000 });
  if (videoSent.statusCode !== 201) throw new Error(`Guest video frame failed with HTTP ${videoSent.statusCode}.`);
  const guestFileId = 'g'.repeat(24);
  const guestFileChunks = [
    { fileId: guestFileId, index: 0, total: 2, iv: 'abcdefghijklmnop', ciphertext: 'encrypted-guest-file-manifest' },
    { fileId: guestFileId, index: 1, total: 2, iv: 'qrstuvwxyzABCDEF', ciphertext: 'encrypted-guest-file-data' }
  ];
  let guestFileSend = 201;
  for (const chunk of guestFileChunks) {
    const uploaded = await requestOnionService(`${baseUrl}/files`, proxyPort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(chunk), timeoutMs: 30000 });
    if (uploaded.statusCode !== 201) throw new Error(`Guest file chunk failed with HTTP ${uploaded.statusCode}.`);
  }
  const secondGuest = await requestOnionService(`${baseUrl}/messages?after=0`, proxyPort, { headers: { Authorization: `Bearer ${token}`, 'X-Linsoft-Chat-Client': crypto.randomBytes(18).toString('base64url') }, timeoutMs: 30000 });
  if (secondGuest.statusCode !== 403) throw new Error(`A second guest process received HTTP ${secondGuest.statusCode}, expected 403.`);

  process.send({ type: 'guest-ready', sent: sent.statusCode, videoSent: videoSent.statusCode, guestFileSend, guestFileId, secondGuest: secondGuest.statusCode });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host process did not deliver a test message to the guest.')), 90000);
    process.on('message', async (message) => {
      if (message?.type !== 'host-message') return;
      try {
        const polled = await requestOnionService(`${baseUrl}/messages?after=1`, proxyPort, { headers, timeoutMs: 30000 });
        const result = JSON.parse(polled.body);
        if (polled.statusCode !== 200 || result.messages.length !== 1 || result.messages[0].id !== message.id || !result.messages[0].deliveredAt) throw new Error('Guest process did not receive the host message with a delivery receipt.');
        const receipt = await requestOnionService(`${baseUrl}/receipts`, proxyPort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [message.id] }), timeoutMs: 30000 });
        if (receipt.statusCode !== 200) throw new Error(`Guest read receipt failed with HTTP ${receipt.statusCode}.`);
        const remoteVideoResponse = await requestOnionService(`${baseUrl}/video?after=0`, proxyPort, { headers, timeoutMs: 30000 });
        const remoteVideo = JSON.parse(remoteVideoResponse.body);
        if (remoteVideoResponse.statusCode !== 200 || !remoteVideo.active || remoteVideo.frame?.ciphertext !== 'host-encrypted-video-frame') throw new Error('Guest process did not receive the host video frame over Tor.');
        const videoStop = await requestOnionService(`${baseUrl}/video`, proxyPort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }), timeoutMs: 30000 });
        if (videoStop.statusCode !== 200) throw new Error(`Guest video stop failed with HTTP ${videoStop.statusCode}.`);
        const incomingFileResponse = await requestOnionService(`${baseUrl}/files?after=-1`, proxyPort, { headers, timeoutMs: 30000, maxResponseBytes: 200000 });
        const incomingFile = JSON.parse(incomingFileResponse.body).transfer;
        if (incomingFileResponse.statusCode !== 200 || incomingFile?.fileId !== message.hostFileId || incomingFile.chunks.length !== 2 || incomingFile.chunks[1].ciphertext !== 'encrypted-host-file-data') throw new Error('Guest process did not receive encrypted file chunks over Tor.');
        const fileComplete = await requestOnionService(`${baseUrl}/files/complete`, proxyPort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: incomingFile.fileId }), timeoutMs: 30000 });
        if (fileComplete.statusCode !== 200) throw new Error(`Guest file receipt failed with HTTP ${fileComplete.statusCode}.`);
        process.send({ type: 'guest-complete', delivered: 200, readReceipt: receipt.statusCode, videoReceive: 200, videoStop: videoStop.statusCode, hostFileReceive: 200, fileComplete: fileComplete.statusCode });
        clearTimeout(timeout);
        process.disconnect();
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function runGuestProcess({ onion, token, proxyPort, room }) {
  const child = fork(__filename, ['--guest'], {
    env: { ...process.env, LINSOFT_TOR_TEST_ONION: onion, LINSOFT_TOR_TEST_TOKEN: token, LINSOFT_TOR_TEST_PROXY_PORT: String(proxyPort) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '';
  let hostMessage = null;
  let hostVideoFrame = null;
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Guest process timed out.${stderr ? `\n${stderr}` : ''}`)); }, 120000);
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.once('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`Guest process exited with ${code}.${stderr ? `\n${stderr}` : ''}`)); }
    });
    child.on('message', (message) => {
      if (message?.type === 'failure') {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(message.message)); }
        return;
      }
      if (message?.type === 'guest-ready') {
        const guestVideo = getTorChatVideoState(room, 'host', 0);
        if (message.videoSent !== 201 || !guestVideo.active || guestVideo.frame?.ciphertext !== 'guest-encrypted-video-frame') {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          return reject(new Error('Host process did not receive the guest video frame over Tor.'));
        }
        const guestFile = getTorChatFileChunks(room, 'host', -1);
        if (message.guestFileSend !== 201 || guestFile?.fileId !== message.guestFileId || guestFile.chunks.length !== 2 || guestFile.chunks[1].ciphertext !== 'encrypted-guest-file-data') {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          return reject(new Error('Host process did not receive encrypted file chunks over Tor.'));
        }
        clearTorChatFileTransfer(room, 'guest', message.guestFileId);
        hostMessage = enqueueTorChatMessage(room, 'host', { iv: 'abcdefghijklmnop', ciphertext: 'host-process-ciphertext' });
        hostVideoFrame = enqueueTorChatVideoFrame(room, 'host', { iv: 'abcdefghijklmnop', ciphertext: 'host-encrypted-video-frame' });
        const hostFileId = 'h'.repeat(24);
        enqueueTorChatFileChunk(room, 'host', { fileId: hostFileId, index: 0, total: 2, iv: 'abcdefghijklmnop', ciphertext: 'encrypted-host-file-manifest' });
        enqueueTorChatFileChunk(room, 'host', { fileId: hostFileId, index: 1, total: 2, iv: 'qrstuvwxyzABCDEF', ciphertext: 'encrypted-host-file-data' });
        child.send({ type: 'host-message', id: hostMessage.id, videoFrameId: hostVideoFrame.id, hostFileId });
        return;
      }
      if (message?.type === 'guest-complete' && !settled) {
        settled = true;
        clearTimeout(timeout);
        if (!hostMessage?.deliveredAt || !hostMessage.readAt || !hostVideoFrame || getTorChatVideoState(room, 'host', 0).active) return reject(new Error('Host process did not observe chat receipts and video teardown.'));
        if (room.fileTransfers.host) return reject(new Error('Host file transfer was not cleared after guest receipt.'));
        resolve({ guestSend: 201, chatDelivery: message.delivered, chatReadReceipt: message.readReceipt, guestVideoSend: 201, hostVideoReceive: message.videoReceive, videoStop: message.videoStop, guestFileSend: 201, hostFileReceive: message.hostFileReceive, fileComplete: message.fileComplete, secondGuest: 403 });
      }
    });
  });
}

async function run() {
  if (!fs.existsSync(torPath)) throw new Error(`Bundled Tor not found: ${torPath}`);
  fs.mkdirSync(dataDir, { recursive: true });
  try { fs.unlinkSync(path.join(dataDir, 'lock')); } catch {}
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(sitePath, '<!doctype html><title>Linsoft Tor Test</title><h1>Tor hosting OK</h1>', 'utf8');
  const chatToken = crypto.randomBytes(24).toString('base64url');
  const chatRoom = createTorChatRoom(chatToken);
  server = http.createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404); return response.end('Not found'); }
    const data = fs.readFileSync(sitePath);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': data.length });
    response.end(data);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  chatServer = createTorChatServer(chatRoom);
  await new Promise((resolve, reject) => { chatServer.once('error', reject); chatServer.listen(0, '127.0.0.1', resolve); });
  const chatPort = chatServer.address().port;
  fs.writeFileSync(configPath, `DataDirectory "${dataDir.replace(/\\/g, '/')}"\nSocksPort 127.0.0.1:${proxyPort}\nHiddenServiceDir "${serviceDir.replace(/\\/g, '/')}"\nHiddenServicePort 80 127.0.0.1:${port}\nHiddenServicePort 81 127.0.0.1:${chatPort}\n`, 'utf8');
  tor = spawn(torPath, ['-f', configPath, '--Log', 'notice stdout'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let bootstrapped = false;
  const torOutput = [];
  const observe = (chunk) => {
    torOutput.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (torOutput.length > 40) torOutput.splice(0, torOutput.length - 40);
    if (/Bootstrapped 100% \(done\)/i.test(torOutput.join('\n'))) bootstrapped = true;
  };
  tor.once('error', (error) => torOutput.push(`Tor process error: ${error.message}`));
  tor.stdout.on('data', observe);
  tor.stderr.on('data', observe);
  await waitForPort(proxyPort);
  try {
    await waitForFile(path.join(serviceDir, 'hostname'));
  } catch (error) {
    const output = torOutput.slice(-20).join('\n') || '(no Tor output captured)';
    throw new Error(`${error.message}\nTor process: ${tor.exitCode === null ? `running (pid ${tor.pid})` : `exited with ${tor.exitCode}`}\nRecent Tor output:\n${output}`);
  }
  const started = Date.now();
  while (!bootstrapped && Date.now() - started < 180000) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!bootstrapped) throw new Error(`Tor did not bootstrap to 100%.${torOutput.length ? `\nRecent Tor output:\n${torOutput.slice(-20).join('\n')}` : ''}`);
  const onion = fs.readFileSync(path.join(serviceDir, 'hostname'), 'utf8').trim();
  const statusCode = await waitForOnionService(`http://${onion}/`, proxyPort, { timeoutMs: 180000, attemptTimeoutMs: 20000, retryDelayMs: 10000 });
  const tokenHeader = { Authorization: `Bearer ${chatToken}` };
  const chatHealth = await waitForOnionService(`http://${onion}:81/_linsoft/chat/v1/health`, proxyPort, { timeoutMs: 180000, attemptTimeoutMs: 20000, retryDelayMs: 10000, headers: tokenHeader });
  const guest = await runGuestProcess({ onion, token: chatToken, proxyPort, room: chatRoom });
  console.log(JSON.stringify({ ok: true, testOnly: true, onion, onionLifetime: 'temporary; this service stops when the smoke test exits', statusCode, chatHealth, ...guest, response: 'Tor hosting and separate host/guest processes OK' }));
}

(process.argv.includes('--guest') ? runGuestClient() : run()).catch((error) => {
  if (process.send) process.send({ type: 'failure', message: error.message });
  else console.error(error.message);
  process.exitCode = 1;
}).finally(() => {
  server?.close();
  chatServer?.close();
  if (tor && !tor.killed) tor.kill();
  fs.rmSync(root, { recursive: true, force: true });
  if (process.send) process.disconnect();
});
