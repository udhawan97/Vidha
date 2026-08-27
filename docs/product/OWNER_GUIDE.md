# Owner guide

**Status:** Guide to the current synthetic rehearsal and the intended Vidha workflow. It is not evidence of a hosted service, durable storage, encryption, notification delivery, Guardian authority, or Release.

Vidha is a contingency relay for one adult Owner. It keeps each handoff in a recipient-specific **Envelope** with one Recipient, one Protection Mode, and one Release Policy. It is not a legal will, password manager, emergency service, asset-transfer system, or death detector.

## Before using the prototype

- Use only the included synthetic content. Do not enter personal or sensitive information.
- Refresh, a confirmed app update, or a confirmed **Start fresh local rehearsal** action clears the browser session. After accepted session work, common reload paths show a browser warning and a waiting build requires **Update and clear session**; neither warning stores or recovers anything.
- Keep one rehearsal tab open. Same-origin tabs exchange only ephemeral presence, changed-work, and action-pending flags; no Plan, Editable Document, Attachment, Recipient, filename, or event data is copied or merged. If another tab reports work, finish or download there and close it before updating or starting fresh here.
- No file is uploaded, scanned by a malware engine, encrypted, persisted, or sent.
- Timeline rehearsal stops at **Concern**. Nothing in this build can authorize Release.

## Build an Envelope

1. Open **Envelopes** and choose a synthetic Envelope.
2. Confirm the **Recipient**. A Guardian is a different role and never gains content access by providing a Guardian Attestation.
3. Write the first action the Recipient should take. Add where they can verify it, what may change, and who else can help.
4. Import TXT or Markdown only when it should become an **Editable Document**. Compare the converted preview, conversion notes, and source-preservation consequences before choosing **Create editable copy**.
5. Use **Add files** for supporting originals that should remain **Attachments** rather than editable content.
6. Review every staged file before keeping it with the Envelope. Download or remove an Attachment from the Envelope settings.
7. Save a **Document Version** before a larger change. Restoring shows which title, Recipient, and Markdown fields will change and preserves the current draft first; it never changes Attachments or imported-source provenance. This bounded history clears on refresh and is not autosave or backup. Choose one portable-copy format, then download exact Markdown/text source or a standalone escaped semantic HTML reading copy.
8. Return to **Overview** and choose **Review rehearsal**. The run-sheet shows the complete Day 25 reminder, Day 30 due date, and Day 37 Concern boundary, every prepared synthetic handoff, readiness blockers, and the exact content-free test-notice preview. **Run local rehearsal** records only a synthetic `PLAN_REHEARSED` event and sends zero messages. Changing an included Editable Document or Attachment requires another review before the UI offers **Arm rehearsal**.
9. Treat **Disable rehearsal** as terminal for that synthetic Plan. **Start fresh local rehearsal** explicitly clears session edits, Attachments, Document Versions, and local events before loading a separate Draft; it never resumes the Disabled Plan.
10. Open **Guide** in the app for the consequences of Standard Mode, Sealed Mode, Guardian Attestation first, and Automatic Fallback without presenting unimplemented targets as available.
11. If a new build is waiting after you change the rehearsal, choose **Review update**. Download any portable copies or originals you need, then either **Keep working** or explicitly **Update and clear session**. Finish any in-flight Owner action first. A failed update leaves the rehearsal open and protected from ordinary reload.
12. If the multi-tab notice appears, choose one tab. Tabs contain separate rehearsals; changed work or an Owner action in another tab holds app update and fresh-session clearing here until that peer closes. Presence detection is not persistence, content synchronization, recovery, or a production lock.

## Current file contract

