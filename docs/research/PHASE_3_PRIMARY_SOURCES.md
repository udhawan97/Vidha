# Phase 3 primary-source decision research

Research snapshot: 2026-08-21 (America/Chicago)

> **Status and authority boundary:** This report records evidence-backed recommendations for disposable Phase 3 implementation. ADRs 0009–0012 accepted the bounded directions, and the intermediate Phase 3B milestone implements production-shaped disposable adapters without changing those decisions. Phase 3B remains in progress. This report is not production-readiness evidence, security certification, legal opinion, hosted-service claim, or release claim. Vidha remains a pre-alpha contingency relay whose implemented safety path stops at Concern. Nothing below authorizes real credential enrollment, recovery-factor collection, personal content, contact with a real person, a public endpoint, Guardian authority, a notification provider, Veto Window, Delivery Hold, Automatic Fallback, or Release.

## 2026-08-21 implementation refresh

Phase 3B pins SimpleWebAuthn 13.3.2, ClamAV 1.5.4, Pandoc 3.10.2, and file 5.48 in `infra/toolchain.lock.json`. The current official release records are [SimpleWebAuthn 13.3.2](https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v13.3.2), [ClamAV 1.5.4](https://github.com/Cisco-Talos/clamav/releases/tag/clamav-1.5.4), [Pandoc 3.10.2](https://github.com/jgm/pandoc/releases/tag/3.10.2), and [file FILE5_48](https://github.com/file/file/releases/tag/FILE5_48). Source/archive hashes and container manifest digests are independently locked in the repository and checked by CI; a pinned version is evidence of reproducible selection, not of production safety.

## Decision summary

| Slice                   | Recommended Phase 3 direction                                                                                                                                                                                       | Principal trade-off                                                                                                                                               | Hard stop                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Owner identity          | Self-hosted WebAuthn relying party using a reviewed `@simplewebauthn/server` release, user verification required, one-time server-side ceremonies, and revocable opaque server sessions                             | Avoids an identity-provider dependency, but makes Vidha responsible for enrollment, session security, recovery, browser evidence, and abuse controls              | Disposable credentials only; no real person enrolled                                                  |
| Recovery and revocation | Multiple passkeys first; independently modeled credential and session revocation; synthetic recovery-code state machine; fresh reauthentication and cooling-off for recovery and verified-contact authority changes | Fail-closed recovery reduces takeover risk but can lock out an Owner; synced passkeys may share one recovery fabric                                               | No real recovery code, contact, message, or identity proofing                                         |
| Deployment topology     | Core: one versioned Node application image with `api` and `worker` roles plus one PostgreSQL service; the optional import profile adds only the isolated processes inventoried in Section 5                         | Adds a database service compared with SQLite, but avoids Redis, a broker, hosted identity, and a separate scheduler service while retaining multi-process locking | Local disposable deployment only; no public endpoint or production secret                             |
| Metadata persistence    | PostgreSQL 18 baseline; application-layer AES-GCM envelope encryption for classified metadata; `age`-encrypted logical backups; versioned forward migrations and rehearsed restore-safe rollback                    | PostgreSQL is operationally heavier; queryable scheduling fields remain deliberately minimal plaintext; key loss can make encrypted fields unrecoverable          | Synthetic fixtures only; no Standard Mode or personal content claim                                   |
| Import isolation        | Exact-byte quarantine, `libmagic` type classification, ClamAV scanning over `INSTREAM`, then per-job OCI-isolated Pandoc conversion to an allowlisted canonical representation                                      | Signatures and converters reduce risk but cannot prove a file safe; ClamAV adds signature operations and a GPLv2-only process boundary                            | EICAR and benign/adversarial synthetic fixtures only; no real upload                                  |
| Scheduler and outbox    | PostgreSQL due-job and outbox tables committed with domain state; expiring leases, semantic unique keys, at-least-once execution, redacted synthetic sink                                                           | A crash after sink acceptance but before acknowledgement can replay work, so the sink must deduplicate                                                            | Positive allowlist of synthetic Concern-bound tasks only; no delivery provider or Release-shaped task |

These recommendations are one coherent baseline: PostgreSQL supplies revocable sessions, one-time ceremonies, migration state, durable schedules, leases, and the transactional outbox. No broker, cache, workflow engine, hosted identity tenant, or provider-specific scheduler is justified for this phase. ADRs 0009–0012 accepted these target trade-offs. The intermediate Phase 3B milestone adds disposable executable adapters; Phase 3B closure retains the failure/capacity, authenticated restore, browser session, integrated crash, and rootless isolation evidence still missing.

The implementation dependency order is: topology and PostgreSQL transaction primitives; encrypted metadata and restore-safe operations; WebAuthn sessions; recovery/revocation; durable scheduler/outbox; then the untrusted-file pipeline. A later slice must not bypass an unproved prerequisite.

## Method and evidence boundary

- Sources are limited to official standards and government publications, official project documentation/source/licenses, and first-party platform documentation. Repository files are the source of truth for Vidha's current boundaries.
- **Verified fact** means the cited source directly supports the statement. **Vidha synthesis** means a proposed design choice derived from those facts and the repository threat model; the source does not endorse Vidha or prove the synthesis secure.
- Version references are a 2026-08-21 snapshot. Dependencies still require an exact-version advisory and license check immediately before adoption.
- “Compatible” below is an engineering recommendation, not legal advice. Distribution must retain applicable licenses, source offers/notices, and a reviewed dependency inventory.
- Browser availability is not a support matrix. Safari, Firefox, and Chromium acceptance still requires real disposable-device/browser evidence.

## 1. Self-hostable Owner authentication and sessions

### Verified facts

1. WebAuthn is an origin- and RP-bound public-key authentication ceremony. The relying party must verify the expected type, challenge, origin, RP ID hash, user-presence/user-verification flags, credential public key, signature, and other assertion properties. The relying party must generate unpredictable server-side challenges and reject mismatches to prevent replay ([W3C WebAuthn Level 3: verifying assertions](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion), [cryptographic challenges](https://www.w3.org/TR/webauthn-3/#sctn-cryptographic-challenges), [origin validation](https://www.w3.org/TR/webauthn-3/#sctn-validating-origin)).
2. WebAuthn authenticates a credential; it does not issue an application session. NIST separately defines a session secret issued by the session host after authentication, requires expiry/invalidation, and specifies secure cookie properties including Secure, narrow scope, HttpOnly, SameSite, an opaque value, and no cleartext personal information. NIST also requires CSRF protection for state-changing content and says the RP remains authoritative for reauthentication ([NIST SP 800-63B session management](https://pages.nist.gov/800-63-4/sp800-63b/session/)).
3. NIST describes WebAuthn as phishing-resistant through verifier-name binding and nonces/challenges as replay-resistant. This does not make the surrounding enrollment, recovery, session, or endpoint secure by itself ([NIST authenticator requirements](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/#phishing-resistance), [replay resistance](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/#replay-resistance)).
4. `@simplewebauthn/server` generates options and verifies registration/authentication responses against the saved challenge, expected origin, RP ID, credential public key, and counter without requiring a hosted identity service. The official project is MIT-licensed ([server documentation](https://simplewebauthn.dev/docs/packages/server), [official repository](https://github.com/MasterKale/SimpleWebAuthn), [license](https://github.com/MasterKale/SimpleWebAuthn/blob/master/LICENSE.md)).
5. The current SimpleWebAuthn release is `v13.3.2`; it fixes an attestation certificate-chain validation issue affecting earlier versions. A reviewed version must therefore be pinned rather than accepting an unbounded range ([official release](https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v13.3.2), [security advisory](https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-6hxq-p678-4hr2)).
6. WebAuthn is exposed only in secure contexts in supported browsers. That fact does not establish Vidha's browser support or passkey UX ([Mozilla WebAuthn platform documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)).

### Vidha synthesis: selected contract

- Vidha should be its own WebAuthn relying party. Use SimpleWebAuthn as a replaceable adapter, not as the domain authority. Pin `13.3.2` or a later version only after reviewing its release notes, advisory state, transitive licenses, and deterministic fixtures.
- Registration and authentication options should use an exact configured RP ID and an explicit origin allowlist. Set `userVerification: "required"`; use discoverable credentials for the Owner flow; request no identifying attestation by default. Lack of attestation is not a reason to weaken assertion verification.
- First-Owner bootstrap is a separate, single-use disposable ceremony, not open registration. It is enabled only when the credential table is empty, ingress and the verified origin both resolve to loopback, and `RESTORE_SAFE` is false. Generate a random 256-bit capability into a read-once mounted file outside the database; store only its keyed digest and expiry. Bind that capability to one `BOOTSTRAP_REGISTER` challenge, and in one transaction verify the response, insert the first credential, consume the capability, and permanently set bootstrap disabled. Every ordinary unauthenticated registration request fails closed. A valid but losing concurrent request, replay, expired capability, non-loopback request, origin mismatch, or any request after the first credential exists must fail without creating a credential. This mechanism is only for a disposable synthetic Owner and is not identity proofing.
- Persist a one-time ceremony record containing a random challenge digest, purpose (`REGISTER`, `AUTHENTICATE`, or `REAUTHENTICATE`), synthetic Owner ID, allowed origin/RP ID configuration revision, creation/expiry, and consumed timestamp. Consume it atomically with successful verification. A challenge for one purpose cannot satisfy another.
- After a verified assertion, issue 32 random bytes as an opaque session secret. Put the raw secret only in a non-persistent `__Host-vidha_session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Domain`; store only a keyed digest in PostgreSQL. Rotate the token after authentication, reauthentication, and any authority change. Do not put identity, role, expiry, or policy data in the cookie.
- The server-side session record should carry `ownerId`, `credentialId`, `issuedAt`, `lastActiveAt`, `authenticatedAt`, `overallExpiresAt`, `idleExpiresAt`, `revokedAt`, and a revocation reason. Proposed Phase 3 limits are 12 hours overall, 30 minutes idle, and 5 minutes for “recent authentication.” These are conservative Vidha policy values, not a NIST assurance-level claim.
- Validate the record on every request. Logout, overall/idle expiry, credential revocation, recovery completion, or an authority-bearing contact change must invalidate affected sessions immediately. Signed stateless tokens alone are rejected because immediate revocation would still require server state.
- Every mutation requires a verified session, an independent CSRF token, deliberate initiation through the UI, and the existing application authorization check. “Deliberate initiation” is an application invariant, not a claim that every mutation runs a WebAuthn ceremony. Lifecycle-sensitive actions and identity/recovery changes require a new WebAuthn assertion whose UP and UV flags are both verified; an old active session is not “recent authentication.”
- Credential sign counters may be retained as risk evidence, but no single counter anomaly should mutate lifecycle state. No AI or probabilistic risk score may decide Check-in, Concern, or any later safety transition.

### Trade-offs and rejected alternatives

- **Hosted identity provider:** rejected for Phase 3 because it adds a provider and tenant dependency before the self-hosting contract is proven. It can be reconsidered only behind the same identity/session ports and with equivalent local operation.
- **Self-hosted general identity suite:** deferred because it is materially larger than the current one-Owner scope and does not remove Vidha's recovery and session responsibilities.
- **JWT-only browser session:** rejected because immediate per-session and per-credential revocation still needs mutable server state.
- **Email or SMS login/recovery:** rejected as the primary Owner authenticator because it weakens phishing resistance and turns contact-channel compromise into account control.
- **A browser-support claim:** withheld until real Safari, Firefox, and Chromium enrollment, authentication, cancellation, conditional-UI, lost-device, and stale-session journeys pass.

### Required disposable evidence and stop condition

Use a virtual authenticator or disposable security key/account only. The local-browser harness must use an exact secure-context strategy: either HTTPS on a fixed test origin such as `https://vidha.test` with a disposable local CA, or the browser's explicitly documented localhost secure-context exception. Never disable origin, RP ID, TLS, UP, or UV checks for convenience. Tests must cover bootstrap capability purpose/expiry/replay/concurrency/permanent disablement, challenge purpose/expiry/replay, origin and RP mismatch, missing UV/UP, unknown/revoked credentials, signature failure, counter anomalies, CSRF, cookie flags, idle/overall expiry, token rotation, logout, concurrent session revocation, stale reauthentication, and an exact pinned dependency/advisory record. Stop before enrolling a real person or exposing a public endpoint.

## 2. Credential recovery, lost device, revocation, and verified-contact change

### Verified facts

1. NIST says subscriber accounts should maintain at least two separate means of authentication, must permit multiple authenticators, and must require strong authentication before binding an additional authenticator. Binding must also cause an independent notification ([NIST authenticator binding](https://pages.nist.gov/800-63-4/sp800-63b/events/#binding-an-additional-authenticator)).
2. Lost, stolen, damaged, or compromised authenticators must be suspended, invalidated, or destroyed promptly. Invalidation removes the binding between the authenticator and account; WebAuthn client-side credential signals are optional conveniences, so server-side credential status remains authoritative ([NIST loss and invalidation](https://pages.nist.gov/800-63-4/sp800-63b/events/#loss-theft-damage-and-compromise), [W3C credential signals](https://www.w3.org/TR/webauthn-3/#sctn-signal-api)).
3. NIST recognizes saved recovery codes, issued recovery codes, recovery contacts, and repeated identity proofing. Recovery always requires notification; saved codes are single-use, stored hashed, and replaced after use. Accounts without prior identity proofing cannot use “reproofing” as a recovery shortcut ([NIST account recovery](https://pages.nist.gov/800-63-4/sp800-63b/events/#account-recovery)).
4. NIST requires account-event notifications to stored notification addresses and supports multiple notification addresses. The cited requirements are a useful floor, but Vidha has not established a NIST IAL/AAL or a real notification channel ([NIST account notifications](https://pages.nist.gov/800-63-4/sp800-63b/events/#account-notifications)).
5. Syncable authenticators can improve access across devices, but recovery of the sync fabric is itself a threat. Vidha cannot assume that two passkeys represent two independent failure domains or claim an assurance level without a complete assessment ([NIST syncable authenticator guidance](https://pages.nist.gov/800-63-4/sp800-63b/syncable/)).

### Vidha synthesis: selected contract

Credential state and session state must be independent, explicit records.

| Event                           | Required proof                                                                                                             | State effect                                                                                                                                         | Session effect                                                       | Synthetic notification intent          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| Add passkey while authenticated | Fresh assertion from an existing active passkey, one-time registration ceremony, new credential proves authentication once | Add credential as active                                                                                                                             | Keep current session; record credential source                       | All previously verified Owner channels |
| Revoke one lost device          | Fresh assertion from another passkey, or accepted recovery completion                                                      | Mark exact credential revoked; optional WebAuthn cleanup signal only                                                                                 | Revoke every session issued through that credential                  | All verified Owner channels            |
| Remove a passkey                | Fresh assertion; cannot remove the last usable passkey while Armed                                                         | Revoke exact credential                                                                                                                              | Revoke sessions issued through it                                    | All verified Owner channels            |
| Start account recovery          | Two independent synthetic recovery proofs in the state-machine fixture                                                     | Enter `RECOVERY_PENDING` for 72 hours; allow a valid passkey to cancel                                                                               | Existing sessions remain able to cancel but cannot finalize recovery | All old verified channels              |
| Complete account recovery       | Cooling-off elapsed, proofs still valid, no cancellation, new passkey ceremony succeeds                                    | Consume/rotate recovery material; advance credential epoch; revoke every pre-recovery binding; activate only the new passkey; append immutable event | Revoke all prior sessions                                            | All old verified channels              |
| Change verified contact         | Fresh passkey assertion plus successful verification of the new channel                                                    | Enter `CONTACT_CHANGE_PENDING` for 72 hours; old channel remains authoritative and can cancel                                                        | Revoke all sessions when the change becomes authority-bearing        | Old and new channels, content-free     |

The 72-hour values are proposed Vidha policy for adversarial tests, not values supplied by NIST. They must be user-reviewed before an ADR.

Additional rules:

- For the synthetic fixture, “two independent recovery proofs” means one saved-code verifier plus one separately issued, single-use proof delivered to a preexisting synthetic Owner channel. The two verifiers, issuance paths, storage records, and compromise assumptions must not share one secret. This is a test contract, not an approved real recovery design; if credible independence cannot be demonstrated, recovery completion remains disabled.
- Encourage at least two passkeys before arming, while clearly warning that synced credentials may share one platform recovery fabric. Do not claim physical or provider independence that the RP cannot observe.
- Model saved recovery codes in Phase 3 only as salted/keyed verifier fixtures. Do not display or collect a real code. A recovery-code-only path cannot immediately change a Release Policy, Recipient, deadline, or lifecycle state.
- Recovery completion advances an Owner credential epoch and marks every credential from the prior epoch `RECOVERY_REVOKED`, including credentials not identified by the recovering party. No old credential can authenticate afterward. A previously trusted device may return only through a fresh, authenticated binding ceremony initiated with the newly recovered credential.
- Starting recovery cannot itself Check in, cancel Concern, pause, disable, or change a policy. Completing recovery restores account control but never counts as a Check-in; subsequent lifecycle actions still require their ordinary proof.
- A Guardian or Recipient is not an Owner recovery contact by virtue of their role. Recovery authority must be separately selected, consented, minimized, and reviewed in a later phase.
- Notifications contain no private Envelope content, filename, policy, deadline, or reason. They are outbox intents to the synthetic sink only in Phase 3.
- All recovery, revocation, and contact-change commands carry immutable expected revisions and semantic idempotency keys. Concurrent cancellation/completion resolves through one transaction and fails closed on stale revision.

### Trade-offs and stop condition

Fail-closed cooling-off makes hostile recovery slower but can prolong legitimate lockout. Multiple passkeys improve availability but do not prove independent custody. Recovery codes improve portability but introduce a high-value secret. Contact-channel recovery is usable but inherits inbox/number compromise and recycling risk. Tests must prove that recovery invalidates an undisclosed pre-recovery credential, concurrent old-credential use, every old session, and stale completion/cancellation while allowing only an explicit post-recovery rebind. Phase 3 should implement and test only state records, transitions, audit, and synthetic notification intents; stop before creating a real recovery factor, verifying a real channel, selecting a real recovery contact, or claiming identity proofing.

## 3. Smallest self-hostable core topology

### Verified facts

1. The repository is AGPL-3.0 and deliberately requires replaceable provider integrations. The GNU AGPL is designed for network-interactive software and requires corresponding-source access under its terms ([Vidha license](../../LICENSE), [GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html)).
2. PostgreSQL uses the liberal PostgreSQL License. Node.js and SimpleWebAuthn use permissive licenses. This supports the proposed dependency inventory, subject to notices and final review; it is not legal advice ([PostgreSQL license](https://www.postgresql.org/about/licence/), [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE), [SimpleWebAuthn license](https://github.com/MasterKale/SimpleWebAuthn/blob/master/LICENSE.md)).
3. SQLite permits multiple readers but serializes writes, and WAL requires all processes to be on the same host. SQLite's own guidance recommends a client/server database when data and application processes are separated by a network ([SQLite isolation](https://www.sqlite.org/isolation.html), [WAL](https://www.sqlite.org/wal.html), [network caveats](https://www.sqlite.org/useovernet.html)).
4. PostgreSQL row locking and `SKIP LOCKED` support multiple queue-like consumers; PostgreSQL also provides portable logical backup/restore and point-in-time recovery building blocks ([locking clause](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE), [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html), [PITR](https://www.postgresql.org/docs/18/continuous-archiving.html)).

### Vidha synthesis: selected topology

Use one versioned Node application image and one PostgreSQL 18 service as the core topology.

- `ROLE=api`: serves the built PWA and HTTPS API; owns WebAuthn ceremony endpoints, session validation, authorization, and application commands. It never runs lifecycle transitions from a timer.
- `ROLE=worker`: runs two replaceable modules in one process: a scheduler poller that submits deterministic application commands and an outbox dispatcher that calls only a synthetic sink. The modules share no domain rules.
- `postgres`: stores credentials, sessions, ceremonies, Plan state, audit, migrations, due jobs, leases, outbox, retention state, and encrypted synthetic metadata.

The API and worker are the same artifact and configuration schema with least-privilege database roles. A small self-host can run one API process and one worker process. Every row carries an opaque `installation_id`; Phase 3 proves only one installation, one synthetic Owner, and one Plan. Hosted multi-tenant isolation and PostgreSQL row-level-security policy are deferred rather than implied. A hosted topology may scale either role independently with row leases; that is not proven in Phase 3.

The disposable capacity envelope is an explicit test assumption, not a product limit: at most 10 WebAuthn credentials, 32 active sessions, 4 worker processes, 1,000 simultaneously due jobs, and 100,000 historical audit/outbox rows. Crossing it blocks topology acceptance until contention, latency, cleanup, backup, and restore evidence is rerun at the larger bound.

The optional import profile is additional topology, not hidden inside the core claim. Enabling it adds a bounded quarantine store, single-job isolated `libmagic` classifier processes, one offline ClamAV daemon, a separate network-restricted `freshclam` maintenance process, and per-job Pandoc OCI converter processes. Section 5 defines their boundaries and blocks enablement until the exact runtime and platform isolation evidence exists.

Deliberate omissions:

- No Redis, Kafka, external workflow engine, managed identity tenant, managed scheduler, or hosted queue.
- No object store yet. Personal content and Standard/Sealed item cryptography remain blocked; synthetic import bytes stay in a disposable quarantine adapter.
- No provider-specific email/SMS/push adapter. The only sink is local, synthetic, redacted, and idempotent.
- No external watchdog action beyond a future read-only “scheduler stale” alert. A watchdog can never issue a domain command.
- No public ingress, production TLS key, production database credential, telemetry account, or multi-region claim.

Configuration must inventory RP ID/origins, database URL, application and migration database roles, session/CSRF secrets, metadata key provider, `age` backup recipient, retention settings, scanner socket, converter image digest, scheduler poll interval, lease/retry limits, environment identity, and restore-safe mode. Secrets are mounted or injected, never committed or included in diagnostics.

### Why PostgreSQL, not production SQLite

SQLite remains valuable for local tests and possibly a future single-host mode. It is not the Phase 3 operational baseline because the selected topology has separate API/worker processes, needs queue-like leases and contention evidence, and must not encourage a database file on network storage. Supporting SQLite later requires the same migration, backup, restore-safe, outbox, and crash contract—not a reduced safety contract.

### Required evidence and stop condition

Run a local disposable deployment from a clean checkout; prove separate database roles, secret inventory, migrations, API/worker restart, database outage, worker duplication, restore-safe startup, and rollback to the previous synthetic schema. Record exact images and license notices. Stop before binding non-loopback ingress, issuing a public certificate, creating production secrets, or claiming hosted/self-hosted operational equivalence.

## 4. Encrypted metadata persistence operations

### Verified facts

1. PostgreSQL `pgcrypto` executes inside the database server, so data and passwords move between it and the client in cleartext; its documentation recommends client-side cryptography if the database/server administrator is not trusted. Full-disk encryption and TLS address different boundaries ([PostgreSQL `pgcrypto` limitations](https://www.postgresql.org/docs/18/pgcrypto.html#PGCRYPTO-SECURITY-LIMITATIONS), [encryption options](https://www.postgresql.org/docs/18/encryption-options.html)).
2. AES-GCM is an authenticated-encryption mode, Node's stable Web Crypto API implements it, and the initialization vector must be unique for every operation under one key ([NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final), [Node Web Crypto](https://nodejs.org/api/webcrypto.html)).
3. Key management is a lifecycle covering generation, inventory, access, backup/recovery, rotation, compromise, and destruction—not merely an environment variable ([NIST SP 800-57 Part 1 Rev. 5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)).
4. `pg_dump` makes a consistent logical archive while the database is in use; `pg_restore --single-transaction` can make restoration all-or-nothing. A dump can execute source-controlled SQL during restore and must be treated as trusted operational input ([PostgreSQL `pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html), [`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html)).
5. PostgreSQL PITR requires a base backup plus a continuous archived WAL sequence; it is a different operational mechanism from a logical `pg_dump` archive ([PostgreSQL PITR](https://www.postgresql.org/docs/18/continuous-archiving.html), [PostgreSQL `pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html)).
6. Dropping a PostgreSQL column does not immediately remove its bytes from storage; the bytes remain until a later table rewrite ([PostgreSQL `ALTER TABLE`](https://www.postgresql.org/docs/18/sql-altertable.html)).
7. `age` is a BSD-licensed file-encryption tool with an official versioned format and explicit recipient/identity separation. Its CLI can encrypt a streamed backup to an offline recipient ([official `age` repository](https://github.com/FiloSottile/age), [format](https://age-encryption.org/v1), [license](https://github.com/FiloSottile/age/blob/main/LICENSE)).
8. Node's official crypto API supports Ed25519 signing and verification ([Node `crypto.sign` and `crypto.verify`](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback)).

### Vidha synthesis: selected persistence contract

Use PostgreSQL 18 for Phase 3 metadata and perform sensitive-field encryption in the Node application before SQL.

#### Data classes

- **Minimal queryable plaintext:** opaque installation/Owner/Plan IDs, schema version, immutable policy revision, lifecycle/cycle stage, due timestamps, task type/status, lease expiry, retry counters, ciphertext version, and content-free audit ordinals. These fields need indexing or deterministic safety evaluation. They must not contain names, addresses, filenames, excerpts, notification bodies, or caller idempotency keys.
- **Application-encrypted metadata:** contact values, display labels, recovery metadata, WebAuthn user handles and raw credential identifiers where lookup does not require plaintext, import names/warnings, and detailed audit context. Each stored envelope contains format version, algorithm, key version, one wrapped random 256-bit data-encryption key, a fresh random 96-bit IV used once with that key, ciphertext, and a 128-bit authentication tag. Associated data binds installation ID, record type, opaque record ID, field name, and schema version. Missing/unknown versions, authentication failure, or associated-data mismatch fails closed before parsing plaintext.
- **Lookup tokens:** where exact lookup is required, use a keyed blind index separate from ciphertext; a blind index leaks equality and must be documented. Do not use deterministic encryption as an unreviewed shortcut.
- **Not in scope:** Envelope content, Attachment bytes, Standard Mode item keys, Sealed Mode, break-glass, or Recipient key delivery.

Define a `MetadataKeyProvider` port. For disposable self-host evidence, load one key-encryption key from a read-only mounted file outside PostgreSQL that is accessible only to the key-provider process, wrap per-record data-encryption keys, and never export plaintext keys into a dump. A hosted KMS/HSM adapter is deferred; environment variables are not accepted as a production key-custody claim. Rotation writes a new envelope under the new key version, verifies authenticated decryption, and atomically swaps the row; interrupted batches resume from persisted progress while old key versions remain available. A failed verification leaves the old envelope authoritative. Losing all valid key versions is an honest terminal state.

#### Migrations and rollback

- Keep monotonic SQL migration IDs and checksums in PostgreSQL. Run migrations through a dedicated least-privilege command under a database advisory lock, never implicitly in every API instance.
- Phase 3 migrations are additive/expand-backfill-contract over synthetic data. Every migration gets forward, interrupted-resume, stale-binary, contention, and restore tests. Destructive contract steps remain disabled until retention and backup expiry are approved.
- “Rollback” means restore the pre-migration encrypted backup into an isolated restore-safe environment, verify schema/data invariants, then explicitly promote. Down migrations are allowed only when demonstrably lossless; they are not the disaster plan.

#### Backup and restore

Create a custom-format `pg_dump` and stream it through a pinned `age` binary to an offline recipient. `age` provides archive encryption but does not, by itself, express Vidha installation provenance, so each generation also gets a content-free authenticated manifest containing a strictly increasing generation number, parent-manifest digest, ciphertext digest, schema version, database major, application commit, creation time, environment/installation identity, and key-version inventory. Sign the manifest with a separately stored offline Ed25519 key and copy its generation/digest to an append-only external inventory. Before decryption, reject an invalid signature, digest mismatch, broken parent chain, or generation older than the external inventory. Verify decryption and run `pg_restore --single-transaction` only in an isolated disposable database under a least-privilege restore role. The `age` identity and manifest signing key are not stored with the backup or in PostgreSQL; loss of the external inventory blocks promotion rather than silently accepting rollback.

Restored systems start in `RESTORE_SAFE`: all application mutations, scheduler claims, outbox dispatch, scanner updates, and provider adapters are disabled. Inspection and invariant checks precede an explicit promotion. This is a Phase 3 logical-backup baseline, not an RPO/RTO, HA, or PITR claim.

#### Retention and deletion

Retention durations remain unresolved product decisions, so Phase 3 implements configuration and synthetic expiry tests without inventing public values. Deletion must distinguish active rows, encrypted field ciphertext, lookup tokens, outbox/dead-letter records, audit obligations, quarantine bytes, and every backup generation: removing a live row cannot remove copies already captured in older backup generations. A successful live delete is reported as logical/live-store deletion; backup expiry and key destruction are separately evidenced. Cryptographic key destruction is not advertised as complete erasure of unencrypted indices, logs, replicas, or previously delivered data.

### Rejected alternatives and stop condition

- `pgcrypto` alone is rejected for the operator/database-reader threat because plaintext and keys enter the database process.
- Full-disk encryption alone is rejected because it does not protect against an authorized database reader or a running compromised server.
- PGlite remains a parity fixture, not hosted PostgreSQL operations evidence.
- SQLite remains a test adapter; selecting it for production would contradict the separate-process topology until same-host locking, backup, and contention are proved.
- PITR is deferred because its continuous WAL archive is additional operations; it cannot be selected until recovery objectives, retention, monitoring, and restore evidence exist.
- Unencrypted `pg_dump`, a backup stored beside its identity, or a restore that can dispatch tasks fails the gate.

Stop before storing personal content or a real contact/credential. Do not call this Standard Mode, operator-unreadable, independently reviewed, recoverable, production encrypted, or deletion-complete.

## 5. Scanner and isolated converter for untrusted files

### Verified facts

1. ClamAV is an open-source signature scanner. `freshclam` downloads and updates official signature databases; `clamd` supports streamed `INSTREAM` scanning with a configured `StreamMaxLength`. Scan limits can cause files to be skipped or produce errors, so every non-clean/error/limit outcome needs explicit handling ([ClamAV signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html), [`clamd` protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html), [scanning limits](https://docs.clamav.net/manual/Usage/Scanning.html)).
2. At this report's snapshot, ClamAV's official support table lists `1.5.4` and `1.4.6` as the current security-patch releases. ClamAV is GPLv2-only; its optional UnRAR component has a separate restricted license and is runtime-loaded rather than linked. Exact image contents therefore need review ([functionality/release table](https://docs.clamav.net/appendix/FunctionalityLevels.html), [official releases](https://github.com/Cisco-Talos/clamav/releases), [ClamAV repository and licensing](https://github.com/Cisco-Talos/clamav), [GPLv2 text](https://github.com/Cisco-Talos/clamav/blob/main/COPYING.txt)).
3. The EICAR anti-malware test file exists specifically to test scanners without handling real malware ([EICAR test file](https://www.eicar.org/download-anti-malware-testfile/)).
4. `libmagic` identifies file types from byte patterns and can return MIME types; filename extensions alone are not content classification. The official `file` repository's `COPYING` grants source/binary redistribution under two stated notice/disclaimer conditions (a BSD-style license) ([official `file`/`libmagic` repository](https://github.com/file/file), [magic format](https://github.com/file/file/blob/master/doc/magic.man), [libmagic API](https://github.com/file/file/blob/master/doc/libmagic.man), [official `COPYING`](https://github.com/file/file/blob/master/COPYING)).
5. Pandoc can read Markdown, HTML, DOCX, and other formats. Its own security guidance says `--sandbox` narrows file/network access, untrusted HTML has had SSRF risk, generated HTML is not guaranteed safe, filters/PDF engines can escape the intended boundary, and pathological inputs need time/memory limits. Pandoc is GPL-2.0-or-later ([Pandoc manual security](https://pandoc.org/MANUAL.html#security), [official license](https://github.com/jgm/pandoc/blob/main/COPYRIGHT)).
6. OCI Linux containers can create separate user, PID, network, mount, IPC, and cgroup namespaces and express read-only paths and resource limits. Those mechanisms support a converter boundary but do not prove isolation; the exact runtime/kernel configuration still requires adversarial evidence ([OCI Linux runtime configuration](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md)).
7. GNU's license guidance distinguishes mere aggregation of separate programs from linked or combined programs, and its compatibility guidance does not list GPLv2-only as compatible with AGPLv3. Whether a concrete distribution is one combined work depends on the actual coupling and packaging ([GNU license FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation), [GPL version compatibility](https://www.gnu.org/licenses/license-compatibility.en.html)).

### Vidha synthesis: selected pipeline

1. **Prepare:** accept only disposable fixtures into a quarantine store; assign an opaque ID; record declared type, byte length, SHA-256, and exact immutable bytes. Apply a streaming hard byte cap before any parser and reject an incomplete or over-limit body.
2. **Classify:** run an exact reviewed `libmagic` release/build against exact bytes with decompression disabled in a single-job process outside the API and worker. Do not accept a floating OS package; record the version, source, official `COPYING`, build flags, and database digest before bundling. Give it no database credential, application socket, writable host path, or network; allow only the read-only input and bounded result channel. A declared/classified mismatch becomes `TYPE_MISMATCH`, not a warning that can be bypassed.
3. **Scan:** stream exact bytes to a separate, pinned ClamAV `1.5.4` (or reviewed successor) daemon over a local Unix socket using `INSTREAM`. Run the daemon outside the API and worker with no database/application credentials, outbound network, or writable path beyond bounded scanner scratch/signature mounts. Disable third-party signatures and optional UnRAR in the baseline image. Record engine version, signature database version/time, configured limits, byte digest, verdict, and duration. `ERROR`, `LIMIT_EXCEEDED`, `ENCRYPTED_OR_UNSUPPORTED`, and timeout fail closed; “no detection” is not called “safe.”
4. **Update signatures:** run pinned `freshclam` as a separate maintenance process with restricted egress only to configured official ClamAV distribution endpoints and no Vidha/database credentials. Stage an updated signature set, exercise it with benign and EICAR fixtures, then switch the scanner to the reviewed set; an update or reload failure preserves the last passing set and blocks any freshness claim.
5. **Convert:** only an approved scan proof for the same digest can enqueue conversion. Launch a fresh digest-pinned Pandoc OCI job with non-root user and user namespace, no network namespace route, read-only root, no host devices, all capabilities dropped, `no_new_privileges`, default-deny seccomp/AppArmor or equivalent, one read-only input mount, one empty bounded output mount, PID/CPU/memory/output/time limits, and automatic destruction.
6. **Pandoc profile:** invoke the executable, not the library; enable Pandoc `--sandbox`; allow only explicit `txt`, CommonMark/Markdown, HTML-without-raw-HTML, and DOCX readers; disable filters, Lua, templates, includes, PDF engines, remote/local resource fetching, and media extraction. Produce Pandoc JSON, not rendered HTML.
7. **Canonicalize:** validate the JSON against a versioned allowlist of blocks/marks/links, reject unknown/raw nodes and dangerous URL schemes, then convert to Vidha's canonical Editable Document. Preserve the original as an Attachment candidate and show fidelity warnings. Converter output is untrusted until validation completes.
8. **Retain/delete:** expire quarantine bytes, scan proof, converter scratch, and rejected output under an explicit synthetic retention policy. No original or output enters an Envelope in Phase 3.

ClamAV and Pandoc should remain separately invoked programs/images with their own source and notices; Vidha must not link `libclamav`. This is a Vidha distribution recommendation derived from the license evidence, not a verified legal conclusion. The self-host bundle must provide exact source/license routes for those versions, and a legal/license review remains required if distribution shape or protocol coupling changes.

The process boundaries above are target isolation contracts, not runtime selection or completed sandboxes. **Classification, scanning, and conversion all remain disabled** until each parser has a named, versioned containment profile and adversarial evidence:

- `libmagic`: exact executable/database digests, single-job rootless runtime or platform sandbox, non-writable root, read-only one-file input, bounded output/scratch, no network, no application sockets/credentials, syscall policy, and CPU/memory/PID/time limits.
- `clamd`: exact engine/image/signature-set digests, dedicated unprivileged identity, non-writable root and signatures, bounded scratch, no outbound network, only its narrow scan-broker socket, no application/database credentials, syscall policy, and CPU/memory/file/time limits. The networked `freshclam` profile is distinct and cannot share the scanner identity or runtime.
- Pandoc: the per-job OCI contract above, with the same explicit runtime, kernel/platform, filesystem, syscall, network, resource, image-provenance, and teardown evidence.

Implementation is blocked until an exact rootless runtime and version, host kernel, seccomp/AppArmor profiles or platform equivalents, image digest/build provenance, and Linux/macOS/Windows self-host parity strategy are selected for all three. If a platform cannot provide the stated boundary, the affected import stage stays disabled there.

### Required corpus and stop condition

The fixture corpus must include benign TXT/Markdown/HTML/DOCX, EICAR, declared/classified mismatches, truncated and polyglot files, encrypted archives/documents, recursive archives, high-ratio compression, oversized members, excessive file count/depth, malformed XML/ZIP/DOCX, external relationships, HTML iframe/URL SSRF attempts, slow/pathological parser cases, output floods, process crashes, stale scan proofs, signature-update/reload failure, compromised-updater reachability attempts, and concurrent replacement/mutation attempts. Assert classifier/scanner/converter credential isolation, scanner and converter network denial, updater egress restriction, no host-file read, exact-byte proof binding, resource termination, content-free logs, and cleanup.

Stop before a real upload. Scanner success does not prove benign content, containerization does not prove isolation, and conversion does not prove fidelity or safe rendering.

## 6. Durable scheduler and transactional outbox

### Verified facts

1. Node timers do not guarantee exact firing time or ordering ([Node timer documentation](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args)).
2. PostgreSQL transactions make a group of database statements all-or-nothing within the transaction boundary ([PostgreSQL transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html)).
3. `SELECT ... FOR UPDATE SKIP LOCKED` is explicitly useful for multiple consumers of a queue-like table, though it is not a consistent general-purpose view ([PostgreSQL locking clause](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE)).
4. PostgreSQL unique constraints provide database-enforced semantic uniqueness. Constraint design must account for null behavior and the exact key columns ([PostgreSQL constraints](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)).
5. `LISTEN`/`NOTIFY` delivers notifications only after commit, may fold duplicate notifications, and has documented payload and queue limits ([PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/18/sql-notify.html)).
6. PostgreSQL exposes transaction-start and wall-clock time separately. A lease system must choose its authoritative database-time function deliberately rather than comparing independent worker clocks ([PostgreSQL date/time functions](https://www.postgresql.org/docs/18/functions-datetime.html)).

### Vidha synthesis: selected semantics

Because Node timers lack delivery guarantees, treat them only as polling wakeups, not durable scheduling authority. Use the all-or-nothing PostgreSQL boundary to commit accepted Plan state, audit, and its synthetic outbox intent together. Treat `LISTEN/NOTIFY` only as an optional wakeup because its documented folding and queue properties do not provide Vidha's durable job record. Persist two concepts:

- `scheduled_job`: deterministic intent to ask the application/domain whether one Concern-bounded transition is due. Fields include opaque job ID, Plan ID, expected revision/cycle, positive allowlisted kind, `dueAt`, state, lease owner/expiry, monotonically increasing `claimGeneration`, attempt count, and semantic key.
- `outbox_task`: a post-commit synthetic side-effect intent created in the same transaction as the accepted domain state/audit. Fields include opaque task ID, source event ID, positive allowlisted kind, encrypted/redacted payload reference, state, lease owner/expiry, monotonically increasing `claimGeneration`, next attempt, attempt count, and semantic key.

The only initial scheduled kind is `ADVANCE_CHECK_IN_CYCLE`; the scheduler never computes a transition itself. The only initial outbox kinds are content-free synthetic observations such as `OWNER_REMINDER_FIXTURE` and `OWNER_CONCERN_FIXTURE`. The schema and TypeScript unions must contain no Guardian Attestation, Recipient delivery, final notice, Veto Window, Delivery Hold, Automatic Fallback, Envelope availability, or Release-shaped task.

Worker loop:

1. The injected controllable clock decides domain due time; PostgreSQL `clock_timestamp()` is authoritative only for lease acquisition/expiry. Claim a bounded ordered batch with `FOR UPDATE SKIP LOCKED`, increment `claimGeneration`, and set owner/expiry in the same transaction.
2. Submit the deterministic application command using the job semantic key and expected revision. Domain state remains framework-independent and advances at most one semantic stage per command.
3. In one PostgreSQL transaction, persist accepted state/audit, mark or reschedule the job, and insert any allowlisted outbox task under a unique semantic key.
4. Dispatch an outbox task to the local synthetic sink under an expiring lease. Before dispatch and for every later database write, require the exact task ID, lease owner, and `claimGeneration`; reject an expired or superseded claim. The sink deduplicates by task ID and records only redacted fixture evidence.
5. Mark delivered in a new transaction conditioned on the same fencing tuple and an unexpired database-time lease. A crash after sink acceptance but before this mark can replay, so semantics are **at least once plus idempotent sink**, never exactly once. Fencing prevents a stale worker from updating the database; sink idempotency handles the unavoidable race around an external call.
6. On retryable failure, increment attempt and apply bounded deterministic backoff; after the configured limit, enter an inspectable dead-letter state. Dead-letter inspection cannot mutate Plan state or create another task.

`LISTEN/NOTIFY` may wake the worker, but polling the tables remains mandatory. Downtime catch-up processes one domain stage per command and cannot infer or compress any later safety phase. Restore-safe mode prevents every claim and dispatch.

### Failure evidence and stop condition

Use a controllable clock and forced crash points for: before transaction, after claim, after domain decision before commit, after state/outbox commit, after sink acceptance before acknowledgement, after acknowledgement; duplicate workers; lease expiry/reclamation; semantic-key conflict; stale policy revision; ordered downtime catch-up; database disconnect; retry exhaustion; dead-letter inspection; `NOTIFY` loss; restore-safe startup; and redacted telemetry. One test must pause worker A after claim, let the database lease expire, let worker B reclaim with the next generation, then resume A and prove every A database write is rejected while duplicate sink delivery remains content-identical and deduplicated. Property tests must establish that only the positive allowlist can be persisted or dispatched.

Stop before a provider adapter, real notification, Guardian Attestation, Recipient flow, final notice, Veto Window, Delivery Hold, Automatic Fallback, or Release task. Completion proves only disposable durability semantics, not provider delivery, human retrieval, or production scheduling.

## Cross-slice acceptance gate

Phase 3 research supports implementation only if all six slices preserve these joint properties:

1. Identity, session, recovery, scheduler, and scanner adapters never recreate domain lifecycle rules.
2. Every mutation uses an authenticated/authorized application command, expected immutable revision, injected time, semantic idempotency, and an auditable transaction.
3. Secrets, contact values, filenames, imported bytes, challenges, session tokens, recovery verifiers, and notification bodies never enter logs or plaintext backups.
4. Restore-safe mode disables scheduler claims, outbox dispatch, scanner updates, converter execution, and all application mutations until explicit promotion.
5. The local fixture environment can be destroyed without preserving personal data or contacting anyone.
6. The runnable UI and public docs continue to say pre-alpha, synthetic, Concern-bounded, and not production/release ready.

Passing the disposable adapter gate does not establish production authentication, real recovery, identity proofing, personal-data acceptance, Standard Mode, Sealed Mode, notification delivery, Guardian authority, Release, deployment, or v1 readiness. The intermediate Phase 3B milestone supplies only the evidence in its current foundation record; Phase 3B closure and every independent release gate remain mandatory.
