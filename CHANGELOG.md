# Changelog

All notable changes are documented here. Vidha has not published an application version.

## Unreleased

- Renamed the provisional working product from `Viraha` to `Vidha`; no release or shipped application exists.
- Established the Vidha product vocabulary and scope.
- Recorded initial architecture, licensing, encryption, and Release Policy decisions.
- Added the pre-v1 product, security, public-surface, and release documentation.
- Added a TypeScript monorepo with a pure, deterministic Check-in timeline that deliberately stops at Concern.
- Added a responsive React/Vite PWA prototype with synthetic data, temporary text editing and import/export, and a prompted update flow.
- Added domain, component, WebKit desktop/mobile, accessibility, PWA, build, lint, formatting, and documentation checks.
- Expanded the synthetic document rehearsal with Recipient reassignment, undo and redo, restorable session checkpoints, browser-decoded text snapshots for import restore, and Markdown, plain-text, and escaped standalone HTML copies.
- Implemented the next six bounded foundation slices with synthetic identities and disposable state: a provider-neutral authenticated-principal/session input boundary, application authorization, atomic content-free audit/idempotency storage, memory/SQLite/PGlite parity, explicit Plan lifecycle, and quarantined text intake.
- Hardened those slices so authorization and recent authentication precede replay handling, caller idempotency values never enter domain or persisted exports, semantic key conflicts fail closed, timeline numbers remain portable safe integers, PGlite snapshots are transactionally consistent, and import approval is bound to intake-owned scanned bytes.
- Preserved exact approved import bytes only for the browser session, with explicit warnings that the fixture inspection is not malware scanning or sandboxed conversion.
- Kept real accounts, durable personal data, Guardian authority, production cryptography and providers, notifications, and Release outside the implemented claim; the production database direction remained deferred at the end of Phase 2.
- Added a Phase 3 Owner identity coordinator that generates canonical synthetic sessions, retains only session digests, rejects global token collisions, requires proof-adapter UP/UV, serializes revisioned and semantically idempotent mutations, models retry-safe credential/session revocation, requires two independently modeled recovery proofs plus cooling-off, verifies and permits cancellation of new channel references, and emits content-free notice intent.
- Changed the application boundary to resolve Owner, authentication, and expiry only through `SessionVerifier`; forged caller principal/time fields are ignored and unknown sessions fail before a transaction.
- Selected the self-hostable target of one API/worker application image with PostgreSQL and replaceable adapters, while keeping PGlite as disposable contract evidence rather than a production-database claim.
- Added bounded encrypted operational metadata with an AES-256-GCM fixture, authenticated record/schema context, IV-reuse failure, retention/deletion, ciphertext-only snapshots, and restore-safe reads; production key custody, wrapped keys, authenticated backups, and Standard/Sealed Mode remain absent.
- Added durable scheduled-job and synthetic-outbox contracts with atomic encrypted-state/outbox commit, positive task allowlists, semantic idempotency, bounded retries, dead letter, expiring leases, monotonic fencing, stale-worker rejection, and memory/PGlite parity.
- Bound import inspection evidence to exact digest and byte count, engine/signature versions, duration, verdict, and an accepted isolation profile. The web adapter remains explicitly `synthetic_fixture`; libmagic, ClamAV, Pandoc, OCI isolation, and real uploads remain Phase 3B planning.
- Recorded primary-source decisions and ADRs for WebAuthn/revocable sessions, recovery, PostgreSQL topology, encrypted operations, fenced work, and isolated import processing, then bounded the next six executable-evidence slices in the Phase 3B completion plan.

No application version has been released.
