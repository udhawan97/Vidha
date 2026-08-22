#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
public_dir="$repository_root/apps/web/public"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert is required to render Vidha's PNG icon fallbacks." >&2
  exit 1
fi

rsvg-convert --width 192 --height 192 --output "$public_dir/pwa-192.png" "$public_dir/vidha-mark.svg"
rsvg-convert --width 512 --height 512 --output "$public_dir/pwa-512.png" "$public_dir/vidha-mark.svg"
rsvg-convert --width 512 --height 512 --output "$public_dir/pwa-maskable-512.png" "$public_dir/vidha-mark-maskable.svg"

echo "Rendered PWA icon fallbacks from the working-concept SVG sources."
