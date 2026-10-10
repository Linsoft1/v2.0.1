# Linsoft Browser

Linsoft Browser is a desktop browser for Windows and Linux Debian, focused on a clean interface, quick web access, bookmarks, app installs, and basic privacy controls.

## Features

- Browser tabs and navigation
- Bookmarks and history
- Home/start page
- Web app installation support
- App center
- Downloads panel
- Optional exit cleanup clears cookies and shader cache while preserving websites' local storage and IndexedDB
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

## Experimental native tab engine

The native `WebContentsView` tab engine remains opt-in while it receives wider
runtime testing. To try it from PowerShell:

```powershell
$env:LINSOFT_NATIVE_TABS = '1'
npm start
```

Both tab engines now share navigation-history and page-state handling. The
native engine also restores muted tabs, suspends inactive pages, recreates
crashed renderers, and enables Chromium's PDF plugin only for PDF URLs (local
files are validated before opening). `npm test` covers these shared policies
and lifecycle rules. Run `npm run test:electron-smoke` for an isolated,
headless Electron check of startup, local navigation, back/forward, bookmark
suggestions, popup tabs, suspension/restoration and draft preservation in both
tab engines. This smoke test does not cover downloads,
PDF rendering, session restoration, crash recovery, or real websites. Keep the
native engine opt-in until those workflows are manually checked on Windows and
Linux.

To also verify two consecutive address-bar searches against the live Linsoft
Search website, run:

```powershell
$env:LINSOFT_SMOKE_LIVE_SEARCH = '1'
npm run test:electron-smoke
Remove-Item Env:LINSOFT_SMOKE_LIVE_SEARCH
```

This opt-in check submits public test queries to the live service and verifies
that the results view contains links in both tab engines. It requires internet
access. Source changes are used by `npm start`; an already installed executable
needs a rebuilt package to include them.

Linsoft Search queries use a narrowly scoped session preload to hide the initial
search form before rendering. Search starts at DOM readiness rather than waiting
for all page resources. Opening the search homepage without a query is unchanged.
The browser waits up to 10 seconds for the site's search function or form,
submits once, and avoids resubmitting a query already handled by the site.
Failures produce a browser notification. The temporary hiding is removed when
the results view starts, or after 15 seconds with a visible retry message if
initialization fails. The preload exposes no IPC or Node APIs to websites.
Native URL query support still requires a change in the separately hosted Search
project; this repository only contains the browser-side integration.

## Address suggestions and inactive tabs

Address recognition supports domain names (including international names), local
servers, IPv4/IPv6, paths, query strings and fragments. Search phrases stay search
queries; malformed addresses and unsafe schemes are rejected with a notification.
Suggestions are computed locally from history and bookmarks, matching without
diacritics and ranking exact matches above prefixes, then considering bookmarks,
recency and visit count. One-character typos and adjacent swapped letters can
offer similar titles/domains, below literal matches, without changing the typed
address or automatically navigating. Matching open tabs offer a switch action
instead of opening duplicates. Prepared local indexes are rebuilt when history
or bookmarks change; typing is debounced by 80 ms. Guest windows do not show
these suggestions. No suggestion queries are sent to a server.

Local suggestion learning is enabled by default. Selecting a suggestion records
the normalized typed query, canonical destination URL, bounded selection count
and timestamp (at most 200 query/URL pairs). The bonus only changes ordering within
the same match strength; similar spellings cannot displace literal matches.
The advanced settings can disable both recording and personalization, or erase
the learned order. Guest windows never learn. Clearing history/browser data also
erases learned order; removing a history suggestion forgets its destination's
learning. Other browser windows refresh learned data when local storage changes.

When inactive-tab suspension is enabled, the browser checks once a minute and
considers at most two tabs, oldest first. With less than 15% free system RAM the
inactivity threshold is 5 minutes, with at least 40% it is 20 minutes, otherwise
10 minutes. A failed memory measurement is reported and no tabs are unloaded.
Active,
pinned, locked, loading and audio-playing tabs, YouTube, supported Office document
pages and Linsoft Chat are excluded. Before unloading, both engines check for
playing media, live media tracks, editable documents and filled/changed forms,
including same-origin frames. Inaccessible frames conservatively prevent
suspension. Trusted form edits protect the document until navigation/reload, even
after the visible field is cleared; this deliberately favors draft safety.
Selecting a suspended tab reloads its URL. Arbitrary in-memory website state
or calls without DOM media cannot be fully detected. The tab context menu's
“Túto stránku nikdy neuspávať” saves an exception for the exact origin (scheme,
host and port), covering all its tabs. Remove exceptions in the settings'
performance section or using the same menu. Guest exceptions stay in the guest
profile. Pin or lock individual tabs that must not be unloaded.

Among eligible tabs, suspension favors larger measured Chromium processes,
dividing their working set by the number of associated web contents when shared,
then breaking ties by inactivity. This is a prioritization estimate, not exact
per-page allocation or guaranteed freed RAM. The advanced settings' performance
overview shows measured process working sets, shared-process labels and protection
reasons, alongside the existing page-load measurements. Measurements are local,
refreshed on request and during the minute-based suspension check.

