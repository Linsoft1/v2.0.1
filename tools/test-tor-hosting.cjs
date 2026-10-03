const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { requestOnionService, waitForOnionService } = require('../lib/tor-hosting.cjs');
const { createTorChatRoom, createTorChatServer } = require('../lib/tor-chat-protocol.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linsoft-tor-test-'));
const dataDir = path.join(root, 'data');
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

async function run() {
  if (!fs.existsSync(torPath)) throw new Error(`Bundled Tor not found: ${torPath}`);
  fs.mkdirSync(dataDir, { recursive: true });
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
  await waitForFile(path.join(serviceDir, 'hostname'));
  const started = Date.now();
  while (!bootstrapped && Date.now() - started < 180000) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!bootstrapped) throw new Error(`Tor did not bootstrap to 100%.${torOutput.length ? `\nRecent Tor output:\n${torOutput.slice(-20).join('\n')}` : ''}`);
  const onion = fs.readFileSync(path.join(serviceDir, 'hostname'), 'utf8').trim();
  const statusCode = await waitForOnionService(`http://${onion}/`, proxyPort, { timeoutMs: 180000, attemptTimeoutMs: 20000, retryDelayMs: 10000 });
  const tokenHeader = { Authorization: `Bearer ${chatToken}` };
  const chatHealth = await waitForOnionService(`http://${onion}:81/_linsoft/chat/v1/health`, proxyPort, { timeoutMs: 180000, attemptTimeoutMs: 20000, retryDelayMs: 10000, headers: tokenHeader });
  const clientHeaders = { ...tokenHeader, 'X-Linsoft-Chat-Client': 'a'.repeat(24) };
  const messagesUrl = `http://${onion}:81/_linsoft/chat/v1/messages?after=0`;
  const initialMessages = await requestOnionService(messagesUrl, proxyPort, { headers: clientHeaders, timeoutMs: 30000 });
  if (initialMessages.statusCode !== 200 || JSON.parse(initialMessages.body).messages.length !== 0) throw new Error('Tor chat did not return an empty initial conversation.');
  const encryptedMessage = { iv: 'abcdefghijklmnop', ciphertext: 'ciphertext-only' };
  const sent = await requestOnionService(`http://${onion}:81/_linsoft/chat/v1/messages`, proxyPort, { method: 'POST', headers: { ...clientHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(encryptedMessage), timeoutMs: 30000 });
  if (sent.statusCode !== 201) throw new Error(`Tor chat send failed with HTTP ${sent.statusCode}.`);
  const received = JSON.parse((await requestOnionService(messagesUrl, proxyPort, { headers: clientHeaders, timeoutMs: 30000 })).body);
  if (received.messages.length !== 1 || received.messages[0].ciphertext !== encryptedMessage.ciphertext || Object.hasOwn(received.messages[0], 'text')) throw new Error('Tor chat did not relay only the encrypted payload.');
  const secondClient = await requestOnionService(messagesUrl, proxyPort, { headers: { ...tokenHeader, 'X-Linsoft-Chat-Client': 'b'.repeat(24) }, timeoutMs: 30000 });
  if (secondClient.statusCode !== 403) throw new Error('Tor chat accepted a second guest for a 1:1 invitation.');
  console.log(JSON.stringify({ ok: true, onion, statusCode, chatHealth, chatSend: sent.statusCode, secondGuestStatus: secondClient.statusCode, response: 'Tor hosting and 1:1 encrypted chat OK' }));
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  server?.close();
  chatServer?.close();
  if (tor && !tor.killed) tor.kill();
  fs.rmSync(root, { recursive: true, force: true });
});
