const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimTorChatGuest,
  clearTorChatFileTransfer,
  createTorChatRoom,
  createTorChatServer,
  enqueueTorChatFileChunk,
  enqueueTorChatMessage,
  enqueueTorChatVideoFrame,
  getTorChatReceipts,
  getTorChatFileChunks,
  getTorChatVideoState,
  isAuthorizedTorChatRequest,
  isValidTorChatEnvelope,
  isValidTorChatFileChunk,
  markTorChatMessagesDelivered,
  markTorChatMessagesRead,
  stopTorChatVideo
} = require('../lib/tor-chat-protocol.cjs');
const { decrypt, encrypt, generateKey, importKey } = require('../lib/tor-chat-crypto.js');

test('onion invitation authorizes one joining client only', () => {
  const room = createTorChatRoom('invite-secret');
  assert.equal(isAuthorizedTorChatRequest({ headers: { authorization: 'Bearer invite-secret' } }, room.token), true);
  assert.equal(isAuthorizedTorChatRequest({ headers: { authorization: 'Bearer wrong-secret' } }, room.token), false);
  assert.equal(claimTorChatGuest({ headers: { 'x-linsoft-chat-client': 'a'.repeat(24) } }, room), true);
  assert.equal(claimTorChatGuest({ headers: { 'x-linsoft-chat-client': 'b'.repeat(24) } }, room), false);
  assert.equal(claimTorChatGuest({ headers: { 'x-linsoft-chat-client': 'a'.repeat(24) } }, room), true);
});

test('chat queue accepts encrypted envelopes and drops old messages at its bound', () => {
  const room = createTorChatRoom('invite-secret');
  assert.equal(isValidTorChatEnvelope({ iv: 'abcdefghijklmnop', ciphertext: 'encrypted-payload' }), true);
  assert.equal(isValidTorChatEnvelope({ iv: 'short', ciphertext: 'plaintext' }), false);
  for (let index = 0; index < 205; index += 1) {
    assert.ok(enqueueTorChatMessage(room, index % 2 ? 'guest' : 'host', { iv: 'abcdefghijklmnop', ciphertext: `encrypted${index}` }));
  }
  assert.equal(room.messages.length, 200);
  assert.equal(room.messages[0].id, 6);
  assert.equal(room.messages.at(-1).id, 205);
  assert.equal(Object.hasOwn(room.messages[0], 'text'), false);
});

test('chat receipts track delivery and reading only in the in-memory room', () => {
  const room = createTorChatRoom('invite-secret');
  const message = enqueueTorChatMessage(room, 'host', { iv: 'abcdefghijklmnop', ciphertext: 'encrypted' });
  assert.deepEqual(getTorChatReceipts(room, 'host'), [{ id: message.id, deliveredAt: null, readAt: null }]);
  markTorChatMessagesDelivered(room, 'guest', [message]);
  assert.ok(message.deliveredAt);
  assert.equal(markTorChatMessagesRead(room, 'guest', [message.id]), true);
  assert.ok(message.readAt);
  assert.equal(markTorChatMessagesRead(room, 'guest', ['invalid']), false);
});

test('video transport retains only the latest encrypted frame per participant', () => {
  const room = createTorChatRoom('invite-secret');
  assert.ok(enqueueTorChatVideoFrame(room, 'host', { iv: 'abcdefghijklmnop', ciphertext: 'frame-one' }));
  const latest = enqueueTorChatVideoFrame(room, 'host', { iv: 'qrstuvwxyzABCDEF', ciphertext: 'frame-two' });
  assert.deepEqual(getTorChatVideoState(room, 'guest', 0), { active: true, frame: latest });
  assert.equal(getTorChatVideoState(room, 'guest', latest.id).frame, null);
  assert.equal(room.messages.length, 0);
  assert.equal(enqueueTorChatVideoFrame(room, 'guest', { iv: 'bad', ciphertext: 'plaintext' }), null);
  assert.equal(stopTorChatVideo(room, 'host'), true);
  assert.deepEqual(getTorChatVideoState(room, 'guest', 0), { active: false, frame: null });
});

