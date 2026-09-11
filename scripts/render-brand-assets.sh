#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
public_dir="$repository_root/apps/web/public"
site_dir="$repository_root/site"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert is required to render Vidha's PNG icon fallbacks." >&2
  exit 1
fi

# The square SVG is the single source for every app-icon surface.
cp "$public_dir/vidha-icon.svg" "$site_dir/vidha-mark.svg"
cp "$public_dir/vidha-icon.svg" "$public_dir/vidha-mark.svg"
cp "$public_dir/vidha-icon.svg" "$public_dir/vidha-mark-reversed.svg"
python3 - "$public_dir" <<'PYTHON'
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

public = Path(sys.argv[1])
ET.register_namespace('', 'http://www.w3.org/2000/svg')
root = ET.parse(public / 'vidha-icon.svg').getroot()
ns = '{http://www.w3.org/2000/svg}'
background = ET.Element(ns + 'rect', {'width': '512', 'height': '512', 'fill': 'url(#night)'})
artwork = ET.Element(ns + 'g', {'transform': 'translate(51.2 51.2) scale(0.8)'})
for child in list(root):
    if child.tag not in {ns + 'defs', ns + 'title', ns + 'desc'}:
        root.remove(child)
        # The operating system supplies the mask; keep its background full-bleed.
        if child.tag != ns + 'rect':
            artwork.append(child)
root.append(background)
root.append(artwork)
ET.ElementTree(root).write(public / 'vidha-mark-maskable.svg', encoding='unicode')

# Compose the social card from the same passive vector source, without remote assets.
card = ET.Element(ns + 'svg', {'width': '1200', 'height': '630', 'viewBox': '0 0 1200 630'})
ET.SubElement(card, ns + 'rect', {'width': '1200', 'height': '630', 'fill': '#F3F1EB'})
ET.SubElement(card, ns + 'path', {'d': 'M80 530H1120', 'stroke': '#CBC6B8'})
for text, x, y, size, color, family in [
    ('VIDHA / CONTINGENCY RELAY', 80, 95, 18, '#79551D', 'sans-serif'),
    ('Vidha', 76, 245, 112, '#172A50', 'Georgia, serif'),
    ('Brief the handoff.', 80, 337, 44, '#172A50', 'Georgia, serif'),
    ('Rehearse the relay.', 80, 391, 44, '#172A50', 'Georgia, serif'),
    ('PRE-ALPHA  ·  LOCAL SYNTHETIC PROTOTYPE', 80, 571, 17, '#525B78', 'sans-serif'),
]:
    element = ET.SubElement(card, ns + 'text', {'x': str(x), 'y': str(y), 'font-size': str(size), 'fill': color, 'font-family': family})
    element.text = text
icon = ET.parse(public / 'vidha-icon.svg').getroot()
icon.attrib.update({'x': '770', 'y': '140', 'width': '330', 'height': '330'})
card.append(icon)
ET.ElementTree(card).write(public.parent.parent.parent / 'site' / 'og-card.svg', encoding='unicode')
PYTHON
rsvg-convert --width 192 --height 192 --output "$public_dir/pwa-192.png" "$public_dir/vidha-icon.svg"
rsvg-convert --width 512 --height 512 --output "$public_dir/pwa-512.png" "$public_dir/vidha-icon.svg"
rsvg-convert --width 180 --height 180 --output "$public_dir/apple-touch-icon.png" "$public_dir/vidha-icon.svg"
rsvg-convert --width 512 --height 512 --output "$public_dir/pwa-maskable-512.png" "$public_dir/vidha-mark-maskable.svg"
rsvg-convert --output "$site_dir/og-card.png" "$site_dir/og-card.svg"
cp "$public_dir/pwa-192.png" "$site_dir/pwa-192.png"
cp "$public_dir/apple-touch-icon.png" "$site_dir/apple-touch-icon.png"

echo "Rendered app, Apple touch, maskable, and Pages icons from vidha-icon.svg."
