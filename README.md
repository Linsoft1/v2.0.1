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

## Validate the project

```powershell
& "C:\Users\Martin\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\npm.cmd" test
```

The live Tor hosting smoke test is separate because it requires a working Tor network connection:

```powershell
npm run test:tor
```

## Onion chat 1:1

Open Settings > Advanced > Tor Hosting > Onion Chat. One person creates an invitation and shares it privately; the other pastes it and connects. The invitation accepts one guest, and both participants must keep Linsoft Browser running. Chat messages are end-to-end encrypted and held in memory only; stopping the chat or closing the app clears them. The invitation contains the room access token and encryption key, so treat it like a password. A new invitation is required after the host restarts the app.

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
