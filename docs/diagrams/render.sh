#!/usr/bin/env bash
# Render every diagram in this folder to docs/images/<name>-light.png and <name>-dark.png at 2x, with headless Chrome.
# Usage: bash docs/diagrams/render.sh   (set CHROME to override the browser path)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../images"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p "$out"
for page in "$here"/*.html; do
  name="$(basename "$page" .html)"
  # Each page declares its size in <meta name="size" content="W,H">.
  size="$(grep -o 'name="size" content="[0-9]*,[0-9]*"' "$page" | grep -o '[0-9]*,[0-9]*')"
  for theme in light dark; do
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size="$size" --screenshot="$out/$name-$theme.png" "file://$page?theme=$theme" >/dev/null 2>&1
    echo "$out/$name-$theme.png"
  done
done
