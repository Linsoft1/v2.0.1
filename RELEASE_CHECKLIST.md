# Linsoft Browser Release Checklist

## Current Release: 2.0.32

- Fixed a crash in media permission handling when Electron supplies no valid `webContents`.
- The Windows x64 installer and Debian/Ubuntu amd64 package are built by the GitHub Actions release workflow. Linux CI validates the custom Debian package before upload.
- The Windows installer is unsigned. This release proceeds without a signing certificate, with the publisher warning disclosed on the website.
- The GitHub Pages workflow deploys the website after the release workflow completes.
- Wait for both platform builds, release asset upload, and website deployment to complete before calling this release complete.

## Release Gate

- [ ] `npm ci` succeeds on both Windows and Linux runners.
- [x] `npm test` passes locally (66 tests).
- [x] `npm run test:navigation` passes for both tab engines.
- [ ] `npm run test:tor` passes against a separate guest process.
- [ ] Windows installer builds and uploads.
- [x] Unsigned Windows installer accepted for this release; the website discloses the publisher warning.
- [ ] Debian package builds and passes `node tools/verify-deb.cjs`.
- [ ] GitHub Release contains the Windows installer, `latest.yml`, blockmap, and Debian package.
- [ ] GitHub Pages deployment completes and links to the 2.0.32 release assets.
- [ ] Install the Windows package and verify Settings > Updates, manual check, download progress, and restart/install behavior.
- [ ] Install two copies, create and join a chat invitation, exchange messages, then verify stopping the host disconnects the guest.

## Local Commands

```sh
npm ci
npm test
npm run test:navigation
npm run build:installer
npm run build:linux
node tools/build-deb.cjs
node tools/verify-deb.cjs
```

## Expected Artifacts

- Windows: `dist/Linsoft-Browser-Setup-2.0.32.exe`, `dist/latest.yml`, and `dist/*.blockmap`
- Debian: `Linsoft-Browser-2.0.32-amd64.deb`
