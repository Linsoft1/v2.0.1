# Linsoft Browser Release Checklist

## Current Release: 2.0.28

- Adds microphone/device level testing, local camera preview, immediate media permission settings, Debian update notifications and repeated update reminders.
- Removes the extension-based download warning without automatically executing downloads.
- Includes opt-in signed APT repository preparation; APT publication and system installation remain disabled until separately configured.
- `npm test` passes locally (85 tests).
- `npm run test:electron-smoke` passes for both webview and native tab engines.
- The Windows installer is intentionally unsigned, as approved for this release.
- Tag `v2.0.28` triggers the GitHub Actions release workflow. Linux CI stages and verifies the Debian package; build jobs use `--publish never`, and the release job uploads assets using `GITHUB_TOKEN`.
- Release workflow `38101161320` succeeded: tests, Windows installer, verified Debian package and stable release upload.

## Release Gate

- [x] `npm ci` succeeds on both Windows and Linux runners.
- [x] `npm test` passes locally (85 tests).
- [x] `npm run test:electron-smoke` passes for webview and native tab engines.
- [x] Windows installer builds and uploads.
- [ ] Windows installer is signed with the release code-signing certificate (not included in this release, by approval).
- [x] Debian package builds and passes `node tools/verify-deb.cjs`.
- [x] GitHub Release contains the Windows installer, `latest.yml`, blockmap, and Debian package.
- [ ] Install the release packages and verify the app starts.

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

## Optional Debian APT publication gate

- [ ] Dedicated archive-signing key configured in GitHub Secrets; public fingerprint verified and published.
- [ ] Pages contains signed repository metadata, package indexes, keyring and the latest amd64 package.
- [ ] Combined website/repository stays below the Pages 1 GB size limit.
- [ ] Isolated APT signature/hash verification passes.
- [ ] Administrator setup and unattended upgrade from an older version verified on Debian.
- [ ] Weekly metadata refresh succeeds before its 30-day validity expires.
- [ ] Follow [APT setup and key-management guidance](./packaging/APT_UPDATES.md); do not claim system automatic updates are active until configured.