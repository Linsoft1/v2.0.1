# Linsoft Browser Release Checklist

## Current Release: 2.0.25

- Linsoft opens existing local PDF files in its embedded Chromium viewer and registers `.pdf` with Windows and Linux desktop environments.
- Onion Chat includes QR invitations/scanning, 15-minute invitation expiry/renewal, Tor transport recovery, in-memory chat receipts, encrypted video-only calls, and end-to-end encrypted 2 MiB file transfers over Tor.
- Electron is upgraded to `44.4.5` and Electron Builder to `26.15.3` to address the audited advisories.
- `npm test` passes locally (27 tests).
- `npm run test:tor` reaches the onion service from a separate guest process, relays encrypted chat, video frames, and file chunks, verifies receipts, and rejects a second guest.
- Production dependency audit (`npm audit --omit=dev`) reports zero vulnerabilities.
- The local Windows installer is intentionally unsigned; the signing gate below remains unsatisfied.
- Publish tag `v2.0.25` only after the applicable release gates are complete. Linux CI stages the custom Debian package in a flat folder; build jobs use `--publish never` and the dedicated release job uploads assets using `GITHUB_TOKEN`.
- Wait for both build jobs and the release upload to complete before calling this release complete.

## Release Gate

- [ ] `npm ci` succeeds on both Windows and Linux runners.
- [x] `npm test` passes, including Tor chat protocol and AES-GCM tests.
- [x] `npm run test:tor` reaches the onion service from a separate guest process, relays encrypted chat, video frames, and file chunks, verifies receipts, and rejects a second guest.
- [ ] Windows installer builds and uploads.
- [ ] Windows installer is signed with the release code-signing certificate; verify its publisher in the file properties before publishing.
- [ ] Debian package builds and passes `node tools/verify-deb.cjs`.
- [ ] GitHub Release contains the Windows installer, `latest.yml`, blockmap, and Debian package.
- [ ] Install the Windows package and verify Settings > Updates, manual check, download progress, and restart/install behavior.
- [ ] Install two copies, create and join a chat invitation, exchange messages, then verify stopping the host disconnects the guest.
- [x] Review and update vulnerable Electron/build dependencies.

## Local Commands

```sh
npm ci
npm test
npm run build:installer
npm run build:linux
node tools/build-deb.cjs
node tools/verify-deb.cjs
```

## Expected Artifacts

- Windows: `dist/Linsoft-Browser-Setup-<version>.exe`, `dist/latest.yml`, and `dist/*.blockmap`
- Debian: `dist/Linsoft-Browser-<version>-amd64.deb` and `dist-debian-final/Linsoft-Browser-<version>-amd64.deb`