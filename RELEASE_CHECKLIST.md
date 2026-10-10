# Linsoft Browser Release Checklist

## Current Release: 2.0.27

- Updates browser address suggestions, tab lifecycle/state handling, and Google sign-in recovery, with matching website/download guidance.
- `npm test` passes locally (72 tests).
- `npm run test:electron-smoke` passes for both webview and native tab engines.
- The Windows installer is intentionally unsigned, as approved for this release.
- Tag `v2.0.27` triggers the GitHub Actions release workflow. Linux CI stages and verifies the Debian package; build jobs use `--publish never`, and the release job uploads assets using `GITHUB_TOKEN`.
- Wait for both build jobs and the release upload to complete before calling this release complete.

## Release Gate

- [x] `npm ci` succeeds on both Windows and Linux runners.
- [x] `npm test` passes locally (72 tests).
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