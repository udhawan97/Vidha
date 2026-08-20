# Vidha product brief

**Status:** Approved direction for a pre-alpha build. Everything described here is a requirement or target, not a shipped claim.

## Product job

Vidha helps an individual prepare recipient-specific messages and documents, remain in control through simple authenticated Check-ins, and release selected material through a deliberate contingency process if they become persistently unreachable.

## Intended Owner

Version 1 serves one adult Owner managing one personal Contingency Plan for a small circle of people they already trust. It is not a family workspace, business continuity platform, professional estate portal, or service for minors.

## The narrow problem

Existing approaches commonly separate the writing experience from the release mechanism: a basic dead-man switch sends a stored payload, while document vaults focus on storage and legacy products often make broad estate claims. Vidha's intended niche is the combination of:

- a calm, focused place to write and import recipient-specific material;
- a visible Standard or Sealed Protection Mode covering every item in an Envelope;
- a Release Policy chosen per Envelope;
- bounded Guardian Attestations by default rather than silence as a death proxy;
- an optional, deliberately constrained Automatic Fallback;
- an open-source, self-hostable implementation with a hosted path for nontechnical people.

The competitive landscape must be treated as evidence, not a uniqueness guarantee. Read `docs/research/GITHUB_COMPETITIVE_LANDSCAPE.md` before refining positioning.

## Product principles

### Control before automation

Automation advances an explicit state machine. It does not infer death, interpret prose, or invent authority.

### Different material deserves different protection

Each Envelope gets its own Protection Mode and Release Policy. Standard Mode favors practical recovery and server-assisted features. Sealed Mode favors confidentiality and visibly gives up recovery or processing capabilities that would contradict that promise. The mode covers both Editable Documents and Attachments.

### Write here, leave clean files behind

Vidha includes a focused rich-text and Markdown-compatible editor. Supported text imports become editable copies; unsupported originals remain downloadable Attachments. Export must remain possible without the hosted service.

### Notifications are not the vault

Email, web push, and optional SMS carry minimal notices. Private content is retrieved through an authenticated Recipient experience.

### Free software needs replaceable services

The AGPL application must not make one hosted email, SMS, identity, storage, or scheduling provider inseparable from the domain model. Self-hosters can bring compatible providers and bear their direct costs.

## Target version 1 capabilities

### Plan setup

- Create one Contingency Plan.
- Add and verify Guardians and Recipients.
- Explain role boundaries before an invitation is accepted.
- Configure a Check-in schedule and grace periods within safe system bounds.
- Rehearse the plan with clearly marked test notifications before arming it.

### Writing workspace

- Create, autosave, version, preview, and export Editable Documents.
- Provide a deliberately small formatting system suited to letters and practical instructions.
- Import TXT, Markdown, HTML, and DOCX through explicit conversion with a source-preserving path.
- Preserve PDFs, images, archives, and unsupported files as Attachments.
- Scan and isolate untrusted uploads before preview or delivery.
- Let the Owner assign a Recipient and Release Policy to each Envelope.

### Protection modes

- Standard Mode uses managed per-item encryption, recovery, and tightly audited operator access for the entire Envelope.
- Sealed Mode must never promise server processing that requires plaintext and must cover every item in the Envelope.
- The UI must show mode consequences before creation, conversion, recovery, and Release.
- Converting between modes requires explicit confirmation and an auditable new version.

### Check-in and Concern

- Provide a fast, authenticated Check-in suitable for passkeys.
- Treat reminder links as navigation only; a user-presence action changes state.
- Use a low-noise reminder sequence, then enter Concern after the configured grace period.
- Present Guardians with one bounded attestation prompt and only the minimum evidence allowed by the accepted policy; never ask them to certify death.
- Let an Owner immediately cancel Concern after authenticating.

### Release

- Bounded Guardian Attestations are the default Release Policy.
- Automatic Fallback is optional per Envelope and carries a longer enforced delay and explicit warnings.
- Every Release path gets a full final Veto Window. It starts only after at least one verified Owner channel accepts the final notice; if every channel fails before Release, including through later negative delivery evidence, the Envelope enters Delivery Hold and must later start a new full window.
- Release is idempotent, append-only in the audit history, and recoverable from provider retries without duplicates.
- A Recipient receives a minimal notice and authenticates before retrieving an Envelope.
- The notice says a contingency plan activated; it never declares the Owner dead.

### Portability and operation

- Deliver an installable responsive web app for version 1.
- Provide an official hosted deployment and a documented self-hosted deployment from the same repository.
- Provide encrypted export, configuration export, restore rehearsal, and account deletion.
- Keep email and SMS providers replaceable; document that carrier SMS is not sustainably cost-free.
- Add an external scheduler watchdog that alerts operators but cannot cause Release.

## Explicit non-goals for version 1

- Legal will creation, witnessing, notarization, probate, or asset distribution
- Password-manager or cryptocurrency-seed storage claims
- Automatic confirmation of death
- Emergency dispatch or wellness monitoring
- Shared plan ownership, organizations, professionals, or minors
- Native macOS or Windows applications
- Editing every proprietary document format in place
- AI-generated Release or Guardian Attestation decisions, legal interpretation, or document classification
- Silent telemetry, targeted advertising, or sale of personal information

## Product success conditions

Version 1 is ready only when a first-time Owner can create and rehearse a plan, routinely Check in, understand every security and recovery trade-off, and exercise both a Guardian flow and safe simulation without ambiguity. The implementation must also survive duplicate jobs, provider failures, clock advancement, revoked contacts, upload attacks, and restoration from backup without an unintended Release.

## Decisions Fable must still resolve with the user

Fable must ask one decision at a time and recommend an answer. At minimum, resolve:

- whether a Guardian may also be a Recipient and what conflict rule applies;
- the exact Guardian Attestation prompt, allowed response states, evidence minimization/retention, conflicts, abstention, expiry, and Delivery Hold effects;
- which final-notice delivery evidence is sufficient, how delayed/replayed negative webhooks affect Delivery Hold, and who may clear it;
- the minimum and maximum Check-in cadence, grace period, Veto Window, and Automatic Fallback delay;
- the Guardian quorum choices permitted in version 1;
- whether Sealed Mode ships in v1 or behind an explicitly experimental gate;
- supported Attachment types and size limits;
- Recipient authentication and recovery expectations;
- retention after Release, expiration, revocation, and deletion behavior;
- the hosted-service funding boundary for email, storage, and SMS without weakening the free-software promise;
- final hosting region, data-processing disclosures, and provider choices;
- the exact v1 import/export fidelity contract;
- whether Guardians can extend Concern and under what audit rules;
- the final visual identity and name-clearance decision for Vidha.
