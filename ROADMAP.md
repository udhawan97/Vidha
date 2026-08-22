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
- Synthetic Recipient reassignment, undo/redo, restorable session checkpoints, browser-decoded import snapshots, and Markdown/plain-text/escaped-HTML copies
- Canonical-session application boundary plus synthetic Owner Credential, session revocation, two-proof recovery, and Verified Owner Channel contracts
- Disposable in-memory, SQLite, and Postgres-compatible PGlite Plan stores under one atomic audit/idempotency contract
- Explicit Draft, Armed, Paused, and Disabled lifecycle with rehearsal-before-arm, recent authentication, policy revision, and fresh-interval resume rules
- Quarantined TXT/Markdown intake with byte/type/resource checks, digest-bound scanner version/duration/isolation evidence, explicit approval, and exact session-byte preservation
- Accepted one-image API/worker plus PostgreSQL topology contract with replaceable adapters and a read-only watchdog
- Disposable encrypted operational-metadata, retention, restore-safe, atomic synthetic-outbox, retry/dead-letter, lease, and stale-worker fencing evidence across memory and PGlite
- Digest-pinned PostgreSQL 18 topology with one image, one-shot migrator, separate API/worker roles, checksum-locked migrations, readiness, and disposable integration gates
- Pinned SimpleWebAuthn ceremony adapter plus durable credential, assertion-proof, identity, session-digest, recovery-proof, and revision storage
- Per-record wrapped metadata keys, key rewrap, signed generation-chain backup manifests, and external anti-rollback inventory fixtures
- PostgreSQL Plan/audit/schedule/outbox atomicity, `SKIP LOCKED`, database-time leasing, fencing, dead letter, restore-safe denial, and an idempotent synthetic sink
- Disposable PostgreSQL backend termination at six migration/four claim checkpoints, rollback/lost-ack replay, one worker partition/recovery probe, bounded pool exhaustion, a 1,000-due-job plus 100,000-row capacity fixture, and run-owned tmpfs-root teardown
- Executable source-pinned file, digest-pinned ClamAV, and Pandoc import gates with exact-byte evidence and bounded AST conversion
- Unit, component, build, documentation, accessibility, PWA, desktop-WebKit, and mobile-WebKit checks
- Fable implementation and release handoff

The [Phase 3B six-slice record](docs/product/NEXT_PHASE_3B_SIX.md) has intermediate disposable executable adapters for PostgreSQL topology, wrapped-key backup manifests, WebAuthn ceremonies, durable identity/recovery, integrated PostgreSQL Plan/outbox storage, and file/ClamAV/Pandoc intake. Closure slice 1 now adds disposable topology failure, capacity, partition, and teardown evidence. Phase 3B remains in progress: closure slices 2–6 in the [closure six](docs/product/PHASE_3B_CLOSURE_SIX.md) must still prove authenticated restore and atomic key rotation, browser sessions, wired recovery abuse, canonical scheduled-command crashes, and rootless import isolation before accepting real data or sending a message. Guardian authority, Veto Window, Delivery Hold, Automatic Fallback, and Release remain outside the implemented state machine.

The earlier foundation record is in [`docs/product/NEXT_FOUNDATION_SIX.md`](docs/product/NEXT_FOUNDATION_SIX.md), and current boundaries are in [`docs/architecture/FOUNDATION_PHASE_3B.md`](docs/architecture/FOUNDATION_PHASE_3B.md). The sequence remains intentional: executable provider and operational evidence still precedes any durable personal data, and none of this work authorizes Guardian Attestation or Release behavior.

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
