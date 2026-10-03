const crypto = require('node:crypto');
const http = require('node:http');

const MAX_CHAT_MESSAGES = 200;
const CHAT_API_PREFIX = '/_linsoft/chat/v1';

function createTorChatRoom(token) {
  return { token, guestClientId: '', sequence: 0, messages: [] };
}

function isAuthorizedTorChatRequest(request, expectedToken) {
  const actual = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expectedBuffer = Buffer.from(expectedToken || '', 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return expectedBuffer.length > 0 && expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function claimTorChatGuest(request, room) {
  const clientId = String(request.headers['x-linsoft-chat-client'] || '');
  if (!/^[A-Za-z0-9_-]{24}$/.test(clientId)) return false;
  if (!room.guestClientId) room.guestClientId = clientId;
  const expected = Buffer.from(room.guestClientId, 'utf8');
  const actual = Buffer.from(clientId, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isValidTorChatEnvelope(envelope) {
  return Boolean(envelope && typeof envelope.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(envelope.iv) && typeof envelope.ciphertext === 'string' && /^[A-Za-z0-9_-]{1,11000}$/.test(envelope.ciphertext));
}

function enqueueTorChatMessage(room, sender, envelope) {
  if (!room || !['host', 'guest'].includes(sender) || !isValidTorChatEnvelope(envelope)) return null;
  const message = { id: ++room.sequence, sender, iv: envelope.iv, ciphertext: envelope.ciphertext, sentAt: Date.now() };
  room.messages.push(message);
  if (room.messages.length > MAX_CHAT_MESSAGES) room.messages.splice(0, room.messages.length - MAX_CHAT_MESSAGES);
  return message;
}

function writeJson(response, statusCode, value) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close'
  });
  response.end(data);
}

function readJson(request, maximumBytes = 12000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Chat message is too large.'), { statusCode: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid chat message JSON.'), { statusCode: 400 })); }
    });
  });
}

function createTorChatServer(room) {
  return http.createServer((request, response) => {
    const handle = async () => {
      let requestUrl;
      try { requestUrl = new URL(request.url || '/', 'http://127.0.0.1'); }
      catch { return writeJson(response, 400, { ok: false, message: 'Invalid URL.' }); }
      const healthPath = `${CHAT_API_PREFIX}/health`;
      const messagesPath = `${CHAT_API_PREFIX}/messages`;
      if (requestUrl.pathname !== healthPath && requestUrl.pathname !== messagesPath) return writeJson(response, 404, { ok: false, message: 'Not found.' });
      if (!isAuthorizedTorChatRequest(request, room.token)) return writeJson(response, 401, { ok: false, message: 'Invalid chat invitation.' });
      if (requestUrl.pathname === healthPath && request.method === 'GET') return writeJson(response, 200, { ok: true });
      if (requestUrl.pathname !== messagesPath || !['GET', 'POST'].includes(request.method || '')) return writeJson(response, 405, { ok: false, message: 'Method not allowed.' });
      if (!claimTorChatGuest(request, room)) return writeJson(response, 403, { ok: false, message: 'This invitation is already in use.' });

      if (request.method === 'GET') {
        const after = Number(requestUrl.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) return writeJson(response, 400, { ok: false, message: 'Invalid message cursor.' });
        return writeJson(response, 200, { ok: true, messages: room.messages.filter((message) => message.id > after) });
      }

      try {
        const envelope = await readJson(request);
        if (!isValidTorChatEnvelope(envelope)) return writeJson(response, 400, { ok: false, message: 'Invalid encrypted message.' });
        const message = enqueueTorChatMessage(room, 'guest', envelope);
        return writeJson(response, 201, { ok: true, id: message.id });
      } catch (error) {
        return writeJson(response, error.statusCode || 400, { ok: false, message: error.message });
      }
    };

    handle().catch(() => {
      if (!response.headersSent) writeJson(response, 500, { ok: false, message: 'Chat request failed.' });
      else response.destroy();
    });
  });
}

module.exports = { claimTorChatGuest, createTorChatRoom, createTorChatServer, enqueueTorChatMessage, isAuthorizedTorChatRequest, isValidTorChatEnvelope };