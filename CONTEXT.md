# Vidha

Vidha is a contingency relay in which an individual prepares private, recipient-specific material that may be released if they become persistently unreachable. Inactivity begins verification; it is never treated as proof of death.

## People

**Owner**:
The individual adult who creates and controls their Contingency Plan and completes authenticated Check-ins. A Contingency Plan has one Owner.
_Avoid_: User, deceased person, subject

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

**Envelope**:
Private, recipient-specific material prepared by the Owner for possible Release.
_Avoid_: Will, payload

**Editable Document**:
Owner-authored content held in Vidha's canonical rich-text and Markdown-compatible form so it can be imported, edited, and exported without depending on one proprietary editor.
_Avoid_: Arbitrary file, Attachment

**Attachment**:
An original file preserved with an Envelope for preview or download without a promise that its native format can be edited in Vidha.
_Avoid_: Editable Document

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
