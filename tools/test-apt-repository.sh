#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "$0")/.." && pwd)
temporary=$(mktemp -d)
export GNUPGHOME="$temporary/gnupg"
mkdir -m 700 "$GNUPGHOME"
cleanup() {
  gpgconf --kill gpg-agent
  find "$temporary" -type f -delete
  find "$temporary" -depth -type d -empty -delete
}
trap cleanup EXIT

gpg --batch --pinentry-mode loopback --passphrase '' \
  --quick-generate-key 'Disposable Linsoft APT Test <apt-test@localhost>' rsa2048 sign 1d
fingerprint=$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
mkdir -p "$temporary/package/DEBIAN" "$temporary/package/usr/share/linsoft-apt-test"
printf 'Package: linsoft-browser\nVersion: 2.0.28\nArchitecture: amd64\nMaintainer: Test <apt-test@localhost>\nDescription: Inert APT verification fixture\n' \
  > "$temporary/package/DEBIAN/control"
printf 'Not an executable. No browser is installed by this test.\n' \
  > "$temporary/package/usr/share/linsoft-apt-test/fixture.txt"
dpkg-deb --build "$temporary/package" "$temporary/fixture.deb"
bash "$root/tools/build-apt-repository.sh" "$temporary/fixture.deb" "$temporary/repository" "$fingerprint"
grep -q '^Valid-Until:' "$temporary/repository/dists/stable/Release"
if bash "$root/tools/build-apt-repository.sh" "$temporary/fixture.deb" "$temporary/repository" "$fingerprint"; then
  echo "Builder overwrote an existing repository." >&2
  exit 1
fi
if bash "$root/tools/build-apt-repository.sh" "$temporary/fixture.deb" "$temporary/invalid-repository" invalid; then
  echo "Builder accepted an invalid fingerprint." >&2
  exit 1
fi

mkdir -p "$temporary/state/lists/partial" "$temporary/cache/archives/partial" "$temporary/downloads"
touch "$temporary/status"
printf 'deb [signed-by=%s] file:%s stable main\n' \
  "$temporary/repository/linsoft-browser-archive-keyring.gpg" "$temporary/repository" > "$temporary/sources.list"
apt_options=(
  -o "Dir::Etc::sourcelist=$temporary/sources.list"
  -o "Dir::Etc::sourceparts=-"
  -o "Dir::Etc::main=-"
  -o "Dir::Etc::parts=-"
  -o "Dir::State=$temporary/state"
  -o "Dir::State::status=$temporary/status"
  -o "Dir::Cache=$temporary/cache"
  -o "APT::Sandbox::User=$(id -un)"
  -o APT::Update::Error-Mode=any
)
apt-get "${apt_options[@]}" update
policy=$(apt-cache "${apt_options[@]}" policy linsoft-browser)
grep -q 'Candidate: 2.0.28' <<< "$policy"
cd "$temporary/downloads"
apt-get "${apt_options[@]}" download linsoft-browser=2.0.28
cmp linsoft-browser_2.0.28_amd64.deb "$temporary/fixture.deb"
rm linsoft-browser_2.0.28_amd64.deb
printf 'tampered' >> "$temporary/repository/pool/main/l/linsoft-browser/linsoft-browser_2.0.28_amd64.deb"
if apt-get "${apt_options[@]}" download linsoft-browser=2.0.28; then
  echo "APT accepted a tampered package." >&2
  exit 1
fi
sed -i 's/Origin: Linsoft Browser/Origin: Forged Browser/' "$temporary/repository/dists/stable/InRelease"
if apt-get "${apt_options[@]}" update; then
  echo "APT accepted tampered repository metadata." >&2
  exit 1
fi
sed -i 's/^Valid-Until:.*/Valid-Until: Wed, 01 Jan 2020 00:00:00 UTC/' "$temporary/repository/dists/stable/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase '' --local-user "$fingerprint" \
  --clearsign --output "$temporary/repository/dists/stable/InRelease" "$temporary/repository/dists/stable/Release"
if apt-get "${apt_options[@]}" update; then
  echo "APT accepted expired repository metadata." >&2
  exit 1
fi
echo "APT signature, package hash, version selection and fail-closed checks passed without system installation."
