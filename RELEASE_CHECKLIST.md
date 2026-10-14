# Linsoft Browser Release Checklist

## Release 2.0.30

- Adds Linsoft Chat and Linsoft Office to the browser start page, App Center, and project website.
- Refreshes the Linsoft services section with service logos, descriptions, and accurate encryption and local-storage notes.
- Identifies website requests as Linsoft Browser while preserving Chromium compatibility.
- Keeps AdBlock opt-in and improves its behavior on active pages.
- Speeds up entering and leaving webpage/video fullscreen.
- Aligns the application branding and Windows identity, and updates package metadata and website links.
- `npm test` and `npm run test:electron-smoke` must pass before publication.
- The unsigned Windows installer and verified Debian package are built by the GitHub Actions release workflow.
- The release workflow publishes both platform packages to GitHub Releases; the Pages workflow deploys `docs/` to the Linsoft Browser website.
- The release website must show the GitHub-provided SHA-256 digests rather than locally guessed checksum values.
- The Windows installer is unsigned; the release workflow disables automatic code-signing discovery.

## Release Gate

- [x] `npm test` passes locally.
- [x] `npm run test:electron-smoke` passes locally for webview and native tab engines.
- [x] Release workflow tests pass in CI.
- [x] Windows 2.0.30 installer builds locally.
- [x] Windows installer uploads from CI.
- [x] Debian package builds and passes `node tools/verify-deb.cjs` in CI.
- [x] GitHub Release contains the Windows installer, `latest.yml`, blockmap, and Debian package.
- [x] GitHub Pages deploy succeeds with the updated website and service logos.
- [x] Download links and release-provided SHA-256 digests are checked after publication.
- [ ] Install the release packages and verify the app starts.
- Windows installer is unsigned; a release code-signing certificate is not configured.

## Local Commands

```sh
npm ci
npm test
npm run test:electron-smoke
npm run build:installer
npx electron-builder --linux dir --publish never
node tools/build-deb.cjs
node tools/verify-deb.cjs
```

## Expected Artifacts

- Windows: `dist/Linsoft-Browser-Setup-2.0.30.exe`, `dist/latest.yml`, and `dist/*.blockmap`
- Debian: `dist-debian-final/Linsoft-Browser-2.0.30-amd64.deb`

## Optional Debian APT publication gate

- [ ] Dedicated archive-signing key configured in GitHub Secrets; public fingerprint verified and published.
- [ ] Pages contains signed repository metadata, package indexes, keyring and the latest amd64 package.
- [ ] Combined website/repository stays below the Pages 1 GB limit.
- [ ] Isolated APT signature/hash verification passes.
- [ ] Administrator setup and unattended upgrade from an older version verified on Debian.
- [ ] Weekly metadata refresh succeeds before its 30-day validity expires.
- [ ] Follow [APT setup and key-management guidance](./packaging/APT_UPDATES.md); do not claim system automatic updates are active until configured.
