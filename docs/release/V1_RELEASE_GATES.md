# Version 1 release gates

**Target:** the first public `v1.0.0` release. No release exists today.

Sections 1–11 are **release-readiness gates**. Every checkbox in those sections must be supported by current evidence before external publication begins. Section 12 is the ordered publication-and-closure procedure; its checks necessarily occur afterward. A blocked readiness gate stops publication. A failed publication step stops later steps and invokes its rollback or incident path. Version 1 is complete only when both readiness and closure pass.

## 1. Product decisions

- [ ] Every unresolved decision in `docs/product/PRODUCT_BRIEF.md` has a user answer.
- [ ] `CONTEXT.md`, ADRs, UI terminology, schemas, tests, and templates agree.
- [ ] The v1 scope and explicit non-goals are visible in the app and public documentation.
- [ ] The Vidha name has received repository, package, domain, app-store, and appropriate legal/trademark review; no uniqueness claim exceeds the evidence.

## 2. Core journeys

- [ ] Owner registration and strong authentication work on supported browsers.
- [ ] Guardian and Recipient invitation, consent, revocation, and reverification work.
- [ ] An Owner can create, rehearse, arm, pause, resume, export, and delete a Contingency Plan.
- [ ] Routine Check-in, missed Check-in, Concern, bounded Guardian Attestation, Veto Window, cancellation, and Release work end to end.
- [ ] Automatic Fallback is clearly opt-in per Envelope and satisfies the enforced minimum delay.
- [ ] Every journey has an accessible recovery or honest terminal state.

## 3. State-machine safety

- [ ] The domain transition table is explicit and reviewed.
- [ ] All time is injected; tests cover exact boundaries before, at, and after deadlines.
- [ ] Duplicate commands, jobs, webhooks, and provider retries are idempotent.
- [ ] Concurrent Guardian, Owner, and scheduler actions cannot bypass policy revision checks.
- [ ] Guardian Attestation prompts, response states, evidence handling, conflicts, abstention, expiry, holds, and UI wording match the accepted policy and never ask anyone to declare death.
- [ ] `GET`, email open, preview bot, and unauthenticated link fetches cannot mutate safety state.
- [ ] A missed Check-in never produces a death claim.
- [ ] Under every Release Policy, catch-up cannot create a final Owner notice, consume its Veto Window, and authorize Release in one historical-time pass.
- [ ] Every Release path starts a fresh Veto Window only after at least one verified Owner channel accepts the final notice; all-channel failure before Release enters Delivery Hold.
- [ ] Accepted-then-bounced, rejected, expired, delayed, reordered, and replayed Owner-notice evidence is re-evaluated before Release; if no accepted, non-failed channel remains, Delivery Hold prevents Release and clearing it starts a new full window.
- [ ] Property or model-based tests establish that no invalid path reaches Release.

## 4. Documents and imports

- [ ] The canonical editor schema is versioned and has portable Markdown/HTML export.
- [ ] TXT, Markdown, HTML, and DOCX conversion behavior is documented and fixture-tested.
- [ ] Unsupported formats remain Attachments without a false editability claim.
- [ ] File detection, limits, quarantine, malware scanning, sandboxed conversion, and archive defenses are tested.
- [ ] Source preservation and conversion warnings are visible before an Owner accepts an editable copy.
- [ ] Export and import round trips are tested on representative documents.

## 5. Encryption and access

- [ ] Standard Mode covers every Editable Document and Attachment with per-item encryption, reviewed key wrapping, and rotation.
- [ ] Administrative decrypt requires step-up access, reason, immutable audit, and alerting.
- [ ] Sealed Mode covers every item in its Envelope and ships only if the protocol, recovery story, independent review, and test vectors pass; otherwise the feature is absent or explicitly experimental and cannot be armed.
- [ ] Authorization is tested across every Owner, Guardian, Recipient, operator, and revoked-contact combination.
- [ ] Tokens, logs, analytics, errors, filenames, and notification templates do not leak content.
- [ ] Security headers, dependency review, secret scanning, and supply-chain checks pass.

## 6. Delivery and operations

- [ ] Email sender identity, templates, consent, bounce handling, webhook verification, and retry behavior work against a real provider sandbox or bounded live test.
- [ ] SMS is either verified with its real cost/compliance boundary or absent from shipped claims.
- [ ] Provider acceptance is distinguished from delivery and human retrieval.
- [ ] The scheduler catches up safely after an outage without compressing safety intervals or clearing Delivery Hold through elapsed time alone.
- [ ] An independent watchdog detects missing scheduler runs but cannot authorize Release.
- [ ] Capacity, free-tier exhaustion, abuse, and rate-limit behavior preserve already-authorized safety work.
- [ ] Backup, encrypted export, restore-safe mode, restore rehearsal, and rollback pass.