test('file transfer stores bounded encrypted chunks per participant and clears on receipt', () => {
  const room = createTorChatRoom('invite-secret');
  const fileId = 'a'.repeat(24);
  const manifest = { fileId, index: 0, total: 2, iv: 'abcdefghijklmnop', ciphertext: 'encrypted-manifest' };
  const payload = { fileId, index: 1, total: 2, iv: 'qrstuvwxyzABCDEF', ciphertext: 'encrypted-file-bytes' };
  assert.equal(isValidTorChatFileChunk(manifest), true);
  assert.ok(enqueueTorChatFileChunk(room, 'host', manifest));
  assert.equal(enqueueTorChatFileChunk(room, 'guest', payload), null);
  assert.ok(enqueueTorChatFileChunk(room, 'host', payload));
  assert.deepEqual(getTorChatFileChunks(room, 'guest', -1).chunks.map((chunk) => chunk.index), [0, 1]);
  assert.equal(getTorChatFileChunks(room, 'guest', 1).chunks.length, 0);
  assert.equal(enqueueTorChatFileChunk(room, 'host', { ...payload, fileId: 'b'.repeat(24) }), null);
  assert.equal(clearTorChatFileTransfer(room, 'host', fileId), true);
  assert.equal(getTorChatFileChunks(room, 'guest', -1), null);
  assert.equal(room.messages.length, 0);
});

