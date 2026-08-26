# Vidha

Vidha is a contingency relay in which an individual prepares private, recipient-specific material that may be released if they become persistently unreachable. Inactivity begins verification; it is never treated as proof of death.

## People

**Owner**:
The individual adult who creates and controls their Contingency Plan and completes authenticated Check-ins. A Contingency Plan has one Owner.
_Avoid_: User, deceased person, subject

**Owner Credential**:
An authenticator bound to one Owner identity. The accepted target is a passkey verified by Vidha as its own WebAuthn relying party; an Owner may have multiple Owner Credentials, and revocation is server-authoritative.
_Avoid_: Password, email login, identity proof

**Verified Owner Channel**:
An opaque reference to a previously verified destination for content-free Owner security notices. Control of a channel alone never authenticates a Check-in, authorizes a lifecycle mutation, or completes recovery.
_Avoid_: Login, recovery authority, proof of life

**Guardian**:
A trusted person authorized to submit a bounded Guardian Attestation during Concern. A Guardian never declares the Owner dead and does not gain Envelope access.
_Avoid_: Emergency contact, executor

**Guardian Attestation**:
An authenticated, time-bounded response to an exact verification prompt during Concern. Its allowed assertions, evidence handling, conflicts, abstention, expiry, and hold behavior must be explicit; it is never factual or legal confirmation of death.
_Avoid_: Death certificate, vote that someone died, informal message

**Recipient**:
A person designated to receive one or more Envelopes after Release.
_Avoid_: Beneficiary

## Prepared material

**Contingency Plan**:
An Owner's chosen Check-in schedule, Guardians, Recipients, and Envelopes, with a Release Policy selected for each Envelope.
_Avoid_: Will, death switch

**Draft**:
A Contingency Plan lifecycle state in which setup and rehearsal may occur but no Check-in timeline or Concern transition is active. A Draft must be rehearsed before it can become Armed.
_Avoid_: Active plan, live schedule

**Draft Rehearsal Review**:
A bounded review of the current Draft, synthetic contact assignments, prepared Envelopes, complete Check-in-to-Concern timing, and content-free test-notice copy before the rehearsal is recorded. The current prototype binds this review only inside browser memory, sends no notice, and requires another review after any included Plan, contact, Editable Document, or Attachment identity changes.
_Avoid_: Readiness certification, provider test, delivery proof, Arm authorization

**Armed**:
The Contingency Plan lifecycle state in which its Check-in timeline is active. Arming requires an authenticated, recent Owner action against the current policy revision after rehearsal.
_Avoid_: Released, guaranteed

**Paused**:
An Owner-authorized Contingency Plan lifecycle state in which timeline advancement is suspended. Resuming requires recent authentication and starts a new full Check-in interval rather than consuming time that elapsed while Paused.
_Avoid_: Concern, temporary Release

**Disabled**:
The terminal Contingency Plan lifecycle state. A Disabled plan cannot resume, Check in, enter Concern, or Release; the current synthetic prototype requires refresh to create a new disposable rehearsal.
_Avoid_: Paused, deleted

**Envelope**:
Private, recipient-specific material prepared by the Owner for possible Release.
_Avoid_: Will, payload

**Editable Document**:
Owner-authored content held in the versioned `vidha.editable-document` schema. Version 1 uses a title, Recipient label, and canonical Markdown-compatible source so portable Markdown and derived semantic HTML do not depend on one proprietary editor. Imported originals and conversion provenance remain separate from this editable copy.
_Avoid_: Arbitrary file, Attachment

**Document Version**:
A canonical point-in-time snapshot of one Editable Document's title, Recipient label, and Markdown. The current synthetic rehearsal keeps a bounded, in-memory session history and preserves the current draft before a restore; it never includes Attachments, imported-source provenance, durable storage, or an entire Envelope.
_Avoid_: Checkpoint, backup, Envelope snapshot

**Attachment**:
An original file preserved with an Envelope for preview or download without a promise that its native format can be edited in Vidha.
_Avoid_: Editable Document

**Signature Set Identity**:
The immutable SHA-256 manifest identity of the exact malware-scanner database files used for one inspection. It is recorded alongside, but is not interchangeable with, the scanner's human-readable database version.
_Avoid_: Safe-file proof, latest signatures, scanner version

**Protection Mode**:
The security and recovery contract applied to every Editable Document and Attachment in one Envelope. An Envelope uses either Standard Mode or Sealed Mode; format and editability do not weaken that choice.
_Avoid_: File type, sensitivity guess

**Standard Mode**:
An Envelope Protection Mode using service-managed encryption, allowing recovery and server-assisted product features for its contents.
_Avoid_: Unencrypted, ordinary file

**Sealed Mode**:
An optional Envelope Protection Mode designed so the hosted operator cannot read or recover its contents. Stronger confidentiality comes with reduced recovery and server-assisted features.
_Avoid_: Secret file, guaranteed-recoverable

## Continuity and release

**Check-in**:
An authenticated action by the Owner that confirms continued control of the Contingency Plan and begins a new schedule interval.
_Avoid_: Email open, link click, heartbeat

**Concern**:
The state entered after the Owner remains overdue beyond the configured grace period. It permits verification activity but does not authorize Release.
_Avoid_: Death detected, deceased

**Veto Window**:
The full final interval in which the Owner can cancel a pending Release. It starts only after at least one verified Owner channel accepts the final notice and remains usable only while at least one such channel has not produced negative delivery evidence; clearing a Delivery Hold starts a new full window.
_Avoid_: Last warning

**Delivery Hold**:
A safe state that prevents every Release path when no verified Owner channel has accepted the final notice or negative delivery evidence leaves every attempted channel failed. Time passing during an outage does not remove the hold.
_Avoid_: Release retry, compressed warning

**Release Policy**:
The Owner's chosen conditions for authorizing Release of a specific Envelope, using bounded Guardian Attestations by default or an explicitly enabled Automatic Fallback.
_Avoid_: Death test, trigger

**Automatic Fallback**:
An Owner-enabled Release Policy that may proceed after extended inactivity without Guardian confirmation.
_Avoid_: Death detection, default release

**Release**:
The irreversible authorization that makes an Envelope available to its designated Recipient.
_Avoid_: Declaring death, email send
