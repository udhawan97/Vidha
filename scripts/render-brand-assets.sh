#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
public_dir="$repository_root/apps/web/public"
site_dir="$repository_root/site"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert is required to render Vidha's PNG icon fallbacks." >&2
  exit 1
fi

rsvg-convert --width 192 --height 192 --output "$public_dir/pwa-192.png" "$public_dir/vidha-mark.svg"
rsvg-convert --width 512 --height 512 --output "$public_dir/pwa-512.png" "$public_dir/vidha-mark.svg"
rsvg-convert --width 512 --height 512 --output "$public_dir/pwa-maskable-512.png" "$public_dir/vidha-mark-maskable.svg"
rsvg-convert --width 192 --height 192 --output "$site_dir/pwa-192.png" "$site_dir/vidha-mark.svg"

echo "Rendered app and Pages icon fallbacks from the Vidha courier SVG sources."
