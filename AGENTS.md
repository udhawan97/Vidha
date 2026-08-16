# Viraha repository instructions

Viraha is pre-alpha. There is no shipped application, hosted service, installer, updater, or v1 release yet. Never turn a target or plan into a shipped claim.

## Read first

Before changing product behavior, architecture, security, public documentation, or release configuration, read:

1. `CONTEXT.md`
2. every file in `docs/adr/`
3. `docs/product/PRODUCT_BRIEF.md`
4. `docs/security/THREAT_MODEL.md`
5. `docs/release/V1_RELEASE_GATES.md`

Use the exact domain vocabulary in `CONTEXT.md`. Update it immediately when a term is resolved. Record an ADR only for a decision that is hard to reverse, surprising without context, and the result of a real trade-off.

## Product invariants

- Viraha is a contingency relay, not a death detector, legal will, emergency service, password manager, or asset-transfer system.
- A missed Check-in may enter Concern; it never proves death.
- A Guardian submits only a bounded Guardian Attestation; the product never asks them to declare death.
- Email opens, link previews, and unauthenticated `GET` requests never count as Check-ins or authorize state changes.
- Bounded Guardian Attestations are the default Release Policy. Automatic Fallback is explicit and applies per Envelope.
- Every irreversible transition is idempotent, auditable, retry-safe, and exercised with a controllable clock.
- No Release path can compress Concern, final notice, and Veto Window into one historical-time advance. If all Owner final-notice channels fail before Release, including after initial provider acceptance, the Envelope enters Delivery Hold and later starts a new full Veto Window.
- A notification contains no private Envelope content. It leads an authenticated Recipient to the content.
- Standard Mode and Sealed Mode apply to every item in an Envelope and have visibly different recovery and server-processing guarantees.
- Imported files are untrusted. Editable conversion is bounded; unsupported originals remain Attachments.
- No AI or probabilistic system may decide Check-in, Concern, Guardian quorum, Veto Window, or Release state.

## Architecture and verification

- Keep domain state transitions in a framework-independent module. UI, schedulers, and providers consume domain decisions; they do not recreate them.
- Keep email, SMS, storage, authentication, scheduler, and hosting integrations behind replaceable adapters so the AGPL application remains self-hostable.
- Prefer deterministic tests for every time boundary and failure path before adding presentation polish.
- Use disposable demo data for browser checks and public artifacts. Never use personal plans, contacts, documents, or delivery details.
- If `graphify-out/graph.json` exists, query it before broad cross-file exploration and run `graphify update .` after code changes. Before any release, refresh the graph and verify one scoped query.

## Public surface and release

- The runnable release candidate is the source of truth for README, website, screenshots, downloads, platform support, and updater claims.
- Do not invent a logo, screenshot, version, metric, download URL, signing status, deployment, or release badge.
- Run the `refresh-docs` workflow only after a real release candidate can be exercised safely.
- Do not begin external release publication unless sections 1–11 of `docs/release/V1_RELEASE_GATES.md` pass and the user has activated the release authority; then execute section 12 in order and do not call v1 complete until closure passes.
- The implementation and v1 handoff begins in `docs/FABLE_BUILD_PROMPT.md`.
