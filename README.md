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
