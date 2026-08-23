# Owner guide

**Status:** Guide to the current synthetic rehearsal and the intended Vidha workflow. It is not evidence of a hosted service, durable storage, encryption, notification delivery, Guardian authority, or Release.

Vidha is a contingency relay for one adult Owner. It keeps each handoff in a recipient-specific **Envelope** with one Recipient, one Protection Mode, and one Release Policy. It is not a legal will, password manager, emergency service, asset-transfer system, or death detector.

## Before using the prototype

- Use only the included synthetic content. Do not enter personal or sensitive information.
- Refresh clears the browser session.
- No file is uploaded, scanned by a malware engine, encrypted, persisted, or sent.
- Timeline rehearsal stops at **Concern**. Nothing in this build can authorize Release.

## Build an Envelope

1. Open **Envelopes** and choose a synthetic Envelope.
2. Confirm the **Recipient**. A Guardian is a different role and never gains content access by providing a Guardian Attestation.
3. Write the first action the Recipient should take. Add where they can verify it, what may change, and who else can help.
4. Import TXT or Markdown only when it should become an **Editable Document**. Review the quarantined source, then explicitly approve the decoded text.
5. Use **Add files** for supporting originals that should remain **Attachments** rather than editable content.
6. Review every staged file before keeping it with the Envelope. Download or remove an Attachment from the Envelope settings.
7. Save a session checkpoint before a larger change. Export Markdown, plain text, or standalone escaped HTML when you need a portable copy.
8. Open **Guide** in the app before rehearsing. It explains the consequences of Standard Mode, Sealed Mode, Guardian Attestation first, and Automatic Fallback without presenting unimplemented targets as available.

## Current file contract

| Use in the synthetic rehearsal | Formats                                  | Limit                   | What happens                                                                                   |
| ------------------------------ | ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| Editable text import           | TXT, MD, MARKDOWN                        | 256 KB and 10,000 lines | Exact UTF-8 bytes enter bounded fixture inspection; approved text replaces the current draft   |
| Document Attachment candidate  | PDF, DOCX, XLSX, PPTX                    | 5 MB per file           | Original bytes stay unchanged in memory; no in-app editing or safe preview is promised         |
| Image Attachment candidate     | JPG, JPEG, PNG, GIF, WEBP                | 5 MB per file           | Original bytes stay unchanged in memory; image content is not interpreted                      |
| Media Attachment candidate     | MP3, M4A, WAV, MP4, MOV                  | 5 MB per file           | Original bytes stay unchanged in memory; playback and delivery are not provided                |
| Data or contact candidate      | CSV, JSON, VCF                           | 5 MB per file           | Original bytes stay unchanged in memory; data is not parsed or treated as authority            |
| Archive Attachment candidate   | ZIP                                      | 5 MB per file           | Original bytes stay unchanged in memory; archive contents are never opened                     |
| Envelope session total         | Up to 8 Attachment candidates, all types | 20 MB                   | Count and size limits are prototype fixtures, not the unresolved version 1 Attachment contract |

HTML, SVG, scripts, executables, macro-enabled Office files, and other unlisted types are excluded from the browser fixture. This is an allowlist, not a claim that accepted files are safe. The production target still requires exact-byte classification, quarantine, malware scanning, isolated conversion, archive defenses, and durable source preservation.

## What each choice entails

### Editable Document versus Attachment

An Editable Document is the canonical copy Vidha can help the Owner revise and export. Conversion may change formatting, so an original source remains distinct. An Attachment preserves the original file without pretending Vidha can safely edit or render every format.

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
