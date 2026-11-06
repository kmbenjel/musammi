#!/usr/bin/env bash
# The 1200×630 link previews named by the og:image tags of the three pages (client/public/og/), drawn by Chrome
# in the app's own night, saffron ink and fonts (Google Fonts: needs the network). The orb and the title stay in
# the centre square because WhatsApp crops small previews to it. No figures that change, like the sponsorship goal:
# scrapers keep an image for weeks.
#
#   scripts/build_og_images.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
CHROME=${CHROME:-google-chrome}
OUT=client/public/og
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$OUT"

# name  title  line  small
render() {
  cat > "$tmp/$1.html" <<EOF
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Reem+Kufi:wght@500;600&family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: radial-gradient(130% 70% at 50% 118%, #4a3a6e 0%, transparent 62%), #101634;
    color: #efe4cc;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    position: relative;
  }
  .orb { position: relative; width: 196px; height: 196px; margin-bottom: 26px; }
  .orb::before {
    content: ''; position: absolute; inset: 0; border-radius: 50%;
    border: 2px solid rgba(217, 180, 95, 0.3);
    background: radial-gradient(circle, rgba(217, 180, 95, 0.32) 34%, transparent 70%);
  }
  .orb::after {
    content: ''; position: absolute; inset: 50px; border-radius: 50%;
    background: radial-gradient(circle at 36% 32%, #f0dcaa 0%, #d9b45f 42%, #9c8145 100%);
  }
  h1 { font: 600 92px/1.3 'Reem Kufi', sans-serif; }
  .line { font: 500 40px/1.45 'Tajawal', sans-serif; color: #d9b45f; margin-top: 6px; }
  .small { font: 400 28px/1.5 'Tajawal', sans-serif; color: #b9b29f; margin-top: 8px; }
  .site { position: absolute; bottom: 26px; font: 500 22px/1 'Tajawal', sans-serif; color: #8a8ca6; direction: ltr; }
</style>
</head>
<body>
  <div class="orb"></div>
  <h1>$2</h1>
  <p class="line">$3</p>
  <p class="small">$4</p>
  <p class="site">musammi.benjelloun.dev</p>
</body>
</html>
EOF
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1200,630 --virtual-time-budget=8000 --user-data-dir="$tmp/profile" \
    --screenshot="$PWD/$OUT/$1.png" "file://$tmp/$1.html" 2>/dev/null
}

render app 'المُسَمِّع' 'شيخ يسمع حفظك للقرآن بصوتك' 'يسكت على الصواب، ويقول «أعِد» عند الخطأ، ويفتح عليك إذا نسيت'
render guide 'كيف تبدأ' 'مفتاح مجاني من Google، في نحو دقيقتين' 'أربع خطوات، ثم يسمع المُسَمِّع حفظك على هاتفك'
render support 'ادعم المُسَمِّع' 'مجاني ومفتوح المصدر، ويطوّره شخص واحد' 'PayPal · GitHub Sponsors · تحويل بنكي'
identify "$OUT"/*.png