test('chat API authenticates, accepts encrypted messages, and rejects a second guest', async () => {
  const room = createTorChatRoom('test-invitation-token');
  const server = createTorChatServer(room);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/_linsoft/chat/v1`;
    const invitationHeaders = { Authorization: 'Bearer test-invitation-token' };
    assert.equal((await fetch(`${baseUrl}/health`, { headers: invitationHeaders })).status, 200);
    const firstClientHeaders = { ...invitationHeaders, 'X-Linsoft-Chat-Client': 'a'.repeat(24) };
    const firstPoll = await fetch(`${baseUrl}/messages?after=0`, { headers: firstClientHeaders });
    assert.equal(firstPoll.status, 200);

    const envelope = { iv: 'abcdefghijklmnop', ciphertext: 'ciphertext-only' };
    const sent = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { ...firstClientHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope)
    });
    assert.equal(sent.status, 201);
    const received = await fetch(`${baseUrl}/messages?after=0`, { headers: firstClientHeaders });
    const result = await received.json();
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].ciphertext, envelope.ciphertext);
    assert.equal(Object.hasOwn(result.messages[0], 'text'), false);
    assert.equal(result.messages[0].deliveredAt, null);

    const hostMessage = enqueueTorChatMessage(room, 'host', envelope);
    const delivered = await fetch(`${baseUrl}/messages?after=1`, { headers: firstClientHeaders });
    assert.equal(delivered.status, 200);
    assert.ok(hostMessage.deliveredAt);
    const readReceipt = await fetch(`${baseUrl}/receipts`, {
      method: 'POST',
      headers: { ...firstClientHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [hostMessage.id] })
    });
    assert.equal(readReceipt.status, 200);
    assert.ok(hostMessage.readAt);

    const secondClient = await fetch(`${baseUrl}/messages?after=0`, { headers: { ...invitationHeaders, 'X-Linsoft-Chat-Client': 'b'.repeat(24) } });
    assert.equal(secondClient.status, 403);
    const unauthorized = await fetch(`${baseUrl}/health`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('video API relays only the latest encrypted frame and clears it when a peer stops', async () => {
  const room = createTorChatRoom('video-invitation-token');
  const server = createTorChatServer(room);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const videoUrl = `http://127.0.0.1:${address.port}/_linsoft/chat/v1/video`;
    const headers = { Authorization: 'Bearer video-invitation-token', 'X-Linsoft-Chat-Client': 'c'.repeat(24) };
    const hostFrame = enqueueTorChatVideoFrame(room, 'host', { iv: 'abcdefghijklmnop', ciphertext: 'host-encrypted-frame' });
    const guestPoll = await fetch(`${videoUrl}?after=0`, { headers });
    const guestState = await guestPoll.json();
    assert.equal(guestPoll.status, 200);
    assert.equal(guestState.active, true);
    assert.equal(guestState.frame.ciphertext, 'host-encrypted-frame');

    const guestFrame = await fetch(videoUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ iv: 'qrstuvwxyzABCDEF', ciphertext: 'guest-encrypted-frame' })
    });
    assert.equal(guestFrame.status, 201);
    assert.equal(getTorChatVideoState(room, 'host', 0).frame.ciphertext, 'guest-encrypted-frame');

    const stop = await fetch(videoUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    });
    assert.equal(stop.status, 200);
    assert.deepEqual(getTorChatVideoState(room, 'host', 0), { active: false, frame: null });
    assert.ok(hostFrame);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('file API relays encrypted chunks in order and clears transfers after receipt', async () => {
  const room = createTorChatRoom('file-invitation-token');
  const server = createTorChatServer(room);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const filesUrl = `http://127.0.0.1:${address.port}/_linsoft/chat/v1/files`;
    const headers = { Authorization: 'Bearer file-invitation-token', 'X-Linsoft-Chat-Client': 'd'.repeat(24) };
    const hostFirstChunk = { fileId: 'a'.repeat(24), index: 0, total: 2, iv: 'abcdefghijklmnop', ciphertext: 'encrypted-manifest' };
    const hostSecondChunk = { fileId: 'a'.repeat(24), index: 1, total: 2, iv: 'qrstuvwxyzABCDEF', ciphertext: 'encrypted-host-data' };
    assert.ok(enqueueTorChatFileChunk(room, 'host', hostFirstChunk));
    assert.ok(enqueueTorChatFileChunk(room, 'host', hostSecondChunk));

    const firstPoll = await fetch(`${filesUrl}?after=-1`, { headers });
    const firstTransfer = await firstPoll.json();
    assert.equal(firstPoll.status, 200);
    assert.deepEqual(firstTransfer.transfer.chunks.map((chunk) => chunk.index), [0, 1]);
    assert.equal(Object.hasOwn(firstTransfer.transfer.chunks[0], 'fileName'), false);

    const guestFirstChunk = { fileId: 'b'.repeat(24), index: 0, total: 2, iv: 'abcdefghijklmnop', ciphertext: 'encrypted-manifest-guest' };
    const guestSecondChunk = { fileId: 'b'.repeat(24), index: 1, total: 2, iv: 'qrstuvwxyzABCDEF', ciphertext: 'encrypted-guest-data' };
    for (const chunk of [guestFirstChunk, guestSecondChunk]) {
      const uploaded = await fetch(filesUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk)
      });
      assert.equal(uploaded.status, 201);
    }
    assert.deepEqual(getTorChatFileChunks(room, 'host', -1).chunks.map((chunk) => chunk.index), [0, 1]);

    const completed = await fetch(`${filesUrl}/complete`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: hostFirstChunk.fileId })
    });
    assert.equal(completed.status, 200);
    assert.equal(getTorChatFileChunks(room, 'guest', -1), null);
    const cancelled = await fetch(`${filesUrl}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: guestFirstChunk.fileId })
    });
    assert.equal(cancelled.status, 200);
    assert.equal(getTorChatFileChunks(room, 'host', -1), null);
    assert.equal(room.messages.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('expired onion invitations are rejected before a guest claims the room', async () => {
  const room = createTorChatRoom('expired-invitation-token', Date.now() - 1);
  const server = createTorChatServer(room);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/_linsoft/chat/v1/health`, {
      headers: { Authorization: 'Bearer expired-invitation-token' }
    });
    assert.equal(response.status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('chat message encryption round-trips and rejects a different invite key', async () => {
  const senderKey = await generateKey();
  const recipientKey = await importKey(senderKey.encoded);
  const wrongKey = await generateKey();
  const message = 'Ahoj cez onion';
  const envelope = await encrypt(senderKey.key, message);
  assert.notEqual(envelope.ciphertext, message);
  assert.equal(await decrypt(recipientKey, envelope), message);
  await assert.rejects(decrypt(wrongKey.key, envelope));
});