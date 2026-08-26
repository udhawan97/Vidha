# Threat model

**Status:** Pre-v1 security contract. Phase 3B supplies disposable executable evidence for selected WebAuthn, durable identity/recovery, wrapped metadata, PostgreSQL transaction/lease, restore-safe, and import-tool properties. Phase 3C adds a synthetic conversion-review and versioned Editable Document boundary; Phase 3D adds bounded in-memory Document Version and restore-planning evidence; Phase 3E adds an exact-state synthetic Draft Rehearsal Review; Phase 3F adds serialized local Owner actions and explicit terminal-session replacement. Controls remain requirements until the exact runnable release candidate proves them.

Vidha coordinates an irreversible disclosure under uncertainty. Its dominant risk is not only data theft; it is releasing the right content at the wrong time or to the wrong person.

## Assets

- Editable Document and Attachment plaintext
- Document encryption and recovery keys
- Owner, Guardian, and Recipient identities and contact channels
- Check-in and Concern timelines
- Guardian Attestations and Veto Window state
- Release Policies and immutable policy revisions
- audit history, delivery evidence, and backups
- provider credentials and administrative access

## Adversaries and failures

- an attacker controlling an email inbox, phone number, browser session, or stolen device;
- a malicious or mistaken Guardian or Recipient;
- a compromised operator, administrator, dependency, build pipeline, or delivery provider;
- automated email scanners and link-preview bots;
- a malformed or hostile imported document;
- duplicate, delayed, reordered, or missing scheduled jobs and webhooks;
- database, object-store, region, DNS, or provider outage;
- an Owner who loses access, changes contacts, or forgets a recovery secret;
- coercion, harassment, spam, and deliberately false contingency plans;
- ordinary bugs involving time zones, daylight-saving transitions, retries, and concurrent state changes.

## Safety properties

Before version 1 can ship, the implementation must demonstrate:

1. No unauthenticated read request can Check in, approve, veto, hold, or Release.
2. A missed Check-in alone never asserts death.
3. The same command or scheduled job can run more than once without duplicating a semantic transition or delivery.
4. Release evaluates an immutable policy revision and the current verified identities.
5. A change to contacts, deadlines, quorum, encryption mode, or Recipient cannot silently shorten an active safety window.
6. Guardians do not gain Envelope access through their verification role.
7. Guardian Attestations use bounded, explicit semantics and never represent factual or legal confirmation of death.
8. No Release path can consume its Veto Window before a fresh final Owner notice is accepted; negative delivery evidence that leaves all channels failed before Release enters Delivery Hold and clearing it restarts the full window.
9. Notifications reveal no private title, filename, excerpt, or content.
10. Standard Mode plaintext and keys are unavailable to ordinary database or object-store readers.
11. Sealed Mode covers every item in its Envelope and matches the actual protocol; support and administrators have no hidden recovery path.
12. Backups can be restored without sending live notifications or advancing production state.

## Priority threats and required controls

| Threat                                                                   | Consequence                                                    | Required controls                                                                                                                                                            | Release evidence                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| False Release after travel, illness, lost device, or failed final notice | Irreversible disclosure while Owner is alive                   | grace, Guardian default, full Veto Window on every policy, multi-channel notices, Delivery Hold on all-channel negative evidence, rehearsal                                  | virtual-clock, accepted-then-bounced, delayed-webhook, replay, and manual scenario tests |
| Email scanner follows Check-in link                                      | Concern is silently reset                                      | `GET` is read-only, explicit user-presence `POST`, short-lived bound challenge                                                                                               | automated scanner/prefetch test                                                          |
| Duplicate scheduler or retry                                             | repeated notices or Release                                    | transactional outbox, semantic unique keys, provider idempotency, deterministic commands                                                                                     | forced crash/retry tests                                                                 |
| Account takeover                                                         | attacker changes Recipient or policy                           | passkeys, recent-auth requirement, cooling-off period, notifications to old channels, immutable revisions                                                                    | takeover and stale-session tests                                                         |
| Guardian collusion, ambiguity, or conflict                               | unauthorized Guardian Release or false death claim             | bounded attestation semantics, explicit quorum, independent authentication, role-overlap/conflict/expiry rules, minimized evidence, Veto Window, audit                       | prompt review and policy matrix tests                                                    |
| Recipient address recycled or mistyped                                   | disclosure to wrong person                                     | invitation acceptance, periodic reverification, channel-change cooling-off, retrieval authentication                                                                         | bounce/reverification and reassignment tests                                             |
| Operator reads Standard Mode content                                     | privacy breach                                                 | per-item encryption, least privilege, KMS boundary, audited break-glass, alerting                                                                                            | access-policy review and break-glass rehearsal                                           |
| Sealed Mode protocol flaw or key loss                                    | hidden plaintext access or permanent loss                      | reviewed protocol, explicit recovery model, test vectors, export, no contradictory features                                                                                  | independent review and cross-client vectors                                              |
| Malicious DOCX/PDF/archive                                               | code execution, SSRF, resource exhaustion                      | quarantine, type detection, malware scan, sandboxed conversion, macro/script removal, size/time limits                                                                       | adversarial corpus and isolation test                                                    |
| Scheduler or hosted platform outage                                      | missed concern, delayed delivery, or a compressed Release path | indexed catch-up jobs, external watchdog, no same-pass final-notice/window/Release compression, fresh Veto Window after one accepted Owner notice, Delivery Hold if all fail | outage simulation, failed-channel tests, and recovery-time evidence                      |
| Provider accepts but does not deliver                                    | Recipient never learns of Release                              | delivery webhooks, bounce handling, alternate verified channels, operator alert, retrieval status                                                                            | provider sandbox and failure tests                                                       |
| Provider accepts an Owner notice then reports failure                    | Veto Window appears usable when every Owner channel failed     | re-evaluate delivery evidence before Release, authenticated webhook ordering/replay rules, Delivery Hold, full restarted window                                              | accepted-then-bounced, delayed, reordered, expiry, and replay tests                      |
| Free-tier exhaustion or abuse                                            | safety work stops                                              | authenticated/rate-limited endpoints, quotas separated from safety jobs, capacity alerts, paid production boundary                                                           | load and quota-exhaustion tests                                                          |
| Backup restore sends real notices                                        | mass false alert or Release                                    | restore-safe mode, provider adapters disabled by default, environment identity, explicit promotion                                                                           | restore rehearsal with canary providers                                                  |
| Supply-chain compromise                                                  | credential or plaintext theft                                  | lockfile, dependency review, provenance/SBOM, least-privilege CI, secret scanning, reproducible builds                                                                       | CI evidence and artifact inspection                                                      |
| Logs leak sensitive data                                                 | secondary privacy breach                                       | structured redaction, no content logging, short retention, restricted access                                                                                                 | log corpus inspection                                                                    |

## Current Phase 3B evidence boundary

- Canonical session facts come from `SessionVerifier`; caller-supplied principal and time fields are ignored, and an unknown or inactive session fails before a Plan transaction.
- Pinned SimpleWebAuthn adapters enforce exact RP/origin configuration, one-time purpose-bound ceremonies, user presence/verification, credential counters, and expiring one-time assertion proofs. An opt-in loopback-only route adds exact Host/Origin and bounded-JSON checks, read-only GET behavior, a digest-backed Secure/HttpOnly/SameSite=Strict `__Host-` cookie, session-bound CSRF, and atomic rotation/revocation. Chromium supplies virtual-authenticator ceremony evidence; Firefox/WebKit supply only HTTP/session-boundary evidence. There is no real authenticator/person, Safari or supported-browser result, identity proofing, public origin, or production session service.
- The PostgreSQL Owner Identity and recovery repositories retain digest-only session/proof material, serialize revisions, consume ceremonies/proofs atomically, enforce independent recovery proofs and a retry lock, and reject mutations in restore-safe mode.
- Wrapped per-record AES-GCM metadata keys bind record/schema context; AES-KW rewrap leaves ciphertext unchanged; signed backup manifests bind generation, parent, and ciphertext digest to an external anti-rollback inventory. The adapters are in-memory fixtures, not production key custody, database restore, Standard Mode, or Sealed Mode.
- Closure-slice-2 source atomically persists metadata-key rewrap plus immutable replay history and rehearses a digest-pinned custom logical archive, wrapped backup data key, post-persistence inventory advancement, rollback/tamper/key-loss rejection, dedicated non-superuser restore, restore-safe invariant digest, read-only promotion denial, and explicit promotion. Exact-commit CI acceptance remains required; in-memory key/signing fixtures, bounded whole-archive encryption, and tmpfs databases do not prove external custody, durable backups, persistent-volume recovery, RPO/RTO, or Standard Mode.
- PostgreSQL commits accepted Plan state, processed-command history, append-only audit, next-stage schedule, content-free synthetic outbox intent, and claimed-job settlement atomically. The runtime worker supplies only opaque claim/fencing identifiers; the adapter reloads immutable intent and derives database time plus a policy-revision-bound canonical `ADVANCE_TIME`. Four execution crash boundaries, one-stage downtime catch-up through Concern, stale-schedule denial, bounded retry/dead letter inspection, idempotent synthetic-sink replay, and allowlisted content-free telemetry remain provider-free.
- The disposable topology gate terminates identity-checked PostgreSQL backends at six defined migration and four defined claim checkpoints, verifies pre-commit rollback and post-commit replay/fencing, performs one worker-network disconnect/reconnect probe, exhausts and recovers a two-connection pool, claims 1,000 due jobs amid 100,000 audit and 100,000 outbox rows, and checks run-owned row, Compose-project, and tmpfs data-root cleanup. Exact-commit acceptance requires the gate to pass. It is not general outage recovery, high availability, failover, production sizing, or durable-volume evidence.
- Import intake executes source-pinned file classification, ClamAV `INSTREAM`, and bounded Pandoc JSON conversion in mandatory CI. Closure slice 6 adds a digest-pinned rootless Podman executor with one regular read-only input, no network, read-only root, dropped capabilities, `no_new_privileges`, user namespace, resource/output/time limits, positive runtime environment, and named cleanup. A separately labeled updater with no network materializes only the databases embedded in the pinned scanner image; runtime proof binds their SHA-256 manifest identity. The generated corpus covers mismatch, polyglot, high-ratio archive, remote resource, timeout, output flood, malformed AST, symlink, credential/network denial, cleanup, and content-free logs. This is not a production updater, egress policy, real upload, general sandbox, or safe-file claim; the browser remains `synthetic_fixture`.
- Phase 3C makes converted text reviewable before approval, binds approval to the exact converted text, converter identity, and warnings, and keeps source bytes and provenance separate from the versioned Editable Document. Portable HTML is derived through an escaped, positive Markdown subset. The browser still performs only synthetic inspection and UTF-8 conversion; HTML and DOCX editable conversion, durable quarantine, encryption, and persistence remain unavailable.
- Phase 3D validates a bounded canonical Document Version history, rejects malformed, sparse, unsupported, gapped, or exhausted history, suppresses unchanged latest versions, tolerates system-clock rollback without reusing identities, preserves the current draft before a restore, and requires an explicit document-only confirmation. A pending restore is bound to the reviewed Envelope, canonical draft, and history and fails closed on drift. Attachments and imported-source provenance remain outside restoration. The history is session memory, not an encrypted durable store, backup, audit log, or concurrency contract.
- Phase 3E builds a deterministic Draft Rehearsal Review from the current policy revision, synthetic contacts, canonical Editable Documents, and Attachment source identities. It exposes blockers, the complete Check-in-to-Concern offsets, and one content-free test-notice preview; completion fails closed on reviewed-state drift. The browser withholds its Arm action after later Envelope changes. The review digest is only a session drift detector: it is not a server-authoritative content revision, signature, fresh-authentication proof, provider test, delivery receipt, Guardian Attestation, Arm authorization, or Release evidence.
- Phase 3F permits at most one synthetic Owner action to execute at a time, shares the same in-flight result across repeated activation of that action, keeps confirmation open when an operation fails, and disables competing controls until settlement. Native confirmation dialogs start on the reversible choice, contain focus, honor Escape, and return focus. Starting fresh clears the in-memory runtime, Editable Document edits, import source, Attachments, Document Versions, review state, and local events before loading a separate Draft; it never resumes the Disabled Plan. This is a browser-only race and recovery boundary, not server concurrency control, durable deletion, authentication, or production error handling.

No item above checks a v1 release gate. Real-authenticator and supported-browser evidence, external key custody and durable authenticated database restore, production signature updates and upload isolation, providers, durable-volume recovery, failover, production sizing, and full outage evidence remain later work.

## Abuse controls

- Guardians and Recipients affirmatively accept invitations before a plan can be armed.
- Invitation, reminder, and Release templates clearly identify Vidha and offer a safe report/revoke path.
- Rate limits apply per account, destination, IP risk signal, and provider budget without blocking already-authorized safety work.
- Uploaded content and filenames are not rendered as trusted HTML.
- Vidha does not send claims that a person died and does not contact emergency services.
- Administrative tools cannot fabricate Guardian Attestations or silently change an immutable Release Policy.

## Privacy and retention

Fable must resolve and document retention periods before implementation. The default direction is data minimization: store only what advances the plan, proves consent, supports delivery, or enables recovery. Release does not imply indefinite hosted retention. Deletion must explain which already-delivered or legally retained records cannot be recalled.

## Security review gates

Version 1 is blocked until:

- the transition table and authorization matrix have dedicated review;
- Guardian Attestation semantics, evidence handling, conflicts, expiry, and UI wording are approved and tested;
- outage catch-up and all-channel failure cannot bypass a fresh Veto Window on any Release Policy;
- accepted-then-failed, delayed, reordered, expired, and replayed Owner-notice evidence enters Delivery Hold when no non-failed channel remains before Release;
- Standard Mode key handling and break-glass procedures are exercised;
- any Sealed Mode protocol has an independent reviewer and published test vectors;
- importers have an adversarial test corpus and isolation proof;
- restore, provider outage, duplicate job, and account-takeover scenarios pass;
- the public security and privacy claims match the runnable release candidate;
- no unresolved critical or high-severity issue remains.

## Non-claims

This threat model does not certify legal compliance, cryptographic correctness, provider uptime, delivery, or zero risk. Provider acceptance cannot prove the Owner actually read a final notice; the controls reduce but cannot eliminate that residual false-Release risk. It states what must be tested and reviewed before those areas can support narrower public claims.
