const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimTorChatGuest,
  createTorChatRoom,
  createTorChatServer,
  enqueueTorChatMessage,
  isAuthorizedTorChatRequest,
  isValidTorChatEnvelope
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

    const secondClient = await fetch(`${baseUrl}/messages?after=0`, { headers: { ...invitationHeaders, 'X-Linsoft-Chat-Client': 'b'.repeat(24) } });
    assert.equal(secondClient.status, 403);
    const unauthorized = await fetch(`${baseUrl}/health`);
    assert.equal(unauthorized.status, 401);
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