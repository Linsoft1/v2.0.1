# Linsoft Browser Release Checklist

## Current Release: 2.0.29

- Improves page presentation with reader mode, per-site zoom, slow-load feedback and navigation recovery.
- Adds browser settings backup/restore and keyboard tab search.
- Improves Google OAuth popup handling and expands browser smoke coverage for both tab engines.
- Includes the accumulated browser, privacy, tab lifecycle and Debian packaging changes since 2.0.28.
- `npm test` and `npm run test:electron-smoke` pass locally before release.
- The Windows installer is unsigned; the release workflow disables automatic code-signing discovery.
- Tag `v2.0.29` triggers the GitHub Actions release workflow. CI builds Windows and Debian artifacts and publishes them to the GitHub Release.
- Release workflow [38372124661](https://github.com/Linsoft1/v2.0.1/actions/runs/38372124661) succeeded: tests, Windows installer, verified Debian package and GitHub Release upload.

## Release Gate

- [x] `npm ci` succeeds on both Windows and Linux runners.
- [x] `npm test` passes locally and in CI.
- [x] `npm run test:electron-smoke` passes for webview and native tab engines.
- [x] Windows installer builds locally and uploads from CI.
- [ ] Windows installer is signed with the release code-signing certificate (not included in this release, by approval).
- [x] Debian package builds and passes `node tools/verify-deb.cjs` in CI.
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