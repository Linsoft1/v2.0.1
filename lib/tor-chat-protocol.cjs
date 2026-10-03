const crypto = require('node:crypto');
const http = require('node:http');

const MAX_CHAT_MESSAGES = 200;
const CHAT_API_PREFIX = '/_linsoft/chat/v1';
const INVITATION_LIFETIME_MS = 15 * 60 * 1000;
const MAX_TOR_CHAT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOR_CHAT_FILE_CHUNKS = 90;
const MAX_TOR_CHAT_FILE_CIPHERTEXT = 44000;
const MAX_TOR_CHAT_FILE_TRANSFER_BYTES = 4 * 1024 * 1024;
const TOR_CHAT_FILE_TRANSFER_TTL_MS = 15 * 60 * 1000;
const MAX_TOR_CHAT_FILE_POLL_CHUNKS = 4;

function createTorChatRoom(token, inviteExpiresAt = Date.now() + INVITATION_LIFETIME_MS) {
  return { token, inviteExpiresAt, guestClientId: '', sequence: 0, messages: [], videoSequence: { host: 0, guest: 0 }, videoFrames: { host: null, guest: null }, videoActive: { host: false, guest: false }, fileTransfers: { host: null, guest: null } };
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
  const message = { id: ++room.sequence, sender, iv: envelope.iv, ciphertext: envelope.ciphertext, sentAt: Date.now(), deliveredAt: null, readAt: null };
  room.messages.push(message);
  if (room.messages.length > MAX_CHAT_MESSAGES) room.messages.splice(0, room.messages.length - MAX_CHAT_MESSAGES);
  return message;
}

function markTorChatMessagesDelivered(room, recipient, messages) {
  const sender = recipient === 'host' ? 'guest' : 'host';
  for (const message of messages) {
    if (message.sender === sender && !message.deliveredAt) message.deliveredAt = Date.now();
  }
}

function markTorChatMessagesRead(room, reader, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_CHAT_MESSAGES || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return false;
  const sender = reader === 'host' ? 'guest' : 'host';
  const selected = new Set(ids);
  for (const message of room.messages) {
    if (selected.has(message.id) && message.sender === sender) message.readAt ||= Date.now();
  }
  return true;
}

function getTorChatReceipts(room, sender) {
  return room.messages.filter((message) => message.sender === sender).map(({ id, deliveredAt, readAt }) => ({ id, deliveredAt, readAt }));
}

function enqueueTorChatVideoFrame(room, sender, envelope) {
  if (!room || !['host', 'guest'].includes(sender) || !isValidTorChatEnvelope(envelope)) return null;
  const frame = { id: ++room.videoSequence[sender], iv: envelope.iv, ciphertext: envelope.ciphertext, sentAt: Date.now() };
  room.videoFrames[sender] = frame;
  room.videoActive[sender] = true;
  return frame;
}

function stopTorChatVideo(room, sender) {
  if (!room || !['host', 'guest'].includes(sender)) return false;
  room.videoActive[sender] = false;
  room.videoFrames[sender] = null;
  return true;
}

function getTorChatVideoState(room, recipient, afterId = 0) {
  const sender = recipient === 'host' ? 'guest' : 'host';
  const frame = room?.videoFrames?.[sender];
  const active = Boolean(room?.videoActive?.[sender] && frame && Date.now() - frame.sentAt < 10000);
  if (room && !active) stopTorChatVideo(room, sender);
  return { active, frame: active && frame.id > afterId ? frame : null };
}

