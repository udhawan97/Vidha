# Pre-alpha product fact sheet

- **Evidence date:** 2026-08-16
- **Repository stage:** documentation-only foundation
- **Release status:** no runnable build, hosted service, download, updater, tag, or GitHub release

This file is the compact truth source for the current public surface. Fable must rebuild it from the release candidate during `refresh-docs`; changing a status here is not evidence that a capability exists.

## Current facts

| Topic | Verified current fact | Evidence |
| --- | --- | --- |
| Name | Viraha is provisional; the exact GitHub account and three recently active exact-name repositories were found, and broader legal clearance is incomplete | [Competitive landscape name-collision evidence](../research/GITHUB_COMPETITIVE_LANDSCAPE.md#working-name-collision-check-viraha) |
| Product | Proposed personal contingency relay for one adult Owner | Product brief and ADR 0002 |
| Client | Version 1 targets an installable responsive web app | Product brief and architecture proposal |
| Native apps | Native macOS and Windows apps are not in version 1 | Product brief and roadmap |
| Release safety | Bounded Guardian Attestations are the default; a constrained Automatic Fallback may be chosen per Envelope | ADR 0001 |
| Protection | Envelope-wide Standard and optional Sealed modes are planned, not implemented | ADR 0004 |
| Editor | Editable TXT, Markdown, HTML, and DOCX conversions plus preserved Attachments are planned | ADR 0005 |
| Hosting | An official hosted path and complete self-host path are required but do not exist | ADR 0003 |
| Notifications | Email is planned; SMS remains optional and its cost/compliance boundary is unresolved | Product brief and architecture proposal |
| License | Repository text is AGPL-3.0 | `LICENSE` and ADR 0006 |
| Runtime proof | None; no application code exists | Repository inspection |

## Claims that are not yet permitted

- Viraha is available, production-ready, secure, private, zero-knowledge, or reliable.
- A hosted service, free hosted allowance, SMS allowance, download, installer, updater, or supported browser matrix exists.
- Version 1 has shipped or any release gate has passed.
- The Viraha name, logo, package, domain, or account identifiers are exclusive or legally cleared.
- Any screenshot, performance figure, delivery rate, user count, testimonial, or comparison is real.

## Replacement rule

For a release candidate, replace every row with an exact source, verification command or exercised journey, public destination, platform/provider limitation, and evidence date. If a fact cannot be reproduced from source, runtime, CI, release metadata, or a primary provider source, keep it out of the public surface.
