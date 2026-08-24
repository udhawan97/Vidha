# Threat model

**Status:** Pre-v1 security contract. The intermediate Phase 3B milestone supplies disposable executable evidence for selected WebAuthn, durable identity/recovery, wrapped metadata, PostgreSQL transaction/lease, restore-safe, and import-tool properties; Phase 3B remains in progress and controls remain requirements until the exact runnable release candidate proves them.

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
- Pinned SimpleWebAuthn adapters enforce exact RP/origin configuration, one-time purpose-bound ceremonies, user presence/verification, credential counters, and expiring one-time assertion proofs. There is no browser endpoint, cookie, virtual-authenticator matrix, real authenticator, or public origin.
- The PostgreSQL Owner Identity and recovery repositories retain digest-only session/proof material, serialize revisions, consume ceremonies/proofs atomically, enforce independent recovery proofs and a retry lock, and reject mutations in restore-safe mode.
- Wrapped per-record AES-GCM metadata keys bind record/schema context; AES-KW rewrap leaves ciphertext unchanged; signed backup manifests bind generation, parent, and ciphertext digest to an external anti-rollback inventory. The adapters are in-memory fixtures, not production key custody, database restore, Standard Mode, or Sealed Mode.
- Closure-slice-2 source atomically persists metadata-key rewrap plus immutable replay history and rehearses a digest-pinned custom logical archive, wrapped backup data key, post-persistence inventory advancement, rollback/tamper/key-loss rejection, dedicated non-superuser restore, restore-safe invariant digest, read-only promotion denial, and explicit promotion. Exact-commit CI acceptance remains required; in-memory key/signing fixtures, bounded whole-archive encryption, and tmpfs databases do not prove external custody, durable backups, persistent-volume recovery, RPO/RTO, or Standard Mode.
- PostgreSQL commits accepted Plan state, processed-command history, append-only audit, next-stage schedule, and content-free synthetic outbox intent atomically. Its positive task allowlist, `SKIP LOCKED`, database-time leases, fencing, bounded retries/dead letter, restore-safe denial, and idempotent synthetic sink remain provider-free.
- The disposable topology gate terminates identity-checked PostgreSQL backends at six defined migration and four defined claim checkpoints, verifies pre-commit rollback and post-commit replay/fencing, performs one worker-network disconnect/reconnect probe, exhausts and recovers a two-connection pool, claims 1,000 due jobs amid 100,000 audit and 100,000 outbox rows, and checks run-owned row, Compose-project, and tmpfs data-root cleanup. Exact-commit acceptance requires the gate to pass. It is not general outage recovery, high availability, failover, production sizing, or durable-volume evidence.
- Import intake executes source-pinned file classification, ClamAV `INSTREAM`, and bounded Pandoc JSON conversion in mandatory CI. File and Pandoc still run as host CI processes, so this is not rootless OCI isolation or an adversarial-corpus sandbox claim; the browser remains `synthetic_fixture`.

No item above checks a v1 release gate. Browser WebAuthn/cookies, external key custody and durable authenticated database restore, integrated canonical scheduled-command crash evidence, rootless adversarial import isolation, providers, durable-volume recovery, failover, production sizing, and full outage evidence remain Phase 3B closure work or later.

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
