#!/bin/bash
# Linux (Debian/Ubuntu): nainštaluje Linsoft Runtime a otestuje Linsoft Browser .lsr.
# Spusti v termináli na ploche:   bash spusti-test.sh
# Výsledok sa uloží do vysledok-testu.txt v tomto priečinku.
set -u
cd "$(dirname "$(readlink -f "$0")")"
DEB=$(ls Linsoft-Runtime-*-amd64.deb 2>/dev/null | head -1)
LSA=$(ls Linsoft-Browser-*.lsr 2>/dev/null | head -1)
LOG="$PWD/vysledok-testu.txt"
exec > >(tee "$LOG") 2>&1

echo "=== Linsoft Linux test · $(date '+%Y-%m-%d %H:%M:%S')"
. /etc/os-release 2>/dev/null && echo "OS: ${PRETTY_NAME:-?} · $(uname -m) · kernel $(uname -r)"
echo "Používateľ: $USER · obrazovka: ${DISPLAY:-žiadna}${WAYLAND_DISPLAY:+ (Wayland $WAYLAND_DISPLAY)}"
[ -n "$DEB" ] && [ -n "$LSA" ] || { echo "✘ V priečinku chýba Linsoft-Runtime-*.deb alebo Linsoft-Browser-*.lsr"; exit 1; }
echo "Súbory: $DEB, $LSA"
echo

echo "— 0. Inštalácia Linsoft Runtime (môže vypýtať heslo pre sudo)"
if ! sudo dpkg -i "$DEB"; then
  echo "dpkg hlási chýbajúce závislosti, doinštalujem ich…"
  sudo apt-get -f install -y || { echo "✘ Inštalácia runtime zlyhala"; exit 1; }
fi
dpkg -s linsoft-runtime 2>/dev/null | grep -E '^(Status|Version):'
MISSING=$(ldd "/opt/Linsoft Runtime/linsoft-runtime" 2>/dev/null | grep 'not found')
if [ -n "$MISSING" ]; then echo "✘ Chýbajúce knižnice:"; echo "$MISSING"; else echo "✔ všetky systémové knižnice sú prítomné"; fi
ls -l "/opt/Linsoft Runtime/chrome-sandbox" | awk '{print "chrome-sandbox: " $1 " " $3}'
if command -v xdg-mime >/dev/null; then
  echo "typ súboru .lsr: $(xdg-mime query filetype "$PWD/$LSA")"
  echo "otvára ho: $(xdg-mime query default application/x-linsoft-runtime-package)"
fi
echo

ELECTRON_RUN_AS_NODE=1 "/opt/Linsoft Runtime/linsoft-runtime" "$PWD/test-lsr-linux.cjs" "$PWD/$LSA" "$@"
RESULT=$?
echo
echo "Výsledok je uložený v: $LOG"
echo "Linsoft Browser si teraz môžeš nainštalovať naostro dvojklikom na $LSA."
exit $RESULT
