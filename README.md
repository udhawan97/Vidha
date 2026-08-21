# Vidha

**Prepare what matters. Release it carefully.**

Vidha is an open-source contingency relay for an individual who wants selected people to receive private messages or documents if they become persistently unreachable. It is designed around explicit Check-ins, human verification by default, recipient-specific Envelopes, and clear recovery trade-offs.

> **Pre-alpha:** this repository contains a runnable synthetic browser prototype and a Phase 3 provider-free operations foundation: a deterministic domain lifecycle through Concern, canonical session and recovery contracts, disposable memory/SQLite/PGlite stores, encrypted metadata fixtures, fenced durable-work fixtures, and bounded text-import inspection evidence. There are no real accounts, production credentials or cryptography, durable personal-content storage, malware scanning, sandboxed conversion, notification delivery, Release implementation, hosted service, deployment, download, tag, or GitHub release yet.

> **Working name:** “Vidha” is provisional. The exact GitHub account, several exact-name repositories, and the `.com` and `.org` domains are already occupied; this project makes no exclusivity or legal-clearance claim. See the [name-collision evidence](docs/research/GITHUB_COMPETITIVE_LANDSCAPE.md#working-name-collision-check-vidha).

[Product brief](docs/product/PRODUCT_BRIEF.md) · [Threat model](docs/security/THREAT_MODEL.md) · [Current foundation](docs/architecture/FOUNDATION_PHASE_3.md) · [Proposed architecture](docs/architecture/ARCHITECTURE.md) · [Fable build handoff](docs/FABLE_BUILD_PROMPT.md)

## Run the local synthetic prototype

Prerequisites: Node.js 24 or newer and pnpm 11.17.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by Vite. The prototype lets you rehearse Draft, Armed, Paused, and Disabled lifecycle controls; advance the Check-in timeline through Concern; explicitly confirm a synthetic Check-in; inspect an in-memory event record; and work with two synthetic Envelopes. A Markdown/plain-text import is first quarantined, classified, and shown for explicit approval. Approved text and its exact original bytes remain available only for the browser session; the fixture inspection is not a malware scan or sandbox. The workspace also supports Recipient reassignment, undo/redo, checkpoints, source restore/download, and Markdown, plain-text, or escaped standalone HTML copies. Refresh clears the session. **Do not enter personal or sensitive information.**

Run the complete local verification suite with:

```sh
pnpm check
pnpm exec playwright install webkit
pnpm test:e2e
```

The production build includes a web-app manifest, service worker, and prompted update flow. This is infrastructure evidence, not a claim that installation or updates have passed the v1 release gate.

## What Vidha is designed to do

- Let one Owner create recipient-specific Envelopes in a focused writing workspace.
- Convert supported text formats into Editable Documents and preserve other files as Attachments.
- Give every Envelope a recoverable Standard Mode and, only if its v1 security gates pass, an optional stricter Sealed Mode covering both Editable Documents and Attachments.
- Make routine Check-ins quick without treating email opens or automated link scans as proof of control.
- Enter Concern after a missed schedule, notify Guardians without exposing content, and use bounded Guardian Attestations as the default Release Policy.
- Allow an Owner to deliberately choose a longer Automatic Fallback for an individual Envelope.
- Notify a Recipient when an Envelope is released without putting the private content directly in email or SMS.
- Run as an installable web app, with an officially hosted path and a complete self-hosting path.

## What makes the product narrow

Vidha is not trying to manage an estate, transfer money, store passwords, predict death, or replace emergency services. Its job is smaller: help someone prepare meaningful material, keep control while they are reachable, and make an eventual handoff deliberate and auditable.

That focus produces four product boundaries:

1. **Document-first:** creation and import are part of the core experience, not an attachment afterthought.
2. **Policy per Envelope:** practical instructions and deeply private letters do not need identical Release conditions.
3. **Human verification by default:** silence begins Concern; it does not announce death.
4. **Portable by design:** the application is AGPL-licensed, self-hostable, and built around replaceable delivery and hosting adapters.

## Intended v1 journey

1. The Owner creates a Contingency Plan, adds verified Guardians and Recipients, and writes or imports an Envelope.
2. The Owner chooses a Release Policy for that Envelope and completes a safe rehearsal before arming it.
3. Vidha requests authenticated Check-ins on the Owner's schedule.
4. A missed schedule moves through reminders, grace, Concern, verification, and a final Veto Window.
5. Release makes the Envelope available only to its Recipient and records an audit trail.

The exact state machine, retries, provider failures, recovery paths, and abuse cases must pass the [v1 release gates](docs/release/V1_RELEASE_GATES.md) before any public release.

## Trust boundaries

- Vidha never claims that an Owner has died.
- No content is released solely because an email was opened or a link was fetched.
- Standard Mode uses managed encryption and can support recovery; operator access must be restricted and audited.
- If it passes its protocol, recovery, independent-review, and test-vector gates, Sealed Mode trades recovery and server-assisted features for stronger confidentiality across the entire Envelope; otherwise it does not ship as an armable v1 feature.
- Emails and SMS messages are notifications, not containers for private Envelope content.
- Legal wills, passwords, recovery seeds, financial transfers, and emergency dispatch are outside the v1 promise.

Read the full [threat model](docs/security/THREAT_MODEL.md) before treating any implementation as trustworthy.

## Repository map

| Path                                                                     | Purpose                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| [`apps/web/`](apps/web/)                                                 | Responsive React/Vite PWA prototype               |
| [`packages/domain/`](packages/domain/)                                   | Pure lifecycle, Check-in, and Concern decisions   |
| [`packages/application/`](packages/application/)                         | Canonical-session and authorization seam          |
| [`packages/identity/`](packages/identity/)                               | Synthetic Owner identity and recovery contract    |
| [`packages/operations/`](packages/operations/)                           | Encrypted metadata and durable-work contracts     |
| [`packages/persistence/`](packages/persistence/)                         | Disposable Plan-store adapters and contract tests |
| [`packages/documents/`](packages/documents/)                             | Bounded untrusted text-import intake              |
| [`e2e/`](e2e/)                                                           | WebKit desktop and mobile acceptance checks       |
| [`CONTEXT.md`](CONTEXT.md)                                               | Canonical product vocabulary                      |
| [`docs/adr/`](docs/adr/)                                                 | Accepted, hard-to-reverse decisions               |
| [`docs/product/`](docs/product/)                                         | Product brief and journeys                        |
| [`docs/architecture/`](docs/architecture/)                               | Proposed system boundaries                        |
| [`docs/security/`](docs/security/)                                       | Threat model and security expectations            |
| [`docs/release/`](docs/release/)                                         | Evidence required before v1                       |
| [`docs/public-surface/FACT_SHEET.md`](docs/public-surface/FACT_SHEET.md) | Verified facts and forbidden pre-alpha claims     |
| [`docs/research/`](docs/research/)                                       | Primary-source inspiration and landscape research |
| [`docs/FABLE_BUILD_PROMPT.md`](docs/FABLE_BUILD_PROMPT.md)               | Copy-paste implementation and release handoff     |

## Build status

Phase 3 locally exercises six bounded decision contracts with disposable synthetic state. `packages/identity` is the only issuer of canonical Owner session facts and models credential, session, recovery, and Verified Owner Channel changes behind proof-verifier seams. `packages/operations` exercises bounded AES-GCM metadata fixtures, retention, restore-safe snapshots, atomic synthetic outbox commits, retries, dead letter, expiring leases, and stale-worker fencing across memory and PGlite. Import intake now validates digest-bound scanner version, duration, byte-count, verdict, and isolation-profile evidence; the browser still declares its adapter a synthetic fixture, not a malware scanner or sandbox.

It deliberately stops at Concern. The [partial Phase 3 six-slice record](docs/product/NEXT_PHASE_3_SIX.md), [current foundation map](docs/architecture/FOUNDATION_PHASE_3.md), [primary-source decisions](docs/research/PHASE_3_PRIMARY_SOURCES.md), and ADRs 0009–0012 describe exactly what is selected and locally exercised. Executable WebAuthn, PostgreSQL, wrapped-key backup, scanner/sandbox, and integrated scheduler adapters remain [Phase 3B completion planning](docs/product/NEXT_PHASE_3B_SIX.md). Real data, external delivery, Guardian authority, and Release remain behind later gates.

Fable can continue from the [bounded build handoff](docs/FABLE_BUILD_PROMPT.md), but must not treat this prototype as release authority. Run `refresh-docs` only after a real release candidate can supply truthful screenshots, commands, downloads, and platform claims.

## Contributing

The safest contribution is one that preserves the domain language and makes a failure mode explicit. Read [CONTRIBUTING.md](CONTRIBUTING.md), the [product brief](docs/product/PRODUCT_BRIEF.md), and the [threat model](docs/security/THREAT_MODEL.md) before proposing behavior.

## License

Vidha is licensed under [AGPL-3.0](LICENSE). Anyone may use, modify, self-host, or commercially operate it; network-hosted modifications must remain available as source under the license terms.
