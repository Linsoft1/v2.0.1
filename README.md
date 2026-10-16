# Linsoft Browser

Linsoft Browser is a desktop browser for Windows and Linux Debian, focused on a clean interface, quick web access, bookmarks, app installs, and basic privacy controls.

## Features

- Browser tabs and navigation
- Browser tabs use theme-aware rounded styling, a clear active underline, stable site icons, larger close/audio targets and keyboard focus indicators. Pinned tabs remain compact, loading indicators respect reduced-motion preferences, and the active page is marked for assistive technology.
- Focused tabs support Left/Right arrows and Home/End in their visible order, and Delete or middle-click to close. Pinned/locked tabs retain their close protection; accessible names and tooltips include pinned, locked and muted states.
- When tabs overflow, the tab strip scrolls horizontally without a visible scrollbar and brings the selected tab into view. New-tab and window controls stay outside the scrolling area.
- Window controls use consistent SVG icons, larger focusable targets and a distinct close highlight. Maximize/restore, full-screen and always-on-top indicators reflect actual Electron window events rather than guessing from clicks.
- Address suggestions identify bookmark/history/open-tab sources, match multi-word names without diacritics and show keyboard hints. Matching open tabs activate directly; unmatched queries can be searched. Connection details distinguish HTTP, HTTPS and internal content without claiming HTTPS guarantees a trustworthy site.
- A branded Linsoft warning appears directly inside the affected tab when connecting to local devices with untrusted HTTPS certificates, including private IPv4/IPv6 and `.local` addresses. It hides URL paths and query data, focuses the safe return action, explains common certificate errors, and exposes technical details accessibly. Explicit approval temporarily permits certificate errors only for the same local device's HTTPS/WSS resources on any port in that tab; the in-memory approval clears when navigating to another device and is never stored on disk.
- Optional USB camera auto-start is off by default. When enabled in Privacy settings, Linsoft authorizes its internal page to identify camera devices without starting capture; connecting a new video input opens a dedicated camera tab with a visible live indicator and stop control. The video-only capture stops when switching tabs, and camera access is never granted to websites.
- Privacy settings also offer explicit camera and microphone tests. The camera test shows a temporary preview; the microphone test displays an input-level meter. Both tests stop when leaving settings or switching tabs, and their narrowly scoped internal permissions are released when stopped.
- The browser menu has grouped tools, consistent icons and shortcut hints, with direct entries for Linsoft Chat and Linsoft Office. The searchable open-tab overview (Ctrl+Shift+A) follows visible tab order and supports arrows, Enter and Escape.
- Bookmarks and history offer combined name/address search, sorting and result counts. The bookmark library uses responsive cards with site icons, readable site labels, quick-access pin controls and a helpful first-use empty state. History can be filtered by date range, groups visits by day, shows recent-activity summaries, and supports undo after removing one or all entries; bookmark actions retain their original targets after sorting/filtering.
- The bookmarks bar scrolls horizontally when it overflows, with discoverable left/right controls, mouse-wheel support, keyboard-accessible bookmark buttons and a clear empty state.
- The start page has a responsive weather card using the device location only after permission; first-use instructions explain how to start the lookup and allow location access. Coordinates are rounded to roughly 1 km and sent to Open-Meteo for current conditions. The approximate location and last forecast are cached locally for quick display and offline fallback. Refreshing weather does not re-request location; a separate action changes it. The card shows temperature, conditions, humidity, wind, daily high/low and the forecast update time. Settings can hide weather, the footer or individual quick-access links without deleting bookmarks or saved favorites.
- The toolbar's labeled Tools control remains discoverable when its extra buttons are collapsed, including at narrower window sizes.
- Appearance settings include dark, light and Glass Blue themes, compact chrome and three browser-interface text sizes; web page zoom remains independent.
- Named tab groups retain their color/name in the restored session, can be renamed together, and can be closed as a group from the tab context menu.
- The connection panel lists permissions for the active site. Clearing that site's cookies and storage requires confirmation and is restricted in the main process to the actual active HTTP(S) origin; matching saved permissions are cleared too.
- Bookmarks and history
- Home/start page
- Branded loading and connection-error screens with the Linsoft Browser logo, retry and address-check actions
- Stop loading from the toolbar or loading screen; a per-tab warning appears after 15 seconds and clears when loading stops
- Connection-error screens offer Home and expandable technical details; onion loading shows the live Tor proxy state (manual proxies are not reported as verified Tor)
- Web app installation support
- Drag an unlocked web or local-file tab outside the tab strip to move it into a new Linsoft Browser window; the source tab closes only after the target confirms the transfer.
- Download history can be cleared with confirmation without hiding active downloads or deleting files already saved on disk.
- App center
- Integrated App Center uses the full tab area with a responsive catalog grid and page scrolling
- Settings use the full tab area, with a sidebar on large windows and horizontal section navigation on smaller windows
- The Settings page hides its scrollbar while retaining mouse-wheel, touchpad and keyboard scrolling.
- The Settings logo has a softly glowing light ring that follows its rounded frame; reduced-motion preferences keep it static.
- About uses the official Linsoft logo with the same light frame in a responsive app identity card.
- License terms in About are presented as numbered, responsive blocks with larger text, headings and framed icons, without changing the existing terms.
- Updates includes a branded installed-version card, explicit checking/error/ready states and an accessible download progress bar. Preview and development builds report update unavailability rather than claiming to be current; installation requires the packaged Windows app.
- Update states use distinct icons and accents, errors offer retry, and the last check time is displayed when supplied by the updater.
- Advanced settings are grouped into protection, downloads, tabs, language/measurement tools and Tor/proxy, with keyboard-accessible section shortcuts. Existing controls retain their save and immediate-action behavior.
- Advanced groups can be collapsed individually or all at once without losing edits. Search results and section shortcuts reopen the relevant group automatically.
- Tor/proxy has separate live connection cards, labeled SOCKS fields and a distinct hosting section. Manual proxy actions apply immediately; hosting shares the selected folder independently of Tor browsing.
- OpenVPN includes labeled profile/connection cards and a larger keyboard-accessible log with a display-only clear action. Saved profile names appear when opening settings; cancelling profile selection keeps the previous profile.
- OpenVPN requires a selected profile before connecting, prevents duplicate connection requests, and supports cancelling an in-progress connection. Disconnecting waits for the client to exit; state messages do not claim a connection before client confirmation.
- Advanced group expansion is remembered locally across settings reopening and app restarts, independently of saved browser preferences.
- Downloads has active/completed totals, responsive status cards, accessible progress (including unknown-size transfers), size/speed details and per-file folder shortcuts.
- Downloads includes a searchable file list combined with status filters, summary tiles and contextual empty states. Failed/cancelled transfers have distinct indicators; displayed speeds are labeled as averages. Removing an entry is labeled as history-only, not deletion from disk.
- The Downloads panel hides its scrollbar while retaining mouse-wheel, touchpad and keyboard scrolling.
- Settings include accent-insensitive search, explicit save/discard controls, preserved drafts when switching tabs, and a separate live Tor/manual-proxy/OpenVPN overview. Leaving an edited settings page requires confirmation; section changes keep edits. Theme changes apply after saving, while connection actions apply immediately.
- Settings navigation includes section descriptions and keyboard focus indicators; theme-aware cards and connection indicators improve readability. The sticky save/discard bar follows all settings, including management controls.
- App Center dashboard includes the Linsoft logo, live app/favorite totals, section shortcuts and an accessible filtered catalog result count
- Downloads panel
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

## Validate the project

```powershell
& "C:\Users\Martin\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\npm.cmd" test
```

The live Tor hosting smoke test is separate because it requires a working Tor network connection. It uses an isolated temporary Tor data directory and an automatically selected local SOCKS port; it does not reuse or unlock another Tor instance's data:

```powershell
npm run test:tor
```

Navigation UI checks launch isolated Electron profiles for both tab engines, verify the real 15-second slow-load threshold, stopping website requests, error recovery, controlled Tor status updates, settings search, saved/discarded drafts, tab-switch preservation, departure/close guards, remembered advanced groups, VPN button availability, the OpenVPN status API, and real downloads from a local test website. Downloads are checked for saved contents, completed progress, unknown-size progress, failure filtering and clearing history while preserving active downloads. VPN process lifecycle tests in `npm test` use controlled process events without changing network routing. Neither suite establishes a real VPN connection or downloads a packaged application update:

```powershell
npm run test:navigation
```

Stopping an onion navigation cancels that tab's pending navigation, not the shared Tor service used by other tabs.

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