## 7. Hosted and self-hosted modes

- [ ] The official deployment is reproducible from versioned infrastructure.
- [ ] Self-hosting starts from a clean machine with documented prerequisites and no hidden hosted dependency.
- [ ] Database migrations and domain tests pass in every supported persistence mode.
- [ ] Provider credentials, key custody, backup ownership, upgrades, and failure responsibility are explicit for self-hosters.
- [ ] Data region, subprocessors, privacy policy, retention, deletion, and abuse contact are published for the hosted service.

## 8. PWA, accessibility, and browser evidence

- [ ] Installability, offline shell behavior, update behavior, stale-client handling, and recovery from a bad service worker are verified.
- [ ] Supported Safari, Firefox, and Chromium versions are derived from real checks, not assumptions.
- [ ] Keyboard, screen reader, visible focus, 200% zoom, reduced motion, contrast, and touch targets pass.
- [ ] Layout is exercised at 320 px, 375×812, 414 px, 768 px, and 1440×900 without horizontal overflow or hidden primary actions.
- [ ] Destructive or irreversible actions have clear labels, consequences, and confirmation behavior.

## 9. Test and repository gate

- [ ] Formatting, lint, type checking, unit, integration, migration, security, and Playwright suites pass from a fresh checkout.
- [ ] CI uses pinned or reviewed actions with least-privilege permissions.
- [ ] The dependency lockfile, license inventory, SBOM, and vulnerability scan are current.
- [ ] `graphify update .` succeeds and a scoped query confirms the current public surface and Release flow.
- [ ] `git diff --check`, repository status, generated-file policy, and secret scan are clean.

## 10. Evidence-led public surface

Run `refresh-docs` against the verified release candidate—not this pre-alpha README.

- [ ] Product facts and coverage ledger are rebuilt from current runtime, source, tests, manifests, and release configuration.
- [ ] README and public website explain the real product to a first-time visitor.
- [ ] Screenshots and recordings come from exercised demo data with no private information.
- [ ] No fake metric, testimonial, download, platform, signing, updater, version, or security claim remains.
- [ ] Start, self-host, help, privacy, security, release notes, and troubleshooting paths are consistent.
- [ ] Private vulnerability reporting is enabled and its reporter-facing route works, or a different verified private channel is published.
- [ ] All links, anchors, metadata, favicons, SVGs, social assets, and responsive layouts are verified.

## 11. Final release readiness

- [ ] The required two-round council has four actual reviewers per round and no unresolved blocker.
- [ ] Council-driven corrections have been implemented and affected checks rerun.
- [ ] The user has explicitly invoked the current release handoff; any spending, provider terms, domain purchase, or newly destructive operation has separate current authority.
- [ ] Immediately before mutation, the authenticated GitHub identity, exact `origin`, repository owner/name/visibility, branch and SHA, hosting account/project, domain, database/environment, and release target are recorded and match the approved targets.
- [ ] No step requires force-push, rewriting an existing tag/release, destructive production migration, or deletion; any such need stops for fresh authority.
- [ ] Backup, migration rollback, deployment rollback, incident, and communication paths are ready and have named owners.

## 12. Ordered publication and closure

Execute this section only after sections 1–11 pass. Do not pre-check these boxes.

- [ ] The exact release commit is pushed to `main` and CI is green.
- [ ] The hosted surface is deployed from that exact commit and checked live; failure rolls back or disables the candidate and stops before tagging.
- [ ] Only after the hosted candidate passes, `v1.0.0` and its public GitHub release are created through the approved workflow from that exact commit.
- [ ] Release artifacts, source archives, SBOM, checksums, install guidance, release notes, hosted runtime, and self-host instructions agree.
- [ ] The tag, GitHub release, assets, public website, hosted app, install/update path, and self-host path are reverified after publication.
- [ ] A post-publication failure is reported immediately and follows the rollback/incident plan; an already public tag is never silently moved or overwritten.

## Release report

The final report must separate readiness evidence, source verification, local runtime, hosted runtime, CI, tag, GitHub release, public website, and closure evidence. If any surface remains unavailable, report it without calling v1 complete.
