# Target user journeys

**Status:** Intended version 1 behavior. These journeys are acceptance targets, not evidence of a current implementation.

## 1. Create and arm a plan

1. An Owner creates an account and registers a phishing-resistant authentication method.
2. Vidha explains that inactivity is not proof of death and that the service is not a legal will or emergency responder.
3. The Owner selects a Check-in cadence and sees the complete Concern timeline before saving it.
4. The Owner invites Guardians and Recipients. A plan cannot be armed while required contacts remain unverified.
5. The Owner writes or imports an Editable Document, adds optional Attachments, chooses a Recipient, and selects one Protection Mode and one Release Policy for the Envelope.
6. Vidha runs a rehearsal that sends clearly marked test notices without exposing the real Envelope.
7. The Owner reviews the final timeline and arms the Contingency Plan with a fresh authentication ceremony.

## 2. Complete a routine Check-in

1. The Owner receives a low-noise reminder through a verified channel.
2. The reminder opens Vidha but does not mutate state.
3. The Owner confirms presence with a passkey or approved fallback.
4. Vidha records the Check-in, shows the next due date in the Owner's locale, and writes an audit event.
5. Repeated link previews, browser refreshes, retries, or duplicate requests do not create additional state transitions.

## 3. Recover from an ordinary missed Check-in

1. The Check-in becomes overdue and scheduled reminders are attempted idempotently.
2. The grace period expires and the plan enters Concern.
3. Guardians receive the accepted bounded attestation prompt; no Envelope title or content is disclosed and the prompt never asks them to declare death.
4. The Owner authenticates, cancels Concern, reviews failed channels, and begins a new interval.
5. Guardians receive a closure notice that does not reveal why the Owner was unavailable.

## 4. Guardian-attested Release

1. Concern remains unresolved through the configured period.
2. Each required Guardian independently authenticates and records one allowed Guardian Attestation; abstention, conflict, hold, expiry, and any evidence follow the accepted policy.
3. When the quorum is met, Vidha enters the Veto Window rather than releasing immediately.
4. Vidha attempts final notices across every verified Owner channel. The full Veto Window starts only after at least one provider accepts the notice; acceptance is not proof that the Owner read it.
5. If every channel fails before Release—including when a later bounce, rejection, expiry, or valid replay removes the last non-failed channel—the Envelope enters Delivery Hold. Clearing the hold requires the accepted authority and starts a new full Veto Window.
6. Only after a usable Veto Window completes does the release job create one durable Release event and one delivery task per Recipient.
7. Each Recipient receives a minimal notice, authenticates, retrieves only their Envelope, and can export a portable copy.
8. Delivery attempts and retrieval are recorded without treating provider acceptance as proof that a human read the content.

## 5. Automatic Fallback

1. The Owner explicitly selects Automatic Fallback for one Envelope and accepts its false-release risk.
2. Vidha enforces a longer system minimum and previews exact dates under the current policy.
3. Concern and a fresh Veto Window still occur; outage catch-up may establish eligibility but cannot compress those stages into one processing pass.
4. The Veto Window begins only after at least one verified Owner channel accepts the final notice. If every channel fails before Release, including through later negative delivery evidence, the Envelope enters Delivery Hold and later starts a new full window rather than Release.
5. Release proceeds only when the extended policy is satisfied and no valid veto or hold exists.
6. The audit history distinguishes an Automatic Fallback from a Guardian-verified Release.

## 6. Use a Sealed Envelope

1. The Owner selects Sealed Mode for an Envelope and sees which recovery, search, preview, and support features become unavailable for every contained item.
2. Vidha verifies that the required key material exists before the Envelope can be armed.
3. The server stores ciphertext and the minimum scheduling metadata needed for the chosen Release Policy.
4. At Release, the authenticated Recipient uses the designed key path to decrypt the Envelope's Editable Documents and Attachments.
5. A lost key produces an honest unrecoverable state; support cannot bypass the promise.

## 7. Import a file

1. Vidha treats the file as untrusted and validates type, size, and scan status.
2. A supported text format can be converted into a new Editable Document after the Owner previews the result.
3. The original remains available when preserving it is safe and useful.
4. Unsupported or fidelity-sensitive files remain Attachments instead of being silently rewritten.
5. Export makes the canonical Document and original Attachments understandable outside Vidha.

## 8. Restore or leave

1. The Owner exports encrypted content, contacts, policies, and audit history in documented formats.
2. A restore rehearsal uses a disposable environment and cannot send real notices.
3. Account deletion previews retention and already-Released material that cannot be recalled.
4. Self-hosting instructions distinguish application portability from provider-specific credentials and delivery history.
