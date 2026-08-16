# Public-surface coverage ledger

This ledger prevents planned capability from appearing as shipped truth. Fable must replace pre-alpha statuses with verified evidence during the release-candidate `refresh-docs` pass.

| Surface or claim | Current source of truth | Status | Current public destination | Required verification |
| --- | --- | --- | --- | --- |
| Product job and intended Owner | Product brief + accepted interview | Approved direction | README opening | Confirm against implemented onboarding and primary journey |
| Viraha product name | [Competitive landscape name-collision evidence](../research/GITHUB_COMPETITIVE_LANDSCAPE.md#working-name-collision-check-viraha) | Provisional; exact account and exact-name repositories already exist, broader clearance incomplete | README warning + title | Recheck repository/package/domain/app-store associations and appropriate trademark sources before launch |
| Installable web app | Roadmap + architecture proposal | Planned | README target capabilities | Install and update a production build on supported browsers |
| Hosted service | ADR 0003 | Planned | README target capabilities | Verify deployed URL, region, providers, privacy, backups, and operations |
| Self-hosting | ADR 0003 | Planned | README trust boundary | Complete clean-machine install and restore rehearsal |
| Standard Mode | ADR 0004 + product brief | Planned | README target capabilities | Inspect all-item encryption, recovery, access controls, and break-glass audit |
| Sealed Mode | ADR 0004 + product brief | Planned; v1 inclusion unresolved | README target capabilities | Prove all-item coverage, independent protocol review, and cross-client test vectors |
| Editor and imports | ADR 0005 + user journeys | Planned | README target capabilities | Exercise real editor, conversions, warnings, Attachments, and export |
| Guardian-attested Release | ADR 0001 | Planned | README workflow | End-to-end virtual-clock and browser verification |
| Automatic Fallback | ADR 0001 | Planned | README workflow | Verify opt-in, minimum delay, Veto Window, and audit distinction |
| Email notifications | Architecture proposal | Planned | README target capabilities | Provider sandbox/live bounded delivery, bounce, webhook, and retry checks |
| SMS | Product brief | Optional and unverified | Not advertised as shipped | Verify provider, regulatory, cost, and delivery boundary before adding |
| Native desktop apps | Explicit v1 non-goal | Unavailable | Roadmap only | No download claim until a separately approved implementation exists |
| Screenshot or demo | No runnable app | Unavailable | Intentionally absent | Capture only from verified demo data in release candidate |
| v1 download and updater | No release | Unavailable | Intentionally absent | Verify exact artifacts, signing, checksums, install, and update path |
| Private vulnerability reporting | Canonical GitHub setting + repository security policy | Enabled and verified; no-details fallback form published | Security policy + no-details contact-request form | Reverify the setting and reporter-facing route after repository-security changes |
| Public product/documentation questions | Canonical GitHub setting + support policy | Discussions and question form published | Question issue form + Discussions | Reverify after issue-template or repository-setting changes |
| AGPL-3.0 license | LICENSE + ADR 0006 | Current; GitHub detection verified | README license | Reverify after license-file changes |
