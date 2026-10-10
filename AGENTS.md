# Linsoft Browser Agent Guide

## Architecture
- This is an Electron desktop browser. `main.cjs` owns windows, web contents, permissions, downloads, and IPC; `app.js`, `index.html`, and `styles.css` implement the browser chrome.
- Loaded websites run in separate web contents (`WebContentsView` or the webview path). For site interactions such as context menus, clipboard, and keyboard events, trace the event across the page, preload bridge, and main-process handler; renderer-only tests do not verify the website surface.
- Keep the security boundary in `main.cjs`: renderer windows use `contextIsolation`, `sandbox`, and `nodeIntegration: false`. Expose narrow APIs through `preload.cjs`; do not expose unrestricted IPC or Node access.
- Shared policy and tab behavior live under `lib/` and have focused tests under `tests/`. The standalone `Linsoft centrum app/` is a separately packaged UI; preserve its protocol handoff when changing it.

## Validation
- Run `npm test` for project validation and the Node test suites. This does not exercise the full Electron UI or loaded websites; manually verify relevant workflows in the app when changing them, and state clearly when runtime verification was not possible.
- `npm start` launches the development app. Auto-update is only active in a packaged Windows build, so updater changes must be checked in that environment.
- For Debian packaging, follow [.github/skills/debian-packaging/SKILL.md](.github/skills/debian-packaging/SKILL.md). For release gates and artifact expectations, see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
- Use [README.md](README.md) for setup and common commands. Avoid treating existing `dist*` output as source code.

## Release Safety
- Do not publish, push, create release tags, or run `tools/publish-github.ps1` unless the user explicitly requests publication. That script can commit and push repository changes and create a version tag.
- Keep changes scoped to the requested behavior; add or update focused tests for changes to logic in `lib/`.