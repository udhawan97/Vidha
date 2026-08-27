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
- Versioned `vidha.editable-document` schema with deterministic canonical JSON, Markdown-compatible editing, and portable Markdown/text/escaped semantic HTML copies
- Synthetic Recipient reassignment, undo/redo, bounded document-only session versions with reviewed safe restore, review-before-accept import previews, exact-source provenance, and one clear portable-copy flow
- Serialized synthetic Owner actions, failure-safe native confirmations, and a deliberate fresh-session path that never resumes a terminal Disabled Plan
- Session-aware reload protection plus an explicit, failure-safe service-worker update decision that names every in-memory rehearsal surface it clears
- Content-free same-origin tab presence, an honest unsynchronized-rehearsal warning, and destructive update/fresh-session holds while another tab reports changed work or an unsettled Owner action
- In-app Owner guidance plus session-only, explicitly reviewed Attachment candidates for bounded document, image, audio, video, data, contact, and ZIP formats; no upload, scan, encryption, persistence, or delivery claim
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
- Atomic persisted metadata-key rewrap with immutable replay history plus a digest-pinned authenticated logical-backup rehearsal covering post-persistence inventory advancement, signed generations, bounded retention retirement, dedicated non-superuser restore, restore-safe invariant inspection, and explicit promotion
- Opt-in loopback WebAuthn/session rehearsal with Chromium virtual-authenticator ceremonies, Firefox/WebKit HTTP-boundary checks, exact origin enforcement, opaque cookie rotation, CSRF, replay denial, revocation, and expiry
- Transactional PostgreSQL recovery proof acceptance, consumption, and cancellation through identity commands; independent-factor and multi-attempt abuse locks; completion/cancellation serialization; session invalidation; schema migration; authenticated restore inspection; and explicit post-promotion cancellation
- Executable source-pinned file, digest-pinned ClamAV, and Pandoc import gates with exact-byte evidence and bounded AST conversion
- Unit, component, build, documentation, accessibility, PWA, desktop-WebKit, and mobile-WebKit checks
- Fable implementation and release handoff

The [Phase 3B six-slice record](docs/product/NEXT_PHASE_3B_SIX.md) has intermediate disposable executable adapters for PostgreSQL topology, wrapped-key backup manifests, WebAuthn ceremonies, durable identity/recovery, integrated PostgreSQL Plan/outbox storage, and file/ClamAV/Pandoc intake. All six [closure slices](docs/product/PHASE_3B_CLOSURE_SIX.md) now have source gates for topology failure/capacity/teardown, authenticated logical restore and atomic key rotation, the loopback-only WebAuthn/session boundary, transactional recovery abuse/restore behavior, canonical scheduled-command crashes, and rootless adversarial import isolation; exact-commit CI acceptance remains mandatory. Phase 3B still cannot accept real data or send a message. Guardian authority, Veto Window, Delivery Hold, Automatic Fallback, and Release remain outside the implemented state machine.

The [Phase 3C six-slice record](docs/product/NEXT_PHASE_3C_SIX.md) adds the versioned canonical Editable Document, deterministic portability, review-before-accept conversion state, exact session-source provenance, and a clearer browser import/export flow. It keeps HTML and DOCX editable conversion, durable content, and every authority or delivery path explicitly outside the current evidence.

The [Phase 3D six-slice record](docs/product/NEXT_PHASE_3D_SIX.md) replaces ambiguous whole-Envelope checkpoints with bounded Document Versions, duplicate suppression, document-only change summaries, preservation of the current draft before restore, and an explicit confirmation flow. The history remains in memory and excludes Attachments and imported-source provenance; it is not autosave, durable versioning, backup, or Release evidence.

The [Phase 3E six-slice record](docs/product/NEXT_PHASE_3E_SIX.md) binds Draft rehearsal to the exact synthetic Plan, contact, Editable Document, and Attachment identities reviewed, exposes complete timing and content-free notice previews, and invalidates Arm after drift. The review remains session-only and sends no message.

The [Phase 3F six-slice record](docs/product/NEXT_PHASE_3F_SIX.md) serializes local Owner actions, keeps failed confirmations open, uses safe-default native dialogs, and provides an explicit way to clear a terminal session and load a separate Draft. It does not add durable session state, authentication, provider delivery, or authority beyond Concern.

The [Phase 3G six-slice record](docs/product/NEXT_PHASE_3G_SIX.md) marks accepted browser-session work, warns before common reload paths, blocks app updates during Owner actions, and requires an explicit, failure-safe decision before a waiting service-worker build clears the rehearsal. It does not add autosave, durable storage, state migration, bad-service-worker recovery, or supported-browser update evidence.

The [Phase 3H six-slice record](docs/product/NEXT_PHASE_3H_SIX.md) detects same-origin rehearsal tabs through an ephemeral content-free protocol, exposes that their in-memory state does not synchronize, and holds app updates or fresh-session clearing while a peer reports changed work or an unsettled Owner action. It does not copy, merge, persist, recover, encrypt, or durably delete content and is not a cross-device or server-authoritative lock.

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
