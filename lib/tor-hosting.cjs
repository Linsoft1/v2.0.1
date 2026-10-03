const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveHostedFile(root, relativePath) {
  try {
    const realRoot = fs.realpathSync(root);
    const candidate = path.resolve(realRoot, relativePath);
    if (!isWithinDirectory(realRoot, candidate)) return null;
    const realCandidate = fs.realpathSync(candidate);
    return isWithinDirectory(realRoot, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

function createTorStaticRequestHandler(root, onRequest = () => {}) {
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
  return (request, response) => {
    let requested;
    try { requested = decodeURIComponent((request.url || '/').split('?')[0]); } catch { response.writeHead(400); response.end('Bad request'); return; }
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      response.end('Method not allowed');
      return;
    }
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const filePath = resolveHostedFile(root, relative);
    onRequest(request.method || 'GET', requested);
    if (!filePath) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end('Not found'); return; }
    fs.stat(filePath, (error, stats) => {
      if (error || !stats.isFile()) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end('Not found'); return; }
      const extension = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[extension] || 'application/octet-stream';
      const compressible = /^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/i.test(contentType);
      const cacheControl = ['.html', '.htm'].includes(extension) ? 'no-cache' : 'public, max-age=300';
      const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': contentType,
        'Last-Modified': stats.mtime.toUTCString(),
        ETag: etag,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff'
      };
      if (compressible) headers.Vary = 'Accept-Encoding';
      const ifNoneMatch = request.headers['if-none-match'];
      const ifModifiedSince = Date.parse(String(request.headers['if-modified-since'] || ''));
      const notModified = ifNoneMatch
        ? String(ifNoneMatch).split(',').some((value) => value.trim() === '*' || value.trim() === etag)
        : Number.isFinite(ifModifiedSince) && Math.floor(stats.mtimeMs / 1000) * 1000 <= ifModifiedSince;
      if (notModified) { response.writeHead(304, headers); response.end(); return; }
      const acceptsGzip = compressible && stats.size >= 512 && String(request.headers['accept-encoding'] || '').split(',').some((value) => {
        const [encoding, ...parameters] = value.trim().split(';');
        return encoding.toLowerCase() === 'gzip' && !parameters.some((parameter) => /^\s*q=0(?:\.0*)?\s*$/i.test(parameter));
      });
      if (request.method === 'HEAD') {
        if (acceptsGzip) headers['Content-Encoding'] = 'gzip';
        else headers['Content-Length'] = stats.size;
        response.writeHead(200, headers);
        response.end();
        return;
      }
      if (acceptsGzip) headers['Content-Encoding'] = 'gzip';
      else headers['Content-Length'] = stats.size;
      response.writeHead(200, headers);
      const file = fs.createReadStream(filePath);
      file.on('error', () => { if (!response.headersSent) response.writeHead(500); response.end('Server error'); });
      if (acceptsGzip) file.pipe(zlib.createGzip()).pipe(response);
      else file.pipe(response);
    });
  };
}

