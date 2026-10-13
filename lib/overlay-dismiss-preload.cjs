const { ipcRenderer } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  document.addEventListener('pointerdown', (event) => {
    if (event.button === 0) ipcRenderer.send('browser-page-pointerdown');
  }, true);
}
