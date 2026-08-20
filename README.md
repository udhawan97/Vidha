# Vidha

**Prepare what matters. Release it carefully.**

Vidha is an open-source contingency relay for an individual who wants selected people to receive private messages or documents if they become persistently unreachable. It is designed around explicit Check-ins, human verification by default, recipient-specific Envelopes, and clear recovery trade-offs.

> **Pre-alpha:** this repository currently contains the approved product model, safety constraints, architecture proposal, and v1 execution handoff. There is no application code, runnable app, hosted service, deployment, download, updater, tag, or GitHub release yet.

> **Working name:** “Vidha” is provisional. The exact GitHub account, several exact-name repositories, and the `.com` and `.org` domains are already occupied; this project makes no exclusivity or legal-clearance claim. See the [name-collision evidence](docs/research/GITHUB_COMPETITIVE_LANDSCAPE.md#working-name-collision-check-vidha).

[Product brief](docs/product/PRODUCT_BRIEF.md) · [Threat model](docs/security/THREAT_MODEL.md) · [Proposed architecture](docs/architecture/ARCHITECTURE.md) · [Fable build handoff](docs/FABLE_BUILD_PROMPT.md)

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

| Path | Purpose |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | Canonical product vocabulary |
| [`docs/adr/`](docs/adr/) | Accepted, hard-to-reverse decisions |
| [`docs/product/`](docs/product/) | Product brief and journeys |
| [`docs/architecture/`](docs/architecture/) | Proposed system boundaries |
| [`docs/security/`](docs/security/) | Threat model and security expectations |
| [`docs/release/`](docs/release/) | Evidence required before v1 |
| [`docs/public-surface/FACT_SHEET.md`](docs/public-surface/FACT_SHEET.md) | Verified facts and forbidden pre-alpha claims |
| [`docs/research/`](docs/research/) | Primary-source inspiration and landscape research |
| [`docs/FABLE_BUILD_PROMPT.md`](docs/FABLE_BUILD_PROMPT.md) | Copy-paste implementation and release handoff |

## Build status

The next step is not installation; it is implementation. Fable should follow the repository handoff, interview the Owner where decisions remain open, build the verified release candidate, and run `refresh-docs` only after the real app can supply truthful screenshots, commands, downloads, and platform claims.

## Contributing

The safest contribution is one that preserves the domain language and makes a failure mode explicit. Read [CONTRIBUTING.md](CONTRIBUTING.md), the [product brief](docs/product/PRODUCT_BRIEF.md), and the [threat model](docs/security/THREAT_MODEL.md) before proposing behavior.

## License

Vidha is licensed under [AGPL-3.0](LICENSE). Anyone may use, modify, self-host, or commercially operate it; network-hosted modifications must remain available as source under the license terms.
