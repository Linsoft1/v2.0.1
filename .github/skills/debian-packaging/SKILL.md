---
name: debian-packaging
description: "Build, verify, and diagnose Debian packaging for Electron apps. Use for creating .deb artifacts, validating Debian archive structure, checking desktop entries and app bundle layout, and debugging Linux packaging failures."
argument-hint: "Build and verify a Debian package, then diagnose any archive or bundle issues."
user-invocable: true
disable-model-invocation: false
---

# Debian Packaging Workflow

## When to Use
- You need to create or rebuild a Debian package for the app.
- You need to validate an existing .deb artifact before release.
- The packaging process fails because files are missing, paths are wrong, or the ar/tar structure is invalid.
- You need a repeatable, evidence-based workflow for Linux packaging.

## Inputs and References
- Build logic: [../../../tools/build-deb.cjs](../../../tools/build-deb.cjs)
- Verification logic: [../../../tools/verify-deb.cjs](../../../tools/verify-deb.cjs)
- Desktop launcher: [../../../packaging/linsoft-browser.desktop](../../../packaging/linsoft-browser.desktop)
- App bundle: [../../../dist-debian-final/linux-unpacked](../../../dist-debian-final/linux-unpacked)

## Procedure

### 1. Confirm prerequisites
Before building, check that the Electron app bundle exists and the required packaging inputs are present.

- Ensure the unpacked app directory exists at `dist-debian-final/linux-unpacked`.
- Verify the icon file is present at `assets/linsoft-icon-256.png`.
- Verify the desktop launcher exists in `packaging/linsoft-browser.desktop`.
- Verify the project metadata in `package.json` matches the intended artifact name and version.

If any required input is missing, stop and fix the source before packaging.

### 2. Build the Debian package
Use the project-specific Debian packaging script rather than ad hoc shell commands.

- Run the Debian builder script: [../../../tools/build-deb.cjs](../../../tools/build-deb.cjs)
- The script should create a .deb file in `dist-debian-final/`.
- It should validate the internal archive structure as part of the build.

Do not trust a package artifact simply because a file was created; confirm the archive layout is valid.

### 3. Verify the artifact with independent checks
Use a separate verification script to confirm the package structure and required entries.

- Run [../../../tools/verify-deb.cjs](../../../tools/verify-deb.cjs)
- Confirm that the file is a valid Debian ar archive.
- Confirm it contains `debian-binary`, `control.tar.gz`, and `data.tar.gz` members.
- Confirm the archive includes required paths such as:
  - `./opt/Linsoft Browser/linsoft-browser`
  - `./usr/share/applications/linsoft-browser.desktop`
  - `./usr/share/icons/hicolor/256x256/apps/linsoft-browser.png`
- Confirm the file size is reasonable and stable for the expected build.

### 4. Diagnose packaging failures systematically
When validation fails, repair the underlying cause instead of patching symptoms.

Common failure modes and fixes:

- Missing app bundle:
  - Cause: `dist-debian-final/linux-unpacked` was not produced or was cleaned.
  - Fix: rebuild the app bundle before packaging.

- Missing icon or wrong icon path:
  - Cause: the icon source or target path is absent.
  - Fix: restore the icon file and ensure the desktop entry references the right location.

- Broken desktop entry:
  - Cause: invalid `Exec` path or missing quoting.
  - Fix: ensure the launcher points to the installed executable path consistently.

- Invalid ar archive:
  - Cause: malformed member headers, missing terminators, or truncated data.
  - Fix: inspect the generation code in [../../../tools/build-deb.cjs](../../../tools/build-deb.cjs) and ensure both tar and ar generation match Debian expectations.

- Invalid tar payload:
  - Cause: missing required directory entries or nonstandard archive formatting.
  - Fix: ensure all file entries are correctly added and the tar header values are valid.

- Incorrect permissions or ownership metadata:
  - Cause: directory or executable bit values were not set.
  - Fix: check the archive entry mode values and ensure executable files receive executable permissions.

### 5. Quality gate before release
A build is complete only when all of the following are true:

- Build script exits without error.
- Verification script exits without error.
- Artifact exists at the expected output path.
- .deb file size and expected members are logged.
- Required launchers, icons, and application bundle paths are present.

## Completion Checklist
Use this as a release gate:

- [ ] App bundle exists and is complete.
- [ ] Desktop entry exists and is valid.
- [ ] Icon file exists and is included in the package.
- [ ] Build script completes successfully.
- [ ] Verification script confirms Debian archive validity.
- [ ] Required app files and desktop metadata are present.
- [ ] Final artifact has expected size and stable naming.

## Best Practices
- Prefer the project’s dedicated build/verification scripts over manual packaging commands.
- Validate output immediately after each build rather than assuming success.
- Preserve evidence by recording file path, size, and the validation output.
- Treat Debian packaging as an artifact-validation workflow, not just a file-copy step.
