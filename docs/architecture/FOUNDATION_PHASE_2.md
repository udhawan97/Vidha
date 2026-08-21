# Phase 2 synthetic foundation

**Status:** Implemented and locally verifiable with disposable synthetic state. This foundation has no real accounts, production credential enrollment, personal-content persistence, production malware scanner, hosted database, Guardian authority, cryptography, notification provider, or Release path.

## Deep modules and seams

| Module                 | Interface exercised by callers                                                                                                                                 | Current adapters or implementation                                                                                  | Deliberate stop                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`      | `createDraftPlan` and `applyPlanCommand`                                                                                                                       | Pure deterministic state transitions                                                                                | Concern remains the final cycle stage; no Guardian or Release command exists                                                                       |
| `packages/application` | Caller-supplied authenticated-principal/session input, interactive command, reminder inspection, scheduler advance, injected clock, and `PlanTransactionStore` | Owner command mapping plus role denial before replay handling; reminder `GET`/`HEAD` is navigation-only             | It does not authenticate a person or issue a session; no passkey provider, real session issuer, recovery, Guardian Attestation, or route framework |
| `packages/persistence` | Atomic Plan transaction, audit read, logical snapshot export/restore, and restore-safe mode                                                                    | In-memory, Node SQLite, and PGlite adapters against one contract suite                                              | SQL runs on disposable data; no production database, encrypted backup, migration deployment, or HA                                                 |
| `packages/documents`   | Prepare, inspect, and explicitly approve an untrusted text import                                                                                              | Bounded UTF-8 converter plus injected scanner seam; the web uses an explicitly synthetic fixture-inspection adapter | No malware proof, sandbox, HTML/DOCX/archive conversion, Attachment store, or production quarantine                                                |
| `apps/web`             | Synthetic Owner actions and explicitly approved browser import                                                                                                 | In-memory Plan store and synthetic fixture inspection                                                               | Refresh clears all state; the UI warns against personal or sensitive information                                                                   |

## Authorization matrix

The application module—not a route or UI—validates caller-supplied authenticated-principal/session input and maps an authorized request to a domain command. It does not authenticate a person or issue a session.

| Actor or input                 | Reminder `GET`/`HEAD` | Owner Check-in `POST`                         | Rehearse Draft                     | Arm, Pause, Resume, Disable             | Scheduler advance                  |
| ------------------------------ | --------------------- | --------------------------------------------- | ---------------------------------- | --------------------------------------- | ---------------------------------- |
| Matching Owner                 | Navigation only       | Allowed with active session and user presence | Allowed with active authentication | Allowed only with recent authentication | Not exposed through Owner command  |
| Different Owner                | Navigation only       | Denied                                        | Denied                             | Denied                                  | Not exposed through Owner command  |
| Guardian                       | Navigation only       | Denied                                        | Denied                             | Denied                                  | Not exposed through Guardian role  |
| Recipient                      | Navigation only       | Denied                                        | Denied                             | Denied                                  | Not exposed through Recipient role |
| Operator                       | Navigation only       | Denied                                        | Denied                             | Denied                                  | Not exposed through operator role  |
| Scanner, preview, replayed GET | Navigation only       | Cannot submit a command                       | Cannot submit a command            | Cannot submit a command                 | Cannot advance                     |
| Scheduler entry point          | Not applicable        | Not applicable                                | Not applicable                     | Not applicable                          | One semantic stage per command     |

Every interactive command requires `POST`, an active authenticated session, explicit user presence, the matching Owner identity, and a semantic idempotency key. Lifecycle changes also carry the expected policy revision. Reminder inspection is pure and repeatable: expiry changes its read-only result but never Plan state.

## Lifecycle transition table

| Current state      | Command       | Required proof                                   | Result                                                                |
| ------------------ | ------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Draft              | Rehearse      | Authenticated matching Owner + current policy    | Remains Draft and records rehearsal                                   |
| Draft              | Arm           | Prior rehearsal + recent authentication + policy | Armed with a new full Check-in interval                               |
| Armed              | Pause         | Recent authentication + current policy           | Paused; scheduler commands cannot advance the cycle                   |
| Paused             | Resume        | Recent authentication + current policy           | Armed with a new full Check-in interval; a prior Concern is cancelled |
| Draft/Armed/Paused | Disable       | Recent authentication + current policy           | Disabled terminal state                                               |
| Disabled           | Any lifecycle | None accepted                                    | Rejected                                                              |

The transition is idempotent by semantic command key. A stale policy revision, expired session, missing user presence, wrong role, backward timestamp, invalid lifecycle, or missing recent authentication fails closed.

## Verification map

- Domain tests cover rehearsal-before-arm, recent authentication, policy-revision mismatch, exact lifecycle transitions, Paused time advancement, fresh resume interval, and Disabled terminal behavior.
- Application tests cover reminder GET replay/expiry, mutation denial, active-session and user-presence requirements, Owner/Guardian/Recipient/operator authorization, injected time, and duplicate scheduler commands.
- Persistence contract tests run the same migration, atomic commit, audit ordering, duplicate, concurrent writer, crash/retry, snapshot restore, and restore-safe assertions against memory, SQLite, and PGlite.
- Document tests cover exact byte preservation, SHA-256 source identity, declared/classified type mismatch, size/line/UTF-8/NUL limits, active content, unsupported HTML/DOCX/archive inputs, scanner failure, and explicit conversion approval.
- Component and Playwright WebKit checks exercise lifecycle controls, quarantine disclosure and approval, session history, source restore/download, escaped HTML export, accessibility, responsive layout, and PWA infrastructure.

These tests are foundation evidence, not production authentication, security, storage, supported-browser, or release evidence.
