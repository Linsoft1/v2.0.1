const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

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
  server = http.createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(sitePath).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  fs.writeFileSync(configPath, `DataDirectory "${dataDir.replace(/\\/g, '/')}"\nSocksPort 127.0.0.1:${proxyPort}\nHiddenServiceDir "${serviceDir.replace(/\\/g, '/')}"\nHiddenServicePort 80 127.0.0.1:${port}\n`, 'utf8');
  tor = spawn(torPath, ['-f', configPath, '--Log', 'notice stdout'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let bootstrapped = false;
  const observe = (chunk) => { if (/Bootstrapped 100% \(done\)/i.test(String(chunk))) bootstrapped = true; };
  tor.stdout.on('data', observe);
  tor.stderr.on('data', observe);
  await waitForPort(proxyPort);
  await waitForFile(path.join(serviceDir, 'hostname'));
  const started = Date.now();
  while (!bootstrapped && Date.now() - started < 60000) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!bootstrapped) throw new Error('Tor did not bootstrap to 100%.');
  const onion = fs.readFileSync(path.join(serviceDir, 'hostname'), 'utf8').trim();
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const output = execFileSync(curl, ['--socks5-hostname', `127.0.0.1:${proxyPort}`, '--connect-timeout', '30', '--max-time', '60', `http://${onion}/`], { encoding: 'utf8' });
  if (!output.includes('Tor hosting OK')) throw new Error('Unexpected onion response.');
  console.log(JSON.stringify({ ok: true, onion, response: 'Tor hosting OK' }));
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  server?.close();
  if (tor && !tor.killed) tor.kill();
  fs.rmSync(root, { recursive: true, force: true });
});
