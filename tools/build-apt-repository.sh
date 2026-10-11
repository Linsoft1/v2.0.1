#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -ne 3 ]]; then
  echo "Usage: bash tools/build-apt-repository.sh PACKAGE.deb OUTPUT_DIRECTORY SIGNING_FINGERPRINT" >&2
  exit 1
fi
package=$(realpath "$1")
output=$(realpath -m "$2")
fingerprint=${3^^}
[[ $fingerprint =~ ^[A-F0-9]{40}$ ]] || { echo "A full signing fingerprint is required." >&2; exit 1; }
for tool in dpkg-deb dpkg-scanpackages apt-ftparchive gpg gzip; do
  command -v "$tool" >/dev/null || { echo "Missing repository tool: $tool" >&2; exit 1; }
done
[[ -f "$package" ]] || { echo "Debian package not found." >&2; exit 1; }
[[ ! -e "$output" ]] || { echo "Repository output must not exist; refusing to overwrite it." >&2; exit 1; }
[[ $(dpkg-deb -f "$package" Package) == linsoft-browser ]] || { echo "Unexpected Debian package name." >&2; exit 1; }
version=$(dpkg-deb -f "$package" Version)
architecture=$(dpkg-deb -f "$package" Architecture)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Only stable numeric package versions are supported." >&2; exit 1; }
[[ $architecture == amd64 ]] || { echo "This repository currently supports amd64 only." >&2; exit 1; }
gpg --batch --list-secret-keys "$fingerprint" >/dev/null

mkdir -p "$output/pool/main/l/linsoft-browser" "$output/dists/stable/main/binary-amd64"
cp "$package" "$output/pool/main/l/linsoft-browser/linsoft-browser_${version}_${architecture}.deb"
cd "$output"
dpkg-scanpackages --multiversion pool /dev/null > dists/stable/main/binary-amd64/Packages
gzip -n -k dists/stable/main/binary-amd64/Packages
valid_until=$(date -u -d '+30 days' '+%a, %d %b %Y %H:%M:%S UTC')
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="Linsoft Browser" \
  -o APT::FTPArchive::Release::Label="Linsoft Browser" \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Components=main \
  release dists/stable > dists/stable/Release
printf 'Valid-Until: %s\n' "$valid_until" >> dists/stable/Release
printf '%s' "${LINSOFT_APT_PASSPHRASE:-}" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
  --local-user "$fingerprint" --digest-algo SHA256 --clearsign \
  --output dists/stable/InRelease dists/stable/Release
printf '%s' "${LINSOFT_APT_PASSPHRASE:-}" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
  --local-user "$fingerprint" --digest-algo SHA256 --armor --detach-sign \
  --output dists/stable/Release.gpg dists/stable/Release
gpg --batch --export-options export-minimal --export "$fingerprint" > linsoft-browser-archive-keyring.gpg
gpg --batch --verify dists/stable/InRelease
gpg --batch --verify dists/stable/Release.gpg dists/stable/Release
echo "Signed APT repository built for Linsoft Browser $version ($architecture)."
