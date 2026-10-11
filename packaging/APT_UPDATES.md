# Debian automatic updates through APT

This is an opt-in setup for Debian amd64 with systemd. It installs updates using
APT and unattended-upgrades, not a privileged Electron IPC handler. The browser's
automatic-check toggle only controls in-app notifications; system APT updates
have separate administrator-controlled settings.

## Repository publication prerequisites

The repository is published alongside the website at
`https://linsoft1.github.io/v2.0.1/apt/`. The Pages workflow downloads the latest
stable amd64 release asset and builds a signed repository with only that package.
The package is not added to Git history. The existing 2.0.27 package is about
175 MiB; Pages allows a site up to 1 GB and has a soft 100 GB/month transfer limit.
The workflow checks total site size before uploading. Consider dedicated hosting
if downloads approach the bandwidth limit.

Before deploying, create a dedicated archive-signing GPG key on a trusted
administrator machine. For example:

```sh
gpg --full-generate-key
gpg --list-secret-keys --keyid-format long
gpg --fingerprint KEY_ID
```

Use a signing-capable key, protect its passphrase and keep an offline backup.
Configure these in the repository's GitHub Actions settings:

- Secret `LINSOFT_APT_PRIVATE_KEY`: armored export of that dedicated secret key
  (`gpg --armor --export-secret-keys FULL_FINGERPRINT`).
- Secret `LINSOFT_APT_PASSPHRASE`: the key passphrase.
- Variable `LINSOFT_APT_FINGERPRINT`: the full 40-character primary fingerprint.
- Variable `LINSOFT_APT_ENABLED`: set to `true` only after signing is configured.
  Until enabled, Pages deploys the website only and explicitly reports that APT
  publication is disabled. Do not disable it after clients are enrolled without
  planning repository retirement, as a website-only deployment removes APT files.

Do not commit or paste the private key/passphrase into chat, logs, or source.
Publish the public fingerprint through an independently trusted channel before
asking users to enable the repository. Key rotation requires distributing and
verifying the replacement key; the installer deliberately rejects mismatches.

When APT is enabled, Pages deployment fails explicitly if signing configuration or a stable release
is missing; the previous deployed site remains available. Publication runs on
website/repository-tool changes, stable release publication, manual dispatch,
completion of the release workflow, and weekly refresh. Signed metadata expires after 30 days. Monitor workflow
failures and signing-key expiry: clients must reject stale or invalid metadata.
Do not disable APT signature or expiry checks to work around a failure.

## One-time administrator setup on Debian

Wait until the signed repository is deployed. Obtain and independently verify
the public fingerprint. Install prerequisites (`curl`, `gnupg`, CA certificates)
using Debian's package manager, then download and inspect the setup script:

```sh
curl --fail --proto '=https' --proto-redir '=https' --location \
  https://linsoft1.github.io/v2.0.1/apt/enable-debian-auto-updates.sh \
  -o enable-debian-auto-updates.sh
less enable-debian-auto-updates.sh
sudo bash enable-debian-auto-updates.sh VERIFIED_40_CHARACTER_FINGERPRINT
sudo unattended-upgrade --dry-run --debug
systemctl list-timers apt-daily.timer apt-daily-upgrade.timer
```

The setup verifies the downloaded key's primary fingerprint and scopes trust to
this repository with `Signed-By`. It installs Linsoft Browser and
unattended-upgrades, adds the Linsoft origin to allowed upgrade sources, and
enables daily APT package-list refresh and installation through systemd timers.
Existing Debian unattended-upgrade rules (including security updates) remain in
effect. Their blacklist/pinning rules can still prevent Linsoft upgrades; inspect
the dry-run output. Timers use the distribution's randomized schedule, not an
instant upgrade on every browser launch.

Updates do not force-close the browser or request a computer reboot. Restart
Linsoft Browser after an update to load its new version. Logs are available under
`/var/log/unattended-upgrades/` and in the APT service journal.

To stop automatic Linsoft upgrades without disabling Debian security updates,
remove only `/etc/apt/apt.conf.d/52linsoft-browser-updates`. To stop receiving
packages from this repository, also remove its
`/etc/apt/sources.list.d/linsoft-browser.sources` and
`/etc/apt/keyrings/linsoft-browser.gpg`, then run `sudo apt-get update`.
The periodic configuration `/etc/apt/apt.conf.d/92linsoft-browser-periodic`
can be removed to restore the previous periodic settings; do not disable shared
APT timers if other packages still use them.

## Validation before production

- Build with a disposable signing key and an actual Debian package.
- Verify both signatures, index hashes, package name/version/architecture, and
  APT retrieval using an isolated APT configuration.
- Confirm installation and a subsequent upgrade on a disposable Debian VM.
- Confirm dry-run unattended-upgrades selects Linsoft without altering other
  configured origins.
- Confirm wrong keys, expired metadata, changed payloads, and missing packages
  fail closed.
- No repository or system setup is active merely because these source files exist.