Before suspension the browser remembers the top-level URL and scroll position.
After reloading the same URL, both engines restore it with a bounded three-second
layout wait. User interaction cancels restoration; navigation to another URL
does not receive the old position. Changed layouts may prevent exact restoration
and produce a notification. Nested-frame scroll positions and arbitrary website
application state are not restored.

A narrow isolated preload records trusted edits and installs main-world activity
tracking before website scripts. Open RTCPeerConnection objects (even while
connecting), pending/live camera, microphone or display-capture tracks, non-read
fetch requests and XHR requests prevent suspension. Closing peers, stopping
capture tracks or finishing requests releases that protection; edits remain
protected until document navigation. Browser downloads also protect their source
web contents. Frame reports are kept in the main process; no general-purpose IPC
or Node API is exposed to websites. These are conservative detectors, not a
universal guarantee: workers, unusual native API replacements, cloned media
tracks, socket uploads without tracked peers and browser-native form submissions
may need an explicit never-suspend exception.

When a renderer crashes, its tab shows an explicit recovery screen instead of
reloading on selection. Recovery recreates only the selected tab, preserves its
browser navigation history and warns that unsaved site edits may have been lost.
The crash marker survives session restoration, so restarting the browser does
not silently reload a previously crashed document.
Tabs sharing the crashed Chromium process may all be affected. This does not
recover documents from renderer memory or replace website autosave/backups.

## Website hosting

The static website and its optimized, locally hosted browser screenshots are in
[`docs/`](./docs/). GitHub Actions deploys it to
[GitHub Pages](https://linsoft1.github.io/v2.0.1/) when changes to that folder
are pushed to `main`. Before the first deployment, enable GitHub Pages in the
repository settings under **Settings > Pages**, with **GitHub Actions** as the
build and deployment source.

## License

Original Linsoft Browser source code is released under the [MIT License](./LICENSE).
You may use, modify, redistribute, and sell it, provided the copyright and
license notice are included. Third-party libraries, trademarks, and third-party
content shown in website screenshots retain their own licenses and are not
relicensed by the Linsoft license.

## Validate the project

```powershell
& "C:\Users\Martin\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\npm.cmd" test
```

The live Tor hosting smoke test is separate because it requires a working Tor network connection:

```powershell
npm run test:tor
```

## Google sign-in and website device registration

Google can reject sign-in with "This browser or app may not be secure". Linsoft
Browser detects Google's `deniedsigninrejected`, `disallowed_useragent`, and
`restricted_useragent` error URLs in regular and native tabs, including popups.
It offers to restart at the originating website's home address in an installed
Microsoft Edge or Google Chrome on Windows, or Google Chrome, Firefox, or
Microsoft Edge on Linux. If none is found, the address can be copied manually.
The selected browser is launched directly, avoiding a loop when Linsoft Browser
is the system default.

This is a fallback, not a bypass of Google's sign-in restrictions. Only the
website origin is passed; paths, query parameters, fragments, passwords, cookies,
and OAuth tokens are not transferred. Sign-in and any device registration must
be restarted and completed in the other browser. Its own profile is used even
when the originating Linsoft Browser window is a guest window; a confirmation
is required before launching it. This does not sign the user into the original
Linsoft Browser tab or add USB/passkey device support.

`npm test` includes offline tests for rejected sign-in detection, popup origin
tracking, subframe isolation, safe launch arguments, and launch failures.
Actual Google sign-in and device registration still require a manual test on
the affected website with the user's device and account.

## Onion chat 1:1

Open Settings > Advanced > Tor Hosting and choose **Otvoriť chat** to open the dedicated Onion Chat tab. One person creates an invitation and shares it privately by QR code or link; the other can scan it with **Naskenovať QR** or paste it. Camera access is requested only for scanning or a call and is released when that action ends. The invitation accepts one guest, expires after 15 minutes if unused, and can be replaced with **Vytvoriť novú pozvánku** after expiry. Both participants must keep Linsoft Browser running. The app retries interrupted Tor connections with increasing delays and restarts a failed Tor transport while retaining the in-memory room. Chat messages, delivery/read receipts, and active file transfers are held in memory only; stopping the chat or closing the app clears them. Messages show sent, delivered, and read status. Read receipts are sent only while the recipient's Onion Chat tab is active and visible. Attachments are end-to-end encrypted in 24 KiB chunks and limited to 2 MiB; the recipient explicitly chooses **Uložiť súbor**, and files are never opened automatically. Both participants can enable **Video hovor** for an end-to-end encrypted, video-only feed relayed through Tor; it has a low frame rate and no audio, and does not use direct WebRTC connections. Only the latest frame is kept in memory. The invitation contains the room access token and encryption key, so treat it like a password. A new invitation is required after the host restarts the app.

Linsoft Browser opens existing local PDF files in its embedded viewer. PDF opening uses the Chromium viewer inside an isolated webview; the PDF plugin is enabled only for PDF URLs.

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