function isValidTorChatFileChunk(chunk) {
  return Boolean(chunk && /^[A-Za-z0-9_-]{24}$/.test(chunk.fileId || '')
    && Number.isSafeInteger(chunk.index) && chunk.index >= 0
    && Number.isSafeInteger(chunk.total) && chunk.total >= 2 && chunk.total <= MAX_TOR_CHAT_FILE_CHUNKS && chunk.index < chunk.total
    && typeof chunk.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(chunk.iv)
    && typeof chunk.ciphertext === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${MAX_TOR_CHAT_FILE_CIPHERTEXT}}$`).test(chunk.ciphertext));
}

function enqueueTorChatFileChunk(room, sender, chunk) {
  if (!room || !['host', 'guest'].includes(sender) || !isValidTorChatFileChunk(chunk)) return null;
  let transfer = room.fileTransfers[sender];
  if (transfer && Date.now() - transfer.updatedAt > TOR_CHAT_FILE_TRANSFER_TTL_MS) {
    room.fileTransfers[sender] = null;
    transfer = null;
  }
  if (!transfer) {
    if (chunk.index !== 0) return null;
    transfer = { fileId: chunk.fileId, total: chunk.total, chunks: new Array(chunk.total), encryptedBytes: 0, startedAt: Date.now(), updatedAt: Date.now() };
    room.fileTransfers[sender] = transfer;
  }
  if (transfer.fileId !== chunk.fileId || transfer.total !== chunk.total) return null;
  const previous = transfer.chunks[chunk.index];
  const nextBytes = transfer.encryptedBytes - (previous?.ciphertext.length || 0) + chunk.ciphertext.length;
  if (nextBytes > MAX_TOR_CHAT_FILE_TRANSFER_BYTES) return null;
  const storedChunk = { fileId: chunk.fileId, index: chunk.index, total: chunk.total, iv: chunk.iv, ciphertext: chunk.ciphertext };
  transfer.chunks[chunk.index] = storedChunk;
  transfer.encryptedBytes = nextBytes;
  transfer.updatedAt = Date.now();
  return storedChunk;
}

function getTorChatFileChunks(room, recipient, afterIndex = -1) {
  const sender = recipient === 'host' ? 'guest' : 'host';
  const transfer = getTorChatFileTransfer(room, sender);
  if (!transfer) return null;
  return {
    fileId: transfer.fileId,
    total: transfer.total,
    chunks: transfer.chunks.slice(afterIndex + 1, afterIndex + 1 + MAX_TOR_CHAT_FILE_POLL_CHUNKS).filter(Boolean)
  };
}

function getTorChatFileTransfer(room, sender) {
  const transfer = room?.fileTransfers?.[sender];
  if (transfer && Date.now() - transfer.updatedAt > TOR_CHAT_FILE_TRANSFER_TTL_MS) {
    room.fileTransfers[sender] = null;
    return null;
  }
  return transfer || null;
}

function clearTorChatFileTransfer(room, sender, fileId) {
  if (!room || !['host', 'guest'].includes(sender) || room.fileTransfers[sender]?.fileId !== fileId) return false;
  room.fileTransfers[sender] = null;
  return true;
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
      const receiptsPath = `${CHAT_API_PREFIX}/receipts`;
      const videoPath = `${CHAT_API_PREFIX}/video`;
      const filesPath = `${CHAT_API_PREFIX}/files`;
      const filesCompletePath = `${filesPath}/complete`;
      const filesCancelPath = `${filesPath}/cancel`;
      if (![healthPath, messagesPath, receiptsPath, videoPath, filesPath, filesCompletePath, filesCancelPath].includes(requestUrl.pathname)) return writeJson(response, 404, { ok: false, message: 'Not found.' });
      if (!isAuthorizedTorChatRequest(request, room.token)) return writeJson(response, 401, { ok: false, message: 'Invalid chat invitation.' });
      if (!room.guestClientId && Date.now() >= room.inviteExpiresAt) return writeJson(response, 410, { ok: false, message: 'This onion invitation has expired.' });
      if (requestUrl.pathname === healthPath && request.method === 'GET') return writeJson(response, 200, { ok: true });
      if (requestUrl.pathname === receiptsPath && request.method === 'POST') {
        if (!claimTorChatGuest(request, room)) return writeJson(response, 403, { ok: false, message: 'This invitation is already in use.' });
        try {
          const body = await readJson(request);
          if (!markTorChatMessagesRead(room, 'guest', body.ids)) return writeJson(response, 400, { ok: false, message: 'Invalid read receipt.' });
          return writeJson(response, 200, { ok: true });
        } catch (error) {
          return writeJson(response, error.statusCode || 400, { ok: false, message: error.message });
        }
      }
      if (requestUrl.pathname === videoPath) {
        if (!['GET', 'POST'].includes(request.method || '')) return writeJson(response, 405, { ok: false, message: 'Method not allowed.' });
        if (!claimTorChatGuest(request, room)) return writeJson(response, 403, { ok: false, message: 'This invitation is already in use.' });
        if (request.method === 'GET') {
          const after = Number(requestUrl.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) return writeJson(response, 400, { ok: false, message: 'Invalid video cursor.' });
          return writeJson(response, 200, { ok: true, ...getTorChatVideoState(room, 'guest', after) });
        }
        try {
          const body = await readJson(request);
          if (body?.active === false) {
            stopTorChatVideo(room, 'guest');
            return writeJson(response, 200, { ok: true });
          }
          const frame = enqueueTorChatVideoFrame(room, 'guest', body);
          if (!frame) return writeJson(response, 400, { ok: false, message: 'Invalid encrypted video frame.' });
          return writeJson(response, 201, { ok: true, id: frame.id });
        } catch (error) {
          return writeJson(response, error.statusCode || 400, { ok: false, message: error.message });
        }
      }
      if (requestUrl.pathname === filesPath || requestUrl.pathname === filesCompletePath || requestUrl.pathname === filesCancelPath) {
        if (!['GET', 'POST'].includes(request.method || '') || ([filesCompletePath, filesCancelPath].includes(requestUrl.pathname) && request.method !== 'POST')) return writeJson(response, 405, { ok: false, message: 'Method not allowed.' });
        if (!claimTorChatGuest(request, room)) return writeJson(response, 403, { ok: false, message: 'This invitation is already in use.' });
        if (requestUrl.pathname === filesPath && request.method === 'GET') {
          const after = Number(requestUrl.searchParams.get('after') ?? -1);
          if (!Number.isSafeInteger(after) || after < -1 || after >= MAX_TOR_CHAT_FILE_CHUNKS) return writeJson(response, 400, { ok: false, message: 'Invalid file cursor.' });
          return writeJson(response, 200, { ok: true, transfer: getTorChatFileChunks(room, 'guest', after), outgoingPending: Boolean(getTorChatFileTransfer(room, 'guest')) });
        }
        try {
          const body = await readJson(request, requestUrl.pathname === filesPath ? 48000 : 12000);
          if (requestUrl.pathname === filesCompletePath || requestUrl.pathname === filesCancelPath) {
            const sender = requestUrl.pathname === filesCompletePath ? 'host' : 'guest';
            if (typeof body.fileId !== 'string' || !clearTorChatFileTransfer(room, sender, body.fileId)) return writeJson(response, 404, { ok: false, message: 'File transfer not found.' });
            return writeJson(response, 200, { ok: true });
          }
          const chunk = enqueueTorChatFileChunk(room, 'guest', body);
          if (!chunk) return writeJson(response, 409, { ok: false, message: 'File chunk is invalid or another transfer is active.' });
          return writeJson(response, 201, { ok: true, index: chunk.index });
        } catch (error) {
          return writeJson(response, error.statusCode || 400, { ok: false, message: error.message });
        }
      }
      if (requestUrl.pathname !== messagesPath || !['GET', 'POST'].includes(request.method || '')) return writeJson(response, 405, { ok: false, message: 'Method not allowed.' });
      if (!claimTorChatGuest(request, room)) return writeJson(response, 403, { ok: false, message: 'This invitation is already in use.' });

      if (request.method === 'GET') {
        const after = Number(requestUrl.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) return writeJson(response, 400, { ok: false, message: 'Invalid message cursor.' });
        const messages = room.messages.filter((message) => message.id > after);
        markTorChatMessagesDelivered(room, 'guest', messages);
        return writeJson(response, 200, { ok: true, messages, receipts: getTorChatReceipts(room, 'guest') });
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

module.exports = { claimTorChatGuest, clearTorChatFileTransfer, createTorChatRoom, createTorChatServer, enqueueTorChatFileChunk, enqueueTorChatMessage, enqueueTorChatVideoFrame, getTorChatFileChunks, getTorChatFileTransfer, getTorChatReceipts, getTorChatVideoState, isAuthorizedTorChatRequest, isValidTorChatEnvelope, isValidTorChatFileChunk, markTorChatMessagesDelivered, markTorChatMessagesRead, stopTorChatVideo };