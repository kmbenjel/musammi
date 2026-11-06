#!/usr/bin/env bash
# The two pictures under step 4 of the guide («ثبّته على هاتفك»): Chrome on Android and Safari on iPhone, drawn
# (not screenshotted) from scripts/install_images/*.html in the guide's own night, saffron ink and fonts, by Chrome
# at 2x. Google Fonts: needs the network. Output: client/public/install/{android,iphone}.webp.
#
#   scripts/build_install_images.sh [out_dir]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
CHROME=${CHROME:-google-chrome}
SRC=scripts/install_images
OUT=${1:-client/public/install}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$OUT"

for name in android iphone; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=720,640 --virtual-time-budget=8000 --user-data-dir="$tmp/profile" \
    --screenshot="$tmp/$name.png" "file://$PWD/$SRC/$name.html" 2>/dev/null
  cwebp -quiet -q 86 "$tmp/$name.png" -o "$OUT/$name.webp"
  [[ ${KEEP_PNG:-} ]] && cp "$tmp/$name.png" "$OUT/$name.png"
done
identify "$OUT"/*.webp
