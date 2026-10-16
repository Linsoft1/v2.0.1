const addressInput = document.getElementById('addressInput');
const content = document.getElementById('content');
const tabTitle = document.getElementById('tabTitle');
const isGuestWindow = new URLSearchParams(window.location.search).has('guest');
const isNativeTabs = new URLSearchParams(window.location.search).has('nativeTabs');
const windowSessionId = new URLSearchParams(window.location.search).get('session');
const sessionStorageKey = (key) => `linsoft-${key}${/^[0-9a-f-]{36}$/i.test(windowSessionId || '') ? `-${windowSessionId}` : ''}`;
document.getElementById('guestIndicator').hidden = !isGuestWindow;
const torChatUi = { role: '', onion: '', invite: '', inviteQr: '', expiresAt: 0, expiryTimer: null, guestConnected: false, pendingReadIds: [], reconnectAttempts: 0, scanning: false, videoActive: false, videoStarting: false, videoStream: null, videoSendTimer: null, videoPollTimer: null, videoLastId: 0, videoGeneration: 0, videoSending: false, videoPolling: false, videoStatus: 'Video-only cez Tor; kvalita prispôsobená sieti.', fileTimer: null, fileGeneration: 0, filePolling: false, fileSending: false, outgoingFileId: '', fileCursor: -1, incomingFile: null, key: null, lastId: 0, messages: [], pollTimer: null, polling: false, busy: false, generation: 0, status: 'stopped', statusMessage: 'Onion chat je vypnutý.' };
let torChatPanel = null;
let torChatScannerControls = null;
async function importTorChatKey(encodedKey) { return window.linsoftTorChatCrypto.importKey(encodedKey); }
async function encryptTorChatMessage(text) { return window.linsoftTorChatCrypto.encrypt(torChatUi.key, text); }
async function decryptTorChatMessage(message) { return window.linsoftTorChatCrypto.decrypt(torChatUi.key, message); }
function formatTorChatFileSize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }
function parseTorChatInvitation(value) {
  const invite = new URL(String(value || '').trim());
  const [token, encodedKey, extra] = invite.hash.slice(1).split('.');
  if (invite.protocol !== 'http:' || !/^[a-z2-7]{56}\.onion$/i.test(invite.hostname) || invite.username || invite.password || invite.pathname !== '/' || invite.search || extra !== undefined || !/^[A-Za-z0-9_-]{32}$/.test(token || '') || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey || '')) throw new Error('Vlož platnú onion pozvánku od druhého účastníka.');
  return { address: `${invite.origin}/`, token, encodedKey };
}
function isPdfDocumentUrl(value) {
  try { return /\.pdf$/i.test(decodeURIComponent(new URL(String(value)).pathname)); }
  catch { return false; }
}
async function stopTorChatQrScanner(chatPanel = torChatPanel) {
  torChatScannerControls?.stop();
  torChatScannerControls = null;
  const scanner = chatPanel?.querySelector('#torChatScanner');
  const video = chatPanel?.querySelector('#torChatScannerVideo');
  if (video?.srcObject) {
    for (const track of video.srcObject.getTracks()) track.stop();
    video.srcObject = null;
  }
  if (scanner) scanner.hidden = true;
  await window.linsoftBrowser?.releaseTorChatCamera?.();
  torChatUi.scanning = false;
  if (torChatPanel?.isConnected) renderTorChatState();
}
async function startTorChatQrScanner(chatPanel) {
  if (torChatScannerControls || torChatUi.scanning || torChatUi.busy || torChatUi.role) return;
  torChatUi.scanning = true;
  renderTorChatState();
  const panel = chatPanel.querySelector('#torChatScanner');
  const status = chatPanel.querySelector('#torChatScannerStatus');
  panel.hidden = false;
  status.textContent = 'Čaká sa na povolenie kamery...';
  try {
    const permission = await window.linsoftBrowser?.authorizeTorChatCamera?.();
    if (!permission?.ok) throw new Error(permission?.message || 'Prístup ku kamere bol zrušený.');
    if (!navigator.mediaDevices?.getUserMedia || !window.ZXingBrowser?.BrowserQRCodeReader) throw new Error('QR skener nie je v tomto zariadení dostupný.');
    status.textContent = 'Namier kameru na QR pozvánku.';
    const reader = new window.ZXingBrowser.BrowserQRCodeReader();
    let invitationQueued = false;
    torChatScannerControls = await reader.decodeFromVideoDevice(undefined, chatPanel.querySelector('#torChatScannerVideo'), (result) => {
      if (!result || invitationQueued) return;
      const value = result.getText();
      try {
        parseTorChatInvitation(value);
        invitationQueued = true;
        chatPanel.querySelector('#torChatInviteInput').value = value;
        status.textContent = 'Pozvánka načítaná. Pripájam...';
        void stopTorChatQrScanner(chatPanel).then(() => chatPanel.querySelector('#torChatJoin').click());
      } catch {
        status.textContent = 'Tento QR kód neobsahuje platnú Onion Chat pozvánku.';
      }
    });
  } catch (error) {
    await stopTorChatQrScanner(chatPanel);
    torChatUi.statusMessage = error instanceof Error ? error.message : 'QR skener sa nepodarilo spustiť.';
    renderTorChatState();
  }
}
async function startTorChatVideoCall(chatPanel = torChatPanel) {
  if (!chatPanel || torChatUi.videoActive || torChatUi.videoStarting || torChatUi.role === '' || torChatUi.status !== 'connected' || !torChatUi.key) return;
  const generation = ++torChatUi.videoGeneration;
  torChatUi.videoStarting = true;
  torChatUi.videoStatus = 'Žiadam o povolenie kamery...';
  renderTorChatState();
  try {
    const permission = await window.linsoftBrowser?.authorizeTorChatCamera?.('video');
    if (!permission?.ok) throw new Error(permission?.message || 'Prístup ku kamere bol zrušený.');
    torChatUi.videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 1, max: 2 } }, audio: false });
    if (generation !== torChatUi.videoGeneration) {
      torChatUi.videoStream.getTracks().forEach((track) => track.stop());
      return;
    }
    const localVideo = chatPanel.querySelector('#torChatLocalVideo');
    localVideo.srcObject = torChatUi.videoStream;
    await localVideo.play().catch(() => {});
    torChatUi.videoStarting = false;
    torChatUi.videoLastId = 0;
    torChatUi.videoActive = true;
    torChatUi.videoStatus = 'Video-only cez Tor. Nízka snímková frekvencia šetrí prenos.';
    renderTorChatState();
    void sendTorChatVideoFrame(chatPanel, generation);
    void pollTorChatVideoFrame(chatPanel, generation);
    torChatUi.videoSendTimer = setInterval(() => void sendTorChatVideoFrame(chatPanel, generation), 1400);
    torChatUi.videoPollTimer = setInterval(() => void pollTorChatVideoFrame(chatPanel, generation), 1400);
  } catch (error) {
    if (generation !== torChatUi.videoGeneration) return;
    torChatUi.videoStarting = false;
    torChatUi.videoStatus = error instanceof Error ? error.message : 'Video hovor sa nepodarilo spustiť.';
    await stopTorChatVideoCall(chatPanel, false);
    await window.linsoftBrowser?.releaseTorChatCamera?.();
    torChatUi.videoStatus = error instanceof Error ? error.message : 'Video hovor sa nepodarilo spustiť.';
    renderTorChatState();
  }
}
async function sendTorChatVideoFrame(chatPanel = torChatPanel, generation = torChatUi.videoGeneration) {
  if (!torChatUi.videoActive || torChatUi.videoSending || !torChatUi.key || generation !== torChatUi.videoGeneration) return;
  const video = chatPanel?.querySelector('#torChatLocalVideo');
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  torChatUi.videoSending = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = Math.max(90, Math.round(160 * video.videoHeight / video.videoWidth));
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    let frameData = canvas.toDataURL('image/jpeg', 0.3);
    if (frameData.length > 7600) frameData = canvas.toDataURL('image/jpeg', 0.16);
    const envelope = await encryptTorChatMessage(frameData);
    if (generation !== torChatUi.videoGeneration) return;
    if (envelope.ciphertext.length > 11000) {
      torChatUi.videoStatus = 'Snímka je príliš veľká pre bezpečný prenos cez Tor.';
      renderTorChatState();
      return;
    }
    const result = await window.linsoftBrowser?.sendTorChatVideoFrame?.(envelope);
    if (!result?.ok && generation === torChatUi.videoGeneration) torChatUi.videoStatus = result?.message || 'Video prenos sa obnovuje cez Tor.';
  } catch (error) {
    if (generation === torChatUi.videoGeneration) torChatUi.videoStatus = error instanceof Error ? error.message : 'Video snímku sa nepodarilo odoslať.';
  } finally {
    torChatUi.videoSending = false;
  }
}
async function pollTorChatVideoFrame(chatPanel = torChatPanel, generation = torChatUi.videoGeneration) {
  if (!torChatUi.videoActive || torChatUi.videoPolling || generation !== torChatUi.videoGeneration) return;
  torChatUi.videoPolling = true;
  try {
    const result = await window.linsoftBrowser?.pollTorChatVideo?.(torChatUi.videoLastId);
    if (generation !== torChatUi.videoGeneration || !torChatUi.videoActive) return;
    if (!result?.ok) {
      torChatUi.videoStatus = result?.message || 'Video prenos sa obnovuje cez Tor.';
      return;
    }
    if (result.frame && result.frame.id > torChatUi.videoLastId) {
      const dataUrl = await decryptTorChatMessage(result.frame);
      if (generation !== torChatUi.videoGeneration) return;
      if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Neplatná video snímka.');
      chatPanel.querySelector('#torChatRemoteVideo').src = dataUrl;
      torChatUi.videoLastId = result.frame.id;
      torChatUi.videoStatus = result.active ? 'Šifrované video cez Tor · nízka snímková frekvencia' : 'Kontakt ukončil video prenos.';
    } else if (!result.active) {
      chatPanel.querySelector('#torChatRemoteVideo').removeAttribute('src');
      torChatUi.videoStatus = 'Čakám na video druhého účastníka...';
    }
  } catch (error) {
    if (generation === torChatUi.videoGeneration) torChatUi.videoStatus = error instanceof Error ? error.message : 'Video snímku sa nepodarilo načítať.';
  } finally {
    torChatUi.videoPolling = false;
    if (chatPanel?.isConnected && torChatUi.videoActive) renderTorChatVideoStatus(chatPanel);
  }
}
function renderTorChatVideoStatus(chatPanel = torChatPanel) {
  const status = chatPanel?.querySelector('#torChatVideoStatus');
  if (status) status.textContent = torChatUi.videoStatus;
}
async function stopTorChatVideoCall(chatPanel = torChatPanel, notifyPeer = true) {
  if (!torChatUi.videoActive && !torChatUi.videoStarting && !torChatUi.videoStream) return;
  torChatUi.videoGeneration += 1;
  torChatUi.videoActive = false;
  torChatUi.videoStarting = false;
  clearInterval(torChatUi.videoSendTimer);
  clearInterval(torChatUi.videoPollTimer);
  torChatUi.videoSendTimer = null;
  torChatUi.videoPollTimer = null;
  torChatUi.videoStream?.getTracks().forEach((track) => track.stop());
  torChatUi.videoStream = null;
  torChatUi.videoSending = false;
  torChatUi.videoPolling = false;
  const localVideo = chatPanel?.querySelector('#torChatLocalVideo');
  if (localVideo) localVideo.srcObject = null;
  const remoteVideo = chatPanel?.querySelector('#torChatRemoteVideo');
  remoteVideo?.removeAttribute('src');
  if (notifyPeer) await window.linsoftBrowser?.stopTorChatVideo?.();
  await window.linsoftBrowser?.releaseTorChatCamera?.();
  torChatUi.videoStatus = 'Video hovor je vypnutý.';
  if (torChatPanel?.isConnected) renderTorChatState();
}
function scheduleTorChatFilePoll(delay = 1200) {
  if (torChatUi.fileTimer) clearTimeout(torChatUi.fileTimer);
  torChatUi.fileTimer = torChatUi.role ? setTimeout(pollTorChatFiles, delay) : null;
}
async function sendTorChatFile(file, chatPanel = torChatPanel) {
  const maximumBytes = 2 * 1024 * 1024;
  const chunkBytes = 24 * 1024;
  if (!file || !torChatUi.role || !torChatUi.key || torChatUi.fileSending) return;
  if (file.size > maximumBytes) {
    showToast('Súbor je väčší ako limit 2 MiB.');
    return;
  }
  const fileId = window.linsoftTorChatCrypto.encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const payloadChunks = Math.max(1, Math.ceil(file.size / chunkBytes));
  const total = payloadChunks + 1;
  const fileMessage = { id: `file-${fileId}`, sender: torChatUi.role, sentAt: Date.now(), file: { name: file.name.slice(0, 160), size: file.size, status: 'Pripravujem šifrovaný prenos...' } };
  const generation = torChatUi.fileGeneration;
  torChatUi.messages.push(fileMessage);
  if (torChatUi.messages.length > 200) torChatUi.messages.shift();
  torChatUi.fileSending = true;
  renderTorChatState();
  try {
    const manifest = JSON.stringify({ name: fileMessage.file.name, size: file.size, type: file.type || 'application/octet-stream' });
    const manifestEnvelope = await encryptTorChatMessage(manifest);
    const manifestResult = await window.linsoftBrowser?.sendTorChatFileChunk?.({ fileId, index: 0, total, ...manifestEnvelope });
    if (!manifestResult?.ok) throw new Error(manifestResult?.message || 'Súbor sa nepodarilo pripraviť.');
    torChatUi.outgoingFileId = fileId;
    for (let index = 0; index < payloadChunks; index += 1) {
      if (generation !== torChatUi.fileGeneration) return;
      const start = index * chunkBytes;
      const bytes = new Uint8Array(await file.slice(start, Math.min(file.size, start + chunkBytes)).arrayBuffer());
      const encoded = window.linsoftTorChatCrypto.encodeBase64Url(bytes);
      const envelope = await encryptTorChatMessage(encoded);
      const result = await window.linsoftBrowser?.sendTorChatFileChunk?.({ fileId, index: index + 1, total, ...envelope });
      if (!result?.ok) throw new Error(result?.message || 'Súbor sa nepodarilo odoslať cez Tor.');
      fileMessage.file.status = `Odosielam ${Math.round(((index + 1) / payloadChunks) * 100)} % cez Tor...`;
      renderTorChatMessages();
    }
    fileMessage.file.status = 'Odoslané do onion prenosu; čaká sa na príjemcu.';
  } catch (error) {
    if (generation !== torChatUi.fileGeneration) return;
    await window.linsoftBrowser?.cancelTorChatFileTransfer?.(fileId);
    if (torChatUi.outgoingFileId === fileId) torChatUi.outgoingFileId = '';
    fileMessage.file.status = error instanceof Error ? error.message : 'Súbor sa nepodarilo odoslať.';
  } finally {
    if (generation !== torChatUi.fileGeneration) return;
    torChatUi.fileSending = false;
    const input = chatPanel?.querySelector('#torChatFileInput');
    if (input) input.value = '';
    renderTorChatState();
  }
}
async function pollTorChatFiles() {
  if (!torChatUi.role || torChatUi.filePolling) return;
  const generation = torChatUi.fileGeneration;
  torChatUi.filePolling = true;
  try {
    const result = await window.linsoftBrowser?.pollTorChatFiles?.(torChatUi.fileCursor);
    if (generation !== torChatUi.fileGeneration) return;
    if (!result?.ok) throw new Error(result?.message || 'Súbor sa nepodarilo prijať cez Tor.');
    if (torChatUi.outgoingFileId && !result.outgoingPending) {
      const outgoing = torChatUi.messages.find((message) => message.id === `file-${torChatUi.outgoingFileId}`);
      if (outgoing?.file) { outgoing.file.status = 'Prenos súboru bol uzavretý.'; renderTorChatMessages(); }
      torChatUi.outgoingFileId = '';
      renderTorChatState();
    }
    const transfer = result.transfer;
    if (!transfer) {
      if (torChatUi.incomingFile) {
        torChatUi.incomingFile = null;
        torChatUi.fileCursor = -1;
      }
      const status = torChatPanel?.querySelector('#torChatFileStatus');
      if (status) { status.textContent = ''; status.hidden = true; }
      return;
    }
    if (!torChatUi.incomingFile || torChatUi.incomingFile.fileId !== transfer.fileId) {
      if (transfer.total < 2 || transfer.total > 90) throw new Error('Počet blokov súboru je neplatný.');
      torChatUi.incomingFile = { fileId: transfer.fileId, total: transfer.total, nextIndex: 0, manifest: null, chunks: new Array(transfer.total), receivedBytes: 0 };
      torChatUi.fileCursor = -1;
    }
    const incoming = torChatUi.incomingFile;
    for (const chunk of transfer.chunks || []) {
      if (generation !== torChatUi.fileGeneration) return;
      if (chunk.fileId !== incoming.fileId || chunk.total !== incoming.total || chunk.index < incoming.nextIndex) continue;
      if (chunk.index !== incoming.nextIndex) throw new Error('Poradie blokov prijatého súboru nesedí.');
      const plaintext = await decryptTorChatMessage(chunk);
      if (chunk.index === 0) {
        const manifest = JSON.parse(plaintext);
        if (typeof manifest.name !== 'string' || manifest.name.length > 160 || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > 2 * 1024 * 1024 || typeof manifest.type !== 'string') throw new Error('Metadáta súboru nie sú platné.');
        incoming.manifest = manifest;
      } else {
        const bytes = plaintext ? window.linsoftTorChatCrypto.decodeBase64Url(plaintext) : new Uint8Array(0);
        incoming.chunks[chunk.index] = bytes;
        incoming.receivedBytes += bytes.length;
        if (incoming.receivedBytes > 2 * 1024 * 1024) throw new Error('Súbor prekračuje limit 2 MiB.');
      }
      incoming.nextIndex += 1;
      torChatUi.fileCursor = chunk.index;
      const status = torChatPanel?.querySelector('#torChatFileStatus');
      if (status && incoming.manifest) {
        status.hidden = false;
        status.textContent = `Prijímam ${incoming.manifest.name}: ${formatTorChatFileSize(incoming.receivedBytes)} / ${formatTorChatFileSize(incoming.manifest.size)}`;
      }
    }
    if (incoming.nextIndex === incoming.total) {
      if (!incoming.manifest || incoming.receivedBytes !== incoming.manifest.size) throw new Error('Prijaté dáta sa nezhodujú s veľkosťou súboru.');
      const bytes = new Uint8Array(incoming.manifest.size);
      let offset = 0;
      for (let index = 1; index < incoming.total; index += 1) {
        const chunk = incoming.chunks[index];
        if (!chunk) throw new Error('Súbor neobsahuje všetky bloky.');
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const completed = await window.linsoftBrowser?.completeTorChatFile?.(incoming.fileId);
      if (!completed?.ok) throw new Error(completed?.message || 'Prijatý súbor sa nepodarilo potvrdiť.');
      torChatUi.messages.push({ id: `file-${incoming.fileId}`, sender: torChatUi.role === 'host' ? 'guest' : 'host', sentAt: Date.now(), file: { name: incoming.manifest.name, type: incoming.manifest.type, size: incoming.manifest.size, bytes, status: 'Prijaté · vyber Uložiť súbor' } });
      if (torChatUi.messages.length > 200) torChatUi.messages.shift();
      torChatUi.incomingFile = null;
      torChatUi.fileCursor = -1;
      const status = torChatPanel?.querySelector('#torChatFileStatus');
      if (status) { status.textContent = ''; status.hidden = true; }
      renderTorChatMessages();
    }
  } catch (error) {
    if (generation !== torChatUi.fileGeneration) return;
    const status = torChatPanel?.querySelector('#torChatFileStatus');
    if (status) { status.hidden = false; status.textContent = error instanceof Error ? error.message : 'Prenos súboru sa prerušil.'; }
  } finally {
    torChatUi.filePolling = false;
    if (generation === torChatUi.fileGeneration) scheduleTorChatFilePoll(torChatUi.incomingFile ? 500 : 1400);
  }
}
function renderTorChatMessages() {
  for (const list of document.querySelectorAll('.tor-chat-messages')) {
    list.replaceChildren();
    if (!torChatUi.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'tor-chat-message-empty';
      empty.textContent = torChatUi.role === 'host' ? 'Pozvánka je pripravená. Správy sa zobrazia po odoslaní.' : 'Táto konverzácia je šifrovaná medzi účastníkmi.';
      list.appendChild(empty);
    }
    for (const message of torChatUi.messages) {
      const bubble = document.createElement('article');
      bubble.className = `tor-chat-message${message.sender === torChatUi.role ? ' own' : ''}`;
      const meta = document.createElement('small');
      const receiptLabel = message.sender !== torChatUi.role ? '' : message.status === 'read' ? ' · Prečítané' : message.status === 'delivered' ? ' · Doručené' : ' · Odoslané';
      meta.textContent = `${message.sender === torChatUi.role ? 'Ty' : 'Kontakt'} · ${new Date(message.sentAt).toLocaleTimeString()}${receiptLabel}`;
      if (message.file) {
        const card = document.createElement('div');
        card.className = 'tor-chat-file-card';
        const title = document.createElement('strong');
        title.textContent = message.file.name;
        const details = document.createElement('small');
        details.className = 'tor-chat-file-details';
        details.textContent = `${formatTorChatFileSize(message.file.size)} · ${message.file.status || (message.file.bytes ? 'Pripravené na uloženie' : 'Prenos cez Tor')}`;
        card.append(title, details);
        if (message.file.bytes) {
          const download = document.createElement('button');
          download.className = 'tor-chat-file-save';
          download.type = 'button';
          download.textContent = 'Uložiť súbor';
          download.addEventListener('click', async () => {
            const data = window.linsoftTorChatCrypto.encodeBase64Url(message.file.bytes);
            const result = await window.linsoftBrowser?.saveTorChatFile?.({ name: message.file.name, data });
            showToast(result?.ok ? 'Súbor bol uložený.' : result?.cancelled ? 'Ukladanie bolo zrušené.' : (result?.message || 'Súbor sa nepodarilo uložiť.'));
          });
          card.appendChild(download);
        }
        bubble.append(meta, card);
      } else {
        const content = document.createElement('p');
        content.textContent = message.text;
        bubble.append(meta, content);
      }
      list.appendChild(bubble);
    }
    list.scrollTop = list.scrollHeight;
  }
}
function renderTorChatState() {
  const active = Boolean(torChatUi.role);
  for (const panel of document.querySelectorAll('.tor-chat-section')) {
    const query = (selector) => panel.querySelector(selector);
    const status = query('#torChatStatus');
    if (!status) continue;
    status.textContent = torChatUi.statusMessage;
    query('#torChatDot').dataset.status = torChatUi.status;
    query('#torChatHost').disabled = torChatUi.busy || active || torChatUi.scanning;
    query('#torChatJoin').disabled = torChatUi.busy || active || torChatUi.scanning;
    query('#torChatScan').disabled = torChatUi.busy || active || torChatUi.scanning;
    query('#torChatEnd').disabled = !active && !torChatUi.busy;
    query('#torChatInvitePanel').hidden = torChatUi.role !== 'host';
    query('#torChatInviteValue').value = torChatUi.invite;
    query('#torChatJoinPanel').hidden = active;
    query('#torChatConversation').hidden = !active;
    query('#torChatEmpty').hidden = active;
    query('#torChatMessage').disabled = !active;
    query('#torChatSend').disabled = !active || ['reconnecting', 'error', 'stopping'].includes(torChatUi.status);
    query('#torChatAttach').disabled = !active || !(torChatUi.role === 'guest' || torChatUi.guestConnected) || torChatUi.busy || torChatUi.fileSending || Boolean(torChatUi.outgoingFileId);
    query('#torChatFileStatus').hidden = !query('#torChatFileStatus').textContent;
    query('#torChatAttach').disabled = !active || !(torChatUi.role === 'guest' || torChatUi.guestConnected) || torChatUi.busy || torChatUi.fileSending || Boolean(torChatUi.outgoingFileId);
    query('#torChatFileStatus').hidden = !query('#torChatFileStatus').textContent;
    query('#torChatPeerName').textContent = torChatUi.role === 'guest' ? 'Hostiteľ onion služby' : 'Druhý účastník';
    query('#torChatPeerStatus').textContent = torChatUi.status === 'starting' ? 'Pripájanie k sieti Tor...' : torChatUi.status === 'stopping' ? 'Ukončujem chat...' : torChatUi.status === 'reconnecting' ? 'Obnovujem spojenie cez Tor...' : torChatUi.status === 'error' ? 'Spojenie sa prerušilo' : torChatUi.status === 'expired' ? 'Pozvánka vypršala' : torChatUi.role === 'guest' || torChatUi.guestConnected ? 'Pripojený cez Tor' : active ? 'Čaká sa na pripojenie' : 'Nepripojený';
    query('#torChatHeaderName').textContent = torChatUi.role === 'guest' ? 'Súkromná správa od hostiteľa' : 'Onion konverzácia';
    query('#torChatHeaderStatus').textContent = torChatUi.statusMessage;
    query('#torChatEnd').textContent = torChatUi.role === 'host' && !torChatUi.guestConnected ? 'Zrušiť pozvánku' : 'Ukončiť chat';
    query('#torChatRenewInvite').hidden = torChatUi.role !== 'host' || torChatUi.status !== 'expired';
    const videoButton = query('#torChatVideoCall');
    const canCall = torChatUi.role === 'guest' || torChatUi.guestConnected;
    videoButton.disabled = !canCall || torChatUi.busy || torChatUi.videoStarting || torChatUi.status !== 'connected';
    videoButton.textContent = torChatUi.videoStarting ? 'Spúšťam...' : torChatUi.videoActive ? 'Ukončiť video' : 'Video hovor';
    query('#torChatVideoPanel').hidden = !torChatUi.videoActive;
    query('#torChatVideoStatus').textContent = torChatUi.videoStatus;
    const qr = query('#torChatInviteQr');
    if (qr) { qr.src = torChatUi.inviteQr; qr.hidden = !torChatUi.inviteQr; }
    const expiry = query('#torChatInviteExpiry');
    if (expiry && torChatUi.role === 'host') {
      const seconds = Math.max(0, Math.ceil((torChatUi.expiresAt - Date.now()) / 1000));
      expiry.textContent = torChatUi.guestConnected ? 'Pozvánka bola použitá.' : seconds ? `Pozvánka vyprší o ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.` : 'Pozvánka vypršala. Zruš ju a vytvor novú.';
    }
  }
  renderTorChatMessages();
}
function stopTorChatPolling() {
  if (torChatUi.pollTimer) clearTimeout(torChatUi.pollTimer);
  torChatUi.pollTimer = null;
}
function scheduleTorChatPoll(delay = 2500) {
  stopTorChatPolling();
  if (torChatUi.role && torChatUi.status !== 'stopping') torChatUi.pollTimer = setTimeout(pollTorChatMessages, delay);
}
function startTorChatInviteCountdown() {
  if (torChatUi.expiryTimer) clearInterval(torChatUi.expiryTimer);
  torChatUi.expiryTimer = setInterval(() => {
    if (torChatUi.guestConnected || !torChatUi.expiresAt) {
      clearInterval(torChatUi.expiryTimer);
      torChatUi.expiryTimer = null;
      return;
    }
    if (Date.now() >= torChatUi.expiresAt) {
      torChatUi.status = 'expired';
      torChatUi.statusMessage = 'Pozvánka vypršala. Zruš ju a vytvor novú.';
    }
    renderTorChatState();
    if (torChatUi.status === 'expired') {
      clearInterval(torChatUi.expiryTimer);
      torChatUi.expiryTimer = null;
    }
  }, 1000);
}
async function pollTorChatMessages() {
  if (!torChatUi.role || torChatUi.polling) return;
  torChatUi.polling = true;
  try {
    const result = await window.linsoftBrowser?.pollTorChat?.(torChatUi.lastId);
    if (!result?.ok) throw new Error(result?.message || 'Tor chat sa odpojil.');
    for (const message of result.messages || []) {
      if (message.id <= torChatUi.lastId) continue;
      torChatUi.lastId = message.id;
      if (torChatUi.messages.some((item) => item.id === message.id)) continue;
      try {
        const text = await decryptTorChatMessage(message);
        torChatUi.messages.push({ id: message.id, sender: message.sender, sentAt: message.sentAt, text, status: message.deliveredAt ? 'delivered' : 'sent' });
        if (message.sender !== torChatUi.role) {
          torChatUi.pendingReadIds.push(message.id);
          if (torChatUi.pendingReadIds.length > 200) torChatUi.pendingReadIds.shift();
        }
        if (torChatUi.messages.length > 200) torChatUi.messages.shift();
      } catch {
        torChatUi.messages.push({ id: message.id, sender: message.sender, sentAt: message.sentAt, text: '[Správu sa nepodarilo dešifrovať.]' });
      }
    }
    torChatUi.reconnectAttempts = 0;
    for (const receipt of result.receipts || []) {
      const message = torChatUi.messages.find((item) => item.id === receipt.id && item.sender === torChatUi.role);
      if (message) message.status = receipt.readAt ? 'read' : receipt.deliveredAt ? 'delivered' : 'sent';
    }
    torChatUi.guestConnected = Boolean(result.guestConnected);
    if (torChatUi.guestConnected) {
      torChatUi.expiresAt = 0;
      if (torChatUi.expiryTimer) clearInterval(torChatUi.expiryTimer);
      torChatUi.expiryTimer = null;
    }
    if (result.invitationExpired) {
      torChatUi.status = 'expired';
      torChatUi.statusMessage = 'Pozvánka vypršala. Zruš ju a vytvor novú.';
    } else {
      torChatUi.status = torChatUi.guestConnected || torChatUi.role === 'guest' ? 'connected' : 'waiting';
      torChatUi.statusMessage = torChatUi.guestConnected || torChatUi.role === 'guest' ? 'Šifrovaný onion chat je pripojený cez Tor.' : 'Onion služba čaká na druhého účastníka.';
    }
    renderTorChatState();
    await flushTorChatReadReceipts();
  } catch (error) {
    torChatUi.reconnectAttempts += 1;
    torChatUi.status = 'reconnecting';
    const delaySeconds = Math.ceil(Math.min(30000, 2500 * (2 ** Math.min(torChatUi.reconnectAttempts, 4))) / 1000);
    torChatUi.statusMessage = `Spojenie sa prerušilo. Obnovujem cez Tor, pokus ${torChatUi.reconnectAttempts} (ďalší o ${delaySeconds} s). ${error instanceof Error ? error.message : ''}`.trim();
    renderTorChatState();
  } finally {
    torChatUi.polling = false;
    const retryDelay = Math.min(30000, 2500 * (2 ** Math.min(torChatUi.reconnectAttempts, 4)));
    scheduleTorChatPoll(torChatUi.status === 'reconnecting' ? retryDelay : torChatUi.status === 'expired' ? 10000 : 2500);
  }
}
function isTorChatTabVisible() {
  return document.visibilityState === 'visible' && tabs.get(activeTabId)?.url === 'linsoft://tor-chat';
}
async function flushTorChatReadReceipts() {
  if (!torChatUi.pendingReadIds.length || !isTorChatTabVisible()) return;
  const ids = [...new Set(torChatUi.pendingReadIds)];
  const result = await window.linsoftBrowser?.markTorChatMessagesRead?.(ids);
  if (result?.ok) torChatUi.pendingReadIds = torChatUi.pendingReadIds.filter((id) => !ids.includes(id));
}
function clearTorChatUi() {
  stopTorChatPolling();
  if (torChatUi.fileTimer) clearTimeout(torChatUi.fileTimer);
  torChatUi.fileTimer = null;
  torChatUi.fileGeneration += 1;
  torChatUi.filePolling = false;
  torChatUi.fileSending = false;
  torChatUi.outgoingFileId = '';
  torChatUi.fileCursor = -1;
  torChatUi.incomingFile = null;
  void stopTorChatQrScanner();
  void stopTorChatVideoCall();
  if (torChatUi.expiryTimer) clearInterval(torChatUi.expiryTimer);
  torChatUi.expiryTimer = null;
  torChatUi.role = '';
  torChatUi.onion = '';
  torChatUi.invite = '';
  torChatUi.inviteQr = '';
  torChatUi.expiresAt = 0;
  torChatUi.guestConnected = false;
  torChatUi.pendingReadIds = [];
  torChatUi.reconnectAttempts = 0;
  torChatUi.scanning = false;
  torChatUi.key = null;
  torChatUi.lastId = 0;
  torChatUi.messages = [];
  torChatUi.polling = false;
  torChatUi.busy = false;
  torChatUi.status = 'stopped';
  torChatUi.statusMessage = 'Onion chat je vypnutý.';
  renderTorChatMessages();
}
async function createTorChatHostSession(renew) {
  if (torChatUi.busy || (torChatUi.role && !renew)) return;
  const generation = ++torChatUi.generation;
  torChatUi.busy = true;
  torChatUi.status = 'starting';
  torChatUi.statusMessage = renew ? 'Vytváram novú onion pozvánku...' : 'Pripájam Tor a vytváram onion službu...';
  renderTorChatState();
  try {
    const generatedKey = await window.linsoftTorChatCrypto.generateKey();
    const result = renew
      ? await window.linsoftBrowser?.renewTorChatHost?.()
      : await window.linsoftBrowser?.startTorChatHost?.();
    if (generation !== torChatUi.generation) return;
    if (!result?.ok) throw new Error(result?.message || 'Onion chat sa nepodarilo spustiť.');
    torChatUi.role = 'host';
    torChatUi.onion = result.onion;
    torChatUi.key = generatedKey.key;
    torChatUi.invite = `${result.onion}#${result.token}.${generatedKey.encoded}`;
    torChatUi.expiresAt = result.expiresAt;
    const qrResult = await window.linsoftBrowser?.createTorChatInviteQr?.(torChatUi.invite);
    if (generation !== torChatUi.generation) return;
    torChatUi.inviteQr = qrResult?.ok ? qrResult.dataUrl : '';
    torChatUi.lastId = 0;
    torChatUi.messages = [];
    torChatUi.pendingReadIds = [];
    torChatUi.outgoingFileId = '';
    torChatUi.fileCursor = -1;
    torChatUi.incomingFile = null;
    torChatUi.fileGeneration += 1;
    torChatUi.reconnectAttempts = 0;
    torChatUi.guestConnected = false;
    torChatUi.busy = false;
    torChatUi.status = 'waiting';
    torChatUi.statusMessage = qrResult?.ok ? 'Onion služba čaká na druhého účastníka. Zdieľaj QR alebo pozvánku súkromne.' : 'Onion služba čaká na druhého účastníka. Pozvánku zdieľaj súkromne.';
    renderTorChatState();
    startTorChatInviteCountdown();
    scheduleTorChatPoll(0);
    scheduleTorChatFilePoll(0);
  } catch (error) {
    if (generation !== torChatUi.generation) return;
    torChatUi.busy = false;
    torChatUi.status = 'error';
    torChatUi.statusMessage = error instanceof Error ? error.message : 'Onion chat sa nepodarilo spustiť.';
    renderTorChatState();
  }
}
const historyStack = ['linsoft://start'];
let historyIndex = 0;
let activeTabId = 1;
let nextTabId = 2;
function isRestorableTabUrl(value) {
  if (typeof value !== 'string') return false;
  if (window.LinsoftTabState.internalUrls.has(value)) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'file:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
const tabs = new Map([[1, { id: 1, url: 'linsoft://start', title: 'Linsoft Browser', history: ['linsoft://start'], historyIndex: 0 }]]);
const closedTabs = (() => {
  try {
    return window.LinsoftTabState.normalizeClosedTabs(JSON.parse(localStorage.getItem(sessionStorageKey('closed-tabs')) || '[]'), isRestorableTabUrl);
  } catch { return []; }
})();
const outgoingTabTransfers = new Map();
const tabGroupColors = ['', 'blue', 'green', 'orange', 'red'];
const suspendedTabs = new Set();
let lastTabDragPosition = { x: 0, y: 0 };
const boundViewers = new WeakSet();
let savedBookmarks = [];
try {
  const storedBookmarks = JSON.parse(localStorage.getItem('linsoft-bookmarks') || '[]');
  savedBookmarks = Array.isArray(storedBookmarks) ? storedBookmarks.filter((item) => item && typeof item.url === 'string') : [];
} catch {
  localStorage.removeItem('linsoft-bookmarks');
}
let startFavorites = [];
try {
  const storedStartFavorites = JSON.parse(localStorage.getItem('linsoft-start-favorites') || '[]');
  startFavorites = Array.isArray(storedStartFavorites) ? storedStartFavorites.filter((item) => {
    try { return item && typeof item.title === 'string' && ['http:', 'https:'].includes(new URL(item.url).protocol); }
    catch { return false; }
  }) : [];
} catch {
  localStorage.removeItem('linsoft-start-favorites');
}
function normalizeInstalledApp(item, fallbackOrder = 0) {
  if (!item || typeof item !== 'object') return null;
  try {
    const url = new URL(String(item.url || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return { title: String(item.title || item.name || url.hostname).slice(0, 60), url: url.href, installedAt: Number(item.installedAt) || Date.now(), favorite: item.favorite === true, sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : fallbackOrder, ...(Number(item.lastOpenedAt) ? { lastOpenedAt: Number(item.lastOpenedAt) } : {}) };
  } catch { return null; }
}
let installedApps = [];
try {
  const storedApps = JSON.parse(localStorage.getItem('linsoft-apps') || '[]');
  installedApps = Array.isArray(storedApps) ? storedApps.map((item, index) => normalizeInstalledApp(item, index)).filter(Boolean) : [];
} catch { installedApps = []; }
const appCatalog = [
  ['Google', 'https://www.google.com', 'work'], ['Gmail', 'https://mail.google.com', 'work'], ['Google Drive', 'https://drive.google.com', 'work'], ['Google Calendar', 'https://calendar.google.com', 'work'],
  ['Microsoft 365', 'https://www.office.com', 'work'], ['Outlook', 'https://outlook.live.com', 'work'], ['GitHub', 'https://github.com', 'work'], ['Slack', 'https://app.slack.com', 'social'],
  ['Discord', 'https://discord.com/app', 'social'], ['Zoom', 'https://app.zoom.us', 'social'], ['Notion', 'https://www.notion.so', 'work'], ['Trello', 'https://trello.com', 'work'],
  ['Figma', 'https://www.figma.com', 'creative'], ['Canva', 'https://www.canva.com', 'creative'], ['Adobe Express', 'https://express.adobe.com', 'creative'], ['YouTube', 'https://www.youtube.com', 'media'],
  ['Spotify', 'https://open.spotify.com', 'media'], ['Netflix', 'https://www.netflix.com', 'media'], ['Twitch', 'https://www.twitch.tv', 'media'], ['Reddit', 'https://www.reddit.com', 'social'],
  ['Chess.com', 'https://www.chess.com', 'games'], ['Lichess', 'https://lichess.org', 'games'], ['Poki', 'https://poki.com', 'games'], ['CrazyGames', 'https://www.crazygames.com', 'games'],
  ['Miniclip', 'https://www.miniclip.com', 'games'], ['skribbl.io', 'https://skribbl.io', 'games'], ['Agar.io', 'https://agar.io', 'games'], ['Slither.io', 'https://slither.io', 'games'],
  ['GeoGuessr', 'https://www.geoguessr.com', 'games'], ['itch.io', 'https://itch.io', 'games'], ['Board Game Arena', 'https://boardgamearena.com', 'games'], ['Kahoot!', 'https://kahoot.it', 'games'],
  ['ChatGPT', 'https://chatgpt.com', 'work'], ['Claude', 'https://claude.ai', 'work'], ['Perplexity', 'https://www.perplexity.ai', 'work'], ['Microsoft Teams', 'https://teams.microsoft.com', 'social'],
  ['Asana', 'https://app.asana.com', 'work'], ['Jira', 'https://www.atlassian.com/software/jira', 'work'], ['Linear', 'https://linear.app', 'work'], ['Dropbox', 'https://www.dropbox.com', 'work'],
  ['OneDrive', 'https://onedrive.live.com', 'work'], ['Miro', 'https://miro.com', 'creative'], ['GitLab', 'https://gitlab.com', 'work'], ['Google Meet', 'https://meet.google.com', 'social'],
  ['Telegram Web', 'https://web.telegram.org', 'social'], ['Messenger', 'https://www.messenger.com', 'social'], ['Instagram', 'https://www.instagram.com', 'social'], ['LinkedIn', 'https://www.linkedin.com', 'social'],
  ['TikTok', 'https://www.tiktok.com', 'media'], ['Disney+', 'https://www.disneyplus.com', 'media'], ['Prime Video', 'https://www.primevideo.com', 'media'], ['SoundCloud', 'https://soundcloud.com', 'media'],
  ['Deezer', 'https://www.deezer.com', 'media'], ['Roblox', 'https://www.roblox.com', 'games'], ['Steam', 'https://store.steampowered.com', 'games'], ['Epic Games Store', 'https://store.epicgames.com', 'games'],
  ['Monday.com', 'https://monday.com', 'work'], ['ClickUp', 'https://app.clickup.com', 'work'], ['Airtable', 'https://airtable.com', 'work'], ['Todoist', 'https://todoist.com', 'work'], ['Calendly', 'https://calendly.com', 'work'],
  ['Photopea', 'https://www.photopea.com', 'creative'], ['Pixlr', 'https://pixlr.com', 'creative'], ['Spline', 'https://spline.design', 'creative'], ['Framer', 'https://www.framer.com', 'creative'], ['Excalidraw', 'https://excalidraw.com', 'creative'],
  ['WhatsApp Web', 'https://web.whatsapp.com', 'social'], ['Google Chat', 'https://chat.google.com', 'social'], ['Signal', 'https://signal.org', 'social'], ['Webex', 'https://web.webex.com', 'social'],
  ['Apple Music', 'https://music.apple.com', 'media'], ['Max', 'https://www.max.com', 'media'], ['Crunchyroll', 'https://www.crunchyroll.com', 'media'], ['Pinterest', 'https://www.pinterest.com', 'social'],
  ['GeForce NOW', 'https://play.geforcenow.com', 'games'], ['Xbox Cloud Gaming', 'https://www.xbox.com/play', 'games'], ['Roblox Creator Hub', 'https://create.roblox.com', 'games'],
  ['Google Translate', 'https://translate.google.com', 'tools'], ['DeepL', 'https://www.deepl.com/translator', 'tools'], ['PDF24 Tools', 'https://tools.pdf24.org', 'tools'], ['Smallpdf', 'https://smallpdf.com', 'tools'],
  ['iLovePDF', 'https://www.ilovepdf.com', 'tools'], ['Speedtest', 'https://www.speedtest.net', 'tools'], ['VirusTotal', 'https://www.virustotal.com', 'tools'], ['QR Code Generator', 'https://www.qr-code-generator.com', 'tools'], ['Remove.bg', 'https://www.remove.bg', 'tools'],
  ['JSON Formatter', 'https://jsonformatter.org', 'tools'], ['JSONLint', 'https://jsonlint.com', 'tools'], ['Regex101', 'https://regex101.com', 'tools'], ['CodePen', 'https://codepen.io', 'tools'],
  ['JSFiddle', 'https://jsfiddle.net', 'tools'], ['StackBlitz', 'https://stackblitz.com', 'tools'], ['Replit', 'https://replit.com', 'tools'], ['CodeSandbox', 'https://codesandbox.io', 'tools'], ['OnlineGDB', 'https://www.onlinegdb.com', 'tools'],
  ['Stack Overflow', 'https://stackoverflow.com', 'tools'], ['diagrams.net', 'https://app.diagrams.net', 'tools'], ['Mermaid Live', 'https://mermaid.live', 'tools'], ['Google Fonts', 'https://fonts.google.com', 'tools'], ['Coolors', 'https://coolors.co', 'tools'],
  ['PageSpeed Insights', 'https://pagespeed.web.dev', 'tools'], ['GTmetrix', 'https://gtmetrix.com', 'tools'], ['DNSChecker', 'https://dnschecker.org', 'tools'], ['urlscan.io', 'https://urlscan.io', 'tools'], ['Have I Been Pwned', 'https://haveibeenpwned.com', 'tools'],
  ['CloudConvert', 'https://cloudconvert.com', 'tools'], ['Convertio', 'https://convertio.co', 'tools'], ['TinyWow', 'https://tinywow.com', 'tools'], ['Squoosh', 'https://squoosh.app', 'tools'], ['Sejda PDF', 'https://www.sejda.com', 'tools'],
  ['Desmos', 'https://www.desmos.com/calculator', 'tools'], ['WolframAlpha', 'https://www.wolframalpha.com', 'tools'], ['GeoGebra', 'https://www.geogebra.org/calculator', 'tools'], ['Reverso', 'https://www.reverso.net/text-translation', 'tools'], ['QR Code Monkey', 'https://www.qrcode-monkey.com', 'tools'],
  ['UptimeRobot', 'https://uptimerobot.com', 'tools'], ['web.dev Measure', 'https://pagespeed.web.dev', 'tools'], ['WebAIM Contrast Checker', 'https://webaim.org/resources/contrastchecker', 'tools']
];
const defaultStartFavorites = [
  { title: 'Google', url: 'https://www.google.com' },
  { title: 'YouTube', url: 'https://www.youtube.com' },
  { title: 'GitHub', url: 'https://github.com' },
  { title: 'Správy', url: 'https://news.google.com' }
];
const defaultSettings = { theme: 'dark', compact: false, uiFontScale: 'normal', startShowWeather: true, startShowFavorites: true, startShowFooter: true, startHiddenFavorites: [], startup: 'start', home: 'linsoft://start', search: 'Google', safe: true, popups: true, tracking: false, trackingProtection: true, downloads: 'Downloads', downloadFolderPath: '', askDownload: false, adBlock: true, clearExit: false, restoreTabs: true, suspendInactiveTabs: true, confirmClose: true, camera: false, autoUsbCamera: false, microphone: false, webNotifications: false, showBookmarksBar: false, showToolbarTools: false, spellcheckLanguages: null, autoUpdateCheck: true };
let settingsFromStorage = {};
try { settingsFromStorage = JSON.parse(localStorage.getItem('linsoft-settings') || '{}'); } catch { settingsFromStorage = {}; }
const settingsState = Object.assign({}, defaultSettings, settingsFromStorage);
const pageLoadStarts = new Map();
let usbCameraStream = null;
let usbCameraDeviceId = '';
let usbCameraTabId = null;
let usbCameraGeneration = 0;
let knownUsbCameraDeviceIds = [];
let usbCameraDeviceMonitorReady = false;
let recentPageLoadMetrics = [];
let mediaDeviceTestStream = null;
let mediaDeviceTestType = '';
let mediaDeviceTestAudioContext = null;
let mediaDeviceTestAnimationFrame = 0;
let mediaDeviceTestGeneration = 0;
try {
  const storedPageLoadMetrics = JSON.parse(localStorage.getItem('linsoft-page-load-metrics') || '[]');
  if (Array.isArray(storedPageLoadMetrics)) recentPageLoadMetrics = storedPageLoadMetrics.slice(0, 50);
} catch { localStorage.removeItem('linsoft-page-load-metrics'); }
let siteZooms = {};
try {
  const storedSiteZooms = JSON.parse(localStorage.getItem('linsoft-site-zooms') || '{}');
  if (storedSiteZooms && typeof storedSiteZooms === 'object' && !Array.isArray(storedSiteZooms)) siteZooms = storedSiteZooms;
} catch { localStorage.removeItem('linsoft-site-zooms'); }
if (!localStorage.getItem('linsoft-glass-blue-selected')) {
  settingsState.theme = 'glass-blue';
  localStorage.setItem('linsoft-glass-blue-selected', '1');
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
}
if (Number(settingsFromStorage.downloadBehaviorVersion || 0) < 2) {
  settingsState.askDownload = false;
  settingsState.downloadBehaviorVersion = 2;
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function bookmarkFaviconUrl(value) {
  try { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(value).hostname)}&sz=32`; }
  catch { return ''; }
}

let toastTimeout = null;
function showToast(message, actionLabel = '', onAction = null) {
  const toast = document.getElementById('toastNotice');
  if (!toast) return;
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = String(message || '');
  toast.replaceChildren(text);
  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.className = 'toast-action';
    action.type = 'button';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      clearTimeout(toastTimeout);
      toast.hidden = true;
      onAction();
    }, { once: true });
    toast.appendChild(action);
  }
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3600);
}

function beginPageLoadMeasurement(tabId, url) {
  let hostname = '';
  try { hostname = new URL(url || tabs.get(tabId)?.url || '').hostname; } catch {}
  pageLoadStarts.set(tabId, { startedAt: performance.now(), hostname, adBlock: settingsState.adBlock === true });
}

function finishPageLoadMeasurement(tabId) {
  const started = pageLoadStarts.get(tabId);
  if (!started) return;
  pageLoadStarts.delete(tabId);
  let hostname = '';
  try { hostname = new URL(tabs.get(tabId)?.url || '').hostname; } catch {}
  recentPageLoadMetrics.unshift({ hostname: hostname || started.hostname || 'neznámy web', durationMs: Math.max(0, Math.round(performance.now() - started.startedAt)), adBlock: started.adBlock, measuredAt: Date.now() });
  recentPageLoadMetrics = recentPageLoadMetrics.slice(0, 50);
  localStorage.setItem('linsoft-page-load-metrics', JSON.stringify(recentPageLoadMetrics));
  renderPageLoadMetrics();
}

function renderPageLoadMetrics() {
  const summary = document.getElementById('pageLoadMetricsSummary');
  const list = document.getElementById('pageLoadMetricsList');
  if (!summary || !list) return;
  const byHost = new Map();
  recentPageLoadMetrics.forEach((metric) => {
    if (!byHost.has(metric.hostname)) byHost.set(metric.hostname, { enabled: [], disabled: [] });
    byHost.get(metric.hostname)[metric.adBlock ? 'enabled' : 'disabled'].push(metric.durationMs);
  });
  const formatAverage = (samples) => samples.length ? `${(samples.reduce((sum, value) => sum + value, 0) / samples.length / 1000).toFixed(2)} s` : '—';
  const comparisons = [...byHost.entries()].slice(0, 4).map(([hostname, samples]) => `${hostname}: zapnutý ${formatAverage(samples.enabled)} / vypnutý ${formatAverage(samples.disabled)}`);
  summary.textContent = comparisons.length ? `Priemer pre rovnaký web · ${comparisons.join(' · ')}` : 'Meraj rovnaké weby s AdBlockom zapnutým aj vypnutým.';
  list.innerHTML = recentPageLoadMetrics.slice(0, 8).map((metric) => `<div class="page-load-metric"><strong>${escapeHtml(metric.hostname)}</strong><span>${(metric.durationMs / 1000).toFixed(2)} s</span><small>AdBlock ${metric.adBlock ? 'zapnutý' : 'vypnutý'}</small></div>`).join('') || '<small class="update-note">Zatiaľ nie sú zaznamenané načítania.</small>';
}

function updateActiveTab(url, title) {
  const tab = tabs.get(activeTabId);
  if (tab) {
    Object.assign(tab, { url, title });
    setTabIcon(tab.id, tab.url === 'linsoft://start' ? '' : (tab.icon || defaultWebsiteFaviconUrl(tab.url)), tab.url === 'linsoft://start');
  }
  const active = document.querySelector(`.managed-tab[data-tab-id="${activeTabId}"]`);
  if (active) { active.querySelector('span:nth-child(2)').textContent = title; active.title = `${title} - ${url}`; active.classList.add('active'); }
  document.querySelectorAll('.managed-tab').forEach((item) => {
    const selected = Number(item.dataset.tabId) === activeTabId;
    item.classList.toggle('active', selected);
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  updateTabDensity();
  updateConnectionIndicator(url);
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateTabDensity() {
  const buttons = document.querySelectorAll('.managed-tab');
  const tabsBar = document.querySelector('.tabs-bar');
  tabsBar?.classList.toggle('many-tabs', buttons.length >= 7);
  if (tabsBar) {
    tabsBar.dataset.tabCount = String(buttons.length);
    tabsBar.classList.toggle('tab-count-8', buttons.length >= 8);
    tabsBar.classList.toggle('tab-count-14', buttons.length >= 14);
    tabsBar.classList.toggle('tab-count-24', buttons.length >= 24);
  }
  buttons.forEach(updateTabLabel);
}

function updateTabLabel(button) {
  const tab = tabs.get(Number(button.dataset.tabId));
  if (!tab) return;
  const states = [tab.pinned ? 'Pripnutá karta' : '', tab.locked ? 'Zamknutá karta' : '', tab.muted ? 'Zvuk je vypnutý' : ''].filter(Boolean);
  button.setAttribute('aria-label', [tab.title, ...states].join(' · '));
  button.removeAttribute('title');
  button.classList.remove(...tabGroupColors.filter(Boolean).map((color) => `tab-group-${color}`));
  if (tab.group && tabGroupColors.includes(tab.group)) button.classList.add(`tab-group-${tab.group}`);
}

function defaultWebsiteFaviconUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? new URL('/favicon.ico', url.origin).href : '';
  } catch { return ''; }
}

function internalTabIcon(url) {
  if (url === 'linsoft://start') return '';
  let route = '';
  try { route = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  return ({
    apps: 'layout-grid',
    bookmarks: 'bookmark',
    camera: 'camera',
    history: 'history',
    settings: 'settings',
    'tor-chat': 'message-square'
  })[route] || '';
}

function setTabIcon(id, iconUrl = '', brandIcon = false) {
  const icon = document.querySelector(`.managed-tab[data-tab-id="${id}"] .tab-logo`);
  if (!icon) return;
  const tab = tabs.get(id);
  const internalIcon = internalTabIcon(tab?.url || '');
  if (internalIcon) {
    icon.style.backgroundImage = '';
    icon.innerHTML = `<svg class="ui-icon tab-internal-svg" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${internalIcon}"></use></svg>`;
    icon.dataset.internalIcon = internalIcon;
    return;
  }
  delete icon.dataset.internalIcon;
  const currentImage = icon.querySelector('.tab-favicon');
  if (iconUrl) {
    const requestedUrl = new URL(iconUrl, document.baseURI).href;
    if (currentImage?.src === requestedUrl) return;
    icon.style.backgroundImage = '';
    const image = document.createElement('img');
    image.className = 'tab-favicon';
    image.alt = '';
    image.draggable = false;
    image.onload = () => {
      if (image.parentElement === icon) image.hidden = false;
    };
    image.onerror = () => {
      if (image.parentElement !== icon) return;
      console.warn('Linsoft Browser could not load the website favicon:', iconUrl);
      image.remove();
      icon.textContent = 'L';
    };
    icon.replaceChildren(image);
    image.src = requestedUrl;
    return;
  }
  currentImage?.remove();
  icon.querySelector('.tab-internal-svg')?.remove();
  icon.textContent = brandIcon ? '' : 'L';
  icon.style.backgroundImage = brandIcon ? 'url("assets/linsoft-icon.svg")' : '';
}

function updateWebviewTabFavicon(id, viewer) {
  const tab = tabs.get(id);
  const pageUrl = viewer?.getURL?.();
  const fallback = defaultWebsiteFaviconUrl(pageUrl || '');
  if (!tab || !fallback || typeof viewer.executeJavaScript !== 'function') return;
  void viewer.executeJavaScript(`(() => {
    const links = [...document.querySelectorAll('link[rel][href]')];
    const icon = links.find(link => link.relList.contains('icon')) ||
      links.find(link => link.relList.contains('apple-touch-icon'));
    return icon?.href || ${JSON.stringify(fallback)};
  })()`).then((favicon) => {
    if (!tabs.has(id) || viewer.getURL?.() !== pageUrl || typeof favicon !== 'string') return;
    let parsed;
    try { parsed = new URL(favicon); } catch { return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return;
    tab.icon = parsed.href;
    setTabIcon(id, tab.icon);
    saveSession();
  }).catch((error) => {
    console.warn('Linsoft Browser could not read the website favicon:', error);
  });
}

function setTabAudioIcon(id, muted = false, playing = false) { const audio = document.querySelector(`.managed-tab[data-tab-id="${id}"] .tab-audio`); if (!audio) return; audio.textContent = muted ? '🔇' : playing ? '🔊' : ''; audio.title = muted ? 'Zapnúť zvuk' : 'Stlmiť kartu'; audio.setAttribute('aria-label', audio.title); }
const tabLoadingTimers = new Map();
const slowLoadingTabs = new Set();
const pendingTorNavigations = new Map();
let navigationTorStatus = { proxyEnabled: false, proxyStatus: 'stopped' };

function setTabLoading(id, loading) {
  const tab = tabs.get(id);
  if (tab) tab.loading = loading;
  const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
  if (!button) return;
  button.classList.toggle('loading', loading);
  if (loading && !tabLoadingTimers.has(id) && !slowLoadingTabs.has(id)) {
    tabLoadingTimers.set(id, window.setTimeout(() => {
      tabLoadingTimers.delete(id);
      if (!tabs.has(id) || !button.classList.contains('loading')) return;
      slowLoadingTabs.add(id);
      if (id === activeTabId) renderNavigationLoadingControls();
    }, 15000));
  } else if (!loading) {
    window.clearTimeout(tabLoadingTimers.get(id));
    tabLoadingTimers.delete(id);
    slowLoadingTabs.delete(id);
  }
  if (id === activeTabId) renderNavigationLoadingControls();
}

function renderNavigationLoadingControls() {
  const loading = Boolean(document.querySelector(`.managed-tab[data-tab-id="${activeTabId}"].loading`));
  const reload = document.getElementById('reloadButton');
  reload.title = loading ? 'Zastaviť načítavanie' : 'Obnoviť';
  reload.setAttribute('aria-label', reload.title);
  reload.querySelector('use').setAttribute('href', loading ? '#icon-x' : '#icon-rotate-cw');
  document.getElementById('slowLoadNotice').hidden = !loading || !slowLoadingTabs.has(activeTabId);
  document.getElementById('loadingTrack').classList.toggle('loading', loading);
  document.getElementById('securityButton').classList.toggle('address-loading', loading);
}

async function stopTabLoading(id = activeTabId) {
  try {
    const pendingTor = pendingTorNavigations.has(id);
    if (pendingTor) {
      pendingTorNavigations.delete(id);
    } else if (isNativeTabs) {
      const result = await window.linsoftBrowser?.nativeTabCommand?.({ tabId: id, command: 'stop' });
      if (!result?.ok) throw new Error(result?.message || 'Karta nie je dostupná.');
    } else {
      const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
      if (!viewer) throw new Error('Karta nie je dostupná.');
      viewer.stop();
    }
    setTabLoading(id, false);
    clearNavigationStatus(id);
    const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`);
    if (pendingTor && surface) {
      showNavigationStatus(id, { url: tabs.get(id)?.url, stopped: true });
    }
    if (id === activeTabId) showToast('Načítavanie bolo zastavené.');
  } catch (error) {
    console.error('Linsoft Browser could not stop page loading:', error);
    showToast(`Načítavanie sa nepodarilo zastaviť: ${error.message}`);
  }
}

function renderNavigationTorStatus(update) {
  navigationTorStatus = { ...navigationTorStatus, ...update };
  const status = navigationTorStatus;
  const label = status.proxyStatus === 'connecting' ? 'Tor sa pripája…'
    : status.proxyStatus === 'error' ? `Chyba Tor: ${status.proxyMessage || 'Pripojenie sa nepodarilo.'}`
      : status.proxyStatus === 'manual' ? 'Manuálna proxy je zapnutá (Tor nie je overený).'
        : status.proxyEnabled && status.proxyStatus === 'running' ? 'Tor je pripojený'
          : 'Tor je odpojený';
  document.querySelectorAll('.navigation-tor-status').forEach((element) => {
    element.textContent = label;
    element.dataset.status = status.proxyStatus;
  });
  renderSettingsConnectionOverview();
}

let settingsVpnStatus = { status: 'unknown', message: window.linsoftBrowser ? 'Stav VPN sa zisťuje.' : 'Dostupné v desktopovej aplikácii.' };
const settingsDrafts = new WeakMap();

function renderVpnControls() {
  const status = settingsVpnStatus.status;
  const busy = ['connecting', 'disconnecting'].includes(status);
  const active = busy || status === 'connected';
  document.querySelectorAll('[data-settings-panel="vpn"]').forEach((panel) => {
    const connect = panel.querySelector('#connectOpenVpn');
    const disconnect = panel.querySelector('#disconnectOpenVpn');
    const choose = panel.querySelector('#chooseOpenVpn');
    if (!connect || !disconnect || !choose) return;
    connect.disabled = !window.linsoftBrowser?.connectOpenVpn || !settingsState.openvpnProfile || active || status === 'unknown';
    connect.textContent = status === 'connecting' ? 'Pripájam...' : status === 'connected' ? 'VPN je pripojená' : 'Pripojiť VPN';
    disconnect.disabled = !window.linsoftBrowser?.disconnectOpenVpn || !active || status === 'disconnecting';
    disconnect.textContent = status === 'connecting' ? 'Zrušiť pripájanie' : status === 'disconnecting' ? 'Odpájam...' : 'Odpojiť';
    choose.disabled = active || !window.linsoftBrowser?.selectOpenVpnProfile;
    panel.querySelector('.settings-vpn-connection')?.setAttribute('aria-busy', String(busy));
    const hint = panel.querySelector('[data-vpn-hint]');
    if (hint) hint.textContent = !window.linsoftBrowser ? 'Ovládanie je dostupné v desktopovej aplikácii.'
      : status === 'connecting' ? 'Čakám na potvrdenie OpenVPN klienta. Pripájanie môžeš zrušiť.'
        : status === 'disconnecting' ? 'Čakám na ukončenie OpenVPN klienta.'
          : !settingsState.openvpnProfile ? 'Najprv vyber platný .ovpn profil.' : 'Pripojenie a odpojenie sa vykoná okamžite.';
  });
}

function renderSettingsConnectionOverview() {
  const tor = navigationTorStatus;
  const torLabel = tor.proxyStatus === 'connecting' ? 'Pripája sa' : tor.proxyStatus === 'error' ? `Chyba: ${tor.proxyMessage || 'Spojenie zlyhalo.'}` : tor.proxyEnabled && tor.proxyStatus === 'running' ? 'Pripojený' : 'Odpojený';
  const proxyLabel = tor.proxyStatus === 'manual' && tor.proxyEnabled ? tor.proxyMessage || 'Manuálna proxy je zapnutá' : 'Manuálna proxy je vypnutá';
  document.querySelectorAll('[data-connection-tor]').forEach((el) => { el.textContent = torLabel; el.dataset.status = tor.proxyStatus === 'manual' ? 'disconnected' : tor.proxyStatus; });
  document.querySelectorAll('[data-connection-proxy]').forEach((el) => { el.textContent = proxyLabel; el.dataset.status = tor.proxyStatus === 'manual' && tor.proxyEnabled ? 'connected' : 'disconnected'; });
  document.querySelectorAll('[data-connection-vpn]').forEach((el) => { el.textContent = settingsVpnStatus.message; el.dataset.status = settingsVpnStatus.status; });
  document.querySelectorAll('#openVpnStatus').forEach((el) => { el.textContent = settingsVpnStatus.message; });
  document.querySelectorAll('#openVpnDot').forEach((el) => { el.dataset.status = settingsVpnStatus.status; });
  renderVpnControls();
}

function confirmSettingsDeparture(id = activeTabId, discardChanges = true) {
  const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`);
  const draft = settingsDrafts.get(surface);
  if (!draft?.dirty()) return true;
  if (!window.confirm('Máte neuložené zmeny v Nastaveniach. Opustiť stránku bez ich uloženia? Zrušiť vás vráti k tlačidlu Uložiť zmeny.')) return false;
  if (discardChanges) draft.discard();
  return true;
}
function syncNativeTabLayout() {
  if (!isNativeTabs) return;
  const bounds = content.getBoundingClientRect();
  window.linsoftBrowser?.setNativeTabLayout?.({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}
function hideNativeTab() { if (isNativeTabs) window.linsoftBrowser?.deactivateNativeTab?.(); }
new ResizeObserver(syncNativeTabLayout).observe(content);

function bindTabButton(button, id) {
  button.addEventListener('click', (event) => { if (event.target.classList.contains('tab-close')) { event.preventDefault(); event.stopPropagation(); closeTab(id); } else if (event.target.classList.contains('tab-audio')) { event.preventDefault(); event.stopPropagation(); toggleTabMute(id); } else selectTab(id); });
  button.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });
  button.addEventListener('mouseenter', () => scheduleTabPreview(button, id));
  button.addEventListener('mouseleave', hideTabPreview);
  button.addEventListener('focus', () => scheduleTabPreview(button, id));
  button.addEventListener('blur', hideTabPreview);
  button.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = [...document.querySelectorAll('.managed-tab')];
    const index = buttons.indexOf(button);
    let target;
    if (event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length];
    else if (event.key === 'ArrowLeft') target = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === 'Home') target = buttons[0];
    else if (event.key === 'End') target = buttons[buttons.length - 1];
    else if (event.key === 'Delete') {
      event.preventDefault();
      closeTab(id);
      document.querySelector(`.managed-tab[data-tab-id="${activeTabId}"]`)?.focus();
      return;
    }
    if (!target) return;
    event.preventDefault();
    selectTab(Number(target.dataset.tabId));
    target.focus();
  });
  button.addEventListener('contextmenu', (event) => { event.preventDefault(); selectTab(id); showTabContextMenu(event.clientX, event.clientY, id); });
  bindTabDrag(button, id);
}

function createTabButton(tab) {
  const button = document.createElement('button');
  button.className = `tab managed-tab${tab.pinned ? ' pinned' : ''}${tab.locked ? ' locked' : ''}${tab.group ? ` tab-group-${tab.group}` : ''}`;
  button.dataset.tabId = tab.id;
  button.draggable = true;
  button.innerHTML = `<span class="tab-logo">L</span><span>${escapeHtml(tab.title)}</span><span class="tab-audio" aria-label="${tab.muted ? 'Zapnúť zvuk karty' : 'Stlmiť kartu'}" title="${tab.muted ? 'Zapnúť zvuk karty' : 'Stlmiť kartu'}">${tab.muted ? '🔇' : ''}</span><span class="tab-loading" aria-hidden="true"></span><span class="tab-close" title="${tab.locked ? 'Karta je zamknutá' : 'Zatvoriť kartu'}">${tab.locked ? '🔒' : '×'}</span>`;
  document.getElementById('tabStrip').appendChild(button);
  updateTabDensity();
  if (tab.url === 'linsoft://start') setTabIcon(tab.id, '', true);
  else setTabIcon(tab.id, tab.icon || defaultWebsiteFaviconUrl(tab.url));
  bindTabButton(button, tab.id);
  return button;
}

let tabPreviewTimer = 0;
let tabPreviewRequest = 0;
function hideTabPreview() {
  window.clearTimeout(tabPreviewTimer);
  tabPreviewRequest += 1;
  const preview = document.getElementById('tabPreview');
  if (preview) {
    preview.hidden = true;
    preview.setAttribute('aria-hidden', 'true');
  }
}
function cacheTabPreview(id) {
  const tab = tabs.get(id);
  if (!tab || !/^(https?:|file:)/i.test(tab.url)) return;
  const webview = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
  if (!isNativeTabs && !webview) return;
  const result = window.linsoftBrowser?.getTabPreview?.(isNativeTabs
    ? { tabId: id, active: true }
    : { webContentsId: webview?.getWebContentsId?.(), active: true });
  if (result?.then) void result.then((preview) => {
    if (!preview?.ok) console.warn('Linsoft Browser could not cache a tab preview:', preview?.message || 'Unknown error.');
  }).catch((error) => console.warn('Linsoft Browser could not cache a tab preview:', error));
}
function internalTabPreviewUrl(tab) {
  if (!/^linsoft:/i.test(tab.url || '')) return '';
  const title = escapeHtml(tab.url === 'linsoft://start' ? 'Linsoft Browser' : (tab.title || 'Linsoft Browser'));
  const startPage = tab.url === 'linsoft://start';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0a2b46"/><stop offset="1" stop-color="#061522"/></linearGradient><linearGradient id="brand"><stop stop-color="#8bd4ff"/><stop offset="1" stop-color="#ffb85c"/></linearGradient></defs>
    <rect width="320" height="180" rx="10" fill="url(#bg)"/><path d="M0 0h320v22H0z" fill="#174b70" opacity=".8"/><circle cx="14" cy="11" r="4" fill="#8bd4ff"/><rect x="25" y="8" width="102" height="6" rx="3" fill="#c8eaff" opacity=".8"/>
    ${startPage ? '<text x="160" y="73" text-anchor="middle" fill="url(#brand)" font-family="Segoe UI, sans-serif" font-size="29" font-weight="700">Linsoft</text><rect x="50" y="90" width="220" height="23" rx="12" fill="#142c3d" stroke="#68afd4" stroke-opacity=".6"/><circle cx="65" cy="101" r="3" fill="#8bd4ff"/><rect x="76" y="98" width="92" height="5" rx="2.5" fill="#a9c6d8" opacity=".65"/><rect x="73" y="126" width="50" height="22" rx="5" fill="#1b4058" stroke="#7bc8f0" stroke-opacity=".35"/><rect x="135" y="126" width="50" height="22" rx="5" fill="#1b4058" stroke="#7bc8f0" stroke-opacity=".35"/><rect x="197" y="126" width="50" height="22" rx="5" fill="#1b4058" stroke="#7bc8f0" stroke-opacity=".35"/><circle cx="86" cy="137" r="5" fill="#8bd4ff"/><circle cx="148" cy="137" r="5" fill="#ff4444"/><circle cx="210" cy="137" r="5" fill="#c5d5e2"/>' : `<text x="160" y="99" text-anchor="middle" fill="#eaf7ff" font-family="Segoe UI, sans-serif" font-size="20" font-weight="650">${title}</text><text x="160" y="121" text-anchor="middle" fill="#a9c6d8" font-family="Segoe UI, sans-serif" font-size="10">Linsoft Browser</text><rect x="124" y="137" width="72" height="20" rx="10" fill="#174b70"/><text x="160" y="150" text-anchor="middle" fill="#d9f3ff" font-family="Segoe UI, sans-serif" font-size="9">Interná stránka</text>`}
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function scheduleTabPreview(button, id) {
  hideTabPreview();
  const requestId = tabPreviewRequest;
  tabPreviewTimer = window.setTimeout(async () => {
    const tab = tabs.get(id);
    const preview = document.getElementById('tabPreview');
    if (!tab || !preview || !button.isConnected) return;
    const image = preview.querySelector('.tab-preview-image');
    const title = preview.querySelector('.tab-preview-title');
    const url = preview.querySelector('.tab-preview-url');
    const status = preview.querySelector('.tab-preview-status');
    const bounds = button.getBoundingClientRect();
    preview.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 308))}px`;
    preview.style.top = `${Math.max(8, Math.min(bounds.bottom + 8, window.innerHeight - 230))}px`;
    title.textContent = tab.title || 'Nová karta';
    url.textContent = tab.url || '';
    status.textContent = tab.crashed ? 'Karta sa neočakávane ukončila.' : tab.loading ? 'Stránka sa načítava…' : 'Obnovuje sa snímka…';
    image.removeAttribute('src');
    preview.dataset.previewState = 'loading';
    preview.hidden = false;
    preview.setAttribute('aria-hidden', 'false');
    const internalPreview = internalTabPreviewUrl(tab);
    if (internalPreview) {
      if (requestId !== tabPreviewRequest || preview.hidden) return;
      image.src = internalPreview;
      preview.dataset.previewState = 'ready';
      status.textContent = '';
      return;
    }
    try {
      const webview = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
      const getPreview = (active) => window.linsoftBrowser?.getTabPreview?.(isNativeTabs
        ? { tabId: id, active }
        : { webContentsId: webview?.getWebContentsId?.(), active });
      let result = await getPreview(id === activeTabId);
      for (let attempt = 0; !result?.ok && attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        result = await getPreview(true);
      }
      if (requestId !== tabPreviewRequest || preview.hidden) return;
      if (result?.ok && result.dataUrl) {
        image.src = result.dataUrl;
        preview.dataset.previewState = tab.loading ? 'loading' : 'ready';
        status.textContent = tab.loading ? 'Stránka sa načítava…' : '';
      } else {
        preview.dataset.previewState = 'unavailable';
        status.textContent = tab.crashed ? 'Kliknutím obnovíš túto kartu.' : 'Náhľad zatiaľ nie je dostupný.';
      }
    } catch (error) {
      if (requestId !== tabPreviewRequest || preview.hidden) return;
      console.error('Linsoft Browser could not show the tab preview:', error);
      preview.dataset.previewState = 'error';
      status.textContent = 'Náhľad sa nepodarilo obnoviť.';
    }
  }, 350);
}

function movePinnedTab(button) {
  if (!button) return;
  const tabsBar = document.getElementById('tabStrip');
  const firstUnpinned = [...tabsBar.querySelectorAll('.managed-tab:not(.pinned)')][0];
  if (button.classList.contains('pinned') && firstUnpinned && firstUnpinned !== button) tabsBar.insertBefore(button, firstUnpinned);
}

function togglePinnedTab(id) {
  const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
  if (!tab || !button) return;
  tab.pinned = !tab.pinned; button.classList.toggle('pinned', tab.pinned); updateTabLabel(button); movePinnedTab(button); saveSession();
}

function toggleTabMute(id) {
  const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`); const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
  if (!tab || !button) return;
  tab.muted = !tab.muted;
  if (viewer?.setAudioMuted) viewer.setAudioMuted(tab.muted);
  setTabAudioIcon(id, tab.muted, false);
  updateTabLabel(button);
  saveSession();
}

function toggleTabLock(id) { const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`); if (!tab || !button) return; tab.locked = !tab.locked; button.classList.toggle('locked', tab.locked); const close = button.querySelector('.tab-close'); if (close) { close.textContent = tab.locked ? '🔒' : '×'; close.title = tab.locked ? 'Karta je zamknutá' : 'Zatvoriť kartu'; } updateTabLabel(button); saveSession(); }

function cycleTabGroup(id) {
  const tab = tabs.get(id); const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
  if (!tab || !button) return;
  const index = tabGroupColors.indexOf(tab.group || ''); tab.group = tabGroupColors[(index + 1) % tabGroupColors.length];
  button.classList.remove(...tabGroupColors.filter(Boolean).map((color) => `tab-group-${color}`));
  if (tab.group) button.classList.add(`tab-group-${tab.group}`);
  saveSession();
}

function setTabGroupName(id) { const tab = tabs.get(id); if (!tab) return; const name = window.prompt('Názov skupiny karty:', tab.groupName || '')?.trim(); if (name === undefined) return; const previousName = tab.groupName; const sameNamedGroup = previousName ? [...tabs.values()].filter((candidate) => candidate.groupName === previousName) : [tab]; sameNamedGroup.forEach((candidate) => { candidate.groupName = name.slice(0, 30); updateTabLabel(document.querySelector(`.managed-tab[data-tab-id="${candidate.id}"]`)); }); saveSession(); }

function showTabContextMenu(x, y, id) {
  document.querySelector('.tab-context-menu')?.remove();
  const menu = document.createElement('div'); menu.className = 'tab-context-menu';
  menu.setAttribute('role', 'menu');
  const hasNamedGroup = Boolean(tabs.get(id)?.groupName);
  const actions = [['group', 'Zmeniť skupinu/farbu'], ['groupName', 'Pomenovať skupinu'], ...(hasNamedGroup ? [['closeGroup', 'Zatvoriť pomenovanú skupinu']] : []), ['mute', tabs.get(id)?.muted ? 'Zapnúť zvuk karty' : 'Stlmiť kartu'], ['lock', tabs.get(id)?.locked ? 'Odomknúť kartu' : 'Zamknúť kartu'], ['detach', 'Otvoriť kópiu v novom okne'], ['pin', tabs.get(id)?.pinned ? 'Odpnúť kartu' : 'Pripnúť kartu'], ['duplicate', 'Duplikovať kartu'], ['close', 'Zatvoriť kartu'], ['closeOthers', 'Zatvoriť ostatné karty'], ['closeRight', 'Zatvoriť karty napravo']];
  menu.innerHTML = actions.map(([action, label]) => `<button role="menuitem" data-tab-action="${action}">${label}</button>`).join('');
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`; menu.style.top = `${Math.min(y, window.innerHeight - 220)}px`; document.body.appendChild(menu);
  const closeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', closeFromOutside, true); document.removeEventListener('click', closeFromOutside, true); document.removeEventListener('keydown', closeFromEscape, true); };
  menu.closeContextMenu = closeMenu;
  const closeFromOutside = (event) => { if (!menu.contains(event.target)) closeMenu(); };
  const closeFromEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('click', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  menu.addEventListener('keydown', (event) => {
    const buttons = [...menu.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; buttons[(current + direction + buttons.length) % buttons.length]?.focus(); }
  });
  menu.querySelector('button')?.focus();
  menu.addEventListener('click', (event) => { const action = event.target.closest('[data-tab-action]')?.dataset.tabAction; if (!action) return; closeMenu(); if (action === 'group') cycleTabGroup(id); if (action === 'groupName') setTabGroupName(id); if (action === 'closeGroup') { const name = tabs.get(id)?.groupName; [...tabs.values()].filter((tab) => tab.groupName === name && !tab.pinned).forEach((tab) => closeTab(tab.id)); } if (action === 'mute') toggleTabMute(id); if (action === 'lock') toggleTabLock(id); if (action === 'detach') detachTab(id); if (action === 'pin') togglePinnedTab(id); if (action === 'duplicate') duplicateTab(id); if (action === 'close') closeTab(id); if (action === 'closeOthers') [...tabs.keys()].filter((tabId) => tabId !== id && !tabs.get(tabId)?.pinned).forEach(closeTab); if (action === 'closeRight') closeTabsRight(id); });
}

function showInputContextMenu(input, x, y) {
  if (input === addressInput) closeAddressSuggestions();
  document.querySelector('.input-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu input-context-menu';
  menu.setAttribute('role', 'menu');
  const hasSelection = input.selectionStart !== input.selectionEnd;
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const selectedText = input.value.slice(selectionStart, selectionEnd);
  menu.innerHTML = [
    ['cut', 'Vystrihnúť', !hasSelection || input.readOnly],
    ['copy', 'Kopírovať', !hasSelection],
    ['paste', 'Vložiť', input.readOnly],
    ['selectAll', 'Označiť všetko', input.value.length === 0]
  ].map(([action, label, disabled]) => `<button role="menuitem" data-input-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`).join('');
  menu.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 220))}px`;
  menu.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 190))}px`;
  document.body.appendChild(menu);
  const closeMenu = () => { menu.remove(); document.removeEventListener('pointerdown', closeFromOutside, true); document.removeEventListener('click', closeFromOutside, true); document.removeEventListener('keydown', closeFromEscape, true); };
  menu.closeContextMenu = closeMenu;
  const closeFromOutside = (event) => { if (!menu.contains(event.target)) closeMenu(); };
  const closeFromEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('click', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-input-action]')?.dataset.inputAction;
    if (!action) return;
    input.focus();
    if (action === 'paste') {
      try { const text = await window.linsoftBrowser?.readClipboardText?.(); input.setRangeText(String(text || ''), input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); } catch { showToast('Text sa nepodarilo vložiť zo schránky.'); }
    } else if (action === 'copy' || action === 'cut') {
      const result = await window.linsoftBrowser?.writeClipboardText?.(selectedText);
      if (action === 'cut' && result?.ok) { input.setRangeText('', selectionStart, selectionEnd, 'start'); input.dispatchEvent(new Event('input', { bubbles: true })); }
    } else {
      document.execCommand(action === 'selectAll' ? 'selectAll' : action);
    }
    closeMenu();
  });
}

document.addEventListener('contextmenu', (event) => {
  const input = event.target.closest?.('input, textarea');
  if (!input || input.disabled) return;
  event.preventDefault();
  input.focus();
  showInputContextMenu(input, event.clientX, event.clientY);
});

function duplicateTab(id) { const tab = tabs.get(id); if (tab) openNewTab(tab.url); }
function detachTab(id) {
  const tab = tabs.get(id);
  if (!tab?.url) return;
  const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
  const currentUrl = viewer?.getURL?.() || tab.url;
  tab.url = currentUrl;
  window.linsoftBrowser?.openDetachedWindow(currentUrl);
  saveSession();
}
async function transferTabToDetachedWindow(id, token) {
  const transfer = outgoingTabTransfers.get(token);
  if (!transfer || transfer.tabId !== id) return;
  try {
    const registration = await transfer.registration;
    if (!registration?.ok) throw new Error('Prenos karty sa nepodarilo pripraviť.');
    window.linsoftBrowser?.openDetachedWindow?.('linsoft://start', token);
  } catch (error) {
    outgoingTabTransfers.delete(token);
    console.error('Linsoft Browser could not detach the tab:', error);
    showToast(error instanceof Error ? error.message : 'Kartu sa nepodarilo presunúť do nového okna.');
  }
}
function closeTabsRight(id) { const ids = [...tabs.keys()]; const index = ids.indexOf(id); ids.slice(index + 1).filter((tabId) => !tabs.get(tabId)?.pinned).forEach(closeTab); }

function normalizeBrowserSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sk');
}

function searchOpenTabs() {
  document.getElementById('tabSearchDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'tabSearchDialog';
  dialog.className = 'tab-search-dialog';
  dialog.setAttribute('aria-labelledby', 'tabSearchHeading');
  dialog.innerHTML = `<header><div><span class="settings-eyebrow">OTVORENÉ KARTY</span><h2 id="tabSearchHeading">Nájdi svoju kartu</h2></div><button type="button" data-close-tab-search aria-label="Zavrieť prehľad kariet">×</button></header><input type="search" aria-label="Hľadať otvorenú kartu" placeholder="Názov alebo adresa stránky..." autofocus><p class="tab-search-count" role="status"></p><div class="tab-search-results"></div>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('input');
  let dialogClosed = false;
  const removeDialog = () => {
    if (dialogClosed) return;
    dialogClosed = true;
    dialog.remove();
    if (isNativeTabs && /^(https?:|file:)/i.test(tabs.get(activeTabId)?.url || '')) {
      syncNativeTabLayout();
      window.linsoftBrowser?.activateNativeTab?.(activeTabId);
    }
  };
  const closeDialog = () => {
    if (dialog.open) dialog.close();
    removeDialog();
  };
  const render = () => {
    const query = normalizeBrowserSearch(input.value);
    const ordered = [...document.querySelectorAll('.managed-tab')].map((button) => tabs.get(Number(button.dataset.tabId))).filter(Boolean);
    const matches = ordered.filter((tab) => normalizeBrowserSearch(`${tab.title} ${tab.url}`).includes(query));
    dialog.querySelector('.tab-search-count').textContent = `Nájdené: ${matches.length} · Otvorené: ${ordered.length}`;
    dialog.querySelector('.tab-search-results').innerHTML = matches.map((tab) => `<button type="button" data-select-search-tab="${tab.id}"${tab.id === activeTabId ? ' aria-current="page"' : ''}><span class="tab-search-icon" aria-hidden="true">${tab.pinned ? '◆' : 'L'}</span><span><strong>${escapeHtml(tab.title)}</strong><small>${escapeHtml(tab.url)}</small></span><span class="tab-search-state">${tab.id === activeTabId ? 'Aktívna' : tab.locked ? 'Zamknutá' : tab.pinned ? 'Pripnutá' : 'Prepnúť'}</span></button>`).join('') || '<div class="empty-library">Žiadna karta nezodpovedá hľadaniu.</div>';
  };
  input.addEventListener('input', render);
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-tab-search]')) return closeDialog();
    const button = event.target.closest('[data-select-search-tab]');
    if (!button) return;
    const id = Number(button.dataset.selectSearchTab);
    closeDialog();
    selectTab(id);
    document.querySelector(`.managed-tab[data-tab-id="${id}"]`)?.focus();
  });
  dialog.addEventListener('keydown', (event) => {
    const buttons = [...dialog.querySelectorAll('[data-select-search-tab]')];
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      buttons[0]?.click();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = index < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  dialog.addEventListener('close', removeDialog, { once: true });
  render();
  hideNativeTab();
  dialog.showModal();
}

function bindTabDrag(button, id) {
  let dragTransferToken = '';
  button.addEventListener('dragstart', (event) => {
    const tab = tabs.get(id);
    dragTransferToken = '';
    event.dataTransfer.setData('text/plain', String(id));
    event.dataTransfer.effectAllowed = 'move';
    if (tab && !tab.locked && /^(https?:|file:)/i.test(tab.url)) {
      const token = crypto.randomUUID();
      dragTransferToken = token;
      event.dataTransfer.setData('application/x-linsoft-tab-transfer', token);
      const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`);
      const currentUrl = viewer?.getURL?.() || tab.url;
      tab.url = currentUrl;
      outgoingTabTransfers.set(token, { tabId: id, url: currentUrl, registration: null });
      const registration = window.linsoftBrowser?.registerTabTransfer?.({
        token, tabId: id, url: currentUrl, title: tab.title,
        history: tab.history, historyIndex: tab.historyIndex,
        pinned: tab.pinned, muted: tab.muted, group: tab.group, groupName: tab.groupName
      });
      const outgoing = outgoingTabTransfers.get(token);
      if (outgoing) outgoing.registration = registration;
      if (registration) void registration.then((result) => {
        if (!result?.ok) console.error('Linsoft Browser could not prepare the tab transfer.');
      }).catch((error) => {
        outgoingTabTransfers.delete(token);
        console.error('Linsoft Browser could not prepare the tab transfer:', error);
      });
      window.setTimeout(() => outgoingTabTransfers.delete(token), 35000);
    }
    lastTabDragPosition = { x: event.clientX, y: event.clientY };
    button.classList.add('dragging');
  });
  button.addEventListener('dragend', (event) => {
    button.classList.remove('dragging');
    const draggedTab = tabs.get(id);
    const tabsBar = document.querySelector('.tabs-bar').getBoundingClientRect();
    const y = lastTabDragPosition.y || event.clientY;
    const outsideWindowHorizontally = event.screenX < window.screenX - 20 || event.screenX > window.screenX + window.outerWidth + 20;
    const detached = y > tabsBar.bottom + 40 || y < tabsBar.top - 20 || event.screenY > window.screenY + window.innerHeight - 20 || event.screenY < window.screenY - 20 || outsideWindowHorizontally;
    if (detached && draggedTab && event.dataTransfer.dropEffect !== 'move') {
      if (dragTransferToken) void transferTabToDetachedWindow(id, dragTransferToken);
      else detachTab(id);
    }
    dragTransferToken = '';
  });
  button.addEventListener('dragover', (event) => event.preventDefault());
  button.addEventListener('drop', (event) => {
    if (event.dataTransfer.types.includes('application/x-linsoft-tab-transfer')) return;
    event.preventDefault();
    const dragged = document.querySelector(`.managed-tab[data-tab-id="${event.dataTransfer.getData('text/plain')}"]`);
    if (!dragged || dragged === button) return;
    button.parentElement.insertBefore(dragged, button);
    const orderedTabs = [...document.querySelectorAll('.managed-tab')].map((item) => tabs.get(Number(item.dataset.tabId))).filter(Boolean);
    tabs.clear();
    orderedTabs.forEach((tab) => tabs.set(tab.id, tab));
    updateTabDensity();
    saveSession();
  });
}

document.addEventListener('dragover', (event) => { lastTabDragPosition = { x: event.clientX, y: event.clientY }; }, true);

async function receiveTabTransfer(token) {
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await window.linsoftBrowser?.claimTabTransfer?.(token);
    if (result?.ok) break;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  if (!result?.ok || !isRestorableTabUrl(result.tab?.url)) {
    showToast('Kartu sa nepodarilo preniesť. Pôvodná karta zostala otvorená.');
    return;
  }
  const transferredUrl = result.tab.url;
  const tabId = activeTabId;
  const tab = tabs.get(tabId);
  if (tab) {
    navigate(transferredUrl, false);
    Object.assign(tab, result.tab, { id: tabId, history: Array.isArray(result.tab.history) ? result.tab.history : [transferredUrl] });
    const button = document.querySelector(`.managed-tab[data-tab-id="${tabId}"]`);
    button?.classList.toggle('pinned', tab.pinned === true);
    setTabAudioIcon(tabId, tab.muted === true, false);
    updateTabLabel(button);
    movePinnedTab(button);
    if (activeTabId === tabId) {
      addressInput.value = tab.url;
      tabTitle.textContent = tab.title;
      updateActiveTab(tab.url, tab.title);
    }
    saveSession();
  }
  const completed = await window.linsoftBrowser?.completeTabTransfer?.(token);
  if (!completed?.ok) showToast('Karta bola otvorená v tomto okne, pôvodná karta zostala zachovaná.');
}

const tabStrip = document.getElementById('tabStrip');
tabStrip.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('application/x-linsoft-tab-transfer')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
tabStrip.addEventListener('drop', (event) => {
  if (!event.dataTransfer.types.includes('application/x-linsoft-tab-transfer')) return;
  event.preventDefault();
  event.stopPropagation();
  void receiveTabTransfer(event.dataTransfer.getData('application/x-linsoft-tab-transfer')).catch((error) => {
    console.error('Linsoft Browser could not receive the tab transfer:', error);
    showToast('Prenos karty zlyhal. Pôvodná karta zostala otvorená.');
  });
});

function renderSavedBookmarks() {
  const bar = document.getElementById('bookmarksBar');
  const list = document.getElementById('bookmarkItems');
  const emptyState = document.getElementById('bookmarkBarEmpty');
  if (!bar || !list || !emptyState) return;
  list.replaceChildren();
  savedBookmarks.forEach((bookmark) => {
    const button = document.createElement('button');
    button.className = 'saved-bookmark';
    const title = String(bookmark.title || bookmark.url);
    const iconUrl = bookmarkFaviconUrl(bookmark.url);
    button.innerHTML = `${iconUrl ? `<img class="saved-bookmark-icon" src="${escapeHtml(iconUrl)}" alt="">` : ''}<span class="saved-bookmark-title">${escapeHtml(title)}</span><span class="saved-bookmark-fallback" hidden>${escapeHtml(title.slice(0, 1).toUpperCase())}</span>`;
    const icon = button.querySelector('.saved-bookmark-icon');
    icon?.addEventListener('error', () => { icon.hidden = true; button.querySelector('.saved-bookmark-fallback').hidden = false; });
    button.dataset.url = bookmark.url;
    button.title = `${title} — ${bookmark.url}`;
    button.setAttribute('aria-label', `Otvoriť záložku ${title}`);
    button.addEventListener('click', () => navigate(bookmark.url));
    button.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      openBackgroundTab(bookmark.url);
    });
    list.appendChild(button);
  });
  emptyState.hidden = savedBookmarks.length > 0;
  updateBookmarkBarControls();
}

function updateBookmarkBarControls() {
  const bar = document.getElementById('bookmarksBar');
  const list = document.getElementById('bookmarkItems');
  const leftButton = document.getElementById('bookmarkScrollLeft');
  const rightButton = document.getElementById('bookmarkScrollRight');
  if (!bar || !list || !leftButton || !rightButton) return;
  const overflow = list.scrollWidth > list.clientWidth + 1;
  leftButton.hidden = !overflow;
  rightButton.hidden = !overflow;
  leftButton.disabled = !overflow || list.scrollLeft <= 1;
  rightButton.disabled = !overflow || list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
}

function updateBookmarksBar() {
  const bar = document.getElementById('bookmarksBar');
  const toggle = document.getElementById('toggleBookmarksBar');
  if (bar) bar.hidden = !settingsState.showBookmarksBar;
  if (toggle) toggle.innerHTML = `<svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-bookmark"></use></svg><span>${settingsState.showBookmarksBar ? 'Skryť' : 'Zobraziť'} lištu záložiek</span>`;
  window.requestAnimationFrame(updateBookmarkBarControls);
}

const bookmarkItems = document.getElementById('bookmarkItems');
document.getElementById('bookmarkScrollLeft')?.addEventListener('click', () => {
  bookmarkItems?.scrollBy({ left: -Math.max(180, bookmarkItems.clientWidth * 0.7), behavior: 'smooth' });
});
document.getElementById('bookmarkScrollRight')?.addEventListener('click', () => {
  bookmarkItems?.scrollBy({ left: Math.max(180, bookmarkItems.clientWidth * 0.7), behavior: 'smooth' });
});
bookmarkItems?.addEventListener('scroll', updateBookmarkBarControls, { passive: true });
bookmarkItems?.addEventListener('wheel', (event) => {
  if (!bookmarkItems || bookmarkItems.scrollWidth <= bookmarkItems.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  bookmarkItems.scrollLeft += event.deltaY;
}, { passive: false });
window.addEventListener('resize', updateBookmarkBarControls);
if (typeof ResizeObserver === 'function' && bookmarkItems) {
  const bookmarkBarResizeObserver = new ResizeObserver(updateBookmarkBarControls);
  bookmarkBarResizeObserver.observe(bookmarkItems);
  bookmarkBarResizeObserver.observe(document.getElementById('bookmarksBar'));
}

function addTab(initialUrl = 'linsoft://start') {
  const id = nextTabId++;
  if (tabs.get(activeTabId)?.url === 'linsoft://camera' && initialUrl !== 'linsoft://camera') void stopUsbCameraCapture('Kamera bola pozastavená pri prepnutí karty.');
  const initialTitle = initialUrl === 'linsoft://start' ? 'Linsoft Browser' : initialUrl === 'linsoft://tor-chat' ? 'Onion Chat' : initialUrl === 'linsoft://camera' ? 'Kamera' : initialUrl.replace(/^https?:\/\//, '').split('/')[0];
  tabs.set(id, { id, url: initialUrl, title: initialTitle, history: [initialUrl], historyIndex: 0 });
  const button = createTabButton({ id, url: initialUrl, title: initialTitle, pinned: false });
  activeTabId = id;
  saveSession();
  initialUrl === 'linsoft://start' ? startPage() : navigate(initialUrl, false);
  return id;
}

function openNewTab(url = 'linsoft://start') {
  const id = addTab(url);
  const newTab = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
  newTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return id;
}

function openTorChatTab() {
  const existingTab = [...tabs.values()].find((tab) => tab.url === 'linsoft://tor-chat');
  if (existingTab) { selectTab(existingTab.id); return; }
  openNewTab('linsoft://tor-chat');
}

function openBackgroundTab(url) {
  const previousTabId = activeTabId;
  openNewTab(url);
  selectTab(previousTabId);
}

function selectTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (activeTabId !== id) cacheTabPreview(activeTabId);
  if (activeTabId !== id && getActiveSurface()?.querySelector('.settings-page')) {
    void stopMediaDeviceTest('Test zariadenia bol zastavený pri prepnutí karty.');
  }
  if (activeTabId !== id && tabs.get(activeTabId)?.url === 'linsoft://camera') void stopUsbCameraCapture('Kamera bola pozastavená pri prepnutí karty.');
  if (tab.url !== 'linsoft://tor-chat') {
    if (torChatUi.scanning) void stopTorChatQrScanner();
    if (torChatUi.videoActive || torChatUi.videoStarting) void stopTorChatVideoCall();
  }
  activeTabId = id;
  updateActiveTab(tab.url, tab.title);
  addressInput.value = tab.url;
  tabTitle.textContent = tab.title;
  if (suspendedTabs.has(id) || tab.crashed) {
    suspendedTabs.delete(id);
    tab.suspended = false;
    tab.crashed = false;
    navigate(tab.url, false);
  } else if (tab.url === 'linsoft://start' && !content.querySelector(`.tab-surface[data-tab-id="${id}"]`)) {
    hideNativeTab();
    startPage();
  } else if (tab.url === 'linsoft://settings') {
    hideNativeTab();
    if (content.querySelector(`.tab-surface[data-tab-id="${id}"] .settings-page`)) activateSurface(id);
    else openSettings();
  } else if (tab.url === 'linsoft://apps') {
    hideNativeTab();
    openAppCenter();
  } else if (tab.url === 'linsoft://tor-chat') {
    hideNativeTab();
    openTorChatPage();
  } else if (tab.url === 'linsoft://camera') {
    hideNativeTab();
    usbCameraTabId = id;
    if (content.querySelector(`.tab-surface[data-tab-id="${id}"] .usb-camera-page`)) activateSurface(id);
    else openUsbCameraPage();
  } else {
    activateSurface(id);
    if (isNativeTabs && pendingTorNavigations.has(id)) hideNativeTab();
    else if (isNativeTabs) {
      syncNativeTabLayout();
      window.linsoftBrowser?.activateNativeTab?.(id);
    }
  }
  updateNavigationButtons();
}

function removeTransferredTab(id, url) {
  const tab = tabs.get(id);
  if (!tab || tab.url !== url) return false;
  pendingTorNavigations.delete(id);
  setTabLoading(id, false);
  const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`);
  if (isNativeTabs) window.linsoftBrowser?.destroyNativeTab?.(id);
  else surface?.querySelectorAll('webview').forEach((viewer) => viewer.remove());
  if (tabs.size === 1) {
    Object.assign(tab, { url: 'linsoft://start', title: 'Linsoft Browser', history: ['linsoft://start'], historyIndex: 0, pinned: false, group: '', groupName: '' });
    const button = document.querySelector(`.managed-tab[data-tab-id="${id}"]`);
    button?.classList.remove('pinned');
    updateTabLabel(button);
    activeTabId = id;
    startPage();
    saveSession();
    return true;
  }
  const ids = [...tabs.keys()];
  const fallbackId = ids[Math.max(0, ids.indexOf(id) - 1)];
  surface?.remove();
  document.querySelector(`.managed-tab[data-tab-id="${id}"]`)?.remove();
  tabs.delete(id);
  updateTabDensity();
  saveSession();
  if (activeTabId === id) selectTab(fallbackId);
  return true;
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab || tab.pinned || tab.locked || !confirmSettingsDeparture(id)) return;
  if (id === activeTabId && content.querySelector(`.tab-surface[data-tab-id="${id}"] .settings-page`)) {
    void stopMediaDeviceTest('Test zariadenia bol zastavený zatvorením nastavení.');
  }
  if (tab.url === 'linsoft://camera') void stopUsbCameraCapture('Kamera bola vypnutá zatvorením karty.');
  pendingTorNavigations.delete(id);
  setTabLoading(id, false);
  if (tab.url === 'linsoft://tor-chat') { torChatUi.generation += 1; clearTorChatUi(); void window.linsoftBrowser?.stopTorChat?.(); }
  closedTabs.unshift({ ...tab });
  closedTabs.splice(10);
  updateClosedTabsButton();
  const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`);
  if (isNativeTabs) window.linsoftBrowser?.destroyNativeTab?.(id);
  else surface?.querySelectorAll('webview').forEach((viewer) => viewer.remove());
  if (tabs.size === 1) {
    Object.assign(tab, { url: 'linsoft://start', title: 'Linsoft Browser', history: ['linsoft://start'], historyIndex: 0 });
    activeTabId = id;
    startPage();
    saveSession();
    return;
  }
  const ids = [...tabs.keys()];
  const closedIndex = ids.indexOf(id);
  const fallbackId = ids[Math.max(0, closedIndex - 1)];
  surface?.remove();
  document.querySelector(`.managed-tab[data-tab-id="${id}"]`)?.remove();
  tabs.delete(id);
  updateTabDensity();
  saveSession();
  if (activeTabId === id) selectTab(fallbackId);
}

function restoreClosedTab() {
  if (!confirmSettingsDeparture()) return;
  const tab = closedTabs.shift();
  if (!tab) return;
  tab.id = nextTabId++;
  tabs.set(tab.id, tab);
  createTabButton(tab);
  activeTabId = tab.id;
  navigate(tab.url, false);
  updateClosedTabsButton();
  saveSession();
}

function updateClosedTabsButton() {
  const button = document.getElementById('restoreClosedTab');
  if (!button) return;
  button.disabled = closedTabs.length === 0;
  button.title = closedTabs.length ? `Znova otvoriť zatvorenú kartu: ${closedTabs[0].title}` : 'Nie sú zatvorené karty';
}

function activeViewer() { return isNativeTabs ? null : content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`); }
function ensureActiveTabLoaded() { const tab = tabs.get(activeTabId); if (tab && suspendedTabs.has(activeTabId)) { suspendedTabs.delete(activeTabId); tab.suspended = false; navigate(tab.url, false); return null; } return activeViewer(); }
function viewerCanNavigate(viewer, direction) {
  if (!viewer || viewer.dataset.domReady !== 'true') return false;
  return direction < 0 ? viewer.canGoBack() : viewer.canGoForward();
}
function updateNavigationButtons() { const tab = tabs.get(activeTabId); const viewer = activeViewer(); const back = document.getElementById('backButton'); const forward = document.getElementById('forwardButton'); if (back) back.disabled = !(viewerCanNavigate(viewer, -1) || (tab?.historyIndex > 0)); if (forward) forward.disabled = !(viewerCanNavigate(viewer, 1) || (tab && tab.historyIndex < tab.history.length - 1)); }
async function navigateTabHistory(direction) {
  const tab = tabs.get(activeTabId);
  if (!confirmSettingsDeparture()) return;
  const viewer = ensureActiveTabLoaded();
  if (!tab) return;
  if (viewer) {
    const canNavigate = viewerCanNavigate(viewer, direction);
    if (canNavigate) {
      if (direction < 0) viewer.goBack();
      else viewer.goForward();
      return;
    }
  }
  if (isNativeTabs) {
    const result = await window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: direction < 0 ? 'back' : 'forward' });
    if (result?.ok) return;
  }
  const nextIndex = tab.historyIndex + direction;
  if (nextIndex >= 0 && nextIndex < tab.history.length) {
    tab.historyIndex = nextIndex;
    navigate(tab.history[nextIndex], false);
  }
}
function navigationErrorMessage(errorCode, description = '') { const messages = { '-105': 'Server sa nenašiel (DNS).', '-106': 'Nie ste pripojení k internetu.', '-102': 'Server odmietol pripojenie.', '-118': 'Pripojenie vypršalo.', '-116': 'Spojenie bolo odmietnuté.' }; return messages[String(errorCode)] || (description ? `Načítanie zlyhalo: ${description}${/[.!?]$/.test(description) ? '' : '.'}` : 'Stránku sa nepodarilo načítať.'); }
function showNavigationStatus(id, { url = '', errorCode, errorDescription = '', stopped = false } = {}) {
  const surface = content.querySelector(`.tab-surface[data-tab-id="${id}"]`);
  if (!surface || !/^(https?:|file:)/i.test(tabs.get(id)?.url || '')) return;
  const failed = errorCode !== undefined || stopped;
  surface.querySelector('.navigation-status')?.remove();
  const panel = document.createElement('section');
  panel.className = `navigation-status${failed ? ' navigation-status-error' : ''}`;
  panel.setAttribute('aria-label', failed ? 'Chyba načítania stránky' : 'Načítavanie stránky');
  const onion = /^https?:\/\/[^/]+\.onion(?:\/|$)/i.test(url);
  panel.innerHTML = `<div class="navigation-status-card">
    <div class="navigation-brand"><img src="assets/linsoft-icon.svg" alt="" width="36" height="36"><span>Linsoft <strong>Browser</strong></span></div>
    <div class="navigation-logo"><img src="assets/linsoft-icon.svg" alt="Logo Linsoft Browser" width="88" height="88"><span class="navigation-status-badge" aria-hidden="true">${failed ? '!' : ''}</span></div>
    <p class="navigation-eyebrow">${stopped ? 'NAČÍTAVANIE ZASTAVENÉ' : failed ? 'PRIPOJENIE SA NEPODARILO' : 'PRIPÁJAME VÁS K WEBU'}</p>
    <h1>${stopped ? 'Načítavanie bolo zastavené' : failed ? 'Stránku sa nepodarilo načítať' : 'Načítava sa stránka'}</h1>
    <p class="navigation-description" role="status">${stopped ? 'Stránku môžete skúsiť načítať znova alebo sa vrátiť domov.' : failed ? escapeHtml(navigationErrorMessage(errorCode, errorDescription)) : 'Linsoft Browser pripravuje vašu stránku. Chvíľku strpenia.'}</p>
    <div class="navigation-address" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
    ${onion ? '<p class="navigation-tor-status" role="status"></p>' : ''}
    ${failed ? `<p class="navigation-hint">${onion ? 'Onion stránky potrebujú funkčné pripojenie cez Tor. Overte adresu a dostupnosť služby.' : 'Skontrolujte adresu a internetové pripojenie, potom to skúste znova.'}</p>
    <div class="navigation-actions"><button type="button" data-navigation-action="retry">Skúsiť znova</button><button type="button" data-navigation-action="address">Skontrolovať adresu</button><button type="button" data-navigation-action="home">Domov</button></div>
    ${stopped ? '' : `<details class="navigation-error-details"><summary>Podrobnosti chyby</summary><dl><dt>Kód chyby</dt><dd>${escapeHtml(String(errorCode))}</dd><dt>Technický popis</dt><dd>${escapeHtml(errorDescription || 'Technický popis nie je dostupný.')}</dd></dl></details>`}` : '<div class="navigation-progress" aria-hidden="true"><i></i></div><p class="navigation-hint">Čakáme na odpoveď stránky…</p><div class="navigation-actions"><button type="button" data-navigation-action="stop">Zastaviť načítavanie</button></div>'}
    <div class="navigation-footer">Linsoft Browser · Váš priestor na webe</div>
  </div>`;
  panel.querySelector('[data-navigation-action="retry"]')?.addEventListener('click', () => {
    if (activeTabId === id) navigate(url || tabs.get(id)?.url, false);
  });
  panel.querySelector('[data-navigation-action="address"]')?.addEventListener('click', () => { addressInput.focus(); addressInput.select(); });
  panel.querySelector('[data-navigation-action="home"]')?.addEventListener('click', () => { if (activeTabId === id) navigate('linsoft://start'); });
  panel.querySelector('[data-navigation-action="stop"]')?.addEventListener('click', () => { void stopTabLoading(id); });
  surface.appendChild(panel);
  renderNavigationTorStatus({});
}

function clearNavigationStatus(id) {
  content.querySelector(`.tab-surface[data-tab-id="${id}"] .navigation-status:not(.navigation-status-error)`)?.remove();
}

const pendingCertificateWarningViews = new Map();
function answerCertificateWarning(requestId, allowOnce) {
  const pending = pendingCertificateWarningViews.get(requestId);
  if (!pending) return;
  pendingCertificateWarningViews.delete(requestId);
  pending.panel.remove();
  window.linsoftBrowser?.answerCertificateWarning?.(requestId, allowOnce);
}

function showCertificateWarningInTab({ requestId, webContentsId, tabId, details = {} } = {}) {
  const targetTabId = tabId ?? [...document.querySelectorAll('.tab-surface .webview')]
    .find((webview) => String(webview.getWebContentsId?.()) === String(webContentsId))?.closest('.tab-surface')?.dataset.tabId;
  const surface = targetTabId === undefined ? null : [...content.querySelectorAll('.tab-surface')]
    .find((candidate) => candidate.dataset.tabId === String(targetTabId));
  if (!requestId || !surface) {
    if (requestId) window.linsoftBrowser?.answerCertificateWarning?.(requestId, false);
    return;
  }
  for (const [pendingId, pending] of pendingCertificateWarningViews) {
    if (pending.tabId === String(targetTabId)) answerCertificateWarning(pendingId, false);
  }
  const panel = document.createElement('section');
  panel.className = 'certificate-warning-overlay';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `certificate-warning-heading-${requestId}`);
  panel.setAttribute('aria-describedby', `certificate-warning-description-${requestId}`);
  panel.innerHTML = `<div class="certificate-warning-card">
    <div class="certificate-warning-brand"><img src="assets/linsoft-icon.svg" alt="" width="30" height="30"><span>Linsoft <strong>Browser</strong></span><span class="certificate-warning-brand-label">BEZPEČNOSTNÉ UPOZORNENIE</span></div>
    <div class="certificate-warning-content">
      <div class="certificate-warning-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 2.8 19h18.4L12 3Z"></path><path d="M12 9v4.5m0 2.7v.1"></path></svg></div>
      <p class="certificate-warning-eyebrow">Bezpečnostné upozornenie</p>
      <h1 id="certificate-warning-heading-${requestId}">Pripojenie nie je dôveryhodné</h1>
      <p id="certificate-warning-description-${requestId}" class="certificate-warning-intro">Linsoft Browser nevie overiť, či sa pripájaš k správnemu zariadeniu. Niekto by mohol sledovať alebo meniť prenášané údaje.</p>
      <section class="certificate-warning-site" aria-label="Podrobnosti pripojenia" aria-live="polite">
        <span class="certificate-warning-label">Adresa zariadenia</span>
        <code>${escapeHtml(details.address || 'Adresa nie je dostupná')}</code>
        <p class="certificate-warning-reason">${escapeHtml(details.reason || 'Nepodarilo sa overiť pravosť certifikátu.')}</p>
      </section>
      <details class="certificate-warning-details">
        <summary>Zobraziť podrobnosti certifikátu</summary>
        <dl>
          <dt>Vydaný pre</dt><dd>${escapeHtml(details.subject || 'Nie je k dispozícii')}</dd>
          <dt>Vydavateľ</dt><dd>${escapeHtml(details.issuer || 'Nie je k dispozícii')}</dd>
          <dt>Platný od</dt><dd>${escapeHtml(formatCertificateWarningDate(details.validFrom))}</dd>
          <dt>Platný do</dt><dd>${escapeHtml(formatCertificateWarningDate(details.validTo))}</dd>
          <dt>Odtlačok SHA-256</dt><dd class="certificate-warning-fingerprint">${escapeHtml(details.fingerprint || 'Nie je k dispozícii')}</dd>
          <dt>Chyba</dt><dd>${escapeHtml(details.errorCode || 'Nie je k dispozícii')}</dd>
        </dl>
      </details>
      <div class="certificate-warning-recommendation"><strong>Odporúčame vrátiť sa do bezpečia.</strong><span>Pokračuj iba vtedy, ak toto lokálne zariadenie poznáš a dôveruješ mu.</span></div>
      <label class="certificate-warning-confirm"><input type="checkbox"><span>Rozumiem riziku a chcem pokračovať na tomto zariadení v tejto karte.</span></label>
      <div class="certificate-warning-actions"><button type="button" class="certificate-warning-safe">Vrátiť sa do bezpečia</button><button type="button" class="certificate-warning-continue" disabled>Pokračovať nezabezpečene</button></div>
      <p class="certificate-warning-note">Povolenie sa neuloží na disk a zruší sa po odchode na inú stránku.</p>
    </div>
  </div>`;
  surface.appendChild(panel);
  const confirmation = panel.querySelector('input[type="checkbox"]');
  const continueButton = panel.querySelector('.certificate-warning-continue');
  const safeButton = panel.querySelector('.certificate-warning-safe');
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      answerCertificateWarning(requestId, false);
    }
  };
  panel.addEventListener('keydown', onKeyDown);
  safeButton.addEventListener('click', () => answerCertificateWarning(requestId, false));
  confirmation.addEventListener('change', () => { continueButton.disabled = !confirmation.checked; });
  continueButton.addEventListener('click', () => {
    if (confirmation.checked) answerCertificateWarning(requestId, true);
  });
  pendingCertificateWarningViews.set(requestId, { panel, tabId: String(targetTabId) });
  safeButton.focus();
}

function formatCertificateWarningDate(value) {
  if (typeof value !== 'string' || !value) return 'Nie je k dispozícii';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Nie je k dispozícii' : date.toLocaleString('sk-SK');
}

window.linsoftBrowser?.onCertificateWarning?.(showCertificateWarningInTab);

function httpFallbackForTlsError(errorCode, failedUrl) {
  if (![-107, -113].includes(Number(errorCode))) return '';
  try {
    const url = new URL(failedUrl);
    if (url.protocol !== 'https:') return '';
    url.protocol = 'http:';
    return url.href;
  } catch { return ''; }
}
function httpsFallbackForIpConnectionRefused(errorCode, failedUrl) {
  if (Number(errorCode) !== -102) return '';
  try {
    const url = new URL(failedUrl);
    const hostname = url.hostname.toLowerCase();
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) && hostname.split('.').every((part) => Number(part) <= 255);
    const ipv6 = /^\[[0-9a-f:]+\]$/i.test(hostname);
    if (url.protocol !== 'http:' || (hostname !== 'localhost' && !ipv4 && !ipv6)) return '';
    if (url.port === '80') url.port = '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}
function replaceFailedUrlInTabHistory(tab, failedUrl, fallbackUrl) {
  const failedIndex = tab.history.indexOf(failedUrl);
  if (failedIndex >= 0) {
    tab.history[failedIndex] = fallbackUrl;
    tab.historyIndex = failedIndex;
  } else {
    tab.history.splice(tab.historyIndex + 1);
    tab.history.push(fallbackUrl);
    tab.historyIndex = tab.history.length - 1;
  }
  tab.url = fallbackUrl;
}

function activateSurface(id) {
  content.querySelectorAll('.tab-surface').forEach((surface) => { const active = Number(surface.dataset.tabId) === id; surface.hidden = false; surface.classList.toggle('inactive-surface', !active); });
  renderNavigationLoadingControls();
}

function getActiveSurface() {
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  activateSurface(activeTabId);
  return surface;
}

function updateUsbCameraPageStatus(message, active = Boolean(usbCameraStream)) {
  if (usbCameraTabId === null) return;
  const surface = content.querySelector(`.tab-surface[data-tab-id="${usbCameraTabId}"]`);
  const status = surface?.querySelector('#usbCameraStatus');
  const indicator = surface?.querySelector('#usbCameraLiveIndicator');
  const stopButton = surface?.querySelector('#usbCameraStop');
  surface?.querySelector('.usb-camera-page')?.classList.toggle('is-live', active);
  if (status) status.textContent = message;
  if (indicator) {
    indicator.dataset.active = String(active);
    indicator.textContent = active ? 'KAMERA AKTÍVNA' : 'KAMERA VYPNUTÁ';
  }
  if (stopButton) stopButton.disabled = !active;
  const tab = tabs.get(usbCameraTabId);
  if (tab) {
    tab.title = active ? 'Kamera · živý obraz' : 'Kamera';
    updateTabLabel(document.querySelector(`.managed-tab[data-tab-id="${usbCameraTabId}"]`));
    if (usbCameraTabId === activeTabId) tabTitle.textContent = tab.title;
  }
}

async function stopMediaDeviceTest(message = 'Test zariadenia bol zastavený.') {
  mediaDeviceTestGeneration += 1;
  const type = mediaDeviceTestType;
  const stream = mediaDeviceTestStream;
  const audioContext = mediaDeviceTestAudioContext;
  mediaDeviceTestType = '';
  mediaDeviceTestStream = null;
  mediaDeviceTestAudioContext = null;
  if (mediaDeviceTestAnimationFrame) cancelAnimationFrame(mediaDeviceTestAnimationFrame);
  mediaDeviceTestAnimationFrame = 0;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioContext && audioContext.state !== 'closed') {
    try {
      await audioContext.close();
    } catch (error) {
      console.error('Linsoft Browser could not close the media-device test audio context:', error);
    }
  }
  const surface = getActiveSurface();
  const preview = surface.querySelector('#mediaDeviceTestPreview');
  if (preview) {
    preview.pause();
    preview.srcObject = null;
    preview.hidden = true;
  }
  const meter = surface.querySelector('#microphoneTestLevel');
  if (meter) meter.value = 0;
  const cameraButton = surface.querySelector('[data-media-device-test="video"]');
  const microphoneButton = surface.querySelector('[data-media-device-test="audio"]');
  if (cameraButton) {
    cameraButton.disabled = false;
    cameraButton.textContent = 'Otestovať kameru';
  }
  if (microphoneButton) {
    microphoneButton.disabled = false;
    microphoneButton.textContent = 'Otestovať mikrofón';
  }
  const status = surface.querySelector('#mediaDeviceTestStatus');
  if (status && type) status.textContent = message;
  if (type) {
    try {
      await window.linsoftBrowser?.releaseMediaDeviceTest?.(type);
    } catch (error) {
      console.error('Linsoft Browser could not release the media-device test permission:', error);
    }
  }
}

async function startMediaDeviceTest(type) {
  if (!['audio', 'video'].includes(type)) return;
  const surface = getActiveSurface();
  const button = surface.querySelector(`[data-media-device-test="${type}"]`);
  const status = surface.querySelector('#mediaDeviceTestStatus');
  if (!button || !status) return;
  if (mediaDeviceTestType === type) {
    await stopMediaDeviceTest('Test zariadenia bol zastavený.');
    return;
  }
  await stopMediaDeviceTest('Pripravuje sa test zariadenia...');
  const generation = ++mediaDeviceTestGeneration;
  mediaDeviceTestType = type;
  button.disabled = false;
  button.textContent = 'Zastaviť test';
  status.textContent = `Pripája sa ${type === 'video' ? 'kamera' : 'mikrofón'}...`;
  try {
    let audioContext = null;
    if (type === 'audio') {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) throw new Error('Test úrovne mikrofónu tento systém nepodporuje.');
      audioContext = new AudioContextConstructor();
      mediaDeviceTestAudioContext = audioContext;
      if (audioContext.state === 'suspended') {
        void audioContext.resume().catch((error) => {
          console.error('Linsoft Browser could not resume the microphone test audio context:', error);
        });
      }
    }
    const authorization = await window.linsoftBrowser?.authorizeMediaDeviceTest?.(type);
    if (!authorization?.ok) throw new Error(authorization?.message || 'Prístup k zariadeniu nebol povolený.');
    if (generation !== mediaDeviceTestGeneration) {
      await window.linsoftBrowser?.releaseMediaDeviceTest?.(type);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: type === 'audio',
      video: type === 'video'
    });
    if (generation !== mediaDeviceTestGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      await window.linsoftBrowser?.releaseMediaDeviceTest?.(type);
      return;
    }
    mediaDeviceTestStream = stream;
    const track = type === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
    if (!track) throw new Error(`Zariadenie neposkytlo ${type === 'video' ? 'obraz' : 'zvuk'}.`);
    track.addEventListener('ended', () => {
      if (mediaDeviceTestStream === stream) void stopMediaDeviceTest('Zariadenie bolo odpojené.');
    }, { once: true });
    button.disabled = false;
    button.textContent = type === 'video' ? 'Vypnúť test kamery' : 'Vypnúť test mikrofónu';
    if (type === 'video') {
      const preview = surface.querySelector('#mediaDeviceTestPreview');
      preview.srcObject = stream;
      preview.hidden = false;
      await preview.play();
      status.textContent = `Kamera funguje: ${track.label || 'video vstup'}.`;
      return;
    }
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    if (audioContext.state === 'suspended') await audioContext.resume();
    const samples = new Uint8Array(analyser.fftSize);
    const meter = surface.querySelector('#microphoneTestLevel');
    const updateLevel = () => {
      if (generation !== mediaDeviceTestGeneration || mediaDeviceTestStream !== stream) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      meter.value = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      mediaDeviceTestAnimationFrame = requestAnimationFrame(updateLevel);
    };
    updateLevel();
    status.textContent = `Mikrofón funguje: ${track.label || 'audio vstup'}. Hovor alebo zaklop pre kontrolu úrovne.`;
  } catch (error) {
    if (generation !== mediaDeviceTestGeneration) return;
    const message = error instanceof Error ? error.message : 'Test zariadenia sa nepodarilo spustiť.';
    await stopMediaDeviceTest(message);
    console.error('Linsoft Browser media-device test failed:', error);
  }
}

async function stopUsbCameraCapture(message = 'Kamera je vypnutá.') {
  usbCameraGeneration += 1;
  const stream = usbCameraStream;
  usbCameraStream = null;
  usbCameraDeviceId = '';
  if (stream) stream.getTracks().forEach((track) => track.stop());
  const video = usbCameraTabId === null ? null : content.querySelector(`.tab-surface[data-tab-id="${usbCameraTabId}"] #usbCameraVideo`);
  if (video) video.srcObject = null;
  updateUsbCameraPageStatus(message, false);
}

async function startUsbCameraCapture(deviceId, label = '') {
  if (!settingsState.autoUsbCamera || usbCameraTabId !== activeTabId || !deviceId) return;
  if (usbCameraStream && usbCameraDeviceId === deviceId) return;
  if (usbCameraStream) await stopUsbCameraCapture('Prepína sa kamera...');
  const generation = ++usbCameraGeneration;
  updateUsbCameraPageStatus('Pripája sa ku kamere...', false);
  try {
    const authorization = await window.linsoftBrowser?.authorizeUsbCamera?.();
    if (!authorization?.ok) throw new Error(authorization?.message || 'Prístup ku kamere nie je povolený.');
    if (generation !== usbCameraGeneration) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    knownUsbCameraDeviceIds = window.LinsoftUsbCameraDevices.getVideoInputIds(devices);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    if (generation !== usbCameraGeneration || usbCameraTabId !== activeTabId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    usbCameraStream = stream;
    usbCameraDeviceId = deviceId;
    const video = content.querySelector(`.tab-surface[data-tab-id="${usbCameraTabId}"] #usbCameraVideo`);
    if (!video) throw new Error('Náhľad kamery sa nepodarilo zobraziť.');
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      if (usbCameraStream !== stream) return;
      void stopUsbCameraCapture('Kamera sa odpojila.');
    }, { once: true });
    const selectedDevice = devices.find((device) => device.kind === 'videoinput' && device.deviceId === deviceId);
    updateUsbCameraPageStatus(`Živý obraz: ${selectedDevice?.label || label || 'USB kamera'}`, true);
  } catch (error) {
    if (generation !== usbCameraGeneration) return;
    await stopUsbCameraCapture(error instanceof Error ? error.message : 'Kameru sa nepodarilo spustiť.');
    console.error('Linsoft Browser could not start the USB camera preview:', error);
  }
}

async function openUsbCameraForDevice(device) {
  if (!settingsState.autoUsbCamera || !device?.deviceId) return;
  const existingTab = [...tabs.values()].find((tab) => tab.url === 'linsoft://camera');
  if (existingTab) {
    if (activeTabId !== existingTab.id) selectTab(existingTab.id);
    else if (!content.querySelector(`.tab-surface[data-tab-id="${existingTab.id}"] .usb-camera-page`)) openUsbCameraPage();
  } else {
    openNewTab('linsoft://camera');
  }
  await startUsbCameraCapture(device.deviceId, device.label);
}

async function onUsbCameraDeviceChange() {
  if (!usbCameraDeviceMonitorReady || !navigator.mediaDevices?.enumerateDevices) return;
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (error) {
    console.error('Linsoft Browser could not enumerate USB cameras:', error);
    updateUsbCameraPageStatus('Zoznam kamier sa nepodarilo načítať.', false);
    return;
  }
  const nextIds = window.LinsoftUsbCameraDevices.getVideoInputIds(devices);
  const addedDevices = window.LinsoftUsbCameraDevices.getNewVideoInputs(knownUsbCameraDeviceIds, devices);
  knownUsbCameraDeviceIds = nextIds;
  if (usbCameraDeviceId && !nextIds.includes(usbCameraDeviceId)) {
    await stopUsbCameraCapture('Kamera sa odpojila.');
  }
  if (settingsState.autoUsbCamera && addedDevices.length) void openUsbCameraForDevice(addedDevices[0]);
}

function initializeUsbCameraDeviceMonitor() {
  if (usbCameraDeviceMonitorReady || !navigator.mediaDevices?.addEventListener || !navigator.mediaDevices?.enumerateDevices) return;
  usbCameraDeviceMonitorReady = true;
  const mediaDevices = navigator.mediaDevices;
  const initialize = async () => {
    try {
    const authorization = await window.linsoftBrowser?.authorizeUsbCamera?.();
    if (!authorization?.ok) throw new Error(authorization?.message || 'Prístup ku kamere nie je povolený.');
    if (!settingsState.autoUsbCamera) {
      await window.linsoftBrowser?.releaseUsbCamera?.();
      return;
    }
    const devices = await mediaDevices.enumerateDevices();
    if (!settingsState.autoUsbCamera) {
      await window.linsoftBrowser?.releaseUsbCamera?.();
      return;
    }
    knownUsbCameraDeviceIds = window.LinsoftUsbCameraDevices.getVideoInputIds(devices);
    mediaDevices.addEventListener('devicechange', onUsbCameraDeviceChange);
    } catch (error) {
    if (!settingsState.autoUsbCamera) {
      await window.linsoftBrowser?.releaseUsbCamera?.();
      return;
    }
    usbCameraDeviceMonitorReady = false;
    console.error('Linsoft Browser could not initialize USB camera monitoring:', error);
    updateUsbCameraPageStatus('Sledovanie pripojených kamier sa nepodarilo spustiť.', false);
    }
  };
  void initialize();
}

function openUsbCameraPage() {
  hideNativeTab();
  const surface = getActiveSurface();
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  if (surface.querySelector('.usb-camera-page')) {
    usbCameraTabId = activeTabId;
    activateSurface(activeTabId);
    return;
  }
  tab.url = 'linsoft://camera';
  tab.title = 'Kamera';
  usbCameraTabId = activeTabId;
  addressInput.value = tab.url;
  tabTitle.textContent = tab.title;
  updateActiveTab(tab.url, tab.title);
  setInstallAppAvailable(false);
  surface.innerHTML = `<main class="usb-camera-page" aria-labelledby="usbCameraHeading">
    <header class="usb-camera-header"><div><p class="settings-eyebrow">LINSOFT BROWSER</p><h1 id="usbCameraHeading">USB kamera</h1><p>Po pripojení novej kamery sa živý náhľad spustí automaticky, ak je táto funkcia zapnutá v Nastaveniach.</p></div><span id="usbCameraLiveIndicator" class="usb-camera-live" data-active="false">KAMERA VYPNUTÁ</span></header>
    <div class="usb-camera-preview"><video id="usbCameraVideo" autoplay muted playsinline aria-label="Živý náhľad USB kamery"></video><div class="usb-camera-placeholder"><img src="assets/linsoft-icon.svg" alt=""><strong>Čaká sa na USB kameru</strong><span>Pripoj kameru. Ak automatické spustenie nie je zapnuté, povoľ ho v Nastaveniach → Súkromie.</span></div></div>
    <footer class="usb-camera-footer"><p id="usbCameraStatus" role="status" aria-live="polite">Žiadna nová kamera nebola pripojená.</p><button id="usbCameraStop" type="button" disabled>Vypnúť kameru</button><button id="usbCameraSettings" type="button">Nastavenia</button></footer>
  </main>`;
  surface.querySelector('#usbCameraStop').addEventListener('click', () => void stopUsbCameraCapture('Kamera bola vypnutá.'));
  surface.querySelector('#usbCameraSettings').addEventListener('click', () => openNewTab('linsoft://settings'));
  updateUsbCameraPageStatus(settingsState.autoUsbCamera
    ? 'Čaká sa na pripojenie USB kamery.'
    : 'Automatické spustenie kamery je vypnuté v Nastaveniach.', false);
  updateNavigationButtons();
  saveSession();
}

function openTorChatPage() {
  if (!confirmSettingsDeparture()) return;
  if (!torChatPanel) openSettings();
  if (!torChatPanel) { showToast('Onion Chat sa nepodarilo otvoriť.'); return; }
  hideNativeTab();
  const surface = getActiveSurface();
  addressInput.value = 'linsoft://tor-chat';
  tabTitle.textContent = 'Onion Chat';
  updateActiveTab('linsoft://tor-chat', 'Onion Chat');
  setInstallAppAvailable(false);
  surface.innerHTML = '<div class="tor-chat-tab-page"><header class="tor-chat-tab-header"><div class="tor-chat-tab-brand"><span class="tor-chat-brand-mark small">L</span><span>Linsoft <strong>Onion</strong></span></div><span class="tor-chat-tab-secure">Súkromný chat 1:1 cez Tor</span><button class="settings-control" id="torChatBackSettings" type="button">Nastavenia</button></header><div class="tor-chat-tab-content"></div></div>';
  const contentArea = surface.querySelector('.tor-chat-tab-content');
  torChatPanel.hidden = false;
  contentArea.append(torChatPanel);
  surface.querySelector('#torChatBackSettings').addEventListener('click', () => openNewTab('linsoft://settings'));
  surface.querySelector('.tor-chat-rail-button')?.addEventListener('click', () => openNewTab('linsoft://settings'));
  renderTorChatState();
  updateNavigationButtons();
  saveSession();
}

function saveSession() {
  localStorage.setItem(sessionStorageKey('session'), JSON.stringify([...tabs.values()]));
  localStorage.setItem(sessionStorageKey('active-tab'), String(activeTabId));
  localStorage.setItem(sessionStorageKey('closed-tabs'), JSON.stringify(closedTabs.slice(0, 10)));
  localStorage.setItem(sessionStorageKey('session-clean'), '0');
  updateNavigationButtons();
}

function suspendInactiveTabs() { if (!settingsState.suspendInactiveTabs) return; for (const [id, tab] of tabs) { if (id === activeTabId || tab.pinned || suspendedTabs.has(id) || !tab.url || !/^https?:/i.test(tab.url) || /(?:youtube\.com|youtu\.be)/i.test(tab.url)) continue; const viewer = content.querySelector(`.tab-surface[data-tab-id="${id}"] webview`); if (!viewer) continue; viewer.executeJavaScript('document.querySelectorAll("video,audio").forEach((media) => media.pause())').catch(() => {}); viewer.remove(); content.querySelector(`.tab-surface[data-tab-id="${id}"]`)?.remove(); suspendedTabs.add(id); tab.suspended = true; } }

const weatherLocationStorageKey = 'linsoft-weather-location';
const weatherConditions = {
  0: ['Jasno', '☀'], 1: ['Prevažne jasno', '🌤'], 2: ['Polooblačno', '⛅'], 3: ['Zamračené', '☁'],
  45: ['Hmla', '🌫'], 48: ['Mrznúca hmla', '🌫'],
  51: ['Slabé mrholenie', '🌦'], 53: ['Mrholenie', '🌦'], 55: ['Silné mrholenie', '🌧'], 56: ['Mrznúce mrholenie', '🌧'], 57: ['Silné mrznúce mrholenie', '🌧'],
  61: ['Slabý dážď', '🌦'], 63: ['Dážď', '🌧'], 65: ['Silný dážď', '🌧'], 66: ['Mrznúci dážď', '🌧'], 67: ['Silný mrznúci dážď', '🌧'],
  71: ['Slabé sneženie', '🌨'], 73: ['Sneženie', '🌨'], 75: ['Silné sneženie', '❄'], 77: ['Snehové zrná', '❄'],
  80: ['Prehánky', '🌦'], 81: ['Prehánky', '🌧'], 82: ['Silné prehánky', '🌧'], 85: ['Snehové prehánky', '🌨'], 86: ['Silné snehové prehánky', '❄'],
  95: ['Búrka', '⛈'], 96: ['Búrka s krúpami', '⛈'], 99: ['Silná búrka s krúpami', '⛈']
};

function readWeatherLocation() {
  try {
    const location = JSON.parse(localStorage.getItem(weatherLocationStorageKey) || 'null');
    if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
      && location.latitude >= -90 && location.latitude <= 90 && location.longitude >= -180 && location.longitude <= 180) {
      if (location.weather && Number.isFinite(location.weather.updatedAt)) return location;
      return { latitude: location.latitude, longitude: location.longitude, name: String(location.name || 'Tvoja poloha') };
    }
  } catch (error) {
    console.error('Saved weather location could not be read:', error);
    localStorage.removeItem(weatherLocationStorageKey);
  }
  return null;
}

function getDeviceLocation() {
  if (!navigator.geolocation) return Promise.reject(new Error('Poloha zariadenia nie je dostupná.'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ latitude: Number(coords.latitude.toFixed(2)), longitude: Number(coords.longitude.toFixed(2)) }),
    (error) => reject(new Error(error.code === error.PERMISSION_DENIED ? 'Prístup k polohe bol zamietnutý.' : error.code === error.TIMEOUT ? 'Zisťovanie polohy trvalo príliš dlho.' : 'Polohu zariadenia sa nepodarilo zistiť.')),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 15 * 60 * 1000 }
  ));
}

async function fetchWeatherJson(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(String(data.reason || 'Weather service returned an error.'));
    return data;
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderStartWeather(card, location) {
  const weather = location?.weather;
  if (!weather || !card.isConnected) return;
  card.querySelector('.weather-first-use')?.remove();
  const [description, defaultIcon] = weatherConditions[weather.weatherCode] || ['Aktuálne počasie', '☁'];
  const icon = weather.weatherCode === 0 && weather.isDay === 0 ? '☾' : defaultIcon;
  const temperature = (value) => Number.isFinite(value) ? `${Math.round(value)}°` : '—°';
  card.querySelector('.weather-place').textContent = location.name || 'Tvoja poloha';
  card.querySelector('.weather-condition-icon').textContent = icon;
  card.querySelector('.weather-temperature').textContent = temperature(weather.temperature);
  card.querySelector('.weather-description').textContent = description;
  card.querySelector('.weather-feels').textContent = `Pocitovo ${temperature(weather.apparentTemperature)}`;
  card.querySelector('.weather-details').textContent = `Vlhkosť ${Number.isFinite(weather.humidity) ? `${Math.round(weather.humidity)}%` : '—'} · Vietor ${Number.isFinite(weather.windSpeed) ? `${Math.round(weather.windSpeed)} km/h` : '—'}`;
  card.querySelector('.weather-range').textContent = Number.isFinite(weather.high) && Number.isFinite(weather.low) ? `Najvyššia ${Math.round(weather.high)}° · Najnižšia ${Math.round(weather.low)}°` : '';
}

function formatWeatherTime(timestamp) {
  return new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

async function updateStartWeather(card, location, refreshLocation = false) {
  const action = card.querySelector('[data-weather-action]');
  const locationAction = card.querySelector('[data-weather-location]');
  const status = card.querySelector('.weather-status');
  const setState = (message) => { if (card.isConnected) status.textContent = message; };
  if (!card.isConnected || action.disabled) return;
  action.disabled = true;
  if (locationAction) locationAction.disabled = true;
  action.textContent = 'Načítavam…';
  setState(refreshLocation || !location ? 'Zisťujem polohu zariadenia…' : 'Aktualizujem predpoveď…');
  try {
    const coordinates = refreshLocation || !location ? await getDeviceLocation() : location;
    if (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)
      || coordinates.latitude < -90 || coordinates.latitude > 90 || coordinates.longitude < -180 || coordinates.longitude > 180) {
      throw new Error('Poloha zariadenia nie je platná.');
    }
    const query = new URLSearchParams({
      latitude: String(coordinates.latitude),
      longitude: String(coordinates.longitude),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min',
      forecast_days: '1',
      timezone: 'auto'
    });
    const weather = await fetchWeatherJson(`https://api.open-meteo.com/v1/forecast?${query}`);
    if (!card.isConnected) return;
    const result = weather.current;
    if (!result || !Number.isFinite(result.temperature_2m)) throw new Error('Weather service returned incomplete data.');
    const name = coordinates.name || 'Tvoja poloha';
    const weatherLocation = {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      name,
      weather: {
        temperature: result.temperature_2m,
        apparentTemperature: result.apparent_temperature,
        humidity: result.relative_humidity_2m,
        windSpeed: result.wind_speed_10m,
        weatherCode: result.weather_code,
        isDay: result.is_day,
        high: weather.daily?.temperature_2m_max?.[0],
        low: weather.daily?.temperature_2m_min?.[0],
        updatedAt: Date.now()
      }
    };
    localStorage.setItem(weatherLocationStorageKey, JSON.stringify(weatherLocation));
    renderStartWeather(card, weatherLocation);
    action.textContent = 'Obnoviť počasie';
    action.setAttribute('aria-label', 'Obnoviť počasie');
    if (locationAction) locationAction.hidden = false;
    setState(`Aktualizované ${formatWeatherTime(weatherLocation.weather.updatedAt)} · Open-Meteo`);
  } catch (error) {
    console.error('Start page weather failed:', error);
    action.textContent = 'Skúsiť znova';
    action.setAttribute('aria-label', 'Znova načítať počasie');
    const locationError = ['Poloha zariadenia nie je dostupná.', 'Prístup k polohe bol zamietnutý.', 'Zisťovanie polohy trvalo príliš dlho.', 'Polohu zariadenia sa nepodarilo zistiť.', 'Poloha zariadenia nie je platná.'].includes(error.message);
    setState(locationError ? error.message : location?.weather ? `Offline · zobrazené uložené údaje z ${formatWeatherTime(location.weather.updatedAt)}` : error.name === 'AbortError' ? 'Počasie sa načítavalo príliš dlho. Skús to znova.' : 'Počasie sa nepodarilo načítať. Skontroluj pripojenie a skús to znova.');
  } finally {
    action.disabled = false;
    if (locationAction) locationAction.disabled = false;
  }
}

function restoreSession() {
  updateClosedTabsButton();
  if (!settingsState.restoreTabs) return startPage();
  let sessionTabs = [];
  try { sessionTabs = window.LinsoftTabState.normalizeSessionTabs(JSON.parse(localStorage.getItem(sessionStorageKey('session')) || '[]'), isRestorableTabUrl); } catch { sessionTabs = []; }
  if (!sessionTabs.length) return startPage();
  const first = sessionTabs[0]; const firstTab = tabs.get(1); Object.assign(firstTab, first, { id: 1 }); const firstButton = document.querySelector('.managed-tab[data-tab-id="1"]'); firstButton?.classList.toggle('pinned', firstTab.pinned === true); if (firstButton) firstButton.querySelector('span:nth-child(2)').textContent = firstTab.title; if (firstTab.muted) setTabAudioIcon(1, true, false); setTabIcon(1, firstTab.icon || '', firstTab.url === 'linsoft://start'); updateTabLabel(firstButton); if (first.url === 'linsoft://start') startPage(); else navigate(first.url, false);
  sessionTabs.slice(1).forEach((tab) => { const id = nextTabId++; const restoredTab = Object.assign({ history: [tab.url], historyIndex: 0, pinned: false, suspended: true }, tab, { id }); tabs.set(id, restoredTab); suspendedTabs.add(id); const button = createTabButton(restoredTab); updateTabLabel(button); });
  const savedActiveTab = Number(localStorage.getItem(sessionStorageKey('active-tab')));
  if (tabs.has(savedActiveTab)) selectTab(savedActiveTab);
  updateTabDensity();
}

const hadCrash = localStorage.getItem(sessionStorageKey('session-clean')) === '0';
localStorage.setItem(sessionStorageKey('session-clean'), '0');
window.addEventListener('beforeunload', () => { saveSession(); localStorage.setItem(sessionStorageKey('session-clean'), '1'); });
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });
window.setInterval(suspendInactiveTabs, 5 * 60 * 1000);

function startPage() {
  if (!confirmSettingsDeparture()) return;
  pendingTorNavigations.delete(activeTabId);
  hideNativeTab();
  setTabLoading(activeTabId, false);
  addressInput.value = 'linsoft://start';
  tabTitle.textContent = 'Linsoft Browser';
  setInstallAppAvailable(false);
  updateActiveTab('linsoft://start', 'Linsoft Browser');
  updateNavigationButtons();
  setTabIcon(activeTabId, '', true);
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  const hiddenFavorites = new Set(Array.isArray(settingsState.startHiddenFavorites) ? settingsState.startHiddenFavorites.filter((url) => typeof url === 'string') : []);
  const favorites = (startFavorites.length ? startFavorites : defaultStartFavorites).filter((item) => !hiddenFavorites.has(item.url));
  const savedWeatherLocation = readWeatherLocation();
  const siteMarkup = (item) => {
    const title = String(item.title || item.url);
    const faviconUrl = bookmarkFaviconUrl(item.url);
    const iconMarkup = `${faviconUrl ? `<img class="start-site-favicon" src="${escapeHtml(faviconUrl)}" alt="">` : ''}<span class="start-site-fallback"${faviconUrl ? ' hidden' : ''}>${escapeHtml(title.slice(0, 1).toUpperCase())}</span>`;
    return `<div class="start-favorite"${startFavorites.length ? ` draggable="true" data-start-favorite-index="${startFavorites.indexOf(item)}"` : ''}><button class="start-favorite-open" data-url="${escapeHtml(item.url)}" title="${escapeHtml(title)}"><span class="start-favorite-icon">${iconMarkup}</span><span>${escapeHtml(title)}</span></button>${startFavorites.length ? `<button class="start-favorite-remove" data-start-favorite-remove="${startFavorites.indexOf(item)}" aria-label="Odopnúť ${escapeHtml(title)}" title="Odopnúť zo štartu"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-x"></use></svg></button>` : ''}</div>`;
  };
  surface.innerHTML = `<div class="start"><div class="start-kicker">LINSOFT BROWSER <span></span></div><div class="logo"><span class="logo-l">L</span>in<span>soft</span><i>•</i></div><p>${isGuestWindow ? 'Okno hosťa: história, cookies a údaje stránok sa po zatvorení nezachovajú.' : 'Rýchly, súkromný a skutočný webový prehliadač pre Windows a Linux Debian.'}</p><form class="start-form" role="search"><div class="start-search"><span>⌕</span><input class="start-input" aria-label="Hľadať na webe alebo zadať adresu" placeholder="Hľadať na webe alebo zadať adresu" autocomplete="off" /></div></form><section class="start-weather" aria-label="Počasie" aria-live="polite"><div class="weather-heading"><span class="weather-eyebrow">POČASIE V TVOJEJ LOKALITE</span><span class="weather-status">${savedWeatherLocation ? 'Načítavam počasie pre uloženú lokalitu…' : 'Poloha sa zistí až po tvojom povolení.'}</span></div><div class="weather-content"><span class="weather-condition-icon" aria-hidden="true">⌖</span><div class="weather-reading"><strong class="weather-temperature">--°</strong><span class="weather-description">Aktuálne počasie</span></div><div class="weather-place-details"><strong class="weather-place">Poloha zariadenia</strong><span class="weather-feels">Pocitovo --°</span><span class="weather-details">Vlhkosť --% · Vietor -- km/h</span><span class="weather-range"></span></div><button class="weather-action" type="button" data-weather-action>${savedWeatherLocation ? 'Obnoviť polohu' : 'Zistiť počasie'}</button></div><p class="weather-privacy">${savedWeatherLocation ? 'Uložená poloha zostáva v tomto prehliadači; súradnice používa Open-Meteo na výpočet počasia.' : 'Poloha sa zistí až po povolení; súradnice sa odošlú službe Open-Meteo.'}</p></section><section class="start-favorites"><div class="start-section-heading"><h2>${startFavorites.length ? 'Pripnuté stránky' : 'Rýchly prístup'}</h2><button type="button" data-library="bookmarks">${startFavorites.length ? 'Upraviť poradie' : 'Pripnúť záložku'}</button></div><div class="quick">${favorites.map((item) => siteMarkup(item)).join('')}</div></section><div class="start-footer"><span>● ${isGuestWindow ? 'Režim hosťa aktívny' : 'Chránené prehliadanie aktívne'}</span><span>Linsoft Browser 2.0 • Windows + Linux</span></div></div>`;
  activateSurface(activeTabId);
  surface.querySelector('.start-weather').hidden = settingsState.startShowWeather === false;
  surface.querySelector('.start-favorites').hidden = settingsState.startShowFavorites === false;
  surface.querySelector('.start-footer').hidden = settingsState.startShowFooter === false;
  const customizeStart = document.createElement('button');
  customizeStart.type = 'button';
  customizeStart.className = 'start-customize';
  customizeStart.textContent = 'Prispôsobiť úvodnú stránku';
  customizeStart.addEventListener('click', () => openNewTab('linsoft://settings'));
  surface.querySelector('.start-form').insertAdjacentElement('afterend', customizeStart);
  if (!favorites.length) {
    const emptyFavorites = document.createElement('p');
    emptyFavorites.className = 'start-favorites-empty';
    emptyFavorites.textContent = 'Všetky rýchle odkazy sú skryté. Zobraz ich v nastaveniach; záložky zostanú uložené.';
    surface.querySelector('.start-favorites .quick').replaceWith(emptyFavorites);
  }
  surface.querySelectorAll('.start-site-favicon').forEach((icon) => icon.addEventListener('error', () => { icon.hidden = true; icon.nextElementSibling.hidden = false; }));
  surface.querySelector('.start-form').addEventListener('submit', (event) => { event.preventDefault(); navigate(surface.querySelector('.start-input').value); });
  surface.querySelector('.start-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); navigate(event.currentTarget.value); } });
  surface.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.url)));
  surface.querySelectorAll('[data-library]').forEach((button) => button.addEventListener('click', () => openLibrary(button.dataset.library)));
  const weatherCard = surface.querySelector('.start-weather');
  const weatherAction = weatherCard.querySelector('[data-weather-action]');
  const weatherActions = document.createElement('div');
  weatherActions.className = 'weather-actions';
  weatherAction.replaceWith(weatherActions);
  weatherActions.appendChild(weatherAction);
  weatherAction.textContent = savedWeatherLocation ? 'Obnoviť počasie' : 'Zistiť počasie';
  weatherAction.setAttribute('aria-label', savedWeatherLocation ? 'Obnoviť počasie' : 'Zistiť počasie');
  const locationAction = document.createElement('button');
  locationAction.className = 'weather-location-action';
  locationAction.type = 'button';
  locationAction.dataset.weatherLocation = '';
  locationAction.textContent = 'Zmeniť polohu';
  locationAction.hidden = !savedWeatherLocation;
  weatherActions.appendChild(locationAction);
  weatherCard.removeAttribute('aria-live');
  weatherCard.querySelector('.weather-status').setAttribute('role', 'status');
  weatherCard.querySelector('.weather-status').setAttribute('aria-live', 'polite');
  if (!savedWeatherLocation) {
    const firstUse = document.createElement('div');
    firstUse.className = 'weather-first-use';
    firstUse.setAttribute('aria-label', 'Ako načítať počasie');
    firstUse.innerHTML = '<strong>Počasie ešte nie je nastavené</strong><ol><li>Klikni na <b>Zistiť počasie</b>.</li><li>V dialógu prehliadača povoľ prístup k polohe.</li><li>Počasie sa načíta pre približnú polohu.</li></ol>';
    weatherCard.querySelector('.weather-content').insertAdjacentElement('afterend', firstUse);
  }
  weatherAction.addEventListener('click', () => { void updateStartWeather(weatherCard, readWeatherLocation()); });
  locationAction.addEventListener('click', () => { void updateStartWeather(weatherCard, readWeatherLocation(), true); });
  weatherCard.querySelector('.weather-privacy').textContent = savedWeatherLocation
    ? 'Približná poloha je uložená iba v tomto prehliadači; počasie poskytuje Open-Meteo.'
    : 'Približná poloha sa zistí až po povolení a odošle službe Open-Meteo.';
  if (savedWeatherLocation?.weather) {
    renderStartWeather(weatherCard, savedWeatherLocation);
    weatherCard.querySelector('.weather-status').textContent = `Uložené údaje z ${formatWeatherTime(savedWeatherLocation.weather.updatedAt)} · aktualizujem…`;
  }
  if (savedWeatherLocation && settingsState.startShowWeather !== false) void updateStartWeather(weatherCard, savedWeatherLocation);
  surface.querySelectorAll('[data-start-favorite-remove]').forEach((button) => button.addEventListener('click', () => {
    startFavorites.splice(Number(button.dataset.startFavoriteRemove), 1);
    localStorage.setItem('linsoft-start-favorites', JSON.stringify(startFavorites));
    startPage();
  }));
  const quickLinks = surface.querySelector('.quick');
  let draggedFavoriteIndex = -1;
  quickLinks?.addEventListener('dragstart', (event) => {
    const tile = event.target.closest('[data-start-favorite-index]');
    if (!tile) return;
    draggedFavoriteIndex = Number(tile.dataset.startFavoriteIndex);
    event.dataTransfer?.setData('text/plain', String(draggedFavoriteIndex));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  quickLinks?.addEventListener('dragover', (event) => { if (event.target.closest('[data-start-favorite-index]')) event.preventDefault(); });
  quickLinks?.addEventListener('drop', (event) => {
    const target = event.target.closest('[data-start-favorite-index]');
    const targetIndex = Number(target?.dataset.startFavoriteIndex);
    if (!target || draggedFavoriteIndex < 0 || targetIndex === draggedFavoriteIndex) return;
    event.preventDefault();
    const [favorite] = startFavorites.splice(draggedFavoriteIndex, 1);
    startFavorites.splice(targetIndex, 0, favorite);
    localStorage.setItem('linsoft-start-favorites', JSON.stringify(startFavorites));
    startPage();
  });
}

function searchUrl(query) {
  const encoded = encodeURIComponent(query);
  if (settingsState.search === 'Bing') return `https://www.bing.com/search?q=${encoded}`;
  if (settingsState.search === 'DuckDuckGo') return `https://duckduckgo.com/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
}

function translateWebPage(value = tabs.get(activeTabId)?.url || addressInput.value) {
  let pageUrl;
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported');
    pageUrl = parsed.href;
  } catch {
    showToast('Prekladať možno iba webovú stránku HTTP alebo HTTPS.');
    return;
  }
  navigate(`https://translate.google.com/translate?sl=auto&tl=sk&u=${encodeURIComponent(pageUrl)}`);
}

function normalizeNetworkAddress(input) {
  const value = String(input || '').trim();
  const localhost = /^localhost(?::(\d+))?(\/.*)?$/i.exec(value);
  if (localhost) return { value: `http://localhost${localhost[1] ? `:${localhost[1]}` : ''}${localhost[2] || ''}`, isIp: true };
  const ipv4 = value.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::(\d+))?(\/.*)?$/);
  if (ipv4) {
    const validPort = !ipv4[2] || Number(ipv4[2]) <= 65535;
    const valid = validPort && ipv4[1].split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
    if (valid) return { value: `http://${ipv4[1]}${ipv4[2] ? `:${ipv4[2]}` : ''}${ipv4[3] || ''}`, isIp: true };
  }
  const bracketedIpv6 = /^\[([0-9a-f:]+)\](?::(\d+))?(\/.*)?$/i.exec(value);
  if (bracketedIpv6 && (!bracketedIpv6[2] || Number(bracketedIpv6[2]) <= 65535)) return { value: `http://[${bracketedIpv6[1]}]${bracketedIpv6[2] ? `:${bracketedIpv6[2]}` : ''}${bracketedIpv6[3] || ''}`, isIp: true };
  const rawIpv6 = /^[0-9a-f:]+$/i.test(value) && value.includes(':');
  if (rawIpv6) return { value: `http://[${value}]`, isIp: true };
  return { value, isIp: false };
}

function updateConnectionIndicator(url) {
  const secure = /^https:\/\//i.test(url);
  const weak = /^http:\/\//i.test(url);
  const linsoftPage = /^linsoft:\/\//i.test(url);
  const localFile = /^file:\/\//i.test(url);
  const internalLabel = linsoftPage ? 'Interná stránka Linsoft' : localFile ? 'Lokálny súbor' : 'Lokálny alebo nešifrovaný obsah';
  const button = document.getElementById('securityButton');
  const title = document.getElementById('securityTitle');
  const check = document.querySelector('.security-check');
  if (button) { button.classList.toggle('https-active', secure); button.classList.toggle('http-warning', weak); button.title = secure ? 'Zabezpečené HTTPS pripojenie' : weak ? 'Slabo zabezpečené HTTP pripojenie' : internalLabel; button.setAttribute('aria-label', button.title); }
  if (check) { check.classList.toggle('warning', weak); check.textContent = weak ? '!' : '✓'; }
  if (title) title.textContent = secure ? 'Pripojenie je zabezpečené' : weak ? 'Slabo zabezpečené HTTP pripojenie' : internalLabel;
  const origin = document.getElementById('securityOrigin');
  const explanation = document.getElementById('securityExplanation');
  if (origin) {
    try { origin.textContent = linsoftPage ? 'Interná stránka Linsoft' : new URL(url).host || internalLabel; }
    catch { origin.textContent = 'Adresa nie je dostupná'; }
  }
  if (explanation) explanation.textContent = secure ? 'HTTPS šifruje prenos k tomuto webu. Samotné šifrovanie nezaručuje dôveryhodnosť stránky.'
    : weak ? 'HTTP prenos nie je šifrovaný. Na tejto stránke nezadávaj heslá ani platobné údaje.'
      : linsoftPage ? 'Toto je vstavaná stránka Linsoft Browser. Nie je to vzdialené webové pripojenie.'
        : localFile ? 'Tento obsah sa načítava z lokálneho súboru vo svojom zariadení.'
          : 'Táto stránka je lokálna alebo interná. Nejde o overenie vzdialeného webu.';
}

function installYoutubeAdBlock(viewer) {
  if (!settingsState.adBlock || !viewer) return;
  let hostname = '';
  try { hostname = new URL(viewer.getURL?.() || viewer.src || '').hostname; } catch { return; }
  if (!/youtube\.com$/i.test(hostname)) return;
  viewer.executeJavaScript(`(() => {
    if (window.__linsoftYoutubeAdBlock) return;
    window.__linsoftYoutubeAdBlock = true;
    const selectors = [
      '.video-ads', '.ytp-ad-module', '.ytp-ad-overlay-container', '.ytp-ad-text-overlay',
      '.ytp-ad-player-overlay', '.ytp-ad-image-overlay', '.ytp-ad-overlay-slot',
      'ytd-display-ad-renderer', 'ytd-promoted-sparkles-web-renderer',
      'ytd-action-companion-ad-renderer', 'ytd-in-feed-ad-layout-renderer',
      'ytd-banner-promo-renderer', 'ytd-ad-slot-renderer'
    ];
    const clean = () => {
      document.querySelectorAll(selectors.join(',')).forEach((element) => element.remove());
      const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
      if (skip) skip.click();
      const player = document.querySelector('.html5-video-player');
      if (player && player.classList.contains('ad-showing')) {
        const video = player.querySelector('video');
        if (video) { video.currentTime = video.duration || 0; video.play().catch(() => {}); }
      }
    };
    clean();
    new MutationObserver(clean).observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(clean, 2500);
  })()`).catch(() => {});
}

function installOverlayCloseFallback(viewer) {
  if (!viewer) return;
  viewer.executeJavaScript(`(() => {
    if (window.__linsoftOverlayCloseFallbackInstalled) return;
    window.__linsoftOverlayCloseFallbackInstalled = true;
    const closeLabels = /^(?:zavrie(?:ť|t)|zatvoriť|close|dismiss)(?:\\s+(?:reklamu|advertisement|ad|okno|window))?$/i;
    document.addEventListener('click', (event) => {
      const path = event.composedPath?.() || [event.target];
      const closeControl = path.find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent].filter(Boolean).join(' ').trim().replace(/\\s+/g, ' ');
        return closeLabels.test(label) && (node.matches('button, a, [role="button"], [aria-label], [title]') || getComputedStyle(node).cursor === 'pointer');
      });
      if (!closeControl) return;
      let overlay = null;
      for (let parent = closeControl; parent instanceof HTMLElement && parent !== document.body; parent = parent.parentElement) {
        const bounds = parent.getBoundingClientRect();
        const style = getComputedStyle(parent);
        const dialog = parent.matches('dialog, [role="dialog"], [aria-modal="true"]');
        const floatingPanel = style.position === 'fixed' && Number.parseInt(style.zIndex, 10) > 10 && bounds.width > innerWidth * .35 && bounds.height > innerHeight * .15;
        if (dialog || floatingPanel) overlay = parent;
      }
      if (!overlay) return;
      window.setTimeout(() => {
        if (!overlay.isConnected) return;
        const style = getComputedStyle(overlay);
        if (overlay.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
        overlay.style.setProperty('display', 'none', 'important');
      }, 350);
    });
  })()`).catch(() => {});
}


function showExternalPreview(surface, url) {
  surface.innerHTML = `<div class="external-preview"><div class="external-preview-icon">↗</div><p class="settings-eyebrow">WEBOVÁ STRÁNKA</p><h2>${escapeHtml(new URL(url).hostname)}</h2><p>Táto stránka nepovoľuje vloženie do náhľadu. Otvorí sa priamo v novej karte prehliadača.</p><a class="external-preview-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Otvoriť stránku</a></div>`;
  activateSurface(activeTabId);
}

function setInstallAppAvailable(available) { const button = document.getElementById('installAppButton'); if (button) button.hidden = !available; }
function installCurrentApp() { const url = addressInput.value; if (!/^https?:\/\//i.test(url)) return showToast('Táto stránka sa nedá nainštalovať ako webová aplikácia.'); document.getElementById('installDialogTitle').textContent = `Nainštalovať ${tabTitle.textContent}?`; document.getElementById('installDialogUrl').textContent = url; document.getElementById('installDialog').hidden = false; }

function closeInstallDialog() { document.getElementById('installDialog').hidden = true; }

function openAppCenter() {
  if (!confirmSettingsDeparture()) return;
  const appCenterTitle = 'App Centrum · Linsoft Browser';
  addressInput.value = 'linsoft://apps';
  tabTitle.textContent = appCenterTitle;
  updateActiveTab('linsoft://apps', appCenterTitle);
  saveSession();
  setInstallAppAvailable(false);
  const surface = getActiveSurface();
  surface.innerHTML = `<div class="app-center-page app-center-dashboard">
    <header class="app-center-hero">
      <div class="app-center-welcome"><span class="settings-eyebrow">VÁŠ DIGITÁLNY PRIESTOR</span><h1>App Centrum</h1><p>Všetky vaše weby. Jeden prehľadný priestor.</p><div class="app-center-hero-links"><a href="#appCenterWorkspace">Moje aplikácie <span aria-hidden="true">↓</span></a><a href="#appCenterCatalogSection">Objaviť weby <span aria-hidden="true">↗</span></a></div></div>
      <div class="app-center-brand"><img src="assets/linsoft-icon.svg" alt="Logo Linsoft Browser" width="100" height="100"><span>Linsoft <strong>Browser</strong></span></div>
    </header>
    <div class="app-center-overview" aria-label="Prehľad App Centra"><div><span class="app-center-stat-icon" aria-hidden="true"><svg class="ui-icon"><use href="#icon-layout-grid"></use></svg></span><span><strong id="appCenterTotal">0</strong><small>Moje aplikácie</small></span></div><div><span class="app-center-stat-icon" aria-hidden="true"><svg class="ui-icon"><use href="#icon-bookmark-check"></use></svg></span><span><strong id="appCenterFavorites">0</strong><small>Obľúbené</small></span></div><div><span class="app-center-stat-icon" aria-hidden="true"><svg class="ui-icon"><use href="#icon-search"></use></svg></span><span><strong>${appCatalog.length}</strong><small>Weby v katalógu</small></span></div></div>
    <section class="app-center-workspace" id="appCenterWorkspace" aria-labelledby="appCenterWorkspaceTitle">
      <div class="app-center-toolbar"><div class="app-center-section-title"><p class="settings-label">VÁŠ VÝBER</p><h2 id="appCenterWorkspaceTitle">Moje aplikácie</h2><small><strong id="appCenterCount"></strong> vo vašom pracovnom priestore</small></div><div class="app-center-actions"><button class="settings-control" id="appCenterImport" type="button">Importovať</button><button class="settings-control" id="appCenterExport" type="button">Exportovať</button><button class="app-center-add" id="appCenterNewApp" type="button">+ Pridať web</button><input id="appCenterImportFile" type="file" accept="application/json" hidden></div></div>
      <div class="app-center-list" id="appCenterInstalled"></div>
    </section>
    <section class="app-center-catalog" id="appCenterCatalogSection" aria-labelledby="appCenterCatalogTitle">
      <div class="app-center-catalog-head"><div><p class="settings-label">OBJAVTE NIEČO NOVÉ</p><h2 id="appCenterCatalogTitle">Katalóg webov</h2><p class="app-center-section-description">Práca, tvorba aj oddych. Vyberte si web a pridajte ho medzi svoje aplikácie.</p></div><label class="app-center-search-field"><svg class="ui-icon" aria-hidden="true"><use href="#icon-search"></use></svg><input class="app-center-search" id="appCenterSearch" type="search" placeholder="Hľadať aplikáciu alebo web…" aria-label="Hľadať v katalógu"></label></div>
      <div class="app-center-filters" id="appCenterFilters" role="group" aria-label="Kategórie webov"><button class="active" data-category="all" type="button" aria-pressed="true">Všetky</button><button data-category="work" type="button" aria-pressed="false">Práca</button><button data-category="creative" type="button" aria-pressed="false">Tvorba</button><button data-category="social" type="button" aria-pressed="false">Komunikácia</button><button data-category="media" type="button" aria-pressed="false">Médiá</button><button data-category="games" type="button" aria-pressed="false">Hry</button><button data-category="tools" type="button" aria-pressed="false">Nástroje</button></div><p class="app-center-catalog-count" id="appCenterCatalogCount" role="status"></p><div class="app-center-catalog-grid" id="appCenterCatalog"></div>
    </section>
    <div class="app-center-dialog-backdrop" id="appCenterDialog" hidden><form class="app-center-add-dialog" id="appCenterForm"><button class="app-center-dialog-close" id="appCenterDialogClose" type="button" aria-label="Zavrieť">×</button><p class="settings-eyebrow">NOVÝ WEB</p><h2>Pridať do App Centra</h2><label>Názov<input id="appCenterName" maxlength="60" placeholder="napr. Môj projekt" required></label><label>Webová adresa<input id="appCenterUrl" type="url" placeholder="https://example.com" required></label><div class="app-center-dialog-actions"><button class="settings-control" id="appCenterCancel" type="button">Zrušiť</button><button class="app-center-add" type="submit">Pridať</button></div></form></div>
  </div>`;

  let activeCategory = 'all';
  const installedList = surface.querySelector('#appCenterInstalled');
  const catalogGrid = surface.querySelector('#appCenterCatalog');
  const queryInput = surface.querySelector('#appCenterSearch');
  surface.querySelectorAll('.app-center-hero-links a').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    surface.querySelector(link.getAttribute('href'))?.scrollIntoView({ block: 'start' });
  }));
  const savedSortMode = localStorage.getItem('linsoft-app-center-sort');
  let appSortMode = ['manual', 'name', 'recent'].includes(savedSortMode) ? savedSortMode : 'manual';
  const saveApps = () => localStorage.setItem('linsoft-apps', JSON.stringify(installedApps));
  const faviconFor = (url) => { try { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=64`; } catch { return ''; } };
  const sortedInstalledApps = () => installedApps.map((app, index) => ({ app, index })).sort((left, right) => {
    if (Boolean(left.app.favorite) !== Boolean(right.app.favorite)) return Number(right.app.favorite) - Number(left.app.favorite);
    if (appSortMode === 'name') return left.app.title.localeCompare(right.app.title, 'sk');
    if (appSortMode === 'recent') return (Number(right.app.lastOpenedAt) || 0) - (Number(left.app.lastOpenedAt) || 0) || left.app.title.localeCompare(right.app.title, 'sk');
    const leftOrder = Number.isFinite(Number(left.app.sortOrder)) ? Number(left.app.sortOrder) : left.index;
    const rightOrder = Number.isFinite(Number(right.app.sortOrder)) ? Number(right.app.sortOrder) : right.index;
    return leftOrder - rightOrder || left.index - right.index;
  });
  const renderInstalledApps = () => {
    surface.querySelector('#appCenterCount').textContent = `${installedApps.length} ${installedApps.length === 1 ? 'aplikácia' : 'aplikácií'}`;
    surface.querySelector('#appCenterTotal').textContent = String(installedApps.length);
    surface.querySelector('#appCenterFavorites').textContent = String(installedApps.filter((item) => item.favorite).length);
    const orderedApps = sortedInstalledApps();
    installedList.innerHTML = orderedApps.map(({ app: item, index }) => {
      const icon = faviconFor(item.url);
      const fallback = escapeHtml((item.title || item.url).slice(0, 1).toUpperCase());
      return `<article class="app-center-card"><div class="app-center-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${fallback}</span>` : fallback}</div><div class="app-center-info"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.url)}</small></div><button class="app-center-favorite ${item.favorite ? 'active' : ''}" data-favorite-app="${escapeHtml(item.url)}" type="button" title="${item.favorite ? 'Odopnúť obľúbenú aplikáciu' : 'Pripnúť medzi obľúbené'}" aria-label="${item.favorite ? 'Odopnúť obľúbenú aplikáciu' : 'Pripnúť medzi obľúbené'}">${item.favorite ? '★' : '☆'}</button>${appSortMode === 'manual' ? `<div class="app-center-order"><button data-move-app="${escapeHtml(item.url)}" data-direction="-1" type="button" title="Posunúť vyššie" aria-label="Posunúť ${escapeHtml(item.title)} vyššie">↑</button><button data-move-app="${escapeHtml(item.url)}" data-direction="1" type="button" title="Posunúť nižšie" aria-label="Posunúť ${escapeHtml(item.title)} nižšie">↓</button></div>` : ''}<button class="app-center-open" data-open-app="${index}" type="button">Otvoriť</button><button class="app-center-remove" data-remove-app="${index}" type="button">Odstrániť</button></article>`;
    }).join('') || '<div class="app-center-empty"><strong>Zatiaľ tu nie sú uložené weby</strong><small>Pridaj vlastnú adresu alebo vyber web z katalógu nižšie.</small></div>';
    installedList.querySelectorAll('[data-favorite-app]').forEach((button) => button.addEventListener('click', () => {
      const item = installedApps.find((app) => app.url === button.dataset.favoriteApp);
      if (!item) return;
      item.favorite = !item.favorite;
      saveApps();
      renderInstalledApps();
    }));
    installedList.querySelectorAll('[data-move-app]').forEach((button) => button.addEventListener('click', () => {
      const ordered = sortedInstalledApps().map(({ app }) => app);
      const index = ordered.findIndex((app) => app.url === button.dataset.moveApp);
      const nextIndex = index + Number(button.dataset.direction);
      if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length || ordered[index].favorite !== ordered[nextIndex].favorite) return;
      [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
      ordered.forEach((app, order) => { app.sortOrder = order; });
      saveApps();
      renderInstalledApps();
    }));
    installedList.querySelectorAll('[data-open-app]').forEach((button) => button.addEventListener('click', () => {
      const item = installedApps[Number(button.dataset.openApp)];
      if (!item) return;
      item.lastOpenedAt = Date.now();
      saveApps();
      navigate(item.url);
    }));
    installedList.querySelectorAll('[data-remove-app]').forEach((button) => button.addEventListener('click', async () => {
      const item = installedApps[Number(button.dataset.removeApp)];
      if (!item || !window.confirm(`Odstrániť ${item.title} z App Centra?`)) return;
      const result = await window.linsoftBrowser?.uninstallWebApp?.(item.url, item.title);
      if (result && !result.ok) return showToast(result.message || 'Web sa nepodarilo odstrániť.');
      installedApps.splice(Number(button.dataset.removeApp), 1);
      saveApps();
      renderInstalledApps();
      renderCatalog();
    }));
  };
  const renderCatalog = () => {
    const query = queryInput.value.trim().toLowerCase();
    const items = appCatalog.filter(([name, url, category]) => (activeCategory === 'all' || category === activeCategory) && (!query || `${name} ${url}`.toLowerCase().includes(query)));
    surface.querySelector('#appCenterCatalogCount').textContent = `Zobrazené weby: ${items.length} z ${appCatalog.length}`;
    catalogGrid.innerHTML = items.map(([name, url, category]) => {
      const installed = installedApps.some((item) => item.url === url);
      const icon = faviconFor(url);
      return `<article class="catalog-card"><div class="app-center-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${escapeHtml(name.slice(0, 1))}</span>` : escapeHtml(name.slice(0, 1))}</div><div class="app-center-info"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(new URL(url).hostname)}</small></div><button class="catalog-install ${installed ? 'installed' : ''}" data-catalog-url="${escapeHtml(url)}" data-catalog-name="${escapeHtml(name)}" type="button"${installed ? ' disabled' : ''}>${installed ? 'Nainštalované' : 'Nainštalovať'}</button></article>`;
    }).join('') || '<div class="catalog-empty">Nenašiel sa žiadny web.</div>';
    catalogGrid.querySelectorAll('[data-catalog-url]').forEach((button) => button.addEventListener('click', async () => {
      const app = normalizeInstalledApp({ title: button.dataset.catalogName, url: button.dataset.catalogUrl });
      if (!app || installedApps.some((item) => item.url === app.url)) return;
      button.disabled = true;
      button.textContent = 'Inštalujem…';
      const result = await window.linsoftBrowser?.installWebApp?.(app.url, app.title);
      if (!result?.ok) {
        button.disabled = false;
        button.textContent = 'Nainštalovať';
        showToast(result?.message || 'Aplikáciu sa nepodarilo nainštalovať.');
        return;
      }
      installedApps.unshift(app);
      saveApps();
      renderInstalledApps();
      renderCatalog();
      showToast(`${app.title} bol nainštalovaný do Linsoft Browsera.`);
    }));
  };

  const sortAppsSelect = document.createElement('select');
  sortAppsSelect.id = 'appCenterSort';
  sortAppsSelect.className = 'app-center-sort';
  sortAppsSelect.setAttribute('aria-label', 'Zoradiť aplikácie');
  sortAppsSelect.innerHTML = '<option value="manual">Moje poradie</option><option value="name">Podľa názvu</option><option value="recent">Nedávno použité</option>';
  surface.querySelector('.app-center-actions').insertAdjacentElement('beforebegin', sortAppsSelect);
  sortAppsSelect.value = appSortMode;
  sortAppsSelect.addEventListener('change', () => { appSortMode = sortAppsSelect.value; localStorage.setItem('linsoft-app-center-sort', appSortMode); renderInstalledApps(); });
  renderInstalledApps();
  renderCatalog();
  surface.querySelector('#appCenterFilters').querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
    activeCategory = button.dataset.category;
    surface.querySelectorAll('#appCenterFilters [data-category]').forEach((filter) => {
      filter.classList.toggle('active', filter === button);
      filter.setAttribute('aria-pressed', String(filter === button));
    });
    renderCatalog();
  }));
  let searchTimer;
  queryInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderCatalog, 120); });
  surface.querySelector('#appCenterNewApp').addEventListener('click', () => { closeBrowserMenu(); surface.querySelector('#appCenterDialog').hidden = false; surface.querySelector('#appCenterName').focus(); });
  const dialog = surface.querySelector('#appCenterDialog');
  const closeDialog = () => { dialog.hidden = true; surface.querySelector('#appCenterForm').reset(); };
  surface.querySelector('#appCenterDialogClose').addEventListener('click', closeDialog);
  surface.querySelector('#appCenterCancel').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
  surface.querySelector('#appCenterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const app = normalizeInstalledApp({ title: surface.querySelector('#appCenterName').value.trim(), url: surface.querySelector('#appCenterUrl').value });
    if (!app) return showToast('Zadaj platnú adresu stránky HTTP alebo HTTPS.');
    if (installedApps.some((item) => item.url === app.url)) return showToast('Tento web už je v App Centre.');
    installedApps.unshift(app);
    saveApps();
    closeDialog();
    renderInstalledApps();
    renderCatalog();
  });
  const importInput = surface.querySelector('#appCenterImportFile');
  surface.querySelector('#appCenterImport').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported)) throw new Error('invalid');
      const normalized = imported.map(normalizeInstalledApp).filter(Boolean);
      let added = 0;
      normalized.forEach((item) => { if (!installedApps.some((current) => current.url === item.url)) { installedApps.push(item); added += 1; } });
      saveApps();
      renderInstalledApps();
      renderCatalog();
      showToast(`Importovaných webov: ${added}.`);
    } catch { showToast('Súbor nemá platný zoznam webov.'); }
    finally { importInput.value = ''; }
  });
  surface.querySelector('#appCenterExport').addEventListener('click', () => {
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(installedApps, null, 2)], { type: 'application/json' }));
    link.href = objectUrl;
    link.download = 'linsoft-apps.json';
    link.click();
    URL.revokeObjectURL(objectUrl);
  });
}

function applyTheme() {
  document.body.classList.toggle('light-theme', settingsState.theme === 'light');
  document.body.classList.toggle('glass-blue-theme', settingsState.theme === 'glass-blue');
  document.body.classList.toggle('compact-chrome', settingsState.compact === true);
  const fontScale = settingsState.uiFontScale === 'small' ? 0.94 : settingsState.uiFontScale === 'large' ? 1.08 : 1;
  document.body.style.setProperty('--ui-font-scale', String(fontScale));
}

function getBrowserPreferencesFromSettings() {
  return {
    downloads: settingsState.downloads,
    downloadFolderPath: settingsState.downloadFolderPath || '',
    askDownload: settingsState.askDownload,
    adBlock: settingsState.adBlock,
    trackingProtection: settingsState.trackingProtection,
    camera: settingsState.camera,
    autoUsbCamera: settingsState.autoUsbCamera,
    microphone: settingsState.microphone,
    webNotifications: settingsState.webNotifications,
    spellcheckLanguages: settingsState.spellcheckLanguages,
    clearExit: settingsState.clearExit,
    autoUpdateCheck: settingsState.autoUpdateCheck
  };
}

function saveSettings() {
  localStorage.setItem('linsoft-settings', JSON.stringify(settingsState));
  applyTheme();
  const preferenceUpdate = window.linsoftBrowser?.setBrowserPreferences(getBrowserPreferencesFromSettings());
  preferenceUpdate?.catch((error) => {
    console.error('Linsoft Browser could not apply browser settings:', error);
  });
  applyDefaultZoomToTabs();
  return preferenceUpdate;
}

function zoomOriginForUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch { return ''; }
}

function pageZoomForUrl(value) {
  const origin = zoomOriginForUrl(value);
  const savedZoom = Number(siteZooms[origin]);
  return Math.max(50, Math.min(200, savedZoom || Number(settingsState.zoom) || 100));
}

function applyTabZoom(tabId, url) {
  const zoom = pageZoomForUrl(url) / 100;
  if (isNativeTabs) {
    window.linsoftBrowser?.nativeTabCommand?.({ tabId, command: 'zoom', value: zoom });
    return;
  }
  content.querySelector(`.tab-surface[data-tab-id="${tabId}"] webview`)?.setZoomFactor?.(zoom);
}

function applyDefaultZoomToTabs() {
  for (const [tabId, tab] of tabs) {
    const origin = zoomOriginForUrl(tab.url);
    if (origin && siteZooms[origin]) continue;
    applyTabZoom(tabId, tab.url);
  }
}

function openLibrary(mode) {
  if (!confirmSettingsDeparture()) return;
  let items;
  try {
    items = mode === 'bookmarks' ? savedBookmarks : JSON.parse(localStorage.getItem('linsoft-history') || '[]');
    if (!Array.isArray(items)) throw new Error('Library data must be an array.');
  } catch (error) {
    console.error('Library data failed:', error);
    showToast('Uložené stránky sa nepodarilo načítať.');
    return;
  }
  const previousSurface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  const previousView = previousSurface?.querySelector(`.library-tools[data-library-mode="${mode}"]`);
  const previousQuery = previousView?.querySelector('input').value || '';
  const previousSort = previousView?.querySelector('[data-library-sort]')?.value || 'original';
  const previousPeriod = previousView?.querySelector('[data-history-period]')?.value || 'all';
  addressInput.value = `linsoft://${mode}`; tabTitle.textContent = mode === 'bookmarks' ? 'Záložky' : 'História';
  updateActiveTab(`linsoft://${mode}`, mode === 'bookmarks' ? 'Záložky' : 'História');
  saveSession();
  const surface = getActiveSurface();
  const isBookmarks = mode === 'bookmarks';
  const isHistory = mode === 'history';
  const countLabel = items.length === 1 ? 'záložka' : items.length > 1 && items.length < 5 ? 'záložky' : 'záložiek';
  const recentHistoryCount = isHistory
    ? items.filter((item) => Number(item.visitedAt) >= Date.now() - 7 * 24 * 60 * 60 * 1000).length
    : 0;
  const itemMarkup = items.map((item, index) => {
    const title = String(item.title || item.url);
    const iconUrl = isBookmarks ? bookmarkFaviconUrl(item.url) : '';
    const isPinned = isBookmarks && startFavorites.some((favorite) => favorite.url === item.url);
    let siteName = '';
    try { siteName = new URL(item.url).hostname.replace(/^www\./i, ''); } catch {}
    return `<div class="library-row${isBookmarks ? ' library-bookmark-row' : ''}">
      <button class="library-open" data-url="${escapeHtml(item.url)}" title="Otvoriť ${escapeHtml(title)}">
        ${isBookmarks ? `<span class="library-icon library-bookmark-icon">${iconUrl ? `<img class="library-favicon" src="${escapeHtml(iconUrl)}" alt=""><span class="library-favicon-fallback" hidden>${escapeHtml(title.slice(0, 1).toUpperCase())}</span>` : escapeHtml(title.slice(0, 1).toUpperCase())}</span>` : '<span class="library-icon">◷</span>'}
        <span class="library-copy"><strong>${escapeHtml(title)}</strong>${isBookmarks ? `<small class="library-site">${escapeHtml(siteName || item.url)}</small>` : ''}<small class="library-url">${escapeHtml(item.url)}</small></span>
        <span class="library-open-arrow" aria-hidden="true">→</span>
      </button>
      ${isBookmarks ? `<button class="library-pin${isPinned ? ' active' : ''}" data-start-favorite-url="${escapeHtml(item.url)}" aria-label="${isPinned ? 'Odopnúť zo štartovacej stránky' : 'Pripnúť na štartovaciu stránku'}" title="${isPinned ? 'Odopnúť zo štartovacej stránky' : 'Pripnúť na štartovaciu stránku'}"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-bookmark${isPinned ? '-check' : ''}"></use></svg></button><button class="library-delete" data-bookmark-index="${index}" aria-label="Odstrániť záložku" title="Odstrániť záložku">×</button>` : ''}
    </div>`;
  }).join('');
  const emptyMarkup = isBookmarks
    ? '<div class="empty-library library-empty-bookmarks"><span aria-hidden="true">☆</span><strong>Zatiaľ tu nemáš žiadne záložky</strong><small>Počas prehliadania stlač hviezdičku pri adresnom riadku a uložená stránka sa zobrazí tu.</small></div>'
    : '<div class="empty-library library-empty-history"><span aria-hidden="true">◷</span><strong>Tvoja história je zatiaľ prázdna</strong><small>Navštívené stránky sa zobrazia tu a zostanú uložené iba v tomto prehliadači.</small></div>';
  surface.innerHTML = `<div class="library-page${isBookmarks ? ' bookmarks-library-page' : isHistory ? ' history-library-page' : ''}">
    <div class="settings-heading">
      <div class="library-heading-copy">${isBookmarks || isHistory ? `<span class="library-heading-icon" aria-hidden="true"><svg class="ui-icon" viewBox="0 0 24 24"><use href="#icon-${isBookmarks ? 'bookmark' : 'history'}"></use></svg></span>` : ''}
        <div><span class="settings-eyebrow">LINSOFT BROWSER</span><h1>${isBookmarks ? 'Moje záložky' : 'História'}</h1><p>${isBookmarks ? 'Obľúbené weby prehľadne na jednom mieste.' : 'Prehľad navštívených stránok v tomto zariadení.'}</p></div>
      </div>
      <div class="library-actions">${isBookmarks
    ? `<span class="library-total" aria-label="${items.length} ${countLabel}"><strong>${items.length}</strong><span>${countLabel}</span></span>`
    : `<div class="history-summary"><span class="library-total"><strong>${items.length}</strong><span>navštívených stránok</span></span><span class="library-total"><strong>${recentHistoryCount}</strong><span>za posledných 7 dní</span></span></div><button class="danger-button" id="clearHistoryPage"${items.length ? '' : ' disabled'}>Vymazať históriu</button>`}</div>
    </div>
    <div class="library-list${isBookmarks ? ' bookmark-library-grid' : ''}">${itemMarkup || emptyMarkup}</div>
  </div>`;
  surface.querySelectorAll('.library-favicon').forEach((icon) => icon.addEventListener('error', () => { icon.hidden = true; icon.nextElementSibling.hidden = false; }));
  const tools = document.createElement('div');
  tools.className = 'library-tools';
  tools.dataset.libraryMode = mode;
  tools.innerHTML = `<label class="browser-search-field"><svg class="ui-icon" aria-hidden="true"><use href="#icon-search"></use></svg><input type="search" placeholder="Hľadať názov alebo adresu..." aria-label="Hľadať ${mode === 'bookmarks' ? 'záložky' : 'v histórii'}"></label>${isHistory ? '<select data-history-period aria-label="Filtrovať obdobie"><option value="all">Všetky obdobia</option><option value="today">Dnes</option><option value="yesterday">Včera</option><option value="week">Posledných 7 dní</option><option value="month">Posledných 30 dní</option></select>' : ''}<select data-library-sort aria-label="Zoradiť stránky"><option value="original">${mode === 'history' ? 'Posledné návštevy' : 'Uložené poradie'}</option><option value="name">Názov A – Z</option><option value="site">Podľa webu</option></select><span class="library-result-count" role="status"></span>`;
  surface.querySelector('.library-list').insertAdjacentElement('beforebegin', tools);
  const rows = [...surface.querySelectorAll('.library-row')];
  rows.forEach((row, index) => {
    row.dataset.libraryIndex = String(index);
    if (mode !== 'history') return;
    const item = items[index];
    if (item.visitedAt) {
      const time = document.createElement('small');
      time.className = 'library-visit-time';
      time.textContent = new Date(item.visitedAt).toLocaleString('sk-SK');
      row.querySelector('.library-open > span:nth-child(2)').appendChild(time);
    }
    const remove = document.createElement('button');
    remove.className = 'library-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Odstrániť návštevu: ${item.title || item.url}`);
    remove.title = 'Odstrániť túto návštevu';
    remove.addEventListener('click', () => {
      const [removed] = items.splice(index, 1);
      localStorage.setItem('linsoft-history', JSON.stringify(items));
      showToast('Návšteva bola odstránená.', 'Vrátiť späť', () => {
        restoreAddressHistory([removed], index);
        closeAddressSuggestions();
        openLibrary('history');
      });
      openLibrary('history');
    });
    row.appendChild(remove);
  });
  const applyView = () => {
    const query = normalizeBrowserSearch(tools.querySelector('input').value);
    const sort = tools.querySelector('[data-library-sort]').value;
    const period = tools.querySelector('[data-history-period]')?.value || 'all';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 24 * 60 * 60 * 1000;
    const periodStart = period === 'week' ? Date.now() - 7 * 24 * 60 * 60 * 1000
      : period === 'month' ? Date.now() - 30 * 24 * 60 * 60 * 1000
        : 0;
    const ordered = [...rows].sort((left, right) => {
      const a = items[Number(left.dataset.libraryIndex)];
      const b = items[Number(right.dataset.libraryIndex)];
      if (sort === 'name') return String(a.title || a.url).localeCompare(String(b.title || b.url), 'sk');
      if (sort === 'site') return String(a.url).localeCompare(String(b.url), 'sk');
      return Number(left.dataset.libraryIndex) - Number(right.dataset.libraryIndex);
    });
    let count = 0;
    const list = surface.querySelector('.library-list');
    list.querySelectorAll('.history-day-group').forEach((group) => group.remove());
    const visibleGroups = new Map();
    ordered.forEach((row) => {
      const item = items[Number(row.dataset.libraryIndex)];
      const visitedAt = Number(item.visitedAt) || 0;
      const visitDate = visitedAt ? new Date(visitedAt) : null;
      const visitDay = visitDate ? new Date(visitDate.getFullYear(), visitDate.getMonth(), visitDate.getDate()).getTime() : -1;
      const inPeriod = period === 'all'
        || (period === 'today' && visitDay === today)
        || (period === 'yesterday' && visitDay === yesterday)
        || (period === 'week' && visitedAt >= periodStart)
        || (period === 'month' && visitedAt >= periodStart);
      row.hidden = !inPeriod || !normalizeBrowserSearch(`${item.title || ''} ${item.url}`).includes(query);
      if (!row.hidden) {
        count += 1;
        const dayKey = visitDate ? `${visitDate.getFullYear()}-${visitDate.getMonth()}-${visitDate.getDate()}` : 'unknown';
        if (isHistory && sort === 'original') {
          if (!visibleGroups.has(dayKey)) visibleGroups.set(dayKey, { label: visitDate
            ? visitDay === today ? 'Dnes' : visitDay === yesterday ? 'Včera' : visitDate.toLocaleDateString('sk-SK', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'Dátum návštevy nie je dostupný', rows: [] });
          visibleGroups.get(dayKey).rows.push(row);
        }
      }
    });
    if (isHistory && sort === 'original') {
      for (const group of visibleGroups.values()) {
        const heading = document.createElement('div');
        heading.className = 'history-day-group';
        heading.innerHTML = `<strong>${escapeHtml(group.label)}</strong><span>${group.rows.length} ${group.rows.length === 1 ? 'stránka' : 'stránok'}</span>`;
        list.appendChild(heading);
        group.rows.forEach((row) => list.appendChild(row));
      }
    } else {
      ordered.forEach((row) => list.appendChild(row));
    }
    tools.querySelector('.library-result-count').textContent = `Zobrazené: ${count} / ${items.length}`;
    list.querySelector('.library-no-results')?.remove();
    if (rows.length && !count) list.insertAdjacentHTML('beforeend', `<div class="empty-library library-no-results">${isHistory && period !== 'all' ? 'V tomto období sa nenašli žiadne návštevy.' : 'Žiadna stránka nezodpovedá hľadaniu. Skús iný názov alebo adresu.'}</div>`);
  };
  tools.querySelector('input').value = previousQuery;
  tools.querySelector('[data-library-sort]').value = previousSort;
  if (tools.querySelector('[data-history-period]')) tools.querySelector('[data-history-period]').value = previousPeriod;
  tools.querySelector('input').addEventListener('input', applyView);
  tools.querySelector('[data-library-sort]').addEventListener('change', applyView);
  tools.querySelector('[data-history-period]')?.addEventListener('change', applyView);
  applyView();
  surface.querySelector('#clearHistoryPage')?.addEventListener('click', () => {
    if (!items.length) return;
    localStorage.removeItem('linsoft-history');
    showToast('História bola vymazaná.', 'Vrátiť späť', () => {
      restoreAddressHistory(items, 0);
      closeAddressSuggestions();
      openLibrary('history');
    });
    openLibrary('history');
  });
  surface.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.url)));
  surface.querySelectorAll('[data-start-favorite-url]').forEach((button) => button.addEventListener('click', () => { const favoriteUrl = button.dataset.startFavoriteUrl; const index = startFavorites.findIndex((favorite) => favorite.url === favoriteUrl); if (index >= 0) startFavorites.splice(index, 1); else { const bookmark = savedBookmarks.find((item) => item.url === favoriteUrl); if (bookmark) startFavorites.push({ title: String(bookmark.title || bookmark.url), url: bookmark.url }); } localStorage.setItem('linsoft-start-favorites', JSON.stringify(startFavorites)); openLibrary('bookmarks'); }));
  surface.querySelectorAll('[data-bookmark-index]').forEach((button) => button.addEventListener('click', () => { savedBookmarks.splice(Number(button.dataset.bookmarkIndex), 1); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); openLibrary('bookmarks'); }));
}

const passwordPromptCache = new Map();

async function maybeOfferSavePassword(viewer, url) {
  if (!viewer || typeof viewer.executeJavaScript !== 'function') return;
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const data = await viewer.executeJavaScript(`(() => {
      const usernameField = Array.from(document.querySelectorAll('input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="email" i]'))
        .find((element) => element.offsetParent !== null && !element.disabled && !element.readOnly);
      const passwordField = Array.from(document.querySelectorAll('input[type="password"]'))
        .find((element) => element.offsetParent !== null && !element.disabled && !element.readOnly);
      if (!usernameField || !passwordField) return null;
      const username = (usernameField.value || '').trim();
      const password = (passwordField.value || '').trim();
      if (!username || !password) return null;
      return { username, password };
    })()`, true);
    if (!data || !data.username || !data.password) return;
    const cacheKey = `${hostname}|${data.username.toLowerCase()}`;
    if (passwordPromptCache.has(cacheKey)) return;
    const shouldSave = window.confirm(`Uložiť heslo pre ${hostname} a používateľa ${data.username}?`);
    if (!shouldSave) {
      passwordPromptCache.set(cacheKey, Date.now());
      return;
    }
    const result = await window.linsoftBrowser?.savePassword({ hostname, username: data.username, password: data.password });
    passwordPromptCache.set(cacheKey, Date.now());
    if (result?.ok) showToast('Heslo bolo uložené šifrovane.');
    else showToast(result?.message || 'Heslo sa nepodarilo uložiť.');
  } catch {}
}

function bindPasswordSavePrompt(viewer, url) {
  if (!viewer || viewer.isDestroyed?.()) return;
  const currentUrl = viewer.getURL?.() || url;
  if (!currentUrl) return;
  window.setTimeout(() => {
    if (!viewer.isDestroyed?.() && (viewer.getURL?.() || currentUrl) === currentUrl) maybeOfferSavePassword(viewer, currentUrl);
  }, 600);
}

function openSettings(section = 'general') {
  if (!confirmSettingsDeparture()) return;
  void stopMediaDeviceTest('Test zariadenia bol zastavený pri opustení nastavení.');
  addressInput.value = 'linsoft://settings';
  tabTitle.textContent = 'Nastavenia';
  updateActiveTab('linsoft://settings', 'Nastavenia');
  saveSession();
  const surface = getActiveSurface();
  surface.innerHTML = `<div class="settings-page"><div class="settings-heading"><div><span class="settings-eyebrow">LINSOFT BROWSER</span><h1>Nastavenia</h1><p>Prispôsob si browser podľa svojho spôsobu práce.</p></div></div><div class="settings-layout"><nav class="settings-nav"><button data-settings-section="general">⚙ <span>Všeobecné</span></button><button data-settings-section="appearance">◐ <span>Vzhľad</span></button><button data-settings-section="privacy">♢ <span>Súkromie a bezpečnosť</span></button><button data-settings-section="about">ⓘ <span>O aplikácii</span></button></nav><div class="settings-panels"><section data-settings-panel="general"><p class="settings-label">VŠEOBECNÉ</p><h2>Správanie browsera</h2><div class="setting-card"><div><strong>Pri spustení</strong><small>Vyber, čo sa zobrazí po otvorení Linsoft Browsera.</small></div><select id="startupSetting"><option value="start">Nová karta Linsoft</option><option value="home">Domovská stránka</option></select></div>  <div class="setting-card"><div><strong>Domovská stránka</strong><small>Adresa použitá pri spustení, keď je vybraná možnosť „Domovská stránka“.</small></div><input class="settings-input" id="homeSetting" value="${escapeHtml(settingsState.home)}" /></div><div class="setting-card"><div><strong>Vyhľadávač</strong><small>Predvolený vyhľadávač pre otázky v adresnom riadku.</small></div><select id="searchSetting"><option>Google</option><option>Bing</option><option>DuckDuckGo</option></select></div></section><section data-settings-panel="appearance"><p class="settings-label">VZHĽAD</p><h2>Vzhľad aplikácie</h2><div class="setting-card"><div><strong>Farebná téma</strong><small>Vyber, ako má Linsoft Browser vyzerať.</small></div><select id="themeSetting"><option value="dark">Tmavá</option><option value="light">Svetlá</option></select></div><div class="setting-card"><div><strong>Kompaktný panel</strong><small>Zmenší výšku navigačných panelov pre viac priestoru.</small></div><button class="settings-toggle" data-setting-toggle="compact"><i></i></button></div></section><section data-settings-panel="privacy"><p class="settings-label">SÚKROMIE</p><h2>Súkromie a bezpečnosť</h2><div class="setting-card"><div><strong>Bezpečné prehliadanie</strong><small>Upozorní pred známymi nebezpečnými stránkami.</small></div><button class="settings-toggle ${settingsState.safe ? 'on' : ''}" data-setting-toggle="safe"><i></i></button></div><div class="setting-card"><div><strong>Blokovať vyskakovacie okná</strong><small>Obmedzí automatické otváranie nových okien.</small></div><button class="settings-toggle ${settingsState.popups ? 'on' : ''}" data-setting-toggle="popups"><i></i></button></div><div class="setting-card"><div><strong>Posielať požiadavku Do Not Track</strong><small>Požiada weby, aby nesledovali tvoju aktivitu.</small></div><button class="settings-toggle ${settingsState.tracking ? 'on' : ''}" data-setting-toggle="tracking"><i></i></button></div><button class="danger-button" id="clearBrowserData">Vymazať históriu a údaje prehliadania</button></section><section data-settings-panel="about"><p class="settings-label">O APLIKÁCII</p><h2>Linsoft Browser</h2><div class="about-card"><span class="about-logo">L</span><div><strong>Linsoft Browser 1.0.0</strong><small>Desktopový prehliadač pre Windows postavený na Electron + Chromium.</small><small>© 2026 Linsoft</small></div></div></section><div class="settings-actions"><button class="settings-reset" id="resetSettings">Obnoviť predvolené</button><button class="save-settings" id="saveSettings">Uložiť zmeny</button></div></div></div></div>`;
  const startup = surface.querySelector('#startupSetting'); const theme = surface.querySelector('#themeSetting'); const search = surface.querySelector('#searchSetting'); const home = surface.querySelector('#homeSetting');
  theme.insertAdjacentHTML('beforeend', '<option value="glass-blue">Glass Blue</option>');
  theme.closest('.setting-card').insertAdjacentHTML('afterend', `<div class="setting-card"><div><strong>Veľkosť textu rozhrania</strong><small>Zmení text browsera bez zmeny mierky otvorených webov.</small></div><select id="uiFontScaleSetting" aria-label="Veľkosť textu rozhrania"><option value="small">Menšia</option><option value="normal">Predvolená</option><option value="large">Väčšia</option></select></div><p class="settings-label start-page-settings-label">ÚVODNÁ STRÁNKA</p><div class="setting-card"><div><strong>Počasie</strong><small>Zobraziť kartu počasia na úvodnej stránke.</small></div><button class="settings-toggle" data-setting-toggle="startShowWeather"><i></i></button></div><div class="setting-card"><div><strong>Rýchly prístup</strong><small>Zobraziť pripnuté a obľúbené stránky.</small></div><button class="settings-toggle" data-setting-toggle="startShowFavorites"><i></i></button></div><div class="setting-card"><div><strong>Stavový riadok</strong><small>Zobraziť spodné informácie úvodnej stránky.</small></div><button class="settings-toggle" data-setting-toggle="startShowFooter"><i></i></button></div>`);
  const quickLinksCard = document.createElement('div');
  quickLinksCard.className = 'start-quick-links-setting';
  quickLinksCard.innerHTML = '<div class="start-quick-links-heading"><div><strong>Viditeľné rýchle odkazy</strong><small>Skrytie odkazu ho neodstráni zo záložiek ani z uložených obľúbených.</small></div><button type="button" data-show-all-start-links>Všetky</button></div><div class="start-quick-links-list" role="group" aria-label="Rýchle odkazy zobrazené na úvodnej stránke"></div>';
  const quickLinks = startFavorites.length ? startFavorites : defaultStartFavorites;
  const hiddenQuickLinks = new Set(Array.isArray(settingsState.startHiddenFavorites) ? settingsState.startHiddenFavorites : []);
  const quickLinksList = quickLinksCard.querySelector('.start-quick-links-list');
  quickLinks.forEach((item, index) => {
    const label = document.createElement('label');
    label.className = 'start-quick-link-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hiddenQuickLinks.has(item.url);
    checkbox.dataset.startFavoriteVisible = item.url;
    checkbox.id = `startQuickLink${index}`;
    const name = document.createElement('span');
    name.textContent = item.title || item.url;
    label.append(checkbox, name);
    quickLinksList.appendChild(label);
  });
  surface.querySelector('[data-settings-panel="appearance"] .setting-card:last-of-type').insertAdjacentElement('afterend', quickLinksCard);
  quickLinksCard.querySelector('[data-show-all-start-links]').addEventListener('click', () => {
    quickLinksList.querySelectorAll('input').forEach((checkbox) => { checkbox.checked = true; });
    quickLinksList.dispatchEvent(new Event('change', { bubbles: true }));
  });
  quickLinksList.addEventListener('change', () => {
    quickLinksList.dispatchEvent(new Event('start-links-change', { bubbles: true }));
  });
  startup.value = settingsState.startup; theme.value = settingsState.theme; search.value = settingsState.search;
  surface.querySelector('#uiFontScaleSetting').value = ['small', 'large'].includes(settingsState.uiFontScale) ? settingsState.uiFontScale : 'normal';
  addUpdateCheck();
  surface.querySelectorAll('[data-settings-section]').forEach((button) => button.addEventListener('click', () => { surface.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === button)); surface.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.hidden = panel.dataset.settingsPanel !== button.dataset.settingsSection); }));
  surface.querySelector(`[data-settings-section="${section}"]`).click();
  surface.querySelectorAll('[data-setting-toggle]').forEach((toggle) => toggle.addEventListener('click', () => { toggle.classList.toggle('on'); if (toggle.dataset.settingToggle === 'autoUpdateCheck') { settingsState.autoUpdateCheck = toggle.classList.contains('on'); saveSettings(); showToast(settingsState.autoUpdateCheck ? 'Automatická kontrola je zapnutá.' : 'Automatická kontrola je vypnutá.'); } }));
  surface.querySelector('#saveSettings').addEventListener('click', () => { settingsState.startup = startup.value; settingsState.theme = theme.value; settingsState.search = search.value; settingsState.home = home.value.trim() || 'linsoft://start'; settingsState.safe = surface.querySelector('[data-setting-toggle="safe"]').classList.contains('on'); settingsState.popups = surface.querySelector('[data-setting-toggle="popups"]').classList.contains('on'); settingsState.tracking = surface.querySelector('[data-setting-toggle="tracking"]').classList.contains('on'); ['camera', 'autoUsbCamera', 'microphone', 'webNotifications'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (toggle) settingsState[key] = toggle.classList.contains('on'); }); const spellcheckOptions = surface.querySelector('#spellcheckLanguageOptions'); if (spellcheckOptions?.dataset.ready === 'true') settingsState.spellcheckLanguages = [...spellcheckOptions.querySelectorAll('input:checked')].map((input) => input.value); saveSettings(); showToast('Nastavenia boli uložené.'); });
  surface.querySelector('#resetSettings').addEventListener('click', () => { localStorage.removeItem('linsoft-settings'); Object.assign(settingsState, defaultSettings); void stopUsbCameraCapture('Kamera bola vypnutá obnovením nastavení.'); saveSettings(); openSettings(section); showToast('Nastavenia boli obnovené.'); });
  surface.querySelector('#clearBrowserData').addEventListener('click', () => { localStorage.removeItem('linsoft-history'); localStorage.removeItem(sessionStorageKey('session')); localStorage.removeItem(sessionStorageKey('active-tab')); localStorage.removeItem(sessionStorageKey('closed-tabs')); localStorage.removeItem('linsoft-bookmarks'); localStorage.removeItem('linsoft-start-favorites'); localStorage.removeItem('linsoft-apps'); savedBookmarks.splice(0); startFavorites.splice(0); installedApps.splice(0); renderSavedBookmarks(); showToast('História a údaje boli vymazané.'); });
  addAdvancedSettings();
  addSecuritySettings();
  enhanceSettingsPage(surface);
}

function enhanceSettingsPage(surface) {
  const page = surface.querySelector('.settings-page');
  page.classList.add('settings-dashboard');
  let groupPreferences = {};
  try {
    const stored = JSON.parse(localStorage.getItem('linsoft-settings-groups') || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) groupPreferences = stored;
  } catch (error) {
    console.error('Linsoft Browser could not read settings group preferences:', error);
    showToast('Rozloženie skupín sa nepodarilo obnoviť.');
  }
  const advanced = page.querySelector('[data-settings-panel="advanced"]');
  const advancedLinks = document.createElement('nav');
  advancedLinks.className = 'settings-advanced-links';
  advancedLinks.setAttribute('aria-label', 'Časti pokročilých nastavení');
  advanced.querySelector('h2').insertAdjacentElement('afterend', advancedLinks);
  const groupActions = document.createElement('div');
  groupActions.className = 'settings-group-actions';
  groupActions.innerHTML = '<button type="button" data-groups-open="true">Rozbaliť všetko</button><button type="button" data-groups-open="false">Zbaliť všetko</button>';
  advancedLinks.insertAdjacentElement('afterend', groupActions);
  const setGroupOpen = (section, open, persist = true) => {
    section.querySelector('.settings-group-body').hidden = !open;
    section.querySelector('[data-group-toggle]').setAttribute('aria-expanded', String(open));
    section.classList.toggle('collapsed', !open);
    if (persist) {
      groupPreferences[section.dataset.groupKey] = open;
      try { localStorage.setItem('linsoft-settings-groups', JSON.stringify(groupPreferences)); }
      catch (error) {
        console.error('Linsoft Browser could not save settings group preferences:', error);
        showToast('Rozloženie skupín sa nepodarilo uložiť.');
      }
    }
  };
  groupActions.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    advanced.querySelectorAll('.settings-advanced-group').forEach((section) => setGroupOpen(section, button.dataset.groupsOpen === 'true'));
  }));
  const advancedGroups = [
    { key: 'protection', title: 'Ochrana prehliadania', icon: 'shield-check', note: 'Reklamy, sledovanie a lokálne údaje.', selectors: ['[data-setting-toggle="adBlock"]', '[data-setting-toggle="trackingProtection"]', '[data-setting-toggle="clearExit"]', '#updateAdblockList'] },
    { key: 'downloads', title: 'Sťahovanie súborov', icon: 'download', note: 'Priečinok a potvrdenie pred stiahnutím.', selectors: ['#downloadsSetting', '[data-setting-toggle="askDownload"]'] },
    { key: 'tabs', title: 'Karty a zobrazenie', icon: 'layout-grid', note: 'Obnovenie relácie a veľkosť obsahu.', selectors: ['[data-setting-toggle="restoreTabs"]', '#zoomSetting'] },
    { key: 'tools', title: 'Jazyky a meranie', icon: 'settings', note: 'Kontrola pravopisu a načítanie stránok.', selectors: ['#spellcheckLanguageOptions', '#pageLoadMetricsList'] },
    { key: 'tor', title: 'Tor a proxy', icon: 'lock-keyhole', note: 'Pripojenie, hosting a súkromný chat. Tieto akcie sa vykonajú okamžite.', selectors: ['.tor-hosting-section'] }
  ];
  advancedGroups.forEach((group) => {
    const section = document.createElement('section');
    section.className = 'settings-advanced-group';
    section.id = `settings-${activeTabId}-${group.key}`;
    section.dataset.groupKey = group.key;
    const headingId = `${section.id}-heading`;
    section.setAttribute('aria-labelledby', headingId);
    section.tabIndex = -1;
    section.innerHTML = `<header><span><svg class="ui-icon" aria-hidden="true"><use href="#icon-${group.icon}"></use></svg></span><div><h3 id="${headingId}"><button type="button" data-group-toggle aria-expanded="true" aria-controls="${section.id}-body">${escapeHtml(group.title)}<span aria-hidden="true">−</span></button></h3><p>${escapeHtml(group.note)}</p></div></header><div class="settings-group-body" id="${section.id}-body"></div>`;
    const body = section.querySelector('.settings-group-body');
    section.querySelector('[data-group-toggle]').addEventListener('click', () => {
      setGroupOpen(section, body.hidden);
    });
    group.selectors.forEach((selector) => {
      const control = advanced.querySelector(selector);
      const block = control.closest('.security-subsection') || control.closest('.setting-card');
      body.appendChild(block);
    });
    advanced.appendChild(section);
    setGroupOpen(section, groupPreferences[group.key] !== false, false);
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = group.title;
    link.addEventListener('click', () => {
      setGroupOpen(section, true);
      section.scrollIntoView({ block: 'start' });
      section.focus({ preventScroll: true });
    });
    advancedLinks.appendChild(link);
  });
  const torSection = advanced.querySelector('.tor-hosting-section');
  const torConnections = document.createElement('div');
  torConnections.className = 'settings-tor-connections';
  torConnections.innerHTML = '<div><strong>Prehliadanie cez Tor</strong><span data-connection-tor role="status"></span><small>Stav vstavaného Tor pripojenia.</small></div><div><strong>Manuálna proxy</strong><span data-connection-proxy role="status"></span><small>SOCKS spojenie nie je overením anonymity.</small></div>';
  torSection.prepend(torConnections);
  const torBrowsing = advanced.querySelector('#toggleTorProxy').closest('.setting-card');
  torBrowsing.classList.add('settings-tor-browsing');
  torConnections.insertAdjacentElement('afterend', torBrowsing);
  const manualProxy = advanced.querySelector('.manual-proxy-card');
  const proxyFields = [
    ['#manualProxyProtocol', 'Protokol'],
    ['#manualProxyHost', 'Hostiteľ'],
    ['#manualProxyPort', 'Port']
  ];
  proxyFields.forEach(([selector, text]) => {
    const control = manualProxy.querySelector(selector);
    const label = document.createElement('label');
    label.className = 'settings-proxy-field';
    const name = document.createElement('span');
    name.textContent = text;
    control.insertAdjacentElement('beforebegin', label);
    label.append(name, control);
    control.setAttribute('aria-label', text);
  });
  manualProxy.querySelector('strong').insertAdjacentHTML('afterend', '<span class="settings-immediate-badge">Použije sa okamžite</span>');
  const hostingHeading = torSection.querySelector(':scope > .settings-label');
  hostingHeading.classList.add('settings-tor-hosting-heading');
  hostingHeading.insertAdjacentHTML('afterend', '<p class="settings-tor-help">Hosting sprístupní vybraný priečinok cez onion adresu. Je nezávislý od prehliadania cez Tor. Vyber iba súbory, ktoré chceš zdieľať.</p>');
  const vpn = page.querySelector('[data-settings-panel="vpn"]');
  vpn.classList.add('settings-vpn-dashboard');
  vpn.querySelector('h2').insertAdjacentHTML('afterend', '<p class="settings-vpn-intro">Vyber profil od svojho poskytovateľa a spravuj pripojenie na jednom mieste.</p>');
  const vpnProfileCard = vpn.querySelector('#openVpnProfileName').closest('.vpn-card');
  vpnProfileCard.classList.add('settings-vpn-profile');
  vpnProfileCard.insertAdjacentHTML('afterbegin', '<span class="settings-vpn-icon"><svg class="ui-icon" aria-hidden="true"><use href="#icon-file-code"></use></svg></span>');
  vpnProfileCard.querySelector('div').insertAdjacentHTML('beforeend', '<small>Formát .ovpn · Výber sa uloží okamžite.</small>');
  const vpnStatusCard = vpn.querySelector('#openVpnStatus').closest('.vpn-card');
  vpnStatusCard.classList.add('settings-vpn-connection');
  vpnStatusCard.insertAdjacentHTML('afterbegin', '<span class="settings-vpn-icon"><svg class="ui-icon" aria-hidden="true"><use href="#icon-lock-keyhole"></use></svg></span>');
  vpn.querySelector('#openVpnStatus').setAttribute('role', 'status');
  vpnStatusCard.querySelector('div').insertAdjacentHTML('beforeend', '<small>Stav OpenVPN klienta spusteného týmto prehliadačom.</small>');
  vpnStatusCard.appendChild(vpn.querySelector('.vpn-actions'));
  vpnStatusCard.insertAdjacentHTML('beforeend', '<p class="settings-vpn-hint" data-vpn-hint></p>');
  const vpnLog = vpn.querySelector('#openVpnLog');
  vpnLog.tabIndex = 0;
  vpnLog.setAttribute('aria-label', 'Živý log OpenVPN');
  const logTitle = vpn.querySelector('.vpn-log-title');
  logTitle.classList.add('settings-vpn-log-heading');
  logTitle.insertAdjacentHTML('beforeend', '<button type="button" class="settings-control" data-clear-vpn-log>Vyčistiť zobrazenie</button>');
  logTitle.querySelector('button').addEventListener('click', () => { vpnLog.textContent = 'Čaká sa na operáciu...'; });
  vpn.querySelector('.vpn-log-wrap').insertAdjacentHTML('beforeend', '<p class="settings-vpn-log-note">Vyčistenie odstráni iba zobrazené riadky. Pripojenie zostane nezmenené.</p>');
  const heading = page.querySelector('.settings-heading');
  heading.insertAdjacentHTML('beforeend', '<div class="settings-brand"><img src="assets/linsoft-icon.svg" alt="Logo Linsoft Browser" width="76" height="76"></div>');
  const aboutLogo = page.querySelector('[data-settings-panel="about"] .about-logo');
  aboutLogo.classList.add('settings-brand', 'settings-about-logo');
  aboutLogo.innerHTML = '<img src="assets/linsoft-icon.svg" alt="Logo Linsoft Browser" width="88" height="88">';
  heading.insertAdjacentHTML('afterend', `<div class="settings-search-bar"><label><svg class="ui-icon" aria-hidden="true"><use href="#icon-search"></use></svg><input type="search" id="settingsSearch" placeholder="Hľadať nastavenie: Tor, téma, sťahovanie…" aria-label="Hľadať nastavenia"></label><p id="settingsSearchCount" role="status">Nastavenia sa ukladajú tlačidlom Uložiť zmeny.</p><div id="settingsSearchResults" class="settings-search-results" hidden></div></div><section class="settings-connection-overview" aria-label="Prehľad pripojenia"><div><strong>Tor</strong><span data-connection-tor></span><small>Platí pre weby načítané cez vstavaný Tor.</small></div><div><strong>Manuálna proxy</strong><span data-connection-proxy></span><small>SOCKS proxy nie je automaticky overené Tor spojenie.</small></div><div><strong>OpenVPN</strong><span data-connection-vpn></span><small>Stav klienta spusteného týmto prehliadačom.</small></div></section>`);
  const iconNames = { general: 'settings', appearance: 'layout-grid', privacy: 'shield-check', about: 'info', updates: 'rotate-cw', advanced: 'settings', vpn: 'lock-keyhole' };
  const sectionNotes = {
    general: 'Spustenie a vyhľadávanie',
    appearance: 'Téma a priestor na obrazovke',
    privacy: 'Ochrana a povolenia webov',
    about: 'Verzia a informácie',
    updates: 'Kontrola nových verzií',
    advanced: 'Sťahovanie, výkon a Tor',
    vpn: 'Profil a stav pripojenia'
  };
  page.querySelectorAll('[data-settings-section]').forEach((button) => {
    const text = button.querySelector('span')?.textContent || button.textContent.trim();
    const section = button.dataset.settingsSection;
    button.innerHTML = `<svg class="ui-icon" aria-hidden="true"><use href="#icon-${iconNames[section] || 'settings'}"></use></svg><span>${escapeHtml(text)}<small>${escapeHtml(sectionNotes[section] || '')}</small></span>`;
    button.setAttribute('aria-label', text);
    button.setAttribute('aria-current', button.classList.contains('active') ? 'page' : 'false');
    button.addEventListener('click', () => {
      page.querySelectorAll('[data-settings-section]').forEach((item) => item.setAttribute('aria-current', item === button ? 'page' : 'false'));
    });
  });
  page.querySelectorAll('.setting-card, .vpn-card').forEach((card, index) => {
    const title = card.querySelector('strong');
    if (!title) return;
    title.id = `settings-${activeTabId}-label-${index}`;
    card.querySelectorAll('input:not([type="checkbox"]), select').forEach((control) => {
      if (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
      if (control.placeholder) control.setAttribute('aria-label', `${title.textContent}: ${control.placeholder}`);
      else control.setAttribute('aria-labelledby', title.id);
    });
  });
  const notes = {
    startupSetting: 'Použije sa pri ďalšom spustení prehliadača.',
    homeSetting: 'Použije sa pri spustení, ak je zvolená domovská stránka.',
    searchSetting: 'Použije sa po uložení pri ďalšom vyhľadávaní.',
    themeSetting: 'Téma sa zmení po uložení. Reštart nie je potrebný.',
    downloadsSetting: 'Platí pre nové sťahovania po uložení.',
    zoomSetting: 'Po uložení sa upravia karty bez vlastného priblíženia.',
    toggleTorProxy: 'Pripojenie sa mení okamžite. Tor môže potrebovať čas na pripojenie.',
    applyManualProxy: 'Proxy sa použije okamžite na nové spojenia. Neoveruje anonymitu.',
    connectOpenVpn: 'Pripojí vybraný profil okamžite; vyžaduje nainštalovaný OpenVPN.'
  };
  Object.entries(notes).forEach(([id, text]) => {
    const control = surface.querySelector(`#${id}`);
    const card = control?.closest('.setting-card, .vpn-card') || control?.parentElement;
    if (card) {
      const note = document.createElement('p');
      note.className = 'settings-behavior-note';
      note.textContent = text;
      card.appendChild(note);
    }
  });
  const actions = page.querySelector('.settings-actions');
  page.appendChild(actions);
  actions.insertAdjacentHTML('afterbegin', '<span class="settings-draft-status" role="status">Zmeny sú uložené</span>');
  actions.insertAdjacentHTML('beforeend', '<button type="button" id="discardSettings" class="settings-reset" hidden>Zahodiť zmeny</button>');
  actions.addEventListener('click', (event) => {
    if (event.target.closest('#resetSettings') && !window.confirm('Obnoviť predvolené nastavenia? Neuložené zmeny sa zahodia.')) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.target.closest('#resetSettings')) discard();
  }, true);
  const staged = [...page.querySelectorAll('#startupSetting, #homeSetting, #searchSetting, #themeSetting, #uiFontScaleSetting, #downloadsSetting, #zoomSetting, [data-start-favorite-visible], [data-setting-toggle]:not([data-setting-toggle="autoUpdateCheck"])')];
  page.querySelectorAll('[data-setting-toggle]').forEach((toggle) => {
    if (typeof settingsState[toggle.dataset.settingToggle] === 'boolean') toggle.classList.toggle('on', settingsState[toggle.dataset.settingToggle]);
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', toggle.closest('.setting-card')?.querySelector('strong')?.textContent || toggle.dataset.settingToggle);
    toggle.setAttribute('aria-checked', String(toggle.classList.contains('on')));
  });
  const valueOf = (el) => el.matches('[data-setting-toggle]') ? el.classList.contains('on') : el.matches('input[type="checkbox"]') ? el.checked : el.value;
  let baseline = staged.map(valueOf);
  let spellBaseline = null;
  const spellOptions = page.querySelector('#spellcheckLanguageOptions');
  const spellValue = () => [...spellOptions.querySelectorAll('input:checked')].map((el) => el.value).sort().join(',');
  const spellObserver = new MutationObserver(() => {
    if (spellOptions.dataset.ready === 'true' && spellBaseline === null) {
      spellBaseline = spellValue();
      spellObserver.disconnect();
    }
  });
  spellObserver.observe(spellOptions, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ready'] });
  if (spellOptions.dataset.ready === 'true') { spellBaseline = spellValue(); spellObserver.disconnect(); }
  const dirty = () => staged.some((el, index) => valueOf(el) !== baseline[index]) || (spellBaseline !== null && spellValue() !== spellBaseline);
  const updateDirty = () => {
    const hasChanges = dirty();
    actions.classList.toggle('has-changes', hasChanges);
    page.querySelector('.settings-draft-status').textContent = hasChanges ? 'Máte neuložené zmeny' : 'Zmeny sú uložené';
    page.querySelector('#discardSettings').hidden = !hasChanges;
    page.querySelectorAll('[data-setting-toggle]').forEach((el) => el.setAttribute('aria-checked', String(el.classList.contains('on'))));
  };
  const discard = () => {
    staged.forEach((el, index) => {
      if (el.matches('[data-setting-toggle]')) el.classList.toggle('on', baseline[index]);
      else if (el.matches('input[type="checkbox"]')) el.checked = baseline[index];
      else el.value = baseline[index];
    });
    if (spellBaseline !== null) spellOptions.querySelectorAll('input').forEach((el) => { el.checked = spellBaseline.split(',').includes(el.value); });
    const downloads = page.querySelector('#downloadsSetting');
    downloads.dataset.clearCustomFolder = 'false';
    page.querySelector('#downloadFolderName').textContent = settingsState.downloadFolderPath || 'Používa sa predvolený systémový priečinok.';
    updateDirty();
  };
  settingsDrafts.set(surface, { dirty, discard });
  page.querySelector('#saveSettings').addEventListener('click', () => {
    settingsState.startShowWeather = page.querySelector('[data-setting-toggle="startShowWeather"]').classList.contains('on');
    settingsState.startShowFavorites = page.querySelector('[data-setting-toggle="startShowFavorites"]').classList.contains('on');
    settingsState.startShowFooter = page.querySelector('[data-setting-toggle="startShowFooter"]').classList.contains('on');
    settingsState.uiFontScale = page.querySelector('#uiFontScaleSetting').value;
    settingsState.startHiddenFavorites = [...page.querySelectorAll('[data-start-favorite-visible]:not(:checked)')].map((input) => input.dataset.startFavoriteVisible);
  }, true);
  page.addEventListener('input', updateDirty);
  page.addEventListener('change', updateDirty);
  page.addEventListener('click', updateDirty);
  page.querySelector('#discardSettings').addEventListener('click', discard);
  page.querySelector('#saveSettings').addEventListener('click', () => {
    settingsState.compact = page.querySelector('[data-setting-toggle="compact"]').classList.contains('on');
  }, true);
  page.querySelector('#saveSettings').addEventListener('click', () => {
    page.querySelector('#homeSetting').value = settingsState.home;
    baseline = staged.map(valueOf);
    if (spellOptions.dataset.ready === 'true') spellBaseline = spellValue();
    updateDirty();
  });
  const query = page.querySelector('#settingsSearch');
  const results = page.querySelector('#settingsSearchResults');
  const normalize = normalizeBrowserSearch;
  const searchable = [...page.querySelectorAll('.setting-card, .start-quick-links-setting, .vpn-card, .security-subsection, .about-card')].filter((card) => !card.closest('.tor-chat-section') && !card.querySelector('.setting-card, .vpn-card'));
  query.addEventListener('input', () => {
    results.replaceChildren();
    const text = normalize(query.value.trim());
    results.hidden = !text;
    const matches = text ? searchable.filter((card) => normalize(card.textContent).includes(text)) : [];
    page.querySelector('#settingsSearchCount').textContent = text ? `Nájdené nastavenia: ${matches.length}` : 'Nastavenia sa ukladajú tlačidlom Uložiť zmeny.';
    matches.forEach((card) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = card.querySelector('strong, .settings-label')?.textContent || card.textContent.trim().slice(0, 100);
      button.addEventListener('click', () => {
        const panel = card.closest('[data-settings-panel]');
        if (panel) page.querySelector(`[data-settings-section="${panel.dataset.settingsPanel}"]`)?.click();
        const group = card.closest('.settings-advanced-group');
        if (group) setGroupOpen(group, true);
        card.scrollIntoView({ block: 'center' });
        card.querySelector('input, select, button')?.focus({ preventScroll: true });
      });
      results.appendChild(button);
    });
  });
  renderSettingsConnectionOverview();
}

function addSecuritySettings() {
  const surface = getActiveSurface();
  const panel = surface.querySelector('[data-settings-panel="privacy"]');
  if (!panel) return;
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">ULOŽENÉ POVOLENIA WEBOV</p><div class="permission-list-toolbar"><input class="settings-input" id="sitePermissionFilter" placeholder="Filtrovať podľa domény" autocomplete="off"><button class="settings-control" id="clearSitePermissions">Odobrať všetko</button></div><div id="sitePermissionList" class="password-list"><small class="update-note">Načítavam povolenia...</small></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">POVOLENIA WEBOV</p><div class="setting-card"><div><strong>Kamera</strong><small>Weby môžu požiadať o prístup ku kamere.</small></div><button class="settings-toggle" data-setting-toggle="camera"><i></i></button></div><div class="setting-card"><div><strong>Mikrofón</strong><small>Weby môžu požiadať o prístup k mikrofónu.</small></div><button class="settings-toggle" data-setting-toggle="microphone"><i></i></button></div><div class="setting-card"><div><strong>Upozornenia</strong><small>Weby môžu zobrazovať systémové upozornenia.</small></div><button class="settings-toggle" data-setting-toggle="webNotifications"><i></i></button></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">TEST ZARIADENÍ</p><p class="media-device-test-status" id="mediaDeviceTestStatus" role="status" aria-live="polite">Test sa spustí až po kliknutí a oprávnenie sa po vypnutí odoberie.</p><div class="setting-card media-device-test-card"><div><strong>Kamera</strong><small>Overí obraz z predvolenej kamery. Náhľad zostane aktívny iba počas testu.</small></div><button class="settings-control" type="button" data-media-device-test="video">Otestovať kameru</button><video id="mediaDeviceTestPreview" class="media-device-test-preview" autoplay muted playsinline hidden aria-label="Náhľad testovanej kamery"></video></div><div class="setting-card media-device-test-card"><div><strong>Mikrofón</strong><small>Ukazovateľ sa pohne, keď mikrofón zachytí zvuk.</small></div><button class="settings-control" type="button" data-media-device-test="audio">Otestovať mikrofón</button><meter id="microphoneTestLevel" class="microphone-test-level" min="0" max="1" value="0" aria-label="Úroveň zvuku mikrofónu"></meter></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">USB KAMERA</p><div class="setting-card"><div><strong>Automaticky spúšťať pripojenú kameru</strong><small>Pri pripojení novej kamery otvorí kartu Kamera a zobrazí živý náhľad. Kamera sa zastaví pri prepnutí z karty alebo tlačidlom Vypnúť. Toto nastavenie je predvolene vypnuté.</small></div><button class="settings-toggle" data-setting-toggle="autoUsbCamera" aria-label="Automaticky spúšťať pripojenú kameru"><i></i></button></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">ADBLOCK</p><div class="setting-card"><div><strong>Štatistiky blokovania</strong><small id="adBlockStats">Načítavam štatistiky...</small></div><button class="settings-control" id="refreshAdBlockStats">Obnoviť</button></div><div class="setting-card"><div><strong>Výnimka pre aktuálnu stránku</strong><small>Povolí reklamné požiadavky pre doménu otvorenej stránky.</small></div><button class="settings-control" id="toggleAdBlockSite">Povoliť stránku</button></div></div>');
  panel.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">HESLÁ</p><div class="setting-card"><div><strong>Uložené prihlasovacie údaje</strong><small>Heslá sa ukladajú šifrovane do systému, nie do histórie prehliadača.</small></div><button class="settings-control" id="refreshPasswords">Obnoviť</button></div><div id="passwordList" class="password-list"></div><div class="password-form"><input class="settings-input" id="passwordHost" placeholder="Doména, napr. example.com" autocomplete="off"><input class="settings-input" id="passwordUsername" placeholder="Používateľ" autocomplete="off"><input class="settings-input" id="passwordValue" type="password" placeholder="Heslo" autocomplete="new-password"><button class="save-settings" id="savePasswordButton">Uložiť heslo</button></div></div>');
  ['camera', 'microphone', 'webNotifications', 'autoUsbCamera'].forEach((key) => { const toggle = panel.querySelector(`[data-setting-toggle="${key}"]`); toggle.classList.toggle('on', settingsState[key]); toggle.addEventListener('click', () => toggle.classList.toggle('on')); });
  panel.querySelector('[data-setting-toggle="autoUsbCamera"]').addEventListener('click', async (event) => {
    settingsState.autoUsbCamera = event.currentTarget.classList.contains('on');
    try {
      await saveSettings();
    } catch (error) {
      console.error('Linsoft Browser could not update automatic USB camera settings:', error);
      showToast('Nastavenie automatickej kamery sa nepodarilo uložiť.');
      return;
    }
    if (settingsState.autoUsbCamera) {
      initializeUsbCameraDeviceMonitor();
      showToast('Automatické spustenie kamery je zapnuté.');
    } else {
      navigator.mediaDevices?.removeEventListener('devicechange', onUsbCameraDeviceChange);
      usbCameraDeviceMonitorReady = false;
      knownUsbCameraDeviceIds = [];
      void stopUsbCameraCapture('Automatické spustenie kamery je vypnuté.');
      void window.linsoftBrowser?.releaseUsbCamera?.().catch((error) => {
        console.error('Linsoft Browser could not release the USB camera permission:', error);
      });
      showToast('Automatické spustenie kamery je vypnuté.');
    }
  });
  panel.querySelectorAll('[data-media-device-test]').forEach((button) => {
    button.addEventListener('click', () => {
      void startMediaDeviceTest(button.dataset.mediaDeviceTest);
    });
  });
  let sitePermissionEntries = [];
  const renderSitePermissions = async (reload = true) => {
    const list = panel.querySelector('#sitePermissionList');
    if (reload) sitePermissionEntries = await window.linsoftBrowser?.listSitePermissions?.() || [];
    const filter = panel.querySelector('#sitePermissionFilter')?.value.trim().toLowerCase() || '';
    const entries = sitePermissionEntries.filter((entry) => entry.origin.toLowerCase().includes(filter));
    if (!list) return;
    list.innerHTML = (entries || []).map((entry) => {
      const permission = entry.permission === 'notifications' ? 'Upozornenia' : `Médiá (${entry.permission})`;
      const decision = entry.decision === 'allow' ? 'Povolené' : 'Blokované';
      return `<div class="password-row"><span><strong>${escapeHtml(entry.origin)}</strong><small>${escapeHtml(permission)} · ${decision}</small></span><button class="settings-control" data-revoke-site-permission="${escapeHtml(entry.key)}">Odvolať</button></div>`;
    }).join('') || '<small class="update-note">Zatiaľ nie sú uložené žiadne povolenia.</small>';
    list.querySelectorAll('[data-revoke-site-permission]').forEach((button) => button.addEventListener('click', async () => {
      const result = await window.linsoftBrowser?.revokeSitePermission?.(button.dataset.revokeSitePermission);
      if (result?.ok) { renderSitePermissions(); showToast('Povolenie stránky bolo odvolané.'); }
      else showToast('Povolenie sa nepodarilo odvolať.');
    }));
  };
  renderSitePermissions();
  panel.querySelector('#sitePermissionFilter').addEventListener('input', () => renderSitePermissions(false));
  panel.querySelector('#clearSitePermissions').addEventListener('click', async () => {
    if (!sitePermissionEntries.length || !window.confirm('Odobrať všetky uložené povolenia webov?')) return;
    const result = await window.linsoftBrowser?.clearSitePermissions?.();
    if (result?.ok) { renderSitePermissions(); showToast('Všetky povolenia webov boli odvolané.'); }
    else showToast('Povolenia sa nepodarilo odvolať.');
  });
  const renderAdBlockStats = async () => { const stats = await window.linsoftBrowser?.getAdblockStats(); const label = panel.querySelector('#adBlockStats'); if (label && stats) label.textContent = `${stats.blocked} zablokovaných požiadaviek · ${stats.learned} naučených hostov · ${stats.allowlisted} výnimiek`; };
  panel.querySelector('#refreshAdBlockStats').addEventListener('click', renderAdBlockStats);
  panel.querySelector('#toggleAdBlockSite').addEventListener('click', async (event) => { let host = ''; try { host = new URL(addressInput.value).hostname; } catch {} if (!host) return showToast('Aktuálna stránka nemá platnú doménu.'); const result = await window.linsoftBrowser?.toggleAdblockSite(host); if (!result?.ok) return showToast(result?.message || 'Výnimku sa nepodarilo nastaviť.'); event.currentTarget.textContent = result.allowlisted ? 'Výnimka zapnutá' : 'Povoliť stránku'; renderAdBlockStats(); showToast(result.allowlisted ? `Reklamy povolené pre ${host}.` : `Výnimka odstránená pre ${host}.`); });
  renderAdBlockStats();
  const passwordList = panel.querySelector('#passwordList');
  const fillPassword = async (id) => { let hostname = ''; try { hostname = new URL(addressInput.value).hostname.toLowerCase(); } catch {} const entry = await window.linsoftBrowser?.getPassword(id); if (!entry || hostname !== entry.hostname) return showToast('Heslo možno vyplniť iba na rovnakej doméne.'); const viewer = activeViewer(); if (!viewer) return showToast('Na aktuálnej stránke nie je prihlasovací formulár.'); const username = JSON.stringify(entry.username); const password = JSON.stringify(entry.password); const filled = await viewer.executeJavaScript(`(() => { const user = document.querySelector('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="login" i]'); const pass = document.querySelector('input[type="password"]'); if (!pass) return false; const set = (element, value) => { if (!element) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }; set(user, ${username}); set(pass, ${password}); return true; })()`, true).catch(() => false); showToast(filled ? 'Prihlasovacie údaje boli vyplnené.' : 'Na stránke sa nenašlo heslové pole.'); };
  const renderPasswords = async () => { const entries = await window.linsoftBrowser?.listPasswords(); passwordList.innerHTML = (entries || []).map((entry) => `<div class="password-row"><span><strong>${escapeHtml(entry.hostname)}</strong><small>${escapeHtml(entry.username)}</small></span><div class="password-row-actions"><button class="settings-control" data-fill-password="${escapeHtml(entry.id)}">Vyplniť</button><button class="settings-control" data-delete-password="${escapeHtml(entry.id)}">Odstrániť</button></div></div>`).join('') || '<small class="update-note">Žiadne uložené heslá.</small>'; passwordList.querySelectorAll('[data-fill-password]').forEach((button) => button.addEventListener('click', () => fillPassword(button.dataset.fillPassword))); passwordList.querySelectorAll('[data-delete-password]').forEach((button) => button.addEventListener('click', async () => { const result = await window.linsoftBrowser?.deletePassword(button.dataset.deletePassword); if (result?.ok) { renderPasswords(); showToast('Heslo bolo odstránené.'); } })); };
  panel.querySelector('#refreshPasswords').addEventListener('click', renderPasswords);
  panel.querySelector('#savePasswordButton').addEventListener('click', async () => { const result = await window.linsoftBrowser?.savePassword({ hostname: panel.querySelector('#passwordHost').value, username: panel.querySelector('#passwordUsername').value, password: panel.querySelector('#passwordValue').value }); if (!result?.ok) return showToast(result?.message || 'Heslo sa nepodarilo uložiť.'); panel.querySelector('#passwordHost').value = ''; panel.querySelector('#passwordUsername').value = ''; panel.querySelector('#passwordValue').value = ''; renderPasswords(); showToast('Heslo bolo uložené šifrovane.'); });
  renderPasswords();
}

function addUpdateCheck() {
  const surface = getActiveSurface();
  const aboutPanel = surface.querySelector('[data-settings-panel="about"]');
  const navigation = surface.querySelector('.settings-nav');
  const panels = surface.querySelector('.settings-panels');
  if (!aboutPanel || !navigation || !panels) return;
  const aboutCard = aboutPanel.querySelector('.about-card');
  if (aboutCard) { const description = aboutCard.querySelector('small'); if (description) description.remove(); aboutCard.querySelector('div').insertAdjacentHTML('beforeend', '<small>Autor: Martin Pastorek</small>'); }
  aboutPanel.insertAdjacentHTML('beforeend', `<section class="license-card" aria-label="Licenčné podmienky používania">
    <header class="license-heading"><span class="license-heading-icon"><svg class="ui-icon" aria-hidden="true"><use href="#icon-shield-check"></use></svg></span><div><h3>Licenčné podmienky používania</h3><small>Prehľad podmienok pre Linsoft Browser</small></div></header>
    <ul class="license-terms">
      <li><svg class="ui-icon" aria-hidden="true"><use href="#icon-user-round"></use></svg><div><h4>Používanie aplikácie</h4><p>Linsoft Browser je poskytovaný na osobné a interné použitie.</p></div></li>
      <li><svg class="ui-icon" aria-hidden="true"><use href="#icon-lock-keyhole"></use></svg><div><h4>Obmedzenia a súhlas autora</h4><p>Je zakázané aplikáciu predávať, meniť, redistribuovať alebo používať na nezákonné účely bez písomného súhlasu autora.</p></div></li>
      <li><svg class="ui-icon" aria-hidden="true"><use href="#icon-file-code"></use></svg><div><h4>Komponenty tretích strán</h4><p>Aplikácia používa Electron, Chromium a ďalšie komponenty tretích strán, ktoré sa riadia vlastnými licenciami.</p></div></li>
      <li><svg class="ui-icon" aria-hidden="true"><use href="#icon-info"></use></svg><div><h4>Zodpovednosť za obsah</h4><p>Autor nezodpovedá za obsah webových stránok otvorených v prehliadači ani za škody spôsobené ich používaním.</p></div></li>
    </ul>
  </section>`);
  navigation.insertAdjacentHTML('beforeend', '<button data-settings-section="updates">↻ <span>Aktualizácie</span></button>');
  panels.insertAdjacentHTML('beforeend', `<section data-settings-panel="updates" hidden>
    <p class="settings-label">AKTUALIZÁCIE</p><h2>Verzia a aktualizácie</h2>
    <div class="about-card settings-update-version"><img src="assets/linsoft-icon.svg" alt="Logo Linsoft Browser" width="64" height="64"><div><small>Nainštalovaná verzia</small><strong id="settingsAppVersion">Linsoft Browser</strong><small>Nové verzie prinášajú opravy a vylepšenia prehliadača.</small></div></div>
    <div class="settings-update-status" data-update-status="idle" aria-busy="false">
      <div class="settings-update-status-heading"><span class="settings-update-icon"><svg class="ui-icon" aria-hidden="true"><use href="#icon-rotate-cw"></use></svg></span><div><h3 data-update-title>Pripravené na kontrolu</h3><p class="update-note" data-update-note role="status">Skontroluj dostupnosť novej verzie.</p></div></div>
      <progress class="settings-update-progress" max="100" value="0" aria-label="Priebeh sťahovania aktualizácie" hidden></progress>
      <p class="settings-update-checked" data-update-checked>Kontrola zatiaľ neprebehla.</p>
      <button class="check-update" data-update-action="check" type="button">Skontrolovať teraz</button>
    </div>
    <div class="setting-card"><div><strong>Automaticky kontrolovať</strong><small>Kontrolovať pri spustení a pravidelne počas používania. Zmena sa uloží okamžite.</small></div><button class="settings-toggle" id="autoUpdateCheckToggle" data-setting-toggle="autoUpdateCheck"><i></i></button></div>
    <p class="settings-update-help"><svg class="ui-icon" aria-hidden="true"><use href="#icon-info"></use></svg><span>Automatické aktualizácie sú dostupné v nainštalovanej verzii pre Windows. Po stiahnutí si vyberieš, kedy aplikáciu reštartovať a aktualizáciu nainštalovať.</span></p>
  </section>`);
  const updatePanel = panels.querySelector('[data-settings-panel="updates"]');
  const updateToggle = updatePanel.querySelector('#autoUpdateCheckToggle');
  const updateButton = updatePanel.querySelector('[data-update-action]');
  updateToggle.classList.toggle('on', settingsState.autoUpdateCheck !== false);
  updateButton.addEventListener('click', async () => {
    try {
      if (updateButton.dataset.updateAction === 'install') return await window.linsoftBrowser?.installUpdate?.();
      renderSettingsUpdateState({ status: 'checking' });
      const result = await window.linsoftBrowser?.checkForUpdates?.();
      if (result?.status === 'available') {
        renderSettingsUpdateState({ status: 'available', version: result.version });
        renderSettingsUpdateState({ status: 'downloading', version: result.version, percent: 0 });
        const download = await window.linsoftBrowser?.downloadUpdate?.();
        if (!download?.ok) renderSettingsUpdateState({ status: 'error', message: `Sťahovanie zlyhalo: ${download?.message || 'neznáma chyba'}` });
      } else {
        renderSettingsUpdateState(result || { status: 'unavailable', message: 'Kontrola je dostupná v desktopovej aplikácii.' });
      }
    } catch (error) {
      console.error('Linsoft Browser update action failed:', error);
      renderSettingsUpdateState({ status: 'error', message: 'Aktualizácia zlyhala. Skús to znova.' });
    }
  });
  window.linsoftBrowser?.getVersion?.().then((version) => {
    const versionLabel = updatePanel.querySelector('#settingsAppVersion');
    if (versionLabel) versionLabel.textContent = `Linsoft Browser ${version}`;
    const aboutLabel = aboutCard?.querySelector('strong');
    if (aboutLabel) aboutLabel.textContent = `Linsoft Browser ${version}`;
  }).catch((error) => {
    console.error('Linsoft Browser could not read its version:', error);
    updatePanel.querySelector('#settingsAppVersion').textContent = 'Verziu sa nepodarilo zistiť';
  });
  window.linsoftBrowser?.getUpdateState?.().then(renderSettingsUpdateState).catch((error) => {
    console.error('Linsoft Browser could not read update status:', error);
    renderSettingsUpdateState({ status: 'error', message: 'Stav aktualizácií sa nepodarilo zistiť.' });
  });
  if (!window.linsoftBrowser) {
    updatePanel.querySelector('#settingsAppVersion').textContent = 'Verzia dostupná v desktopovej aplikácii';
    renderSettingsUpdateState({ status: 'unavailable', message: 'Kontrola je dostupná v desktopovej aplikácii.' });
  }
}

function renderSettingsUpdateState(state) {
  if (!state) return;
  document.querySelectorAll('[data-settings-panel="updates"]').forEach((panel) => {
    const note = panel.querySelector('[data-update-note]');
    const button = panel.querySelector('[data-update-action]');
    if (!note || !button) return;
    const statusCard = panel.querySelector('.settings-update-status');
    const progress = panel.querySelector('[data-update-status] progress');
    const titles = { idle: 'Pripravené na kontrolu', checking: 'Kontrolujem aktualizácie', available: 'Nová verzia je dostupná', downloading: 'Sťahovanie aktualizácie', downloaded: 'Pripravené na inštaláciu', latest: 'Používaš najnovšiu verziu', error: 'Aktualizácia zlyhala', unavailable: 'Aktualizácie nie sú dostupné' };
    const icons = { idle: 'rotate-cw', checking: 'rotate-cw', available: 'download', downloading: 'download', downloaded: 'shield-check', latest: 'shield-check', error: 'info', unavailable: 'info' };
    const percent = Number.isFinite(Number(state.percent)) ? Math.max(0, Math.min(100, Number(state.percent))) : 0;
    statusCard.dataset.updateStatus = state.status;
    statusCard.setAttribute('aria-busy', String(state.status === 'checking' || state.status === 'downloading'));
    panel.querySelector('[data-update-title]').textContent = titles[state.status] || 'Stav aktualizácií';
    panel.querySelector('.settings-update-icon use').setAttribute('href', `#icon-${icons[state.status] || 'info'}`);
    const checked = panel.querySelector('[data-update-checked]');
    if (typeof state.checkedAt === 'number' && Number.isFinite(state.checkedAt) && state.checkedAt > 0) {
      const date = new Date(state.checkedAt);
      if (!Number.isNaN(date.getTime())) checked.textContent = `Posledná kontrola: ${date.toLocaleString('sk-SK')}`;
    } else if (state.status === 'idle') checked.textContent = 'Kontrola zatiaľ neprebehla.';
    progress.hidden = state.status !== 'downloading';
    progress.value = percent;
    if (state.status === 'checking') note.textContent = 'Overujem dostupnosť novej verzie. Počkaj, prosím.';
    else if (state.status === 'idle') note.textContent = 'Skontroluj dostupnosť novej verzie.';
    else if (state.status === 'available') note.textContent = `Dostupná je verzia ${state.version}.`;
    else if (state.status === 'downloading') note.textContent = `Sťahuje sa aktualizácia: ${percent} %.`;
    else if (state.status === 'downloaded') note.textContent = `Verzia ${state.version} je pripravená na inštaláciu.`;
    else if (state.status === 'latest') note.textContent = `Používaš najnovšiu verziu Linsoft Browser ${state.version}.`;
    else if (state.status === 'error' || state.status === 'unavailable') note.textContent = state.message || 'Aktualizácie sa teraz nedajú overiť.';
    if (state.status === 'downloaded') {
      button.dataset.updateAction = 'install';
      button.textContent = 'Reštartovať a nainštalovať';
      button.disabled = false;
    } else if (state.status === 'downloading' || state.status === 'checking') {
      button.dataset.updateAction = 'check';
      button.textContent = state.status === 'checking' ? 'Kontrolujem...' : 'Sťahuje sa...';
      button.disabled = true;
    } else {
      button.dataset.updateAction = 'check';
      button.textContent = state.status === 'error' ? 'Skúsiť znova' : 'Skontrolovať teraz';
      button.disabled = false;
    }
  });
}

function addAdvancedSettings() {
  const surface = getActiveSurface();
  const navigation = surface.querySelector('.settings-nav');
  const panels = surface.querySelector('.settings-panels');
  navigation.insertAdjacentHTML('beforeend', '<button data-settings-section="advanced">⌘ <span>Pokročilé</span></button>');
  panels.insertAdjacentHTML('beforeend', '<section data-settings-panel="advanced" hidden><p class="settings-label">POKROČILÉ</p><h2>Ďalšie možnosti</h2><div class="setting-card"><div><strong>Blokovanie reklám</strong><small>Blokuje reklamné siete a učí sa z opakovaných reklamných požiadaviek lokálne.</small></div><button class="settings-toggle" data-setting-toggle="adBlock"><i></i></button></div><div class="setting-card"><div><strong>Ochrana proti sledovaniu</strong><small>Obmedzí trackery, analytické pixely a odošle signál Do Not Track.</small></div><button class="settings-toggle" data-setting-toggle="trackingProtection"><i></i></button></div><div class="setting-card"><div><strong>Priečinok na stiahnuté súbory</strong><small>Miesto, kam Linsoft Browser ukladá stiahnuté súbory.</small></div><select id="downloadsSetting"><option value="Downloads">Downloads</option><option value="Desktop">Plocha</option><option value="Documents">Dokumenty</option></select></div><div class="setting-card"><div><strong>Vždy sa opýtať pred stiahnutím</strong><small>Zobrazí potvrdenie pred každým stiahnutím.</small></div><button class="settings-toggle" data-setting-toggle="askDownload"><i></i></button></div><div class="setting-card"><div><strong>Obnoviť karty po spustení</strong><small>Po otvorení obnoví poslednú pracovnú reláciu.</small></div><button class="settings-toggle" data-setting-toggle="restoreTabs"><i></i></button></div><div class="setting-card"><div><strong>Predvolené priblíženie</strong><small>Veľkosť obsahu webových stránok.</small></div><select id="zoomSetting"><option value="80">80 %</option><option value="90">90 %</option><option value="100">100 %</option><option value="110">110 %</option><option value="125">125 %</option></select></div><div class="setting-card"><div><strong>Vymazať údaje pri ukončení</strong><small>Po zatvorení browsera vymaže lokálnu históriu.</small></div><button class="settings-toggle" data-setting-toggle="clearExit"><i></i></button></div><div class="setting-card"><div><strong>Aktualizovať reklamný zoznam</strong><small>Stiahne nový zoznam reklamných domén z verejného zdroja.</small></div><button class="settings-control" id="updateAdblockList">Aktualizovať</button></div></section>');
  navigation.insertAdjacentHTML('beforeend', '<button data-settings-section="vpn">⌁ <span>OpenVPN</span></button>');
  panels.insertAdjacentHTML('beforeend', '<section data-settings-panel="vpn" hidden><p class="settings-label">OPENVPN</p><h2>VPN pripojenie</h2><div class="vpn-card"><div><strong>OpenVPN profil</strong><small id="openVpnProfileName">Nie je vybraný žiadny .ovpn súbor.</small></div><button class="settings-control" id="chooseOpenVpn">Vybrať profil</button></div><div class="vpn-card"><div><strong>Stav pripojenia</strong><small id="openVpnStatus">VPN je odpojená.</small></div><span class="vpn-status-dot" id="openVpnDot"></span></div><div class="vpn-actions"><button class="save-settings" id="connectOpenVpn">Pripojiť VPN</button><button class="settings-reset" id="disconnectOpenVpn">Odpojiť</button></div><div class="vpn-log-wrap"><div class="vpn-log-title">Živý log</div><pre id="openVpnLog">Čaká sa na operáciu...</pre></div><p class="update-note">Vyžaduje nainštalovaný OpenVPN klient vo Windowse a platný .ovpn profil.</p></section>');
  panels.insertAdjacentHTML('beforeend', '<div class="security-subsection"><p class="settings-label">SPRÁVA A VÝKON</p><div class="setting-card"><div><strong>Potvrdiť zatvorenie viacerých kariet</strong><small>Zobrazí potvrdenie pred zatvorením okna s viacerými kartami.</small></div><button class="settings-toggle" data-setting-toggle="confirmClose"><i></i></button></div><div class="setting-card"><div><strong>Pozastavovať neaktívne karty</strong><small>Šetrí pamäť; aktívne, pripnuté a YouTube karty zostanú aktívne.</small></div><button class="settings-toggle" data-setting-toggle="suspendInactiveTabs"><i></i></button></div><div class="setting-card"><div><strong>Vymazať cache</strong><small>Vyčistí dočasné Chromium dáta bez odstránenia záložiek a kariet.</small></div><button class="settings-control" id="clearCacheButton">Vymazať</button></div></div>');
  const advancedButton = navigation.querySelector('[data-settings-section="advanced"]'); const advancedPanel = panels.querySelector('[data-settings-panel="advanced"]'); const downloads = surface.querySelector('#downloadsSetting'); const zoom = surface.querySelector('#zoomSetting'); downloads.value = settingsState.downloads; zoom.value = settingsState.zoom;
  advancedPanel.insertAdjacentHTML('afterbegin', '<div class="security-subsection"><p class="settings-label">KONTROLA PRAVOPISU</p><div class="setting-card"><div><strong>Jazyky kontroly</strong><small>Označ slovenčinu alebo angličtinu. Dostupné sú iba slovníky nainštalované v systéme.</small></div><div class="spellcheck-language-options" id="spellcheckLanguageOptions"><small>Načítavam slovníky...</small></div></div></div>');
  const spellcheckOptions = advancedPanel.querySelector('#spellcheckLanguageOptions');
  window.linsoftBrowser?.getSpellcheckerLanguages?.().then((result) => {
    const available = Array.isArray(result?.available) ? result.available : [];
    const languages = [
      { label: 'Slovenčina', prefix: 'sk' },
      { label: 'Angličtina', prefix: 'en' }
    ].map((language) => ({ ...language, code: available.find((code) => code.toLowerCase() === language.prefix) || available.find((code) => code.toLowerCase().startsWith(`${language.prefix}-`)) })).filter((language) => language.code);
    if (!languages.length) spellcheckOptions.innerHTML = '<small>V systéme nie sú dostupné slovníky pravopisu.</small>';
    else {
      const selected = Array.isArray(settingsState.spellcheckLanguages) ? new Set(settingsState.spellcheckLanguages) : new Set(languages.map((language) => language.code));
      spellcheckOptions.innerHTML = languages.map((language) => `<label class="spellcheck-language-option"><input type="checkbox" value="${escapeHtml(language.code)}"${selected.has(language.code) ? ' checked' : ''}><span>${language.label}</span></label>`).join('');
    }
    spellcheckOptions.dataset.ready = 'true';
  }).catch(() => { spellcheckOptions.innerHTML = '<small>Slovníky pravopisu sa nepodarilo načítať.</small>'; spellcheckOptions.dataset.ready = 'false'; });
  spellcheckOptions.closest('.security-subsection').insertAdjacentHTML('afterend', '<div class="security-subsection"><p class="settings-label">MERANIE RÝCHLOSTI</p><div class="setting-card page-load-metrics-card"><div><strong>Načítanie stránok</strong><small id="pageLoadMetricsSummary">Meranie začne pri ďalšom načítaní stránky.</small><div id="pageLoadMetricsList" class="page-load-metrics-list"></div></div><button class="settings-control" id="clearPageLoadMetrics">Vymazať merania</button></div></div>');
  renderPageLoadMetrics();
  advancedPanel.querySelector('#clearPageLoadMetrics').addEventListener('click', () => {
    recentPageLoadMetrics = [];
    localStorage.removeItem('linsoft-page-load-metrics');
    renderPageLoadMetrics();
    showToast('Merania načítania boli vymazané.');
  });
  advancedPanel.insertAdjacentHTML('beforeend', '<div class="security-subsection tor-hosting-section"><p class="settings-label">TOR HOSTING</p><div class="setting-card"><div><strong>Hostovať web cez Tor</strong><small id="torHostingStatus">Tor hosting je vypnutý.</small></div><span class="vpn-status-dot" id="torHostingDot"></span></div><div class="setting-card"><div><strong>Priečinok webu</strong><small id="torHostingFolder">Nie je vybraný priečinok.</small></div><button class="settings-control" id="chooseTorFolder">Vybrať priečinok</button></div><div class="vpn-actions"><button class="save-settings" id="startTorHosting">Spustiť hosting</button><button class="settings-reset" id="stopTorHosting">Zastaviť</button></div><div class="vpn-log-wrap"><div class="vpn-log-title">Onion adresa</div><pre id="torHostingAddress">Zatiaľ nie je vytvorená.</pre><button class="settings-control" id="copyTorAddress" disabled>Kopírovať adresu</button></div></div>');
  advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('afterbegin', '<div class="setting-card"><div><strong>Prehliadať cez Tor</strong><small id="torProxyStatus">Tor proxy je vypnutá.</small></div><button class="settings-control" id="toggleTorProxy">Zapnúť Tor</button></div>');
  advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('afterbegin', '<div class="setting-card manual-proxy-card"><div><strong>Manuálna proxy</strong><small>Vyber SOCKS4 alebo SOCKS5 a zadaj hostiteľa s portom.</small></div><select class="settings-input" id="manualProxyProtocol"><option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option></select><input class="settings-input" id="manualProxyHost" placeholder="Hostiteľ" value="127.0.0.1"><input class="settings-input" id="manualProxyPort" placeholder="Port" value="9150" inputmode="numeric"><button class="settings-control" id="applyManualProxy">Použiť proxy</button><button class="settings-reset" id="disableManualProxy">Vypnúť proxy</button></div>');
  advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('beforeend', '<div class="security-subsection tor-chat-launcher"><p class="settings-label">ONION CHAT 1:1</p><div class="setting-card"><div><strong>Šifrovaný chat cez Tor</strong><small>Otvor chat v samostatnej karte.</small></div><button class="settings-control" id="openTorChatTab" type="button">Otvoriť chat</button></div></div>');
  const createTorChatPanel = !torChatPanel?.isConnected;
  if (createTorChatPanel) {
    advancedPanel.querySelector('.tor-hosting-section').insertAdjacentHTML('beforeend', `<section class="tor-chat-section" hidden>
      <aside class="tor-chat-rail">
        <div class="tor-chat-brand-mark" aria-hidden="true">L</div>
        <button class="tor-chat-rail-button" type="button" title="Otvoriť nastavenia" aria-label="Otvoriť nastavenia">⚙</button>
        <span class="tor-chat-rail-spacer"></span>
        <span class="tor-chat-rail-lock" title="End-to-end šifrovanie" aria-label="End-to-end šifrovanie">⌑</span>
      </aside>
      <aside class="tor-chat-roster">
        <header class="tor-chat-roster-head"><span class="tor-chat-kicker">LINsoft / SÚKROMNÁ SIEŤ</span><h2>Správy</h2><small id="torChatStatus" aria-live="polite">Onion chat je vypnutý.</small></header>
        <button class="tor-chat-host-action" id="torChatHost" type="button"><span aria-hidden="true">＋</span> Vytvoriť pozvánku</button>
        <div class="tor-chat-invite" id="torChatInvitePanel" hidden><label for="torChatInviteValue">Súkromná pozvánka</label><img id="torChatInviteQr" class="tor-chat-invite-qr" alt="QR kód súkromnej onion pozvánky" hidden><small id="torChatInviteExpiry" class="tor-chat-invite-expiry"></small><textarea class="settings-input" id="torChatInviteValue" rows="2" readonly></textarea><button class="settings-control" id="copyTorChatInvite" type="button">Kopírovať pozvánku</button><button class="tor-chat-renew-button" id="torChatRenewInvite" type="button" hidden>Vytvoriť novú pozvánku</button></div>
        <div class="tor-chat-join-row" id="torChatJoinPanel"><input class="settings-input" id="torChatInviteInput" type="text" placeholder="Vlož onion pozvánku" autocomplete="off"><div class="tor-chat-join-actions"><button class="settings-control" id="torChatScan" type="button">Naskenovať QR</button><button class="settings-control" id="torChatJoin" type="button">Pripojiť</button></div></div>
        <div class="tor-chat-scanner" id="torChatScanner" hidden><video id="torChatScannerVideo" autoplay muted playsinline></video><small id="torChatScannerStatus" aria-live="polite">Namier kameru na QR pozvánku.</small><button class="settings-control" id="torChatScannerStop" type="button">Zavrieť skener</button></div>
        <div class="tor-chat-contact-heading">SÚKROMNÁ KONVERZÁCIA</div>
        <div class="tor-chat-contact-row"><span class="tor-chat-contact-avatar">1:1</span><span class="tor-chat-contact-copy"><strong id="torChatPeerName">Druhý účastník</strong><small id="torChatPeerStatus">Čaká sa na pripojenie</small></span><span class="vpn-status-dot" id="torChatDot" data-status="stopped" aria-label="Stav onion spojenia"></span></div>
        <span class="tor-chat-roster-spacer"></span>
        <button class="tor-chat-end-button" id="torChatEnd" type="button" disabled>Ukončiť chat</button>
      </aside>
      <main class="tor-chat-main">
        <header class="tor-chat-main-head"><span class="tor-chat-contact-avatar large">1:1</span><div><strong id="torChatHeaderName">Onion konverzácia</strong><small id="torChatHeaderStatus">Čaká sa na pozvánku alebo spojenie</small></div><button class="tor-chat-video-button" id="torChatVideoCall" type="button" title="Video-only cez Tor, bez zvuku a s nižšou snímkovou frekvenciou" aria-label="Spustiť alebo ukončiť video hovor" disabled>Video hovor</button><span class="tor-chat-encryption-badge"><span aria-hidden="true">⌑</span> AES-GCM / TOR</span></header>
        <section class="tor-chat-video-stage" id="torChatVideoPanel" hidden><div class="tor-chat-video-grid"><figure><video id="torChatLocalVideo" autoplay muted playsinline></video><figcaption>Ty</figcaption></figure><figure><img id="torChatRemoteVideo" alt="Video druhého účastníka"><figcaption>Kontakt</figcaption></figure></div><small id="torChatVideoStatus" aria-live="polite">Video-only cez Tor, bez zvuku; kvalita sa prispôsobí sieti.</small></section>
        <div class="tor-chat-conversation" id="torChatConversation" hidden><div class="tor-chat-messages" id="torChatMessages" role="log" aria-live="polite" aria-label="Správy onion chatu"></div><small id="torChatFileStatus" class="tor-chat-file-transfer-status" aria-live="polite" hidden></small><form class="tor-chat-compose" id="torChatForm"><button class="tor-chat-attach-button" id="torChatAttach" type="button" aria-label="Poslať súbor" title="Poslať súbor">⌁</button><input id="torChatFileInput" type="file" hidden><textarea class="settings-input" id="torChatMessage" rows="2" maxlength="2000" placeholder="Napíš šifrovanú správu..." disabled></textarea><button class="tor-chat-send-button" id="torChatSend" type="submit" disabled aria-label="Odoslať správu">Odoslať</button></form></div>
        <div class="tor-chat-empty" id="torChatEmpty"><span aria-hidden="true">⌑</span><strong>Súkromná komunikácia cez Tor</strong><p>Vytvor pozvánku alebo vlož pozvánku od druhého účastníka. Správy sa šifrujú medzi zariadeniami a po ukončení chatu sa vymažú.</p></div>
      </main>
    </section>`);
    torChatPanel = advancedPanel.querySelector('.tor-chat-section');
    torChatPanel.hidden = true;
  }
  let torFolder = '';
  let currentTorStatus = { status: 'stopped', proxyStatus: 'stopped', proxyEnabled: false };
  const renderTorStatus = (update) => { currentTorStatus = { ...currentTorStatus, ...update }; const status = currentTorStatus; if (typeof status.folder === 'string' && status.folder) torFolder = status.folder; const label = surface.querySelector('#torHostingStatus'); const proxyLabel = surface.querySelector('#torProxyStatus'); const proxyButton = surface.querySelector('#toggleTorProxy'); const folderLabel = surface.querySelector('#torHostingFolder'); const dot = surface.querySelector('#torHostingDot'); const address = surface.querySelector('#torHostingAddress'); const start = surface.querySelector('#startTorHosting'); const stop = surface.querySelector('#stopTorHosting'); const copy = surface.querySelector('#copyTorAddress'); if (!label) return; const requestInfo = Number(status.requestCount) > 0 ? ` · Požiadavky: ${status.requestCount}` : ''; label.textContent = `${status.message || 'Tor hosting je vypnutý.'}${requestInfo}`; proxyLabel.textContent = status.proxyMessage || (status.proxyEnabled ? 'Tor proxy je pripojená.' : 'Tor proxy je vypnutá.'); proxyButton.textContent = status.proxyStatus === 'manual' ? 'Vypnúť proxy' : status.proxyEnabled ? 'Vypnúť Tor' : 'Zapnúť Tor'; proxyButton.disabled = status.proxyStatus === 'connecting'; folderLabel.textContent = status.folder || torFolder || 'Nie je vybraný priečinok.'; dot.dataset.status = status.status || 'stopped'; address.textContent = status.onion || 'Zatiaľ nie je vytvorená.'; start.disabled = status.status === 'starting' || status.status === 'running'; stop.disabled = status.status !== 'starting' && status.status !== 'running'; copy.disabled = !status.onion; };
  surface.querySelector('#toggleTorProxy').addEventListener('click', async () => { const current = await window.linsoftBrowser?.getTorStatus?.(); const result = current?.proxyEnabled ? await window.linsoftBrowser?.disableTorProxy?.() : await window.linsoftBrowser?.enableTorProxy?.(); renderTorStatus(result?.ok ? result : { proxyStatus: 'error', proxyMessage: result?.message || 'Tor proxy sa nepodarilo prepnúť.' }); });
  surface.querySelector('#applyManualProxy').addEventListener('click', async () => { const result = await window.linsoftBrowser?.setManualProxy?.({ protocol: surface.querySelector('#manualProxyProtocol').value, host: surface.querySelector('#manualProxyHost').value, port: surface.querySelector('#manualProxyPort').value }); renderTorStatus(result?.ok ? result : { proxyStatus: 'error', proxyMessage: result?.message || 'Manuálnu proxy sa nepodarilo zapnúť.' }); });
  surface.querySelector('#disableManualProxy').addEventListener('click', async () => { const result = await window.linsoftBrowser?.setManualProxy?.({ host: '', port: '' }); renderTorStatus(result || { proxyStatus: 'stopped', proxyEnabled: false, proxyMessage: 'Proxy je vypnutá.' }); });
  surface.querySelector('#chooseTorFolder').addEventListener('click', async () => { torFolder = await window.linsoftBrowser?.selectTorFolder?.() || ''; renderTorStatus({ folder: torFolder }); });
  surface.querySelector('#startTorHosting').addEventListener('click', async () => { if (!torFolder) torFolder = await window.linsoftBrowser?.getTorDefaultFolder?.() || ''; if (!torFolder) return; const result = await window.linsoftBrowser?.startTorHosting?.(torFolder); renderTorStatus(result || { status: 'error', message: 'Tor hosting sa nepodarilo spustiť.' }); });
  surface.querySelector('#stopTorHosting').addEventListener('click', async () => { const result = await window.linsoftBrowser?.stopTorHosting?.(); renderTorStatus(result || { status: 'stopped', message: 'Tor hosting je vypnutý.' }); });
  surface.querySelector('#copyTorAddress').addEventListener('click', async () => { const address = surface.querySelector('#torHostingAddress').textContent; await window.linsoftBrowser?.writeClipboardText?.(address); showToast('Onion adresa bola skopírovaná.'); });
  window.linsoftBrowser?.onTorStatus?.(renderTorStatus); window.linsoftBrowser?.getTorStatus?.().then(renderTorStatus).catch(() => {});
  advancedPanel.querySelector('#openTorChatTab').addEventListener('click', openTorChatTab);
  if (createTorChatPanel) {
    const chatPanel = torChatPanel;
    renderTorChatState();
    chatPanel.querySelector('#torChatHost').addEventListener('click', () => createTorChatHostSession(false));
    chatPanel.querySelector('#torChatRenewInvite').addEventListener('click', () => createTorChatHostSession(true));
    chatPanel.querySelector('#torChatScan').addEventListener('click', () => startTorChatQrScanner(chatPanel));
    chatPanel.querySelector('#torChatScannerStop').addEventListener('click', () => stopTorChatQrScanner(chatPanel));
    chatPanel.querySelector('#torChatVideoCall').addEventListener('click', () => torChatUi.videoActive ? stopTorChatVideoCall(chatPanel) : startTorChatVideoCall(chatPanel));
    chatPanel.querySelector('#torChatAttach').addEventListener('click', () => chatPanel.querySelector('#torChatFileInput').click());
    chatPanel.querySelector('#torChatFileInput').addEventListener('change', (event) => sendTorChatFile(event.currentTarget.files?.[0], chatPanel));
  chatPanel.querySelector('#torChatJoin').addEventListener('click', async () => {
    if (torChatUi.busy || torChatUi.role) return;
    const inviteText = chatPanel.querySelector('#torChatInviteInput').value.trim();
    const generation = ++torChatUi.generation;
    torChatUi.busy = true;
    torChatUi.status = 'starting';
    torChatUi.statusMessage = 'Pripájam sa k onion chatu cez Tor...';
    renderTorChatState();
    try {
      const invite = parseTorChatInvitation(inviteText);
      const key = await importTorChatKey(invite.encodedKey);
      const result = await window.linsoftBrowser?.joinTorChat?.({ address: invite.address, token: invite.token });
      if (generation !== torChatUi.generation) return;
      if (!result?.ok) throw new Error(result?.message || 'K onion chatu sa nepodarilo pripojiť.');
      torChatUi.role = 'guest';
      torChatUi.onion = result.onion;
      torChatUi.invite = '';
      torChatUi.inviteQr = '';
      torChatUi.key = key;
      torChatUi.lastId = 0;
      torChatUi.messages = [];
      torChatUi.outgoingFileId = '';
      torChatUi.fileCursor = -1;
      torChatUi.incomingFile = null;
      torChatUi.fileGeneration += 1;
      torChatUi.reconnectAttempts = 0;
      torChatUi.guestConnected = true;
      torChatUi.busy = false;
      torChatUi.status = 'connected';
      torChatUi.statusMessage = 'Pripojené k onion chatu cez Tor. Správy sú šifrované.';
      renderTorChatState();
      scheduleTorChatPoll(0);
      scheduleTorChatFilePoll(0);
    } catch (error) {
      if (generation !== torChatUi.generation) return;
      torChatUi.busy = false;
      torChatUi.status = 'error';
      torChatUi.statusMessage = error instanceof Error ? error.message : 'K onion chatu sa nepodarilo pripojiť.';
      renderTorChatState();
    }
  });
  chatPanel.querySelector('#torChatEnd').addEventListener('click', async () => {
    if (torChatUi.role && !window.confirm(torChatUi.role === 'host' && !torChatUi.guestConnected ? 'Zrušiť pozvánku? Jej odkaz prestane fungovať.' : 'Ukončiť súkromný chat? Správy sa vymažú a spojenie sa zavrie.')) return;
    torChatUi.generation += 1;
    torChatUi.busy = true;
    torChatUi.status = 'stopping';
    torChatUi.statusMessage = 'Ukončujem onion chat...';
    renderTorChatState();
    await stopTorChatVideoCall(chatPanel);
    await window.linsoftBrowser?.stopTorChat?.();
    clearTorChatUi();
    renderTorChatState();
  });
  chatPanel.querySelector('#copyTorChatInvite').addEventListener('click', async () => {
    const result = await window.linsoftBrowser?.writeClipboardText?.(torChatUi.invite);
    showToast(result?.ok ? 'Onion pozvánka bola skopírovaná.' : (result?.message || 'Pozvánku sa nepodarilo skopírovať.'));
  });
  chatPanel.querySelector('#torChatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = chatPanel.querySelector('#torChatMessage');
    const text = input.value.trim();
    if (!text || text.length > 2000 || !torChatUi.role || !torChatUi.key) return;
    const send = chatPanel.querySelector('#torChatSend');
    send.disabled = true;
    try {
      const envelope = await encryptTorChatMessage(text);
      const result = await window.linsoftBrowser?.sendTorChat?.(envelope);
      if (!result?.ok) throw new Error(result?.message || 'Správu sa nepodarilo odoslať cez Tor.');
      input.value = '';
      torChatUi.messages.push({ id: result.id, sender: torChatUi.role, sentAt: Date.now(), text, status: 'sent' });
      if (torChatUi.messages.length > 200) torChatUi.messages.shift();
      renderTorChatMessages();
      await pollTorChatMessages();
    } catch (error) {
      torChatUi.status = 'error';
      torChatUi.statusMessage = error instanceof Error ? error.message : 'Správu sa nepodarilo odoslať.';
      renderTorChatState();
    } finally {
      send.disabled = !torChatUi.role;
      input.focus();
    }
  });
  }
  const downloadFolderRow = downloads.closest('.setting-card'); downloadFolderRow.insertAdjacentHTML('beforeend', `<button class="settings-control" id="chooseDownloadFolder">${settingsState.downloadFolderPath ? 'Zmeniť vlastný priečinok' : 'Vybrať vlastný priečinok'}</button><small class="download-folder-name" id="downloadFolderName">${settingsState.downloadFolderPath ? escapeHtml(settingsState.downloadFolderPath) : 'Používa sa predvolený systémový priečinok.'}</small>`);
  downloads.addEventListener('change', () => { downloads.dataset.clearCustomFolder = String(downloads.value !== settingsState.downloads); surface.querySelector('#downloadFolderName').textContent = downloads.value !== settingsState.downloads ? 'Po uložení sa použije vybraný systémový priečinok.' : settingsState.downloadFolderPath || 'Používa sa predvolený systémový priečinok.'; });
  surface.querySelector('#chooseDownloadFolder').addEventListener('click', async () => { const folder = await window.linsoftBrowser?.selectDownloadFolder?.(); if (!folder) return; settingsState.downloadFolderPath = folder; downloads.dataset.clearCustomFolder = 'false'; surface.querySelector('#downloadFolderName').textContent = folder; surface.querySelector('#chooseDownloadFolder').textContent = 'Zmeniť vlastný priečinok'; saveSettings(); });
  const vpnButton = navigation.querySelector('[data-settings-section="vpn"]'); const vpnPanel = panels.querySelector('[data-settings-panel="vpn"]'); let vpnProfile = settingsState.openvpnProfile || '';
  const showVpnStatus = (data) => { const label = surface.querySelector('#openVpnStatus'); const dot = surface.querySelector('#openVpnDot'); const log = surface.querySelector('#openVpnLog'); if (data.status !== 'log') { if (label) label.textContent = data.message || (data.status === 'connected' ? 'VPN je pripojená.' : data.status === 'connecting' ? 'OpenVPN sa pripája...' : 'VPN je odpojená.'); if (dot) dot.dataset.status = data.status; } if (log && data.message) { log.textContent = `${log.textContent === 'Čaká sa na operáciu...' ? '' : `${log.textContent}\n`}${new Date().toLocaleTimeString()}  ${data.message}`.slice(-4000); log.scrollTop = log.scrollHeight; } };
  showVpnStatus(settingsVpnStatus);
  surface.querySelector('#openVpnProfileName').textContent = vpnProfile ? vpnProfile.split(/[\\/]/).pop() : 'Nie je vybraný žiadny .ovpn súbor.';
  surface.querySelector('#chooseOpenVpn').addEventListener('click', async () => {
    const button = surface.querySelector('#chooseOpenVpn');
    button.disabled = true;
    try {
      const selected = await window.linsoftBrowser?.selectOpenVpnProfile();
      if (!selected) return;
      vpnProfile = selected;
      settingsState.openvpnProfile = vpnProfile;
      document.querySelectorAll('#openVpnProfileName').forEach((el) => { el.textContent = vpnProfile.split(/[\\/]/).pop(); });
      saveSettings();
    } catch (error) {
      console.error('Linsoft Browser could not select OpenVPN profile:', error);
      showToast('Profil OpenVPN sa nepodarilo vybrať.');
    } finally { renderVpnControls(); }
  });
  surface.querySelector('#connectOpenVpn').addEventListener('click', () => {
    if (!settingsState.openvpnProfile || ['connecting', 'connected', 'disconnecting'].includes(settingsVpnStatus.status)) return;
    settingsVpnStatus = { status: 'connecting', message: 'OpenVPN sa pripája...' };
    renderSettingsConnectionOverview();
    window.linsoftBrowser?.connectOpenVpn(settingsState.openvpnProfile);
  });
  surface.querySelector('#disconnectOpenVpn').addEventListener('click', () => {
    if (!['connecting', 'connected'].includes(settingsVpnStatus.status)) return;
    settingsVpnStatus = { status: 'disconnecting', message: 'OpenVPN sa odpája...' };
    renderSettingsConnectionOverview();
    window.linsoftBrowser?.disconnectOpenVpn();
  });
  window.linsoftBrowser?.onOpenVpnStatus(showVpnStatus);
  vpnButton.addEventListener('click', () => { navigation.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === vpnButton)); panels.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel !== vpnPanel; }); });
  ['adBlock', 'trackingProtection', 'askDownload', 'restoreTabs', 'clearExit', 'confirmClose', 'suspendInactiveTabs'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (!toggle) return; toggle.classList.toggle('on', settingsState[key]); toggle.addEventListener('click', () => toggle.classList.toggle('on')); });
  advancedButton.addEventListener('click', () => { navigation.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === advancedButton)); panels.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel !== advancedPanel; }); });
  surface.querySelector('#updateAdblockList').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; button.textContent = 'Aktualizujem...'; const result = await window.linsoftBrowser?.updateAdblockList(); button.disabled = false; button.textContent = 'Aktualizovať'; showToast(result?.ok ? `Zoznam aktualizovaný: ${result.count} domén.` : `Aktualizácia zlyhala: ${result?.message || 'neznáma chyba'}`); });
  surface.querySelector('#clearCacheButton').addEventListener('click', async () => { const result = await window.linsoftBrowser?.clearCache(); showToast(result?.ok ? 'Cache bola vymazaná.' : `Cache sa nepodarilo vymazať: ${result?.message || 'neznáma chyba'}`); });
  surface.querySelector('#saveSettings').addEventListener('click', () => { settingsState.downloads = downloads.value; if (downloads.dataset.clearCustomFolder === 'true') { settingsState.downloadFolderPath = ''; downloads.dataset.clearCustomFolder = 'false'; surface.querySelector('#downloadFolderName').textContent = 'Používa sa predvolený systémový priečinok.'; } settingsState.zoom = zoom.value; ['adBlock', 'trackingProtection', 'askDownload', 'restoreTabs', 'clearExit', 'confirmClose', 'suspendInactiveTabs'].forEach((key) => { const toggle = surface.querySelector(`[data-setting-toggle="${key}"]`); if (toggle) settingsState[key] = toggle.classList.contains('on'); }); saveSettings(); });
}

function navigate(value, addHistory = true, skipTorProxy = false) {
  if (!confirmSettingsDeparture()) return;
  const trimmedInput = value.trim();
  const input = /^[^\s/:]+\.onion(?:\/[^\s]*)?$/i.test(trimmedInput) ? `http://${trimmedInput}` : trimmedInput;
  const navigationTabId = activeTabId;
  if (tabs.get(navigationTabId)?.url === 'linsoft://settings') {
    void stopMediaDeviceTest('Test zariadenia bol zastavený pri opustení nastavení.');
  }
  if (tabs.get(navigationTabId)?.url === 'linsoft://camera' && input.toLowerCase() !== 'linsoft://camera') void stopUsbCameraCapture('Kamera bola pozastavená pri navigácii.');
  pendingTorNavigations.delete(navigationTabId);
  setTabLoading(navigationTabId, false);
  const explicitFile = /^file:\/\//i.test(input);
  let localFileUrl = '';
  if (explicitFile) {
    try {
      const parsedFileUrl = new URL(input);
      if (!/\.(?:html?|pdf)$/i.test(decodeURIComponent(parsedFileUrl.pathname))) throw new Error('Unsupported local file type');
      localFileUrl = parsedFileUrl.href;
    } catch {
      showToast('Otvoriť možno iba platný HTML alebo PDF dokument.');
      return;
    }
  }
  if (!skipTorProxy && /^https?:\/\/[^/]+\.onion(?:\/|$)/i.test(input)) {
    const request = {};
    pendingTorNavigations.set(navigationTabId, request);
    hideNativeTab();
    if (isNativeTabs) window.linsoftBrowser?.destroyNativeTab?.(navigationTabId);
    const surface = getActiveSurface();
    surface.innerHTML = '';
    addressInput.value = input;
    updateActiveTab(input, 'Pripájanie cez Tor');
    showNavigationStatus(navigationTabId, { url: input });
    setTabLoading(navigationTabId, true);
    renderNavigationTorStatus({ proxyStatus: 'connecting', proxyEnabled: false });
    const failTorNavigation = (message) => {
      if (pendingTorNavigations.get(navigationTabId) !== request) return;
      pendingTorNavigations.delete(navigationTabId);
      setTabLoading(navigationTabId, false);
      renderNavigationTorStatus({ proxyStatus: 'error', proxyEnabled: false, proxyMessage: message });
      showNavigationStatus(navigationTabId, { url: input, errorCode: 'TOR_CONNECTION_FAILED', errorDescription: message });
      if (navigationTabId === activeTabId) showToast(message);
    };
    if (!window.linsoftBrowser?.enableTorProxy) {
      failTorNavigation('Tor je dostupný iba v desktopovej aplikácii Linsoft Browser.');
      return;
    }
    window.linsoftBrowser.enableTorProxy().then((result) => {
      if (pendingTorNavigations.get(navigationTabId) !== request) return;
      if (!result?.ok) { failTorNavigation(result?.message || 'Tor proxy sa nepodarilo spustiť.'); return; }
      pendingTorNavigations.delete(navigationTabId);
      renderNavigationTorStatus(result);
      const selectedTabId = activeTabId;
      activeTabId = navigationTabId;
      navigate(input, addHistory, true);
      if (selectedTabId !== navigationTabId) selectTab(selectedTabId);
    }).catch((error) => {
      console.error('Linsoft Browser could not connect to Tor:', error);
      failTorNavigation(`Tor proxy sa nepodarilo spustiť: ${error.message}`);
    });
    return;
  }
  if (input.toLowerCase() === 'linsoft://apps') { hideNativeTab(); openAppCenter(); return; }
  if (input.toLowerCase() === 'linsoft://settings') { hideNativeTab(); openSettings(); return; }
  if (input.toLowerCase() === 'linsoft://tor-chat') { hideNativeTab(); openTorChatPage(); return; }
  if (input.toLowerCase() === 'linsoft://camera') { hideNativeTab(); openUsbCameraPage(); return; }
  if (input.toLowerCase() === 'linsoft://bookmarks') { hideNativeTab(); openLibrary('bookmarks'); return; }
  if (input.toLowerCase() === 'linsoft://history') { hideNativeTab(); openLibrary('history'); return; }
  if (!input || input === 'linsoft://start' || input.toLowerCase() === 'home') { hideNativeTab(); startPage(); return; }
  if (/^(javascript|data|vbscript):/i.test(input)) { showToast('Tento typ adresy je z bezpečnostných dôvodov zablokovaný.'); return; }
  const explicitHttp = /^https?:\/\//i.test(input);
  const networkAddress = normalizeNetworkAddress(input);
  const looksLikeUrl = explicitHttp || explicitFile || networkAddress.isIp || /^[^\s]+\.[^\s]+$/.test(input);
  const requestedUrl = explicitFile ? localFileUrl : looksLikeUrl ? (explicitHttp ? input : networkAddress.isIp ? networkAddress.value : `https://${input}`) : searchUrl(input);
  const url = requestedUrl;
  const currentTab = tabs.get(activeTabId);
  if (addHistory && currentTab) { currentTab.history = currentTab.history || [currentTab.url]; currentTab.history.splice(currentTab.historyIndex + 1); currentTab.history.push(url); currentTab.historyIndex = currentTab.history.length - 1; }
  if (addHistory) {
    let visitHistory = [];
    try { visitHistory = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch { visitHistory = []; }
    visitHistory = [{ url, title: url.replace(/^https?:\/\//, '').split('/')[0], visitedAt: Date.now() }, ...visitHistory.filter((item) => item.url !== url)].slice(0, 200);
    localStorage.setItem('linsoft-history', JSON.stringify(visitHistory));
  }
  addressInput.value = url;
  updateConnectionIndicator(url);
  const tabLabel = url.replace(/^https?:\/\//, '').split('/')[0]; tabTitle.textContent = tabLabel; updateActiveTab(url, tabLabel); saveSession();
  const viewer = window.linsoftBrowser ? `<webview class="webview" src="${escapeHtml(url)}"${isPdfDocumentUrl(url) ? ' plugins' : ''} allowpopups allowfullscreen zoom-factor="${pageZoomForUrl(url) / 100}"></webview>` : `<iframe class="webview" src="${escapeHtml(url)}" title="Web page" allowfullscreen></iframe>`;
  let surface = content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"]`);
  if (!surface) { surface = document.createElement('div'); surface.className = 'tab-surface'; surface.dataset.tabId = activeTabId; content.appendChild(surface); }
  if (isNativeTabs) {
    surface.innerHTML = '<div class="native-view-placeholder" aria-hidden="true"></div>';
    showNavigationStatus(activeTabId, { url });
    setTabLoading(activeTabId, true);
    activateSurface(activeTabId);
    syncNativeTabLayout();
    window.linsoftBrowser?.loadNativeTab?.({ tabId: activeTabId, url, muted: tabs.get(activeTabId)?.muted === true });
    return;
  }
  if (!window.linsoftBrowser && /^https?:\/\//i.test(url)) { showExternalPreview(surface, url); return; }
  const existingViewer = surface.querySelector('.webview');
  const pdfPluginMode = Boolean(window.linsoftBrowser && isPdfDocumentUrl(url));
  if (!existingViewer) surface.innerHTML = viewer;
  else if (existingViewer.tagName === 'WEBVIEW' && existingViewer.hasAttribute('plugins') !== pdfPluginMode) {
    existingViewer.remove();
    surface.insertAdjacentHTML('beforeend', viewer);
  } else existingViewer.src = url;
  activateSurface(activeTabId);
  if (window.linsoftBrowser) {
    showNavigationStatus(activeTabId, { url });
    setTabLoading(activeTabId, true);
  }
  const activeViewer = surface.querySelector('webview');
  const activeTab = tabs.get(activeTabId);
  if (activeViewer?.setAudioMuted && activeTab?.muted) activeViewer.setAudioMuted(true);
  if (activeViewer && !boundViewers.has(activeViewer)) {
    const viewerTabId = activeTabId;
    boundViewers.add(activeViewer);
    const loadingTrack = document.getElementById('loadingTrack');
    activeViewer.addEventListener('did-start-navigation', (event) => { if (event.isMainFrame && !event.isInPlace) showNavigationStatus(viewerTabId, { url: event.url }); });
    activeViewer.addEventListener('did-start-loading', () => { beginPageLoadMeasurement(viewerTabId, activeViewer.getURL?.() || tabs.get(viewerTabId)?.url); if (viewerTabId === activeTabId) { loadingTrack.classList.add('loading'); document.getElementById('securityButton').classList.add('address-loading'); } setTabLoading(viewerTabId, true); });
    activeViewer.addEventListener('media-started-playing', () => setTabAudioIcon(viewerTabId, tabs.get(viewerTabId)?.muted, true));
    activeViewer.addEventListener('media-paused', () => setTabAudioIcon(viewerTabId, tabs.get(viewerTabId)?.muted, false));
    activeViewer.addEventListener('did-stop-loading', () => { finishPageLoadMeasurement(viewerTabId); clearNavigationStatus(viewerTabId); if (viewerTabId === activeTabId) { loadingTrack.classList.remove('loading'); document.getElementById('securityButton').classList.remove('address-loading'); } setTabLoading(viewerTabId, false); const tab = tabs.get(viewerTabId); if (tab) setTabIcon(viewerTabId, tab.icon || defaultWebsiteFaviconUrl(activeViewer.getURL?.() || tab.url)); updateWebviewTabFavicon(viewerTabId, activeViewer); });
    activeViewer.addEventListener('render-process-gone', () => { const tab = tabs.get(viewerTabId); if (tab) { setTabLoading(viewerTabId, false); tab.crashed = true; saveSession(); showToast('Karta sa neočakávane ukončila. Klikni na kartu pre obnovenie.'); } });
    activeViewer.addEventListener('dom-ready', () => {
      activeViewer.dataset.domReady = 'true';
      clearNavigationStatus(viewerTabId);
      activeViewer.insertCSS('*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }').catch(() => {});
      setInstallAppAvailable(/^https?:\/\//i.test(activeViewer.getURL?.() || addressInput.value));
      bindPasswordSavePrompt(activeViewer, activeViewer.getURL?.() || addressInput.value);
    });
    activeViewer.addEventListener('dom-ready', () => window.setTimeout(() => installYoutubeAdBlock(activeViewer), 350));
    activeViewer.addEventListener('dom-ready', () => installOverlayCloseFallback(activeViewer));
    activeViewer.addEventListener('did-navigate', (event) => applyTabZoom(viewerTabId, event.url));
    activeViewer.addEventListener('did-navigate', (event) => { const label = event.url.replace(/^https?:\/\//, '').split('/')[0]; const tab = tabs.get(viewerTabId); if (!tab) return; tab.url = event.url; tab.title = label; tab.history = tab.history || [event.url]; const knownIndex = tab.history.indexOf(event.url); if (knownIndex >= 0) tab.historyIndex = knownIndex; else { tab.history.splice(tab.historyIndex + 1); tab.history.push(event.url); tab.historyIndex = tab.history.length - 1; } if (viewerTabId === activeTabId) { addressInput.value = event.url; tabTitle.textContent = label; updateActiveTab(event.url, label); updateConnectionIndicator(event.url); } tab.icon = defaultWebsiteFaviconUrl(event.url); setTabIcon(viewerTabId, tab.icon); saveSession(); });
    activeViewer.addEventListener('did-navigate-in-page', (event) => { const url = event.url; const label = url.replace(/^https?:\/\//, '').split('/')[0]; const tab = tabs.get(viewerTabId); if (!tab || !url) return; tab.url = url; tab.title = label; tab.history = tab.history || [url]; const knownIndex = tab.history.indexOf(url); if (knownIndex >= 0) tab.historyIndex = knownIndex; else { tab.history.splice(tab.historyIndex + 1); tab.history.push(url); tab.historyIndex = tab.history.length - 1; } if (viewerTabId === activeTabId) { addressInput.value = url; tabTitle.textContent = label; updateActiveTab(url, label); updateConnectionIndicator(url); } saveSession(); });
    activeViewer.addEventListener('page-favicon-updated', (event) => { const iconUrl = event.favicons?.[0] || ''; const tab = tabs.get(viewerTabId); if (tab) tab.icon = iconUrl; setTabIcon(viewerTabId, iconUrl); saveSession(); });
    activeViewer.addEventListener('page-title-updated', (event) => { const tab = tabs.get(viewerTabId); if (event.title && tab) { tab.title = event.title; if (viewerTabId === activeTabId) { tabTitle.textContent = event.title; updateActiveTab(tab.url, event.title); } saveSession(); } });
    activeViewer.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3 || event.isMainFrame === false) return;
      const failedUrl = event.validatedURL || activeViewer.getURL?.() || '';
      const fallbackUrl = httpFallbackForTlsError(event.errorCode, failedUrl) || httpsFallbackForIpConnectionRefused(event.errorCode, failedUrl);
      if (fallbackUrl) {
        const tab = tabs.get(viewerTabId);
        if (tab) { replaceFailedUrlInTabHistory(tab, failedUrl, fallbackUrl); saveSession(); }
        if (viewerTabId === activeTabId) {
          addressInput.value = fallbackUrl;
          updateConnectionIndicator(fallbackUrl);
          showToast(fallbackUrl.startsWith('https:') ? 'HTTP pripojenie odmietnuté; skúšam HTTPS.' : [-200, -201, -202].includes(Number(event.errorCode)) ? 'Certifikát súkromnej IP adresy nie je dôveryhodný; skúšam HTTP.' : 'Web nepodporuje HTTPS; otváram nezabezpečené HTTP pripojenie.');
        }
        activeViewer.src = fallbackUrl;
        return;
      }
      showNavigationStatus(viewerTabId, { url: failedUrl, errorCode: event.errorCode, errorDescription: event.errorDescription });
      setTabLoading(viewerTabId, false);
      if (viewerTabId === activeTabId) showToast(navigationErrorMessage(event.errorCode, event.errorDescription));
    });
  }
}

const addressSuggestions = document.getElementById('addressSuggestions');
let addressSuggestionItems = [];
let activeAddressSuggestion = -1;
let currentAddressSuggestionQuery = '';
function closeAddressSuggestions() {
  addressSuggestions.hidden = true;
  addressInput.setAttribute('aria-expanded', 'false');
  addressInput.removeAttribute('aria-activedescendant');
  activeAddressSuggestion = -1;
}
function renderAddressSuggestions(queryOverride) {
  if (isGuestWindow) return closeAddressSuggestions();
  const query = normalizeBrowserSearch(queryOverride ?? addressInput.value).trim();
  currentAddressSuggestionQuery = query;
  activeAddressSuggestion = -1;
  addressInput.removeAttribute('aria-activedescendant');
  let history = [];
  try { history = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch {}
  const historyItems = (Array.isArray(history) ? history : [])
    .filter((item) => { try { return item && typeof item.url === 'string' && ['http:', 'https:'].includes(new URL(item.url).protocol); } catch { return false; } });
  const candidates = new Map();
  savedBookmarks.forEach((bookmark) => {
    try {
      if (!['http:', 'https:'].includes(new URL(bookmark.url).protocol)) return;
      candidates.set(bookmark.url, { ...bookmark, source: 'bookmark', hasHistory: false, visitedAt: 0 });
    } catch {}
  });
  historyItems.forEach((item) => {
    const bookmark = candidates.get(item.url);
    candidates.set(item.url, { ...item, title: bookmark?.title || item.title || item.url, source: bookmark ? 'bookmark' : 'history', hasHistory: true, visitedAt: Number(item.visitedAt) || 0 });
  });
  tabs.forEach((tab) => {
    try {
      if (!['http:', 'https:'].includes(new URL(tab.url).protocol)) return;
      const previous = candidates.get(tab.url);
      candidates.set(tab.url, { ...previous, ...tab, source: 'tab', hasHistory: Boolean(previous?.hasHistory), visitedAt: Number(previous?.visitedAt) || 0 });
    } catch {}
  });
  const queryParts = query.split(/\s+/).filter(Boolean);
  const matchScore = (item) => {
    if (!query) return item.source === 'bookmark' ? 0 : 1;
    const title = normalizeBrowserSearch(item.title);
    const url = normalizeBrowserSearch(item.url);
    const hostname = normalizeBrowserSearch(new URL(item.url).hostname);
    if (url === query) return 0;
    if (hostname === query) return 1;
    if (title === query) return 2;
    if (item.source === 'tab') return 3;
    if (item.source === 'bookmark') return 4;
    if (hostname.startsWith(query)) return 5;
    if (title.startsWith(query)) return 6;
    if (url.startsWith(query)) return 7;
    return 8;
  };
  addressSuggestionItems = [...candidates.values()]
    .filter((item) => {
      const searchable = normalizeBrowserSearch(`${item.title || ''} ${item.url} ${new URL(item.url).hostname}`);
      return queryParts.every((part) => searchable.includes(part));
    })
    .sort((left, right) => matchScore(left) - matchScore(right) || Number(right.visitedAt) - Number(left.visitedAt))
    .slice(0, 6);
  const clearButton = historyItems.length ? '<button type="button" data-clear-address-history>Vymazať</button>' : '';
  const emptyState = query ? 'Nenašli sa žiadne zodpovedajúce stránky.' : 'Zatiaľ tu nie sú žiadne návštevy ani záložky.';
  const resultMarkup = addressSuggestionItems.length ? addressSuggestionItems.map((item, index) => {
    const title = String(item.title || item.url);
    const hostname = new URL(item.url).hostname;
    const favicon = bookmarkFaviconUrl(item.url);
    const historyLabel = `${hostname} · ${item.source === 'tab' ? 'Otvorená karta' : item.source === 'bookmark' ? 'Záložka' : 'História'}`;
    const removeButton = item.hasHistory ? `<button type="button" class="address-suggestion-remove" data-remove-address-suggestion="${index}" aria-label="Odstrániť z histórie: ${escapeHtml(title)}" title="Odstrániť z histórie"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-x"></use></svg></button>` : '';
    return `<div class="address-suggestion-row"><button type="button" role="option" id="address-suggestion-${index}" aria-selected="false" data-address-suggestion="${index}"><span class="address-suggestion-icon">${favicon ? `<img src="${escapeHtml(favicon)}" alt="">` : escapeHtml(title.slice(0, 1).toUpperCase())}</span><span class="address-suggestion-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(historyLabel)}</small></span></button>${removeButton}</div>`;
  }).join('') : `<div class="address-suggestions-empty">${emptyState}</div>${query ? '<button type="button" class="address-suggestions-search" data-search-address-query>Hľadať zadaný výraz</button>' : '<button type="button" class="address-suggestions-open-history" data-open-address-history>Otvoriť históriu</button>'}`;
  addressSuggestions.innerHTML = `<div class="address-suggestions-heading"><span>${query ? `Nájdené stránky: ${addressSuggestionItems.length}` : 'Záložky a posledné stránky'}</span>${clearButton}</div>${resultMarkup}<div class="address-suggestions-help"><kbd>↑ ↓</kbd> vybrať <kbd>Enter</kbd> otvoriť <kbd>Esc</kbd> zavrieť</div>`;
  const rect = document.getElementById('addressForm').getBoundingClientRect();
  const width = Math.min(Math.max(220, rect.width), window.innerWidth - 16);
  addressSuggestions.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  addressSuggestions.style.top = `${rect.bottom + 6}px`;
  addressSuggestions.style.width = `${width}px`;
  addressSuggestions.hidden = false;
  addressInput.setAttribute('aria-expanded', 'true');
  const clearHistoryButton = addressSuggestions.querySelector('[data-clear-address-history]');
  clearHistoryButton?.addEventListener('mousedown', (event) => event.preventDefault());
  clearHistoryButton?.addEventListener('click', () => {
    localStorage.removeItem('linsoft-history');
    addressSuggestionItems = [];
    closeAddressSuggestions();
    showToast('História bola vymazaná.', 'Vrátiť späť', () => restoreAddressHistory(historyItems, 0));
  });
  const openHistoryButton = addressSuggestions.querySelector('[data-open-address-history]');
  openHistoryButton?.addEventListener('mousedown', (event) => event.preventDefault());
  openHistoryButton?.addEventListener('click', () => { closeAddressSuggestions(); openLibrary('history'); });
  const searchQueryButton = addressSuggestions.querySelector('[data-search-address-query]');
  searchQueryButton?.addEventListener('mousedown', (event) => event.preventDefault());
  searchQueryButton?.addEventListener('click', () => { closeAddressSuggestions(); navigate(query); });
  addressSuggestions.querySelectorAll('[data-remove-address-suggestion]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = addressSuggestionItems[Number(button.dataset.removeAddressSuggestion)];
      if (!item) return;
      let history = [];
      try { history = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch {}
      const historyItems = Array.isArray(history) ? history : [];
      const historyIndex = historyItems.findIndex((entry) => entry?.url === item.url);
      localStorage.setItem('linsoft-history', JSON.stringify(historyItems.filter((entry) => entry?.url !== item.url)));
      const previousHistory = historyIndex >= 0 ? [historyItems[historyIndex]] : [];
      showToast('Návšteva odstránená z histórie.', 'Vrátiť späť', () => restoreAddressHistory(previousHistory, historyIndex));
      renderAddressSuggestions(currentAddressSuggestionQuery);
    });
  });
  addressSuggestions.querySelectorAll('[data-address-suggestion]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      const item = addressSuggestionItems[Number(button.dataset.addressSuggestion)];
      closeAddressSuggestions();
      if (item?.source === 'tab' && tabs.has(item.id)) selectTab(item.id);
      else if (item) navigate(item.url);
    });
    button.querySelector('img')?.addEventListener('error', (event) => {
      const fallback = document.createElement('span');
      fallback.textContent = String(button.querySelector('strong')?.textContent || '?').slice(0, 1).toUpperCase();
      event.currentTarget.replaceWith(fallback);
    });
  });
}
function restoreAddressHistory(entries, insertAt) {
  let currentHistory = [];
  try { currentHistory = JSON.parse(localStorage.getItem('linsoft-history') || '[]'); } catch {}
  const restoredUrls = new Set(entries.map((item) => item.url));
  const restoredHistory = (Array.isArray(currentHistory) ? currentHistory : []).filter((item) => !restoredUrls.has(item.url));
  entries.forEach((item, index) => restoredHistory.splice(Math.min((insertAt ?? index) + index, restoredHistory.length), 0, item));
  localStorage.setItem('linsoft-history', JSON.stringify(restoredHistory.slice(0, 200)));
  renderAddressSuggestions(currentAddressSuggestionQuery);
}
function setActiveAddressSuggestion(index) {
  if (!addressSuggestionItems.length) return;
  activeAddressSuggestion = (index + addressSuggestionItems.length) % addressSuggestionItems.length;
  addressSuggestions.querySelectorAll('[data-address-suggestion]').forEach((button, buttonIndex) => {
    button.setAttribute('aria-selected', String(buttonIndex === activeAddressSuggestion));
  });
  addressInput.setAttribute('aria-activedescendant', `address-suggestion-${activeAddressSuggestion}`);
}
document.getElementById('addressForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const item = addressSuggestionItems[activeAddressSuggestion];
  closeAddressSuggestions();
  navigate(item?.url || addressInput.value);
});
addressInput.addEventListener('focus', () => { addressInput.select(); renderAddressSuggestions(''); });
addressInput.addEventListener('input', renderAddressSuggestions);
addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && !addressSuggestions.hidden) { event.preventDefault(); setActiveAddressSuggestion(activeAddressSuggestion + 1); }
  else if (event.key === 'ArrowUp' && !addressSuggestions.hidden) { event.preventDefault(); setActiveAddressSuggestion(activeAddressSuggestion < 0 ? addressSuggestionItems.length - 1 : activeAddressSuggestion - 1); }
  else if (event.key === 'Escape' && !addressSuggestions.hidden) { event.preventDefault(); closeAddressSuggestions(); }
});
addressInput.addEventListener('blur', () => window.setTimeout(() => { if (document.activeElement !== addressInput) closeAddressSuggestions(); }, 120));
document.getElementById('clearAddress').addEventListener('click', () => { addressInput.value = ''; addressInput.focus(); renderAddressSuggestions(); });
document.getElementById('installAppButton').addEventListener('click', installCurrentApp);
document.getElementById('cancelInstall').addEventListener('click', closeInstallDialog); document.getElementById('cancelInstallButton').addEventListener('click', closeInstallDialog); document.getElementById('confirmInstall').addEventListener('click', async () => { const button = document.getElementById('confirmInstall'); const url = addressInput.value; const title = tabTitle.textContent; button.disabled = true; const result = await window.linsoftBrowser?.installWebApp(url, title); button.disabled = false; closeInstallDialog(); if (!result?.ok) return showToast(result?.message || 'Webovú aplikáciu sa nepodarilo nainštalovať.'); const existing = installedApps.find((item) => item.url === url); if (existing) existing.title = title; else installedApps.push({ url, title, installedAt: Date.now() }); localStorage.setItem('linsoft-apps', JSON.stringify(installedApps)); showToast('Aplikácia bola pridaná do Linsoft App Centra.'); openAppCenter(); });
const securityPanel = document.getElementById('securityPanel'); const publicIp = document.getElementById('publicIp'); const publicNetwork = document.getElementById('publicNetwork'); const ipNote = document.getElementById('ipNote'); let ipLoaded = false;
document.getElementById('securityButton').addEventListener('click', async (event) => { event.preventDefault(); event.stopPropagation(); securityPanel.hidden = !securityPanel.hidden; if (securityPanel.hidden) return; positionSecurityPanel(); if (ipLoaded) return; publicIp.textContent = 'Načítavam...'; publicNetwork.textContent = 'Načítavam...'; const endpoints = [{ url: 'https://ipapi.co/json/', parse: (data) => ({ ip: data.ip, network: `${data.org || 'Neznáma sieť'} · ${data.country_name || 'Neznáma krajina'}` }) }, { url: 'https://ipwho.is/', parse: (data) => ({ ip: data.ip, network: `${data.connection?.isp || 'Neznáma sieť'} · ${data.country || 'Neznáma krajina'}` }) }, { url: 'https://api.ipify.org?format=json', parse: (data) => ({ ip: data.ip, network: 'Sieť a krajina nie sú dostupné' }) }]; let lastError = 'IP služby neodpovedali'; for (const endpoint of endpoints) { try { const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 7000); const response = await fetch(endpoint.url, { cache: 'no-store', signal: controller.signal }); window.clearTimeout(timeout); if (!response.ok) throw new Error(`HTTP ${response.status}`); const result = endpoint.parse(await response.json()); if (!result.ip) throw new Error('Prázdna odpoveď'); publicIp.textContent = result.ip; publicNetwork.textContent = result.network; ipNote.textContent = 'Verejná IP podľa aktuálneho internetového pripojenia.'; ipLoaded = true; return; } catch (error) { lastError = error.name === 'AbortError' ? 'Časový limit vypršal' : error.message; } } publicIp.textContent = 'Nepodarilo sa načítať'; publicNetwork.textContent = 'Neznáme'; ipNote.textContent = `${lastError}. Skontroluj internet, VPN alebo firewall a skús znova.`; }); document.getElementById('closeSecurity').addEventListener('click', () => { securityPanel.hidden = true; }); securityPanel.addEventListener('click', (event) => event.stopPropagation()); document.addEventListener('click', () => { securityPanel.hidden = true; });
async function refreshCurrentSitePrivacy() {
  const permissions = document.getElementById('currentSitePermissions');
  const clearButton = document.getElementById('clearCurrentSiteData');
  let origin = '';
  try {
    const url = new URL(tabs.get(activeTabId)?.url || addressInput.value);
    if (['http:', 'https:'].includes(url.protocol)) origin = url.origin;
  } catch {}
  clearButton.disabled = !origin || isGuestWindow;
  if (!origin) {
    permissions.textContent = 'Dostupné iba pre otvorenú stránku HTTP alebo HTTPS.';
    return;
  }
  const listSitePermissions = window.linsoftBrowser?.listSitePermissions;
  if (typeof listSitePermissions !== 'function') {
    permissions.textContent = 'Prehľad povolení nie je dostupný.';
    return;
  }
  let entries;
  try {
    entries = await listSitePermissions();
  } catch (error) {
    permissions.textContent = 'Povolenia sa nepodarilo načítať.';
    showToast(error instanceof Error ? error.message : 'Povolenia sa nepodarilo načítať.');
    return;
  }
  const matching = entries.filter((entry) => entry.origin === origin);
  permissions.textContent = matching.length
    ? matching.map((entry) => `${entry.permission}: ${entry.decision === 'allow' ? 'povolené' : 'blokované'}`).join(' · ')
    : 'Tento web zatiaľ nemá uložené povolenia.';
}
document.getElementById('securityButton').addEventListener('click', () => { if (!securityPanel.hidden) void refreshCurrentSitePrivacy(); });
document.getElementById('clearCurrentSiteData').addEventListener('click', async (event) => {
  let origin = '';
  try {
    const url = new URL(tabs.get(activeTabId)?.url || addressInput.value);
    if (['http:', 'https:'].includes(url.protocol)) origin = url.origin;
  } catch {}
  if (!origin) return showToast('Údaje možno vymazať iba pre stránku HTTP alebo HTTPS.');
  if (!window.confirm(`Naozaj vymazať cookies, úložisko a uložené povolenia pre ${origin}?`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const viewer = activeViewer();
    const result = await window.linsoftBrowser?.clearActiveSiteData?.(viewer?.getWebContentsId?.());
    if (!result?.ok) return showToast(result?.message || 'Údaje webu sa nepodarilo vymazať.');
    await refreshCurrentSitePrivacy();
    showToast(`Cookies, údaje a povolenia pre ${result.origin} boli vymazané.`);
  } catch (error) {
    console.error('Linsoft Browser could not clear active site data:', error);
    showToast(error instanceof Error ? error.message : 'Údaje webu sa nepodarilo vymazať.');
  } finally {
    button.disabled = false;
  }
});
async function activeEditCommand(command, fromContextMenu = false) {
  const viewer = ensureActiveTabLoaded();
  if (isNativeTabs) {
    const result = await window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command, fromContextMenu });
    if (result?.ok && command === 'paste' && fromContextMenu) showToast('Vloženie bolo odoslané.');
    else if (!result?.ok) showToast(result?.message || 'Táto akcia nie je dostupná na tejto stránke.');
    return;
  }
  const webContentsId = viewer?.getWebContentsId?.();
  const result = webContentsId ? await window.linsoftBrowser?.editCommand?.(webContentsId, command) : null;
  if (result?.ok) { if (command === 'paste' && fromContextMenu) showToast('Vloženie bolo odoslané.'); return; }
  if (command === 'paste' && fromContextMenu) { showToast(result?.message || 'Vloženie zlyhalo. Klikni najprv do textového poľa.'); return; }
  if (viewer && typeof viewer[command] === 'function') { viewer[command](); return; }
  if (viewer?.executeJavaScript && ['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'].includes(command)) {
    try { await viewer.executeJavaScript(`document.execCommand(${JSON.stringify(command)})`); return; } catch {}
  }
  showToast(result?.message || 'Táto akcia nie je dostupná na tejto stránke.');
}
function findOnPage() {
  const viewer = ensureActiveTabLoaded();
  if (!viewer?.findInPage) return showToast('Vyhľadávanie nie je dostupné na tejto stránke.');
  const query = window.prompt('Hľadať na stránke:');
  if (query) viewer.findInPage(query);
}
function changePageZoom(delta) {
  const tab = tabs.get(activeTabId);
  const url = tab?.url || addressInput.value;
  const origin = zoomOriginForUrl(url);
  if (!origin) return showToast('Priblíženie je dostupné iba na webových stránkach.');
  const zoom = Math.max(50, Math.min(200, pageZoomForUrl(url) + delta));
  siteZooms[origin] = zoom;
  localStorage.setItem('linsoft-site-zooms', JSON.stringify(siteZooms));
  applyTabZoom(activeTabId, url);
  showToast(`Priblíženie pre ${new URL(origin).hostname}: ${zoom} %`);
}
function resetPageZoom() {
  const tab = tabs.get(activeTabId);
  const url = tab?.url || addressInput.value;
  const origin = zoomOriginForUrl(url);
  if (!origin) return showToast('Priblíženie je dostupné iba na webových stránkach.');
  delete siteZooms[origin];
  localStorage.setItem('linsoft-site-zooms', JSON.stringify(siteZooms));
  applyTabZoom(activeTabId, url);
  showToast(`Predvolené priblíženie pre ${new URL(origin).hostname}: ${pageZoomForUrl(url)} %`);
}
function printCurrentPage() { const viewer = ensureActiveTabLoaded(); if (!viewer?.print) return showToast('Tlač nie je dostupná na tejto stránke.'); viewer.print(); }
async function toggleReaderMode() {
  const viewer = ensureActiveTabLoaded();
  if (!viewer?.executeJavaScript) return showToast('Čitateľský režim nie je dostupný na tejto stránke.');
  await viewer.executeJavaScript(`(() => { const existing = document.getElementById('linsoft-reader-mode'); if (existing) { existing.remove(); return false; } const style = document.createElement('style'); style.id = 'linsoft-reader-mode'; style.textContent = 'body { background: #f7f3ea !important; color: #252525 !important; } body > * { max-width: 760px !important; margin-left: auto !important; margin-right: auto !important; } nav, header, aside, footer, [role="banner"], [role="navigation"], [role="complementary"], .ad, .ads, .advert, [class*="advert" i], [id*="advert" i] { display: none !important; } p, li { font-size: 18px !important; line-height: 1.75 !important; }'; document.head.appendChild(style); return true; })()`).then((enabled) => showToast(enabled ? 'Čitateľský režim zapnutý.' : 'Čitateľský režim vypnutý.')).catch(() => showToast('Čitateľský režim sa nedá použiť na tejto stránke.'));
}
async function saveCurrentPagePdf() { const viewer = ensureActiveTabLoaded(); const webContentsId = viewer?.getWebContentsId?.(); if (!webContentsId) return showToast('PDF nie je dostupné na tejto stránke.'); const result = await window.linsoftBrowser?.savePagePdf?.(webContentsId); if (result?.ok) showToast('Stránka bola uložená ako PDF.'); else if (!result?.canceled) showToast(result?.message || 'PDF sa nepodarilo uložiť.'); }
async function captureCurrentPage() { const viewer = ensureActiveTabLoaded(); const webContentsId = viewer?.getWebContentsId?.(); if (!webContentsId) return showToast('Snímka nie je dostupná na tejto stránke.'); const result = await window.linsoftBrowser?.capturePage?.(webContentsId); if (result?.ok) showToast('Snímka webu bola uložená.'); else if (!result?.canceled) showToast(result?.message || 'Snímku sa nepodarilo uložiť.'); }
async function copyCurrentPageScreenshot() { const viewer = ensureActiveTabLoaded(); const webContentsId = viewer?.getWebContentsId?.(); if (!webContentsId) return showToast('Snímka nie je dostupná na tejto stránke.'); const result = await window.linsoftBrowser?.capturePageToClipboard?.(webContentsId); showToast(result?.ok ? 'Snímka bola skopírovaná do schránky.' : (result?.message || 'Snímku sa nepodarilo skopírovať.')); }
window.linsoftBrowser?.onWebviewContextMenu?.((data) => {
  document.querySelector('.webview-context-menu')?.closeContextMenu?.();
  document.querySelector('.webview-context-menu')?.remove();
  const dismissLayer = document.createElement('div');
  dismissLayer.className = 'context-menu-dismiss-layer';
  const menu = document.createElement('div');
  menu.className = 'webview-context-menu';
  menu.setAttribute('role', 'menu');
  const viewer = activeViewer();
  const hasSelection = Boolean(data.selectionText);
  const hasLink = /^https?:\/\//i.test(data.linkURL || '');
  const hasImage = data.mediaType === 'image' && /^https?:\/\//i.test(data.srcURL || '');
  let selectedUrl = '';
  try {
    const parsedSelection = new URL(String(data.selectionText || '').trim());
    if (parsedSelection.protocol === 'http:' || parsedSelection.protocol === 'https:') selectedUrl = parsedSelection.href;
  } catch {}
  const actions = [
    ['paste', 'clipboard-paste', 'Vložiť', false, 'Ctrl+V'], ['copy', 'copy', 'Kopírovať', false, 'Ctrl+C'], ['cut', 'scissors', 'Vystrihnúť', !data.isEditable, 'Ctrl+X'], ['divider'],
    ['search', 'search', 'Vyhľadať výber', !hasSelection], ['translate', 'languages', 'Preložiť výber', !hasSelection], ['translate-page', 'languages', 'Preložiť stránku do slovenčiny']
  ];
  if (selectedUrl) actions.push(['divider'], ['open-selected-url', 'external-link', 'Otvoriť adresu vo výbere v novej karte'], ['open-selected-url-background', 'external-link', 'Otvoriť adresu vo výbere na pozadí']);
  if (hasLink) actions.push(['divider'], ['open-link', 'external-link', 'Otvoriť odkaz v novej karte'], ['open-link-background', 'external-link', 'Otvoriť odkaz na pozadí'], ['open-window', 'layout-grid', 'Otvoriť odkaz v novom okne'], ['copy-link', 'link', 'Kopírovať adresu odkazu']);
  if (hasImage) actions.push(['divider'], ['open-image', 'image', 'Otvoriť obrázok v novej karte'], ['save-image', 'download', 'Uložiť obrázok'], ['copy-image', 'image', 'Kopírovať obrázok'], ['copy-image-url', 'link', 'Kopírovať adresu obrázka']);
  actions.push(['divider'], ['view-source', 'file-code', 'Zobraziť HTML kód stránky'], ['bookmark-page', 'bookmark', 'Pridať medzi záložky', false, 'Ctrl+D'], ['copy-page', 'link', 'Kopírovať adresu stránky'], ['open-page-tab', 'plus', 'Otvoriť stránku v novej karte'], ['screenshot', 'camera', 'Urobiť snímku webu'], ['copy-screenshot', 'camera', 'Kopírovať snímku'], ['divider'], ['back', 'arrow-left', 'Späť', !viewerCanNavigate(viewer, -1)], ['forward', 'arrow-right', 'Dopredu', !viewerCanNavigate(viewer, 1)], ['reload', 'rotate-cw', 'Obnoviť', false, 'Ctrl+R'], ['print', 'printer', 'Tlačiť', false, 'Ctrl+P']);
  menu.innerHTML = actions.map((entry) => entry[0] === 'divider' ? '<div class="context-menu-divider" role="separator"></div>' : `<button role="menuitem" data-context-action="${entry[0]}"${entry[3] ? ' disabled' : ''}><svg class="context-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${entry[1]}"></use></svg>${entry[2]}${entry[4] ? `<kbd>${entry[4]}</kbd>` : ''}</button>`).join('');
  document.body.appendChild(dismissLayer);
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(Math.max(8, Number(data.x) || 8), Math.max(8, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(Math.max(80, Number(data.y) || 80), Math.max(80, window.innerHeight - menu.offsetHeight - 8))}px`;
  const closeMenu = () => {
    dismissLayer.remove();
    menu.remove();
    document.removeEventListener('pointerdown', closeFromOutside, true);
    document.removeEventListener('click', closeFromOutside, true);
    document.removeEventListener('keydown', closeFromEscape, true);
  };
  menu.closeContextMenu = closeMenu;
  dismissLayer.addEventListener('pointerdown', closeMenu, { once: true });
  dismissLayer.addEventListener('click', closeMenu, { once: true });
  const closeFromOutside = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
  const closeFromEscape = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('click', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  menu.addEventListener('keydown', (event) => {
    const enabledButtons = [...menu.querySelectorAll('button:not(:disabled)')];
    const currentIndex = enabledButtons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      enabledButtons[(currentIndex + direction + enabledButtons.length) % enabledButtons.length]?.focus();
    }
  });
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if (!action) return;
    closeMenu();
    if (action === 'paste') await activeEditCommand('paste', true);
    if (action === 'cut') await activeEditCommand('cut');
    if (action === 'copy') {
      const result = await window.linsoftBrowser?.copyClipboardSelection?.(data.selectionText);
      showToast(result?.ok ? 'Text bol skopírovaný.' : (result?.message || 'Text sa nepodarilo skopírovať.'));
    }
    if (action === 'search' && data.selectionText) navigate(searchUrl(data.selectionText));
    if (action === 'translate' && data.selectionText) openNewTab(`https://translate.google.com/?sl=auto&tl=sk&text=${encodeURIComponent(data.selectionText)}&op=translate`);
    if (action === 'translate-page') translateWebPage(data.pageURL || tabs.get(activeTabId)?.url || addressInput.value);
    if (action === 'open-selected-url' && selectedUrl) openNewTab(selectedUrl);
    if (action === 'open-selected-url-background' && selectedUrl) openBackgroundTab(selectedUrl);
    if (action === 'open-link' && data.linkURL) openNewTab(data.linkURL);
    if (action === 'open-link-background' && data.linkURL) openBackgroundTab(data.linkURL);
    if (action === 'open-window' && data.linkURL) window.linsoftBrowser?.openBrowserWindow?.(data.linkURL);
    if (action === 'copy-link') { const result = await window.linsoftBrowser?.writeClipboardText?.(data.linkURL); showToast(result?.ok ? 'Adresa odkazu bola skopírovaná.' : (result?.message || 'Adresu odkazu sa nepodarilo skopírovať.')); }
    if (action === 'open-image' && data.srcURL) openNewTab(data.srcURL);
    if (action === 'save-image' && data.srcURL) { activeViewer()?.downloadURL?.(data.srcURL); showToast('Obrázok sa pridáva do sťahovaní.'); }
    if (action === 'copy-image' && data.srcURL) { const result = await window.linsoftBrowser?.writeClipboardImage?.(data.srcURL); if (result?.ok) showToast('Obrázok bol skopírovaný.'); else showToast(result?.message || 'Obrázok sa nepodarilo skopírovať.'); }
    if (action === 'copy-image-url' && data.srcURL) { const result = await window.linsoftBrowser?.writeClipboardText?.(data.srcURL); showToast(result?.ok ? 'Adresa obrázka bola skopírovaná.' : (result?.message || 'Adresu obrázka sa nepodarilo skopírovať.')); }
    if (action === 'bookmark-page') document.getElementById('bookmarkButton').click();
    if (action === 'copy-page') { const result = await window.linsoftBrowser?.writeClipboardText?.(addressInput.value); showToast(result?.ok ? 'Adresa stránky bola skopírovaná.' : (result?.message || 'Adresu stránky sa nepodarilo skopírovať.')); }
    if (action === 'view-source') await showPageSourcePreview();
    if (action === 'open-page-tab') openNewTab(addressInput.value);
    if (action === 'back') navigateTabHistory(-1);
    if (action === 'forward') navigateTabHistory(1);
    if (action === 'reload') document.getElementById('reloadButton').click();
    if (action === 'print') printCurrentPage();
    if (action === 'screenshot') captureCurrentPage();
      if (action === 'copy-screenshot') copyCurrentPageScreenshot();
  });
});
document.getElementById('findPageButton').addEventListener('click', findOnPage);
document.getElementById('zoomOutButton').addEventListener('click', () => changePageZoom(-10));
document.getElementById('zoomInButton').addEventListener('click', () => changePageZoom(10));
document.getElementById('printButton').addEventListener('click', printCurrentPage);
document.getElementById('savePdfButton').addEventListener('click', saveCurrentPagePdf);
document.getElementById('capturePageButton').addEventListener('click', captureCurrentPage);
const readerModeButton = document.createElement('button'); readerModeButton.id = 'readerModeButton'; readerModeButton.title = 'Čitateľský režim'; readerModeButton.setAttribute('aria-label', 'Čitateľský režim'); readerModeButton.textContent = 'Aa'; document.querySelector('.toolbar')?.insertBefore(readerModeButton, document.getElementById('downloadsButton')); readerModeButton.addEventListener('click', toggleReaderMode);
const toolbarElement = document.querySelector('.toolbar');
const toolbarToolsToggle = document.getElementById('toolbarToolsToggle');
toolbarElement.classList.toggle('tools-collapsed', !settingsState.showToolbarTools);
toolbarToolsToggle.setAttribute('aria-expanded', String(settingsState.showToolbarTools));
toolbarToolsToggle.title = settingsState.showToolbarTools ? 'Skryť nástroje' : 'Zobraziť nástroje';
toolbarToolsToggle.setAttribute('aria-label', toolbarToolsToggle.title);
toolbarToolsToggle.querySelector('use').setAttribute('href', settingsState.showToolbarTools ? '#icon-chevron-up' : '#icon-chevron-down');
toolbarToolsToggle.addEventListener('click', () => {
  settingsState.showToolbarTools = toolbarElement.classList.toggle('tools-collapsed') === false;
  toolbarToolsToggle.setAttribute('aria-expanded', String(settingsState.showToolbarTools));
  toolbarToolsToggle.title = settingsState.showToolbarTools ? 'Skryť nástroje' : 'Zobraziť nástroje';
  toolbarToolsToggle.setAttribute('aria-label', toolbarToolsToggle.title);
  toolbarToolsToggle.querySelector('use').setAttribute('href', settingsState.showToolbarTools ? '#icon-chevron-up' : '#icon-chevron-down');
  saveSettings();
});
document.getElementById('newTab').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openNewTab(); });
document.getElementById('restoreClosedTab').addEventListener('click', restoreClosedTab);
document.getElementById('reloadButton').addEventListener('click', () => {
  if (document.querySelector(`.managed-tab[data-tab-id="${activeTabId}"].loading`)) { void stopTabLoading(); return; }
  if (content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .navigation-status-error`)) { navigate(tabs.get(activeTabId).url, false); return; }
  const viewer = ensureActiveTabLoaded();
  if (isNativeTabs && /^https?:|^file:/i.test(tabs.get(activeTabId)?.url || '')) window.linsoftBrowser?.nativeTabCommand?.({ tabId: activeTabId, command: 'reload' });
  else if (viewer) viewer.reload();
  else if (tabs.get(activeTabId)?.url === 'linsoft://start') startPage();
});
document.getElementById('stopSlowLoad').addEventListener('click', () => { void stopTabLoading(); });
window.linsoftBrowser?.onTorStatus?.(renderNavigationTorStatus);
window.linsoftBrowser?.onOpenVpnStatus?.((status) => {
  if (status.status === 'log') return;
  settingsVpnStatus = { ...status, message: status.message || 'Stav VPN nie je dostupný.' };
  renderSettingsConnectionOverview();
});
window.linsoftBrowser?.getOpenVpnStatus?.().then((status) => {
  settingsVpnStatus = status;
  renderSettingsConnectionOverview();
}).catch((error) => {
  console.error('Linsoft Browser could not read OpenVPN status:', error);
  settingsVpnStatus = { status: 'error', message: 'Stav VPN sa nepodarilo zistiť.' };
  renderSettingsConnectionOverview();
});
window.linsoftBrowser?.getTorStatus?.().then(renderNavigationTorStatus).catch((error) => {
  console.error('Linsoft Browser could not read Tor status:', error);
  renderNavigationTorStatus({ proxyStatus: 'error', proxyMessage: 'Stav Tor sa nepodarilo zistiť.' });
});
document.getElementById('backButton').addEventListener('click', () => navigateTabHistory(-1));
document.getElementById('forwardButton').addEventListener('click', () => navigateTabHistory(1));
document.getElementById('bookmarkButton').addEventListener('click', (event) => { const url = addressInput.value; if (!url || url.startsWith('linsoft://')) return showToast('Na domovskú stránku sa záložka nepridáva.'); if (!savedBookmarks.some((item) => item.url === url)) { savedBookmarks.push({ url, title: tabTitle.textContent }); localStorage.setItem('linsoft-bookmarks', JSON.stringify(savedBookmarks)); renderSavedBookmarks(); } event.currentTarget.querySelector('use').setAttribute('href', '#icon-bookmark-check'); event.currentTarget.classList.add('active'); event.currentTarget.setAttribute('aria-label', 'Záložka uložená'); showToast('Záložka uložená.'); });
const adBlockButton = document.getElementById('adBlockButton');
const updateAdBlockButton = () => { adBlockButton.classList.toggle('active', settingsState.adBlock); adBlockButton.querySelector('use').setAttribute('href', settingsState.adBlock ? '#icon-shield-check' : '#icon-shield-off'); adBlockButton.title = settingsState.adBlock ? 'AdBlock zapnutý' : 'AdBlock vypnutý'; adBlockButton.setAttribute('aria-label', adBlockButton.title); };
adBlockButton.addEventListener('click', () => { settingsState.adBlock = !settingsState.adBlock; saveSettings(); updateAdBlockButton(); showToast(settingsState.adBlock ? 'AdBlock je zapnutý.' : 'AdBlock je vypnutý.'); });
document.getElementById('minimizeWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('minimize'));
function renderWindowControlState(state) {
  const maximize = document.getElementById('maximizeWindow');
  maximize.dataset.state = state.maximized ? 'maximized' : 'restored';
  maximize.setAttribute('aria-pressed', String(state.maximized));
  maximize.title = state.maximized ? 'Obnoviť veľkosť okna' : 'Maximalizovať okno';
  maximize.setAttribute('aria-label', maximize.title);
  maximize.querySelector('use').setAttribute('href', state.maximized ? '#icon-window-restore' : '#icon-maximize');
  const fullscreen = document.getElementById('fullscreenWindow');
  fullscreen.classList.toggle('active', state.fullscreen);
  fullscreen.setAttribute('aria-pressed', String(state.fullscreen));
  fullscreen.title = state.fullscreen ? 'Ukončiť celú obrazovku' : 'Celá obrazovka';
  fullscreen.setAttribute('aria-label', fullscreen.title);
  const pin = document.getElementById('pinWindow');
  pin.classList.toggle('active', state.alwaysOnTop);
  pin.setAttribute('aria-pressed', String(state.alwaysOnTop));
  pin.title = state.alwaysOnTop ? 'Vypnúť vždy navrchu' : 'Pripnúť okno navrch';
  pin.setAttribute('aria-label', pin.title);
}
window.linsoftBrowser?.onWindowControlState?.(renderWindowControlState);
window.linsoftBrowser?.getWindowControlState?.().then(renderWindowControlState).catch((error) => {
  console.error('Window control state failed:', error);
  showToast('Stav okna sa nepodarilo zistiť.');
});
document.getElementById('maximizeWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('maximize'));
document.getElementById('fullscreenWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('fullscreen'));
document.getElementById('pinWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('toggle-always-on-top'));
document.getElementById('closeWindow').addEventListener('click', () => window.linsoftBrowser?.windowControl('close'));
const browserMenu = document.getElementById('browserMenu');
const downloadPanel = document.getElementById('downloadPanel');
const bookmarksBar = document.getElementById('bookmarksBar');
const pageSourceDialog = document.getElementById('pageSourceDialog');
const pageSourceCode = document.getElementById('pageSourceCode');
let currentPageSource = '';
function closePageSourcePreview() { pageSourceDialog.hidden = true; }
async function showPageSourcePreview() {
  const result = await window.linsoftBrowser?.getPageSource?.();
  if (!result?.ok) return showToast(result?.message || 'HTML kód stránky sa nepodarilo načítať.');
  currentPageSource = String(result.source || '');
  document.getElementById('pageSourceAddress').textContent = result.url || addressInput.value;
  pageSourceCode.textContent = currentPageSource || '(Stránka neobsahuje HTML kód.)';
  pageSourceDialog.hidden = false;
  pageSourceCode.focus();
}
document.getElementById('closePageSource').addEventListener('click', closePageSourcePreview);
document.getElementById('copyPageSource').addEventListener('click', async () => {
  const result = await window.linsoftBrowser?.writeClipboardText?.(currentPageSource);
  showToast(result?.ok ? 'HTML kód bol skopírovaný.' : (result?.message || 'HTML kód sa nepodarilo skopírovať.'));
});
pageSourceDialog.addEventListener('click', (event) => { if (event.target === pageSourceDialog) closePageSourcePreview(); });
const closeContextMenus = () => {
  document.querySelectorAll('.tab-context-menu, .webview-context-menu').forEach((menu) => {
    if (menu.closeContextMenu) menu.closeContextMenu();
    else menu.remove();
  });
};
const closeBrowserMenu = () => {
  browserMenu.hidden = true;
  document.getElementById('menuButton').setAttribute('aria-expanded', 'false');
  closeContextMenus();
};
const closeTransientPanels = () => { closeBrowserMenu(); downloadPanel.hidden = true; securityPanel.hidden = true; };
browserMenu.setAttribute('role', 'menu');
browserMenu.insertAdjacentHTML('beforeend', '<div class="menu-divider"></div><button id="menuTranslatePage">文 <span>Preložiť stránku do slovenčiny</span></button>');
const menuButton = document.getElementById('menuButton');
const downloadsButton = document.getElementById('downloadsButton');
const positionBrowserMenu = () => {
  const buttonBounds = menuButton.getBoundingClientRect();
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const bookmarksBottom = bookmarksBar.hidden ? 0 : bookmarksBar.getBoundingClientRect().bottom;
  const top = Math.ceil(Math.max(buttonBounds.bottom, toolbarBottom, bookmarksBottom) + 8);
  browserMenu.style.top = `${top}px`;
  browserMenu.style.right = `${Math.max(8, Math.round(window.innerWidth - buttonBounds.right))}px`;
  browserMenu.style.maxHeight = `${Math.max(0, window.innerHeight - top - 12)}px`;
};
const positionDownloadPanel = () => {
  const buttonBounds = downloadsButton.getBoundingClientRect();
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const bookmarksBottom = bookmarksBar.hidden ? 0 : bookmarksBar.getBoundingClientRect().bottom;
  const top = Math.ceil(Math.max(buttonBounds.bottom, toolbarBottom, bookmarksBottom) + 8);
  downloadPanel.style.top = `${top}px`;
  downloadPanel.style.right = `${Math.max(8, Math.round(window.innerWidth - buttonBounds.right))}px`;
  downloadPanel.style.maxHeight = `${Math.max(0, Math.min(430, window.innerHeight - top - 12))}px`;
};
const openDownloadPanel = () => {
  downloadPanel.hidden = false;
  positionDownloadPanel();
};
const securityButton = document.getElementById('securityButton');
const positionSecurityPanel = () => {
  const buttonBounds = securityButton.getBoundingClientRect();
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const bookmarksBottom = bookmarksBar.hidden ? 0 : bookmarksBar.getBoundingClientRect().bottom;
  const top = Math.ceil(Math.max(buttonBounds.bottom, toolbarBottom, bookmarksBottom) + 8);
  const panelWidth = securityPanel.getBoundingClientRect().width;
  securityPanel.style.top = `${top}px`;
  securityPanel.style.left = `${Math.max(8, Math.min(buttonBounds.left, window.innerWidth - panelWidth - 8))}px`;
  securityPanel.style.maxHeight = `${Math.max(0, window.innerHeight - top - 12)}px`;
};
menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!browserMenu.hidden) return closeBrowserMenu();
  browserMenu.hidden = false;
  positionBrowserMenu();
  menuButton.setAttribute('aria-expanded', 'true');
  browserMenu.querySelector('button:not([hidden])')?.focus();
});
window.addEventListener('resize', () => {
  if (!browserMenu.hidden) positionBrowserMenu();
  if (!downloadPanel.hidden) positionDownloadPanel();
  if (!securityPanel.hidden) positionSecurityPanel();
});
document.addEventListener('pointerdown', (event) => {
  if (browserMenu.hidden || browserMenu.contains(event.target) || menuButton.contains(event.target)) return;
  closeBrowserMenu();
}, true);
document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (target.closest?.('#browserMenu, #downloadPanel, #securityPanel, #pageSourceDialog, .tab-context-menu, .webview-context-menu')) return;
  if (target.closest?.('#menuButton')) {
    downloadPanel.hidden = true;
    securityPanel.hidden = true;
    closeContextMenus();
    return;
  }
  closeTransientPanels();
}, true);
document.addEventListener('click', closeBrowserMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeTransientPanels(); closePageSourcePreview(); } });
browserMenu.addEventListener('click', (event) => event.stopPropagation());
browserMenu.addEventListener('keydown', (event) => {
  const buttons = [...browserMenu.querySelectorAll('button:not(:disabled)')];
  const current = buttons.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeBrowserMenu();
    menuButton.focus();
  }
});
const browserMenuIcons = { menuAppCenter: 'layout-grid', menuLinsoftChat: 'message-square', menuLinsoftOffice: 'briefcase-business', menuInstallApp: 'plus', menuNewTab: 'plus', menuGuestWindow: 'user-round', menuSearchTabs: 'search', menuBookmarks: 'bookmark', menuHistory: 'history', menuSettings: 'settings', menuDownloads: 'download', menuClearData: 'trash-2', menuAbout: 'info', menuTranslatePage: 'languages' };
Object.entries(browserMenuIcons).forEach(([id, iconName]) => {
  const button = document.getElementById(id);
  if (!button) return;
  const label = id === 'menuTranslatePage' ? 'Preložiť stránku do slovenčiny' : button.textContent.trim().replace(/^[^\p{L}\p{N}]+/u, '');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'menu-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${iconName}`);
  icon.append(use);
  button.replaceChildren(icon, document.createTextNode(label));
});
document.getElementById('menuNewTab').addEventListener('click', () => { closeBrowserMenu(); addTab(); }); document.getElementById('menuBookmarks').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://bookmarks'); }); document.getElementById('menuHistory').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://history'); }); document.getElementById('menuSettings').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://settings'); }); document.getElementById('menuDownloads').addEventListener('click', () => { closeBrowserMenu(); document.getElementById('downloadsButton').click(); }); document.getElementById('menuClearData').addEventListener('click', () => { closeBrowserMenu(); localStorage.clear(); showToast('Údaje prehliadania boli vymazané.'); }); document.getElementById('menuAbout').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://settings'); });
document.getElementById('menuTranslatePage').addEventListener('click', () => { closeBrowserMenu(); translateWebPage(); });
document.getElementById('menuInstallApp').addEventListener('click', () => { closeBrowserMenu(); installCurrentApp(); }); document.getElementById('menuAppCenter').addEventListener('click', () => { closeBrowserMenu(); openNewTab('linsoft://apps'); });
document.getElementById('menuLinsoftChat').addEventListener('click', () => { closeBrowserMenu(); openNewTab('https://linsoft.ddns.net/linsoft-chat/'); });
document.getElementById('menuLinsoftOffice').addEventListener('click', () => { closeBrowserMenu(); openNewTab('https://linsoft.ddns.net/linsoft-offiece/'); });
document.getElementById('menuGuestWindow').addEventListener('click', () => { closeBrowserMenu(); window.linsoftBrowser?.openGuestWindow?.(); });
document.getElementById('menuSearchTabs').addEventListener('click', () => { closeBrowserMenu(); searchOpenTabs(); });
document.getElementById('toggleBookmarksBar').addEventListener('click', () => { settingsState.showBookmarksBar = !settingsState.showBookmarksBar; saveSettings(); updateBookmarksBar(); closeBrowserMenu(); });
document.getElementById('hideBookmarksBar').addEventListener('click', () => { settingsState.showBookmarksBar = false; saveSettings(); updateBookmarksBar(); });
document.querySelectorAll('[data-app-url]').forEach((button) => button.addEventListener('click', () => { closeBrowserMenu(); openNewTab(button.dataset.appUrl); }));
document.querySelectorAll('.managed-tab').forEach((button) => bindTabButton(button, Number(button.dataset.tabId))); renderSavedBookmarks(); updateBookmarksBar();
document.querySelector('.tabs-bar').addEventListener('auxclick', (event) => { const tab = event.target.closest('.managed-tab'); if (event.button === 1 && tab) { event.preventDefault(); closeTab(Number(tab.dataset.tabId)); } });
document.querySelector('.tabs-bar').addEventListener('wheel', (event) => {
  if (!event.target.closest('.managed-tab')) return;
  const delta = event.deltaY || event.deltaX;
  const tabIds = [...document.querySelectorAll('.tabs-bar .managed-tab')].map((tab) => Number(tab.dataset.tabId));
  const currentIndex = tabIds.indexOf(activeTabId);
  if (!delta || tabIds.length < 2 || currentIndex < 0) return;
  event.preventDefault();
  const direction = delta > 0 ? 1 : -1;
  selectTab(tabIds[(currentIndex + direction + tabIds.length) % tabIds.length]);
}, { passive: false });
const downloadItems = new Map();
const activeDownloadStatuses = new Set(['Pripravuje sa', 'Sťahovanie začalo', 'Sťahuje sa', 'Pozastavené']);

function updateDownloadButton() {
  const button = document.getElementById('downloadsButton');
  if (!button) return;
  const active = [...downloadItems.values()].some((download) => activeDownloadStatuses.has(download.status));
  button.classList.toggle('active', active);
  button.title = active ? 'Sťahovanie prebieha - otvoriť históriu' : 'Sťahovania - otvoriť históriu';
  button.setAttribute('aria-label', active ? 'Sťahovanie prebieha, otvoriť históriu' : 'Otvoriť históriu sťahovaní');
}

function formatDownloadBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDownloadDuration(seconds) {
  const duration = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (duration < 60) return `${duration} s`;
  const minutes = Math.ceil(duration / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function renderDownloads() {
  const list = document.getElementById('downloadList');
  const summary = document.getElementById('downloadSummary');
  const allItems = [...downloadItems.values()];
  const activeCount = allItems.filter((item) => item.active === true && activeDownloadStatuses.has(item.status)).length;
  const clearHistoryButton = document.getElementById('clearDownloads');
  if (clearHistoryButton) clearHistoryButton.disabled = !allItems.some((item) => item.active !== true || !activeDownloadStatuses.has(item.status));
  summary.innerHTML = `<span data-download-total="active">Aktívne: <strong>${activeCount}</strong></span><span data-download-total="completed">Dokončené: <strong>${allItems.filter((item) => item.status === 'Stiahnuté').length}</strong></span><span>Spolu: <strong>${allItems.length}</strong></span>`;
  const filter = document.getElementById('downloadFilter')?.value || 'all';
  const query = document.getElementById('downloadSearch').value.trim().toLocaleLowerCase('sk');
  const items = allItems.filter((item) => {
    if (query && !String(item.fileName || '').toLocaleLowerCase('sk').includes(query)) return false;
    const active = item.active === true && activeDownloadStatuses.has(item.status);
    if (filter === 'active') return active;
    if (filter === 'completed') return item.status === 'Stiahnuté';
    if (filter === 'failed') return ['Zrušené', 'Sťahovanie zlyhalo'].includes(item.status) || item.status.startsWith('Sťahovanie zlyhalo:');
    return true;
  }).sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0));

  list.innerHTML = items.map((item) => {
    const size = item.status === 'Stiahnuté' ? formatDownloadBytes(item.total || item.received) : item.total ? `${formatDownloadBytes(item.received)} / ${formatDownloadBytes(item.total)}` : item.received ? `${formatDownloadBytes(item.received)} / neznáma veľkosť` : 'Veľkosť sa zisťuje';
    const elapsedSeconds = item.startedAt ? Math.max(1, (Date.now() - item.startedAt) / 1000) : 0;
    const bytesPerSecond = item.received && elapsedSeconds ? item.received / elapsedSeconds : 0;
    const speed = bytesPerSecond ? `${formatDownloadBytes(bytesPerSecond)}/s` : '';
    const isInProgress = item.active === true && activeDownloadStatuses.has(item.status);
    const isPaused = item.status === 'Pozastavené';
    const remaining = isInProgress && !isPaused && item.total > item.received && bytesPerSecond ? `Zostáva približne ${formatDownloadDuration((item.total - item.received) / bytesPerSecond)}` : '';
    const completedAt = item.status === 'Stiahnuté' && item.completedAt ? `Dokončené ${new Date(item.completedAt).toLocaleString()}` : '';
    const effectiveId = String(item.id || item.fileName || 'download');
    const percent = item.status === 'Stiahnuté' ? 100 : Math.max(0, Math.min(100, Number(item.percent) || 0));
    const indeterminate = isInProgress && !item.total;
    const visualStatus = item.status === 'Stiahnuté' ? 'completed' : isPaused ? 'paused' : isInProgress ? 'active' : item.status === 'Zrušené' ? 'cancelled' : 'failed';
    const statusIcon = visualStatus === 'completed' ? '✓' : visualStatus === 'paused' ? 'Ⅱ' : visualStatus === 'failed' ? '!' : visualStatus === 'cancelled' ? '×' : '↓';
    const progressLabel = visualStatus === 'failed' ? 'Chyba' : visualStatus === 'cancelled' ? 'Zrušené' : indeterminate ? '…' : `${percent}%`;

    const progressAction = isPaused ? `<button data-resume-download="${escapeHtml(effectiveId)}">Pokračovať</button>` : `<button data-pause-download="${escapeHtml(effectiveId)}">Pozastaviť</button>`;
    const destination = item.filePath ? `<small title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath)}</small>` : '';
    const retryAction = !isInProgress && item.status !== 'Stiahnuté' && /^https?:\/\//i.test(item.sourceUrl || '') ? `<button data-retry-download="${escapeHtml(effectiveId)}">Stiahnuť znova</button>` : '';
    return `<div class="download-item" data-download-id="${escapeHtml(effectiveId)}" data-download-status="${visualStatus}"><span class="download-file-icon" aria-hidden="true">${statusIcon}</span><div class="download-item-body"><strong title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</strong><span>${escapeHtml(item.status)} · ${size}${speed && isInProgress && !isPaused ? ` · Priemer ${speed}` : ''}</span>${remaining ? `<small>${remaining}</small>` : ''}${completedAt ? `<small>${escapeHtml(completedAt)}</small>` : ''}${destination}<progress class="download-item-progress" max="100" ${indeterminate ? '' : `value="${percent}"`} aria-label="${escapeHtml(`Priebeh sťahovania: ${item.fileName}`)}"></progress><div class="download-item-actions">${item.status === 'Stiahnuté' ? `<button data-open-download="${escapeHtml(item.filePath || '')}">Otvoriť</button><button data-show-download="${escapeHtml(item.filePath || '')}">Zobraziť v priečinku</button>` : isInProgress ? `${progressAction}<button data-cancel-download="${escapeHtml(effectiveId)}">Zrušiť</button>` : retryAction}<button data-remove-download="${escapeHtml(effectiveId)}" title="Odstrániť z histórie, nie z disku">Odstrániť</button></div></div><span class="download-item-percent">${progressLabel}</span></div>`;
  }).join('') || `<div class="downloads-empty"><span aria-hidden="true">${query ? '⌕' : '↓'}</span><strong>${query ? 'Žiadny zodpovedajúci súbor' : filter !== 'all' ? 'Žiadne súbory v tomto filtri' : 'Zatiaľ nič nestiahnuté'}</strong><small>${query || filter !== 'all' ? 'Skús iný názov alebo vyber filter Všetko.' : 'Keď stiahneš súbor, jeho priebeh a možnosti nájdeš tu.'}</small></div>`;

  list.querySelectorAll('[data-open-download]').forEach((button) => button.addEventListener('click', () => window.linsoftBrowser?.openDownloadFile(button.dataset.openDownload)));
  list.querySelectorAll('[data-show-download]').forEach((button) => button.addEventListener('click', () => window.linsoftBrowser?.showDownloadFile(button.dataset.showDownload)));
  list.querySelectorAll('[data-pause-download]').forEach((button) => button.addEventListener('click', () => {
    const item = downloadItems.get(button.dataset.pauseDownload);
    if (item) item.status = 'Pozastavené';
    window.linsoftBrowser?.pauseDownload(button.dataset.pauseDownload);
    renderDownloads();
  }));
  list.querySelectorAll('[data-resume-download]').forEach((button) => button.addEventListener('click', () => {
    const item = downloadItems.get(button.dataset.resumeDownload);
    if (item) item.status = 'Sťahuje sa';
    window.linsoftBrowser?.resumeDownload(button.dataset.resumeDownload);
    renderDownloads();
  }));
  list.querySelectorAll('[data-cancel-download]').forEach((button) => button.addEventListener('click', () => {
    const item = downloadItems.get(button.dataset.cancelDownload);
    if (item) item.status = 'Zrušené';
    window.linsoftBrowser?.cancelDownload(button.dataset.cancelDownload);
    renderDownloads();
  }));
  list.querySelectorAll('[data-remove-download]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.removeDownload;
    if (id) downloadItems.delete(id);
    window.linsoftBrowser?.removeDownload?.(id);
    renderDownloads();
  }));
  list.querySelectorAll('[data-retry-download]').forEach((button) => button.addEventListener('click', () => {
    const sourceUrl = downloadItems.get(button.dataset.retryDownload)?.sourceUrl;
    const viewer = activeViewer();
    if (!/^https?:\/\//i.test(sourceUrl || '') || !viewer?.downloadURL) return showToast('Tento súbor sa nedá znova stiahnuť.');
    viewer.downloadURL(sourceUrl);
  }));
  updateDownloadButton();
}

renderDownloads();

document.getElementById('closeDownload').addEventListener('click', () => { document.getElementById('downloadPanel').hidden = true; });
document.getElementById('downloadsButton').addEventListener('click', (event) => {
  event.stopPropagation();
  if (downloadPanel.hidden) openDownloadPanel();
  else downloadPanel.hidden = true;
  updateDownloadButton();
});
document.getElementById('openDownloads').addEventListener('click', () => window.linsoftBrowser?.openDownloads());
document.getElementById('clearDownloads').addEventListener('click', async () => {
  const historyItems = [...downloadItems.values()].filter((item) => item.active !== true || !activeDownloadStatuses.has(item.status));
  if (!historyItems.length) return;
  if (!window.confirm(`Vymazať ${historyItems.length} položiek z histórie sťahovaní? Uložené súbory zostanú v počítači a aktívne sťahovania budú pokračovať.`)) return;
  const button = document.getElementById('clearDownloads');
  button.disabled = true;
  try {
    const result = await window.linsoftBrowser?.clearDownloads?.();
    if (!result?.ok) throw new Error(result?.message || 'Históriu sťahovaní sa nepodarilo vymazať.');
    historyItems.forEach((item) => downloadItems.delete(String(item.id || item.fileName || 'download')));
    renderDownloads();
  } catch (error) {
    console.error('Linsoft Browser could not clear download history:', error);
    showToast(error instanceof Error ? error.message : 'Históriu sťahovaní sa nepodarilo vymazať.');
    renderDownloads();
  }
});
document.getElementById('downloadPanel').addEventListener('click', (event) => event.stopPropagation());
document.getElementById('downloadFilter').addEventListener('change', renderDownloads);
document.getElementById('downloadSearch').addEventListener('input', renderDownloads);

window.linsoftBrowser?.onDownload((download) => {
  const id = String(download.id || download.fileName || `${Date.now()}-${Math.random()}`);
  const isNewDownload = !downloadItems.has(id);
  downloadItems.set(id, { ...download, id, active: activeDownloadStatuses.has(download.status), percent: Number(download.percent) || 0, received: Number(download.received) || 0, total: Number(download.total) || 0 });
  const panel = document.getElementById('downloadPanel');
  if (isNewDownload) openDownloadPanel();
  renderDownloads();
  updateDownloadButton();
});

window.linsoftBrowser?.listDownloads?.().then((downloads) => {
  (downloads || []).forEach((download) => {
    const id = String(download.id || download.fileName || `${Date.now()}-${Math.random()}`);
    downloadItems.set(id, { ...download, id, active: false, percent: Number(download.percent) || 0, received: Number(download.received) || 0, total: Number(download.total) || 0 });
  });
  renderDownloads();
}).catch(() => renderDownloads());

document.addEventListener('click', () => { document.getElementById('downloadPanel').hidden = true; });

window.linsoftBrowser?.onExternalUrl((url) => navigate(url));
window.linsoftBrowser?.onTranslatePage?.(translateWebPage);
window.addEventListener('storage', (event) => {
  if (event.key !== 'linsoft-apps') return;
  try {
    const storedApps = JSON.parse(event.newValue || '[]');
    installedApps = Array.isArray(storedApps) ? storedApps.map(normalizeInstalledApp).filter(Boolean) : [];
    if (addressInput.value === 'linsoft://apps') openAppCenter();
  } catch {}
});
window.linsoftBrowser?.onTabTransferFinished?.(({ token, tabId, url }) => {
  const outgoing = outgoingTabTransfers.get(token);
  if (!outgoing || outgoing.tabId !== tabId || outgoing.url !== url) return;
  outgoingTabTransfers.delete(token);
  if (!removeTransferredTab(tabId, url)) showToast('Kópia sa otvorila v druhom okne; pôvodná karta zostala zachovaná.');
});
window.linsoftBrowser?.onNativeTabEvent?.((event) => {
  if (!isNativeTabs) return;
  const tab = tabs.get(event.tabId);
  if (!tab) return;
  if (!/^(https?:|file:)/i.test(tab.url || '')) return;
  if (pendingTorNavigations.has(event.tabId)) return;
  if (event.type === 'navigation-started') {
    showNavigationStatus(event.tabId, { url: event.url || tab.url });
    return;
  }
  if (event.type === 'document-ready') {
    clearNavigationStatus(event.tabId);
    setTabIcon(event.tabId, tab.icon || defaultWebsiteFaviconUrl(tab.url));
    return;
  }
  if (event.type === 'ready') {
    setTabIcon(event.tabId, tab.icon || defaultWebsiteFaviconUrl(tab.url));
    return;
  }
  if (event.type === 'loading') {
    if (event.loading) beginPageLoadMeasurement(event.tabId, tab.url);
    else finishPageLoadMeasurement(event.tabId);
    setTabLoading(event.tabId, event.loading);
    if (event.tabId === activeTabId) {
      document.getElementById('loadingTrack').classList.toggle('loading', event.loading);
      document.getElementById('securityButton').classList.toggle('address-loading', event.loading);
    }
    return;
  }
  if (event.type === 'crashed') {
    setTabLoading(event.tabId, false);
    tab.crashed = true;
    saveSession();
    if (event.tabId === activeTabId) showToast('Karta sa neočakávane ukončila. Klikni na kartu pre obnovenie.');
    return;
  }
  if (event.type === 'failed') {
    const failedUrl = event.validatedURL || tab.url;
    const fallbackUrl = httpFallbackForTlsError(event.errorCode, failedUrl) || httpsFallbackForIpConnectionRefused(event.errorCode, failedUrl);
    if (fallbackUrl) {
      replaceFailedUrlInTabHistory(tab, failedUrl, fallbackUrl);
      saveSession();
      if (event.tabId === activeTabId) {
        addressInput.value = fallbackUrl;
        updateConnectionIndicator(fallbackUrl);
        showToast(fallbackUrl.startsWith('https:') ? 'HTTP pripojenie odmietnuté; skúšam HTTPS.' : [-200, -201, -202].includes(Number(event.errorCode)) ? 'Certifikát súkromnej IP adresy nie je dôveryhodný; skúšam HTTP.' : 'Web nepodporuje HTTPS; otváram nezabezpečené HTTP pripojenie.');
      }
      window.linsoftBrowser?.loadNativeTab?.({ tabId: event.tabId, url: fallbackUrl, muted: tab.muted === true });
      return;
    }
    if (event.errorCode !== -3) {
      setTabLoading(event.tabId, false);
      showNavigationStatus(event.tabId, { url: failedUrl, errorCode: event.errorCode, errorDescription: event.errorDescription });
      if (event.tabId === activeTabId) showToast(navigationErrorMessage(event.errorCode, event.errorDescription));
    }
    return;
  }
  if (event.type === 'favicon' && event.favicon) {
    tab.icon = event.favicon;
    setTabIcon(event.tabId, event.favicon);
    saveSession();
    return;
  }
  if (event.type === 'title' && event.title) {
    tab.title = event.title;
    if (event.tabId === activeTabId) { tabTitle.textContent = event.title; updateActiveTab(tab.url, event.title); }
    saveSession();
    return;
  }
  if (event.type === 'navigate' && /^https?:\/\//i.test(event.url || '')) {
    const label = event.url.replace(/^https?:\/\//, '').split('/')[0];
    tab.url = event.url;
    applyTabZoom(event.tabId, event.url);
    tab.history = tab.history || [event.url];
    const knownIndex = tab.history.indexOf(event.url);
    if (knownIndex >= 0) tab.historyIndex = knownIndex;
    else { tab.history.splice(tab.historyIndex + 1); tab.history.push(event.url); tab.historyIndex = tab.history.length - 1; }
    tab.icon = defaultWebsiteFaviconUrl(event.url);
    setTabIcon(event.tabId, tab.icon);
    if (event.tabId === activeTabId) {
      addressInput.value = event.url;
      tabTitle.textContent = tab.title || label;
      updateActiveTab(event.url, tab.title || label);
      updateConnectionIndicator(event.url);
      setInstallAppAvailable(true);
    }
    saveSession();
  }
});
window.linsoftBrowser?.onDismissWebviewOverlay?.(() => {
  closeContextMenus();
  closeTransientPanels();
});
window.linsoftBrowser?.onWebviewFullscreen?.((active) => document.querySelector('.browser-window')?.classList.toggle('webview-fullscreen', active));
window.linsoftBrowser?.onBrowserShortcut?.(({ key, shift }) => {
  if (key === 'escape') { document.querySelector('.webview-context-menu')?.closeContextMenu?.(); closeTransientPanels(); return; }
  if (key === 'l' || key === 'k') { addressInput.focus(); addressInput.select(); return; }
  if (key === 'r') { document.getElementById('reloadButton').click(); return; }
  if (key === 't' && shift) { restoreClosedTab(); return; }
  if (key === 't') { openNewTab(); return; }
  if (key === 'w') { closeTab(activeTabId); return; }
  if (key === 'tab') { const ids = [...tabs.keys()]; const current = ids.indexOf(activeTabId); const next = shift ? (current - 1 + ids.length) % ids.length : (current + 1) % ids.length; selectTab(ids[next]); return; }
  if (key === 'arrowleft') { document.getElementById('backButton').click(); return; }
  if (key === 'arrowright') { document.getElementById('forwardButton').click(); return; }
  if (/^[1-9]$/.test(key)) { const tabId = [...tabs.keys()][Number(key) - 1]; if (tabId) selectTab(tabId); return; }
  if (['c', 'x', 'v', 'a', 'z', 'y'].includes(key)) { activeEditCommand({ c: 'copy', x: 'cut', v: 'paste', a: 'selectAll', z: 'undo', y: 'redo' }[key]); return; }
  if (key === 'f') { findOnPage(); return; }
  if (key === 'p') { printCurrentPage(); return; }
  if (key === '0') { resetPageZoom(); return; }
  if (key === '-') { changePageZoom(-10); return; }
  if (key === '=') { changePageZoom(10); return; }
  if (key === 's' && shift) { captureCurrentPage(); return; }
  if (key === 'i' && shift) content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`)?.openDevTools?.();
});
window.linsoftBrowser?.onWindowCloseRequest(() => { if ([...tabs.keys()].some((id) => !confirmSettingsDeparture(id, false))) return; if (!settingsState.confirmClose || tabs.size <= 1 || window.confirm(`Zatvoriť Linsoft Browser s ${tabs.size} otvorenými kartami?`)) window.linsoftBrowser.confirmWindowClose(); });
window.linsoftBrowser?.onOpenAppCenter(() => openNewTab('linsoft://apps'));
window.linsoftBrowser?.onInstallExternalApp(async (data) => { if (!data?.url || !/^https?:\/\//i.test(data.url)) return showToast('Webová adresa nie je platná.'); const result = await window.linsoftBrowser.installWebApp(data.url, data.name || new URL(data.url).hostname);
  if (!result?.ok) return showToast(result?.message || 'Web sa nepodarilo nainštalovať.');
  const existing = installedApps.find((item) => item.url === data.url);
  if (existing) existing.title = data.name || existing.title;
  else installedApps.push({ url: data.url, title: data.name || new URL(data.url).hostname, installedAt: Date.now() });
  localStorage.setItem('linsoft-apps', JSON.stringify(installedApps));
  showToast('Web bol nainštalovaný do Linsoft App Centra.');
  openAppCenter(); });
window.linsoftBrowser?.onUninstallExternalApp(async (data) => { const index = installedApps.findIndex((item) => item.url === data?.url);
  const item = index >= 0 ? installedApps[index] : { title: data?.name || '' };
  const result = await window.linsoftBrowser.uninstallWebApp(data?.url, item.title);
  if (result && !result.ok) return showToast(result.message);
  if (index >= 0) installedApps.splice(index, 1);
  localStorage.setItem('linsoft-apps', JSON.stringify(installedApps));
  showToast('Webová aplikácia bola odinštalovaná.');
  openAppCenter(); });
window.linsoftBrowser?.onLinkInTab((url) => { if (settingsState.popups) openNewTab(url); else showToast('Vyskakovacie okno bolo zablokované.'); });
window.linsoftBrowser?.onLinkInWindow?.((url) => { if (settingsState.popups) window.linsoftBrowser.openDetachedWindow(url); else showToast('Vyskakovacie okno bolo zablokované.'); });
applyTheme();
updateAdBlockButton();
  window.linsoftBrowser?.setBrowserPreferences(getBrowserPreferencesFromSettings()).then(() => {
    if (settingsState.autoUsbCamera) initializeUsbCameraDeviceMonitor();
  }).catch((error) => {
    console.error('Linsoft Browser could not initialize browser preferences:', error);
    updateUsbCameraPageStatus('Nastavenia pre automatickú kameru sa nepodarilo načítať.', false);
  });
document.addEventListener('keydown', (event) => { const command = event.ctrlKey || event.metaKey; if (command && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); content.querySelector(`.tab-surface[data-tab-id="${activeTabId}"] .webview`)?.openDevTools?.(); return; } if (command && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); restoreClosedTab(); return; } if (command && (event.key.toLowerCase() === 'l' || event.key.toLowerCase() === 'k')) { event.preventDefault(); addressInput.focus(); addressInput.select(); return; } if (command && event.key.toLowerCase() === 'r') { event.preventDefault(); document.getElementById('reloadButton').click(); return; } if (command && event.key.toLowerCase() === 't') { event.preventDefault(); openNewTab(); return; } if (command && event.key.toLowerCase() === 'w') { event.preventDefault(); closeTab(activeTabId); return; } if (command && event.key === 'Tab') { event.preventDefault(); const ids = [...tabs.keys()]; const current = ids.indexOf(activeTabId); const next = event.shiftKey ? (current - 1 + ids.length) % ids.length : (current + 1) % ids.length; selectTab(ids[next]); return; } if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); document.getElementById('backButton').click(); return; } if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); document.getElementById('forwardButton').click(); } });
restoreSession();
if (hadCrash) showToast('Obnovené karty po neočakávanom ukončení.');
if (addressInput.value === 'linsoft://apps') openAppCenter();
const startupTransferToken = new URLSearchParams(window.location.search).get('transfer');
if (startupTransferToken) {
  void receiveTabTransfer(startupTransferToken).catch((error) => {
    console.error('Linsoft Browser could not receive a detached tab:', error);
    showToast('Kartu sa nepodarilo preniesť. Pôvodná karta zostala otvorená.');
  });
} else if (settingsState.startup === 'home' && settingsState.home !== 'linsoft://start') navigate(settingsState.home);

const updateNotice = document.getElementById('updateNotice');
const updateNoticeTitle = document.getElementById('updateNoticeTitle');
const updateNoticeText = document.getElementById('updateNoticeText');
const updateNoticeAction = document.getElementById('updateNoticeAction');
const updateNoticeDismiss = document.getElementById('updateNoticeDismiss');
const updateProgress = document.getElementById('updateProgress');
const updateProgressBar = document.getElementById('updateProgressBar');
let visibleUpdateState = null;

function renderUpdateNotice(state) {
  if (!updateNotice || !state) return;
  visibleUpdateState = state;
  if (!['available', 'downloading', 'downloaded'].includes(state.status)) {
    updateNotice.hidden = true;
    return;
  }
  const version = String(state.version || '');
  if (state.status === 'available' && sessionStorage.getItem('linsoft-dismissed-update') === version) {
    updateNotice.hidden = true;
    return;
  }
  updateNotice.hidden = false;
  updateNoticeTitle.textContent = state.status === 'downloaded' ? 'Aktualizácia je pripravená' : 'Nová verzia Linsoft Browser';
  updateNoticeText.textContent = state.status === 'available'
    ? `Verzia ${version} je dostupná.`
    : state.status === 'downloading'
      ? `Sťahuje sa verzia ${version}: ${Math.max(0, Math.min(100, Number(state.percent) || 0))} %.`
      : `Verzia ${version} sa nainštaluje po reštarte.`;
  updateProgress.hidden = state.status !== 'downloading';
  updateProgressBar.style.width = `${Math.max(0, Math.min(100, Number(state.percent) || 0))}%`;
  updateNoticeAction.textContent = state.status === 'downloaded' ? 'Reštartovať' : state.status === 'downloading' ? 'Sťahuje sa' : 'Stiahnuť';
  updateNoticeAction.disabled = state.status === 'downloading';
}

updateNoticeAction.addEventListener('click', async () => {
  if (visibleUpdateState?.status === 'downloaded') {
    window.linsoftBrowser?.installUpdate?.();
    return;
  }
  if (visibleUpdateState?.status !== 'available') return;
  updateNoticeAction.disabled = true;
  const result = await window.linsoftBrowser?.downloadUpdate?.();
  if (!result?.ok) {
    updateNoticeAction.disabled = false;
    updateNoticeText.textContent = `Sťahovanie zlyhalo: ${result?.message || 'skús to znova.'}`;
  }
});

updateNoticeDismiss.addEventListener('click', () => {
  if (visibleUpdateState?.status === 'available') sessionStorage.setItem('linsoft-dismissed-update', String(visibleUpdateState.version || ''));
  updateNotice.hidden = true;
});

window.linsoftBrowser?.onUpdateState?.((state) => { renderUpdateNotice(state); renderSettingsUpdateState(state); });
window.linsoftBrowser?.getUpdateState?.().then(renderUpdateNotice).catch(() => {});

function enhanceBrowserMenu() {
  browserMenu.querySelectorAll('.menu-section-label,.menu-divider').forEach((element) => element.remove());
  ['menuInstallApp', 'menuClearData'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.hidden = true;
  });
  const header = document.createElement('div');
  header.className = 'browser-menu-brand';
  header.innerHTML = '<img src="assets/linsoft-icon.svg" alt=""><div><strong>Linsoft Browser</strong><small>Nástroje a tvoje stránky</small></div>';
  browserMenu.prepend(header);
  const groups = [
    ['PREHLIADANIE', ['menuNewTab', 'menuGuestWindow', 'menuSearchTabs', 'menuDownloads']],
    ['TVOJE STRÁNKY', ['menuBookmarks', 'menuHistory', 'toggleBookmarksBar']],
    ['APLIKÁCIE A NÁSTROJE', ['menuAppCenter', 'menuLinsoftChat', 'menuLinsoftOffice', 'menuTranslatePage']],
    ['NASTAVENIA', ['menuSettings', 'menuAbout']]
  ];
  const shortcutLabels = { menuNewTab: 'Ctrl+T', menuSearchTabs: 'Ctrl+Shift+A' };
  for (const [label, ids] of groups) {
    const section = document.createElement('div');
    section.className = 'browser-menu-group';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', label);
    section.innerHTML = `<div class="menu-section-label">${label}</div>`;
    for (const id of ids) {
      const button = document.getElementById(id);
      if (!button) continue;
      if (!button.querySelector('svg')) button.insertAdjacentHTML('afterbegin', '<svg class="menu-icon" aria-hidden="true"><use href="#icon-bookmark"></use></svg>');
      if (shortcutLabels[id]) button.insertAdjacentHTML('beforeend', `<kbd>${shortcutLabels[id]}</kbd>`);
      button.setAttribute('role', 'menuitem');
      section.appendChild(button);
    }
    browserMenu.appendChild(section);
  }
  const apps = document.createElement('div');
  apps.className = 'browser-menu-apps';
  browserMenu.querySelectorAll('[data-app-url]').forEach((button) => { button.setAttribute('role', 'menuitem'); apps.appendChild(button); });
  browserMenu.appendChild(apps);
  menuButton.setAttribute('aria-controls', 'browserMenu');
  menuButton.setAttribute('aria-expanded', 'false');
}
enhanceBrowserMenu();
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    closeBrowserMenu();
    searchOpenTabs();
  }
});
