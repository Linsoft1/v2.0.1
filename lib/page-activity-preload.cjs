(() => {
  if (!/^https?:$/.test(location.protocol)) return;
  const { contextBridge, ipcRenderer } = require('electron');
  const report = () => {
    const root = document.documentElement;
    ipcRenderer.send('page-activity-state', {
      edited: root?.hasAttribute('data-linsoft-edited') === true,
      call: root?.hasAttribute('data-linsoft-call') === true,
      capture: root?.hasAttribute('data-linsoft-capture') === true,
      transfer: root?.hasAttribute('data-linsoft-transfer') === true
    });
  };
  const markEdited = (event) => {
    if (!event.isTrusted) return;
    const element = event.target;
    if (element?.isContentEditable || element?.matches?.('input:not([type=hidden]),textarea,select')) {
      document.documentElement?.setAttribute('data-linsoft-edited', '');
      report();
    }
  };
  document.addEventListener('input', markEdited, true);
  document.addEventListener('change', markEdited, true);
  document.addEventListener('linsoft-page-activity', report);
  try {
    contextBridge.executeInMainWorld({ func: () => {
      const peers = new Set();
      const tracks = new Set();
      let transfers = 0;
      let pendingCapture = 0;
      const publish = () => {
        const root = document.documentElement;
        if (!root) return;
        for (const [kind, active] of [
          ['call', peers.size > 0],
          ['capture', pendingCapture > 0 || tracks.size > 0],
          ['transfer', transfers > 0]
        ]) root.toggleAttribute(`data-linsoft-${kind}`, active);
        document.dispatchEvent(new Event('linsoft-page-activity'));
      };
      document.addEventListener('DOMContentLoaded', publish, { once: true });
      const OriginalPeer = window.RTCPeerConnection;
      if (OriginalPeer) {
        window.RTCPeerConnection = new Proxy(OriginalPeer, {
          construct(target, args, newTarget) {
            const peer = Reflect.construct(target, args, newTarget);
            peers.add(peer);
            const update = () => {
              if (peer.signalingState === 'closed' || peer.connectionState === 'closed') peers.delete(peer);
              publish();
            };
            peer.addEventListener('connectionstatechange', update);
            peer.addEventListener('signalingstatechange', update);
            const close = peer.close;
            peer.close = function(...values) {
              const result = Reflect.apply(close, this, values);
              peers.delete(this);
              publish();
              return result;
            };
            publish();
            return peer;
          }
        });
      }
      for (const name of ['getUserMedia', 'getDisplayMedia']) {
        const devices = navigator.mediaDevices;
        const original = devices?.[name];
        if (!original) continue;
        devices[name] = function(...args) {
          pendingCapture += 1;
          publish();
          let request;
          try { request = Reflect.apply(original, this, args); }
          catch (error) { pendingCapture -= 1; publish(); throw error; }
          return Promise.resolve(request).then(stream => {
            for (const track of stream.getTracks()) {
              if (track.readyState !== 'live') continue;
              tracks.add(track);
              const stop = track.stop;
              track.stop = function(...values) {
                const result = Reflect.apply(stop, this, values);
                tracks.delete(this);
                publish();
                return result;
              };
              track.addEventListener('ended', () => { tracks.delete(track); publish(); }, { once: true });
            }
            return stream;
          }).finally(() => { pendingCapture -= 1; publish(); });
        };
      }
      const fetch = window.fetch;
      if (fetch) window.fetch = function(input, options) {
        const method = String(options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return Reflect.apply(fetch, this, arguments);
        transfers += 1;
        publish();
        try {
          return Promise.resolve(Reflect.apply(fetch, this, arguments)).finally(() => { transfers -= 1; publish(); });
        } catch (error) { transfers -= 1; publish(); throw error; }
      };
      const send = window.XMLHttpRequest?.prototype.send;
      if (send) window.XMLHttpRequest.prototype.send = function(...args) {
        transfers += 1;
        publish();
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          transfers -= 1;
          publish();
        };
        this.addEventListener('loadend', done, { once: true });
        try { return Reflect.apply(send, this, args); }
        catch (error) { this.removeEventListener('loadend', done); done(); throw error; }
      };
    } });
  } catch (error) {
    console.error('Linsoft Browser could not install call and transfer protection:', error.message);
    // A missing detector must not make an unknown page eligible for unloading.
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement?.setAttribute('data-linsoft-call', '');
      report();
    }, { once: true });
  }
})();
