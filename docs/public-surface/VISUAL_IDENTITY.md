# Courier visual identity

Local visual update, 10 September 2026. Vidha remains a synthetic pre-alpha prototype; the name and identity still require clearance.

## Direction

An ivory courier bird carries an amber Envelope inside a rounded midnight-blue tile. The interface pairs that dimensional icon with warm paper, restrained Newsreader headings, Manrope controls, clear navigation symbols, and stationery-inspired Envelope cards. Dark appearance uses the same icon against deep blue working surfaces.

The overview illustration is decorative. It never represents a delivery, active timeline, security guarantee, or Release decision. The Plan status, available actions, and existing confirmations remain authoritative.

## Assets

`apps/web/public/vidha-icon.svg` is the single icon source. Run:

```sh
bash scripts/render-brand-assets.sh
```

The generator requires Python 3 and `rsvg-convert` (librsvg). It produces the 192/512 px app icons, 180 px Apple touch icons, full-bleed maskable icon, compatibility SVG aliases, project-page icon, and 1200×630 social preview. README and application navigation use the canonical square SVG directly. The maskable artwork is inset to protect the bird and Envelope from operating-system masks. The tile itself has rounded corners; its maskable variant leaves the outer background full-bleed.

The assets contain paths and gradients, with no embedded scripts, remote images, fonts, or network dependencies. The social preview uses local system fonts when regenerated, so its text rasterization may vary by machine.

## Performance and motion

No dependency, canvas renderer, video, animation timer, or additional state effect was added. The existing fonts remain unchanged. The icon enters once over 700 ms using a CSS transform. It is static under reduced motion, and the timeline courier no longer animates perpetually. Hover transitions are short and honor the existing reduced-motion override.

Local Vite output before/after:

| Measure                   |     Before |      After |
| ------------------------- | ---------: | ---------: |
| Main JavaScript, gzip     |   96.02 kB |   96.42 kB |
| CSS, gzip                 |   13.28 kB |   14.10 kB |
| Complete offline precache | 585.22 KiB | 704.23 KiB |

The larger offline cache comes mainly from the richer PNG icon fallbacks and new Apple touch icon. These are static assets, not an ongoing rendering cost. These measurements describe bundle sizes, not a device benchmark or an assertion that every device runs faster.

## Local verification

- All 56 desktop/mobile WebKit browser tests pass; the final dark-hover correction also passed the four affected icon/accessibility checks.
- Automated accessibility checks cover Overview, Envelopes, and Guide in light and dark appearance, plus existing dialog checks.
- Existing responsive checks cover 320, 375, 414, 768, and 1440 px; primary actions, editor navigation, file decisions, and timeline stages remain reachable.
- Icon checks cover square display, passive SVG hygiene, maskable insetting, bounded entrance motion, and reduced-motion stability.
- README image is an actual local production-build screenshot with disposable synthetic data.
- Formatting, lint, type checking, production build, documentation validation, and runtime tests passed. The 31 application component tests passed in isolation at their existing timeout; an unchanged baseline also passed in isolation. Aggregate component runs remained intermittent (five-second time limits and an immediate assertion against an unfinished async Check-in). The aggregate `pnpm check` is therefore not claimed clean. No test timeout or assertion was loosened.

Obscura refused private loopback access. Native Safari capture failed at the computer-use connection, so no native Safari acceptance is claimed. Site assets were changed locally; deployment and live-byte parity are separate work.

Graphify refreshed the code graph and resolved `CourierScene`, `Overview`, and `ContinuityLine`. It still reports missing SQL-parser coverage and four generated JSON files with no extracted nodes; those warnings do not establish semantic coverage of the artwork or documents.