| Use in the synthetic rehearsal | Formats                                  | Limit                   | What happens                                                                                                                    |
| ------------------------------ | ---------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Editable text import           | TXT, MD, MARKDOWN                        | 256 KB and 10,000 lines | Exact UTF-8 bytes enter bounded fixture inspection; a reviewed schema v1 copy replaces the draft only after explicit acceptance |
| Document Attachment candidate  | PDF, DOCX, XLSX, PPTX                    | 5 MB per file           | Original bytes stay unchanged in memory; no in-app editing or safe preview is promised                                          |
| Image Attachment candidate     | JPG, JPEG, PNG, GIF, WEBP                | 5 MB per file           | Original bytes stay unchanged in memory; image content is not interpreted                                                       |
| Media Attachment candidate     | MP3, M4A, WAV, MP4, MOV                  | 5 MB per file           | Original bytes stay unchanged in memory; playback and delivery are not provided                                                 |
| Data or contact candidate      | CSV, JSON, VCF                           | 5 MB per file           | Original bytes stay unchanged in memory; data is not parsed or treated as authority                                             |
| Archive Attachment candidate   | ZIP                                      | 5 MB per file           | Original bytes stay unchanged in memory; archive contents are never opened                                                      |
| Envelope session total         | Up to 8 Attachment candidates, all types | 20 MB                   | Count and size limits are prototype fixtures, not the unresolved version 1 Attachment contract                                  |

HTML, SVG, scripts, executables, macro-enabled Office files, and other unlisted types are excluded from the browser-editable fixture. DOCX may remain a session Attachment, but neither DOCX nor HTML becomes editable without an isolated converter. This is an allowlist, not a claim that accepted files are safe. The production target still requires exact-byte classification, quarantine, malware scanning, isolated format-specific conversion, archive defenses, and durable source preservation.

## What each choice entails

### Editable Document versus Attachment

An Editable Document is the versioned canonical copy Vidha can help the Owner revise and export. Version 1 keeps Markdown-compatible source and produces exact Markdown plus derived semantic HTML. Conversion may change formatting, so the original source, digest, converter identity, and conversion notes remain distinct. An Attachment preserves the original file without pretending Vidha can safely edit or render every format.

A Document Version is one point-in-time copy of only the Editable Document title, Recipient label, and Markdown. The prototype keeps at most six per Envelope in the current browser session, suppresses an unchanged latest copy, and preserves the current draft before a confirmed restore. It does not version Attachments, imported-source provenance, or other Envelope settings, and it provides no durable history or recovery guarantee.

A Draft Rehearsal Review is one session-only run-sheet for the exact synthetic Draft state reviewed in the browser. It derives relative timeline offsets, validates canonical Editable Documents and contact assignments, and previews one content-free notice for the synthetic Guardian and Recipients. Its digest is a drift detector inside this disposable UI, not a signature, audit record, provider receipt, strong-authentication proof, or server-authoritative Arm condition.

### Standard Mode versus Sealed Mode

Standard Mode is intended to support recovery and service-assisted features through managed per-item encryption. It is only a UI direction in this prototype; no content encryption exists. Sealed Mode is intended to keep content unreadable to the hosted operator, which removes recovery and server-processing capabilities that would contradict that promise. It remains unavailable pending a protocol, recovery contract, independent review, and test vectors.

### Guardian Attestation first versus Automatic Fallback

Bounded Guardian Attestations are the default intended Release Policy. A Guardian responds to an exact prompt during Concern, never declares death, and never sees Envelope content through that role. Automatic Fallback is a future per-Envelope opt-in with a longer enforced delay, explicit false-Release warning, and a full final Veto Window. Neither Release Policy is executable in the current build.

## Keep the handoff useful

- Use separate Envelopes when the Recipient, purpose, Protection Mode, or Release Policy differs.
- Point to authoritative originals instead of treating a practical note as legal or medical authority.
- Do not store passwords, passkeys, cryptocurrency seed phrases, or the only copy of an important document.
- Review an Envelope whenever its Recipient, instructions, supporting files, or external references change.
- Rehearse with marked synthetic notices before arming when that journey is implemented.

See the [canonical vocabulary](../../CONTEXT.md), [target user journeys](USER_JOURNEYS.md), and [version 1 release gates](../release/V1_RELEASE_GATES.md) for the controlling product contract.
