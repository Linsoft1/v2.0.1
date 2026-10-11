#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -ne 1 || ! ${1^^} =~ ^[A-F0-9]{40}$ ]]; then
  echo "Usage: sudo bash enable-debian-auto-updates.sh VERIFIED_SIGNING_FINGERPRINT" >&2
  exit 1
fi
fingerprint=${1^^}
[[ $EUID -eq 0 ]] || { echo "Run this setup as root using sudo." >&2; exit 1; }
source /etc/os-release
[[ ${ID:-} == debian ]] || { echo "This setup is intended for Debian." >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { echo "Only amd64 packages are currently published." >&2; exit 1; }
for tool in curl gpg apt-get systemctl; do
  command -v "$tool" >/dev/null || { echo "Install the prerequisite tool first: $tool" >&2; exit 1; }
done
systemctl is-active --quiet timers.target || { echo "Active systemd timers are required." >&2; exit 1; }

repository=https://linsoft1.github.io/v2.0.1/apt
temporary=$(mktemp -d)
trap 'rm -f "$temporary/keyring.gpg"; rmdir "$temporary"' EXIT
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
  "$repository/linsoft-browser-archive-keyring.gpg" -o "$temporary/keyring.gpg"
key_info=$(gpg --batch --with-colons --show-keys "$temporary/keyring.gpg")
primary_count=$(printf '%s\n' "$key_info" | awk -F: '$1 == "pub" { count++ } END { print count+0 }')
actual_fingerprint=$(printf '%s\n' "$key_info" | awk -F: '$1 == "fpr" { print $10; exit }')
[[ $primary_count == 1 && $actual_fingerprint == "$fingerprint" ]] || {
  echo "Repository signing key does not match the independently verified fingerprint." >&2
  exit 1
}
install -d -m 0755 /etc/apt/keyrings
install -m 0644 "$temporary/keyring.gpg" /etc/apt/keyrings/linsoft-browser.gpg
cat > /etc/apt/sources.list.d/linsoft-browser.sources <<'EOF'
Types: deb
URIs: https://linsoft1.github.io/v2.0.1/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/linsoft-browser.gpg
EOF
apt-get -o APT::Update::Error-Mode=any update
apt-get install -y unattended-upgrades linsoft-browser
cat > /etc/apt/apt.conf.d/52linsoft-browser-updates <<'EOF'
Unattended-Upgrade::Origins-Pattern:: "origin=Linsoft Browser,codename=stable";
EOF
cat > /etc/apt/apt.conf.d/92linsoft-browser-periodic <<'EOF'
APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
echo "Linsoft Browser APT updates enabled. Existing Debian unattended-upgrade rules remain in effect."
echo "Verify with: sudo unattended-upgrade --dry-run --debug"
echo "Restart Linsoft Browser after an update; this setup does not reboot the computer."
