# Roadmap

This roadmap describes intent, not shipped capability or a delivery date.

## Foundation — in progress

- Canonical domain language and accepted ADRs
- Product and user-journey definition
- Threat model and v1 release gates
- Primary-source competitive research
- Truthful pre-alpha README and GitHub community files
- Pure deterministic Check-in timeline through Concern, with injected time and idempotent commands
- Responsive local PWA prototype using synthetic, in-memory data
- Temporary Markdown/plain-text import, editing, preview, and export
- Unit, component, build, documentation, accessibility, PWA, desktop-WebKit, and mobile-WebKit checks
- Fable implementation and release handoff

The next foundation slice must decide authentication and persistence boundaries before accepting real data. Guardian authority, Veto Window, Delivery Hold, Automatic Fallback, and Release remain outside the implemented state machine.

## Version 1 candidate — planned

- Installable, responsive web app with a verified update journey
- Single-Owner Contingency Plans
- Guardians, Recipients, and recipient-specific Envelopes
- Focused rich-text and Markdown-compatible editor
- Supported document conversion and preserved Attachments
- Envelope-wide Standard Mode plus Sealed Mode only if its protocol, recovery, review, and test-vector gates pass
- Per-Envelope Guardian and Automatic Fallback policies
- Authenticated Check-ins, Concern workflow, Veto Window, and idempotent Release
- Email notification adapter and documented SMS/BYOK boundary
- Hosted deployment plus self-hosting documentation
- Safe demo data, accessibility coverage, observability, backups, and restore rehearsal
- Verified README, website, screenshots, deployment, and v1 release artifacts

## Later possibilities — uncommitted

- Native desktop clients when a concrete offline or OS-integration need justifies them
- Additional delivery providers and independent redundancy
- More import/export formats where round-trip fidelity can be proven
- Shared or professional workflows only after a separate consent and authority model
