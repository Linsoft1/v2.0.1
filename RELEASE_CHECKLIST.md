# Linsoft Browser Release Checklist

## Current Release: 2.0.7

- Electron is upgraded to `44.4.5` and Electron Builder to `26.15.3` to address the audited advisories.
- `npm ci` succeeds locally with the updated lockfile.
- `npm test` passes locally.
- `npm audit` reports zero vulnerabilities.
- Windows installer `dist/Linsoft-Browser-Setup-2.0.5.exe` builds locally.
- Publish tag `v2.0.7`; Linux CI builds an unpacked bundle and uses the tested custom Debian packer, avoiding an external FPM dependency. Windows CI disables certificate auto-discovery and surfaces build failure details in check annotations.
- Wait for both build jobs and the release upload to complete before calling this release complete.

## Release Gate

- [ ] `npm ci` succeeds on both Windows and Linux runners.
- [ ] `npm test` passes.
- [ ] Windows installer builds and uploads.
- [ ] Debian package builds and passes `node tools/verify-deb.cjs`.
- [ ] GitHub Release contains the Windows installer, `latest.yml`, blockmap, and Debian package.
- [ ] Install the Windows package and verify Settings > Updates, manual check, download progress, and restart/install behavior.
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