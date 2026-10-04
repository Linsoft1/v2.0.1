# Linsoft Browser

Linsoft Browser is a desktop browser for Windows and Linux Debian, focused on a clean interface, quick web access, bookmarks, app installs, and basic privacy controls.

## Features

- Browser tabs and navigation
- Bookmarks and history
- Home/start page
- Web app installation support
- App center
- Downloads panel
- OpenVPN support
- Built-in Tor Expert Bundle for static onion hosting
- Linux `.deb` packaging support

## Requirements

- Node.js 24 LTS
- npm
- Electron dependencies via `npm install`

## Install dependencies

```powershell
npm install
```

## Run the app

```powershell
npm start
```

## Website hosting

The static website and its optimized, locally hosted browser screenshots are in
[`docs/`](./docs/). GitHub Actions deploys it to
[GitHub Pages](https://linsoft1.github.io/v2.0.1/) when changes to that folder
are pushed to `main`. Before the first deployment, enable GitHub Pages in the
repository settings under **Settings > Pages**, with **GitHub Actions** as the
build and deployment source.

## Validate the project

```powershell
& "C:\Users\Martin\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\npm.cmd" test
```

The live Tor hosting smoke test is separate because it requires a working Tor network connection:

```powershell
npm run test:tor
```

## Onion chat 1:1

Open Settings > Advanced > Tor Hosting and choose **Otvoriť chat** to open the dedicated Onion Chat tab. One person creates an invitation and shares it privately by QR code or link; the other can scan it with **Naskenovať QR** or paste it. Camera access is requested only for scanning or a call and is released when that action ends. The invitation accepts one guest, expires after 15 minutes if unused, and can be replaced with **Vytvoriť novú pozvánku** after expiry. Both participants must keep Linsoft Browser running. The app retries interrupted Tor connections with increasing delays and restarts a failed Tor transport while retaining the in-memory room. Chat messages, delivery/read receipts, and active file transfers are held in memory only; stopping the chat or closing the app clears them. Messages show sent, delivered, and read status. Read receipts are sent only while the recipient's Onion Chat tab is active and visible. Attachments are end-to-end encrypted in 24 KiB chunks and limited to 2 MiB; the recipient explicitly chooses **Uložiť súbor**, and files are never opened automatically. Both participants can enable **Video hovor** for an end-to-end encrypted, video-only feed relayed through Tor; it has a low frame rate and no audio, and does not use direct WebRTC connections. Only the latest frame is kept in memory. The invitation contains the room access token and encryption key, so treat it like a password. A new invitation is required after the host restarts the app.

Linsoft Browser opens existing local PDF files in its embedded viewer. PDF opening uses the Chromium viewer inside an isolated webview; the PDF plugin is enabled only for PDF URLs.

## Build Debian package

```powershell
node tools/build-deb.cjs
```

## Verify Debian package

```powershell
node tools/verify-deb.cjs
```

## Release state

The current project state is validated and ready for release based on successful project validation and Debian package verification.

## Notes

The shell environment used during verification did not have `npm` on PATH in one session, but the project itself passed validation when run with the explicit npm path. The core app and packaging flow are therefore considered valid.