function requestOnionService(address, socksPort, { method = 'GET', headers = {}, body = '', timeoutMs = 30000, maxResponseBytes = 65536, signal } = {}) {
  const target = new URL(address);
  if (target.protocol !== 'http:' || !target.hostname.endsWith('.onion') || target.username || target.password) {
    return Promise.reject(new Error('Expected a credential-free HTTP onion-service URL.'));
  }

  const hostname = Buffer.from(target.hostname, 'ascii');
  const port = Number(target.port || 80);
  const requestPath = `${target.pathname || '/'}${target.search}`;
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  if (hostname.length > 255 || !Number.isInteger(port) || port < 1 || port > 65535 || !['GET', 'POST', 'HEAD'].includes(method) || /[\r\n]/.test(requestPath) || bodyBuffer.length > maxResponseBytes) {
    return Promise.reject(new Error('Invalid onion-service request.'));
  }

  const requestHeaders = { ...headers, Host: target.hostname, Connection: 'close', 'Content-Length': String(bodyBuffer.length) };
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value))) {
      return Promise.reject(new Error('Invalid onion-service HTTP header.'));
    }
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: socksPort });
    let stage = 'greeting';
    let buffered = Buffer.alloc(0);
    let settled = false;

    const finish = (error, statusCode) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(statusCode);
    };
    const onAbort = () => finish(new Error('Onion-service probe was cancelled.'));

    socket.setTimeout(timeoutMs, () => finish(new Error('Timed out probing onion service.')));
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once('error', (error) => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('Connection to onion service closed before a response.'));
    });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        while (!settled) {
          if (stage === 'greeting') {
            if (buffered.length < 2) return;
            if (buffered[0] !== 0x05 || buffered[1] !== 0x00) throw new Error('Tor SOCKS5 proxy rejected the connection.');
            buffered = buffered.subarray(2);
            const portBytes = Buffer.from([port >> 8, port & 0xff]);
            socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostname.length]), hostname, portBytes]));
            stage = 'connect';
            continue;
          }

          if (stage === 'connect') {
            if (buffered.length < 5) return;
            const addressType = buffered[3];
            const replyLength = addressType === 0x01 ? 10 : addressType === 0x04 ? 22 : addressType === 0x03 && buffered.length >= 5 ? 7 + buffered[4] : 0;
            if (!replyLength) throw new Error('Tor SOCKS5 proxy returned an invalid response.');
            if (buffered.length < replyLength) return;
            if (buffered[1] !== 0x00) throw new Error(`Tor SOCKS5 connection failed (${buffered[1]}).`);
            buffered = buffered.subarray(replyLength);
            const requestHeader = `${method} ${requestPath} HTTP/1.1\r\n${Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`;
            socket.write(Buffer.concat([Buffer.from(requestHeader, 'utf8'), bodyBuffer]));
            stage = 'http';
            continue;
          }

          const headerEnd = buffered.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const responseHeaderLines = buffered.subarray(0, headerEnd).toString('ascii').split('\r\n');
          const statusLine = responseHeaderLines.shift();
          const match = /^HTTP\/\d\.\d (\d{3})\b/.exec(statusLine);
          if (!match) throw new Error('Onion service returned an invalid HTTP response.');
          const statusCode = Number(match[1]);
          const responseHeaders = {};
          for (const line of responseHeaderLines) {
            const separator = line.indexOf(':');
            if (separator > 0) responseHeaders[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
          }
          if (responseHeaders['transfer-encoding']?.toLowerCase().includes('chunked')) throw new Error('Chunked onion-service responses are not supported.');
          const contentLength = Number(responseHeaders['content-length']);
          if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxResponseBytes) throw new Error('Onion service returned an invalid or oversized response.');
          if (buffered.length - headerEnd - 4 < contentLength) return;
          const responseBody = buffered.subarray(headerEnd + 4, headerEnd + 4 + contentLength);
          finish(null, { statusCode, headers: responseHeaders, body: responseBody.toString('utf8') });
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function probeOnionService(address, socksPort, timeoutMs = 30000, signal) {
  const response = await requestOnionService(address, socksPort, { timeoutMs, signal });
  if (response.statusCode < 200 || response.statusCode >= 400) throw new Error(`Onion service returned HTTP ${response.statusCode}.`);
  return response.statusCode;
}

async function waitForOnionService(address, socksPort, { timeoutMs = 120000, attemptTimeoutMs = 15000, retryDelayMs = 5000, headers, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Onion-service check was cancelled.');
    const remaining = deadline - Date.now();
    try {
      const response = await requestOnionService(address, socksPort, { timeoutMs: Math.min(attemptTimeoutMs, remaining), headers, signal });
      if (response.statusCode < 200 || response.statusCode >= 400) throw new Error(`Onion service returned HTTP ${response.statusCode}.`);
      return response.statusCode;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
    const delay = Math.min(retryDelayMs, deadline - Date.now());
    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, delay);
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('Onion-service check was cancelled.'));
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
  throw new Error(`Onion service did not become reachable: ${lastError?.message || 'timed out'}`);
}

function saveTorHostingFolder(stateFilePath, folder, autoStart = true) {
  const realFolder = fs.realpathSync(folder);
  if (!fs.statSync(realFolder).isDirectory()) throw new Error('The saved Tor hosting path is not a directory.');
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify({ version: 1, folder: realFolder, autoStart: Boolean(autoStart) }), { encoding: 'utf8', mode: 0o600 });
  return realFolder;
}

function saveTorHostingAutoStart(stateFilePath, autoStart) {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    if (saved?.version !== 1 || typeof saved.folder !== 'string' || !saved.folder.trim()) return false;
    fs.writeFileSync(stateFilePath, JSON.stringify({ ...saved, autoStart: Boolean(autoStart) }), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function loadSavedTorHostingState(stateFilePath, hostnamePath) {
  let folder = '';
  let autoStart = false;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    if (saved?.version === 1 && typeof saved.folder === 'string' && saved.folder.trim()) {
      folder = path.resolve(saved.folder);
      autoStart = saved.autoStart === true;
    }
  } catch {}

  try {
    const hostname = fs.readFileSync(hostnamePath, 'utf8').trim();
    if (/^[a-z2-7]{56}\.onion$/i.test(hostname)) {
      const folderExists = folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory();
      return {
        status: 'stopped',
        onion: `http://${hostname}/`,
        folder,
        autoStart,
        message: folderExists && autoStart
          ? 'Tor hosting sa obnovuje na pozadí.'
          : folderExists
            ? 'Hosting je vypnutý. Uložená onion adresa čaká na spustenie.'
          : 'Hosting je vypnutý. Vyber priečinok webu a spusti ho ručne.'
      };
    }
  } catch {}

  return {
    status: 'stopped',
    onion: '',
    folder,
    autoStart,
    message: folder ? 'Hosting je vypnutý. Uložený priečinok čaká na ručné spustenie.' : 'Tor hosting je vypnutý.'
  };
}

module.exports = { createTorStaticRequestHandler, loadSavedTorHostingState, probeOnionService, requestOnionService, resolveHostedFile, saveTorHostingAutoStart, saveTorHostingFolder, waitForOnionService };