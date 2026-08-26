import {
  createEditableDocument,
  serializeEditableDocument,
} from '@vidha/documents';
import type { PlanState } from '@vidha/domain';

export const DRAFT_REHEARSAL_SCHEMA = 'vidha.draft-rehearsal';
export const DRAFT_REHEARSAL_SCHEMA_VERSION = 1 as const;

const CONTENT_FREE_NOTICE =
  'Vidha rehearsal only. A contingency plan test was run. No action is required. No private Envelope content is included.';
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_REHEARSAL_CONTACTS = 64;
const MAX_REHEARSAL_ENVELOPES = 32;
const MAX_REHEARSAL_ATTACHMENTS = 128;
const MAX_REHEARSAL_ATTACHMENTS_PER_ENVELOPE = 8;
const OPAQUE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const PLAN_ID = /^[a-z][a-z0-9_-]{7,63}$/u;
const SOURCE_ID = /^sha256:[a-f0-9]{64}$/u;

export interface DraftRehearsalContactInput {
  readonly contactId: string;
  readonly label: string;
  readonly role: 'Guardian' | 'Recipient';
  readonly status: 'synthetic_verified';
}

export interface DraftRehearsalEnvelopeInput {
  readonly attachmentSourceIds: readonly string[];
  readonly document: {
    readonly markdown: string;
    readonly recipientLabel: string;
    readonly title: string;
  };
  readonly envelopeId: string;
  readonly protectionMode: 'Standard';
  readonly releasePolicy: 'Guardian attestation first';
}

export interface DraftRehearsalInput {
  readonly contacts: readonly DraftRehearsalContactInput[];
  readonly envelopes: readonly DraftRehearsalEnvelopeInput[];
  readonly plan: PlanState;
}

export interface DraftRehearsalCheck {
  readonly detail: string;
  readonly id: 'contacts' | 'documents' | 'lifecycle' | 'policies';
  readonly status: 'blocked' | 'ready';
  readonly title: string;
}

export interface DraftRehearsalTimelineStep {
  readonly afterMs: number;
  readonly id: 'concern' | 'due' | 'reminder';
  readonly label: string;
  readonly stop: boolean;
}

export interface DraftRehearsalNoticeIntent {
  readonly audienceLabel: string;
  readonly contactId: string;
  readonly message: typeof CONTENT_FREE_NOTICE;
  readonly role: 'Guardian' | 'Recipient';
  readonly sent: false;
}

export interface DraftRehearsalReview {
  readonly canComplete: boolean;
  readonly checks: readonly DraftRehearsalCheck[];
  readonly envelopes: readonly {
    readonly attachmentCount: number;
    readonly envelopeId: string;
    readonly protectionMode: 'Standard';
    readonly recipientLabel: string;
    readonly releasePolicy: 'Guardian attestation first';
    readonly title: string;
  }[];
  readonly noticeIntents: readonly DraftRehearsalNoticeIntent[];
  readonly planId: string;
  readonly policyRevision: number;
  readonly reviewIdentity: string;
  readonly reviewedAt: number;
  readonly schema: typeof DRAFT_REHEARSAL_SCHEMA;
  readonly schemaVersion: typeof DRAFT_REHEARSAL_SCHEMA_VERSION;
  readonly timeline: readonly DraftRehearsalTimelineStep[];
}

export interface DraftRehearsalAcceptance {
  readonly planId: string;
  readonly policyRevision: number;
  readonly reviewIdentity: string;
  readonly syntheticNoticeCount: number;
}

export class DraftRehearsalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftRehearsalError';
  }
}

interface EnvelopeSnapshot {
  readonly attachmentSourceIds: readonly string[];
  readonly document: {
    readonly markdown: string;
    readonly recipientLabel: string;
    readonly title: string;
  };
  readonly documentIdentity: string | null;
  readonly documentIssue: string | null;
  readonly envelopeId: string;
  readonly protectionMode: 'Standard';
  readonly releasePolicy: 'Guardian attestation first';
}

export async function createDraftRehearsalReview(
  input: DraftRehearsalInput,
  reviewedAt: number,
): Promise<DraftRehearsalReview> {
  validateTimestamp(reviewedAt);
  const plan = snapshotPlan(input.plan);
  const contacts = snapshotContacts(input.contacts);
  const envelopes = snapshotEnvelopes(input.envelopes);
  const checks = createChecks(plan, contacts, envelopes);
  const identityInput = {
    schema: DRAFT_REHEARSAL_SCHEMA,
    schemaVersion: DRAFT_REHEARSAL_SCHEMA_VERSION,
    plan,
    contacts,
    envelopes: envelopes.map((envelope) => ({
      attachmentSourceIds: envelope.attachmentSourceIds,
      document: envelope.document,
      documentIdentity: envelope.documentIdentity,
      envelopeId: envelope.envelopeId,
      protectionMode: envelope.protectionMode,
      releasePolicy: envelope.releasePolicy,
    })),
  };

  return {
    canComplete: checks.every((check) => check.status === 'ready'),
    checks,
    envelopes: envelopes.map((envelope) => ({
      attachmentCount: envelope.attachmentSourceIds.length,
      envelopeId: envelope.envelopeId,
      protectionMode: envelope.protectionMode,
      recipientLabel: envelope.document.recipientLabel,
      releasePolicy: envelope.releasePolicy,
      title: envelope.document.title.trim() || 'Untitled Editable Document',
    })),
    noticeIntents: contacts.map((contact) => ({
      audienceLabel: contact.label,
      contactId: contact.contactId,
      message: CONTENT_FREE_NOTICE,
      role: contact.role,
      sent: false,
    })),
    planId: plan.planId,
    policyRevision: plan.policyRevision,
    reviewIdentity: `sha256:${await sha256(JSON.stringify(identityInput))}`,
    reviewedAt,
    schema: DRAFT_REHEARSAL_SCHEMA,
    schemaVersion: DRAFT_REHEARSAL_SCHEMA_VERSION,
    timeline: [
      {
        afterMs: plan.policy.checkInIntervalMs - plan.policy.reminderLeadMs,
        id: 'reminder',
        label: 'Reminder begins',
        stop: false,
      },
      {
        afterMs: plan.policy.checkInIntervalMs,
        id: 'due',
        label: 'Check-in due',
        stop: false,
      },
      {
        afterMs: plan.policy.checkInIntervalMs + plan.policy.gracePeriodMs,
        id: 'concern',
        label: 'Concern may begin',
        stop: true,
      },
    ],
  };
}

export async function acceptDraftRehearsalReview(
  reviewed: DraftRehearsalReview,
  current: DraftRehearsalInput,
): Promise<DraftRehearsalAcceptance> {
  const rebuilt = await createDraftRehearsalReview(
    current,
    reviewed.reviewedAt,
  );
  if (JSON.stringify(rebuilt) !== JSON.stringify(reviewed)) {
    throw new DraftRehearsalError(
      'The Plan, contacts, or Envelopes changed after rehearsal review.',
    );
  }
  if (!rebuilt.canComplete) {
    throw new DraftRehearsalError(
      'Every rehearsal readiness check must pass before completion.',
    );
  }
  return {
    planId: rebuilt.planId,
    policyRevision: rebuilt.policyRevision,
    reviewIdentity: rebuilt.reviewIdentity,
    syntheticNoticeCount: rebuilt.noticeIntents.length,
  };
}

function snapshotPlan(plan: PlanState) {
  if (typeof plan !== 'object' || plan === null) {
    throw new DraftRehearsalError(
      'The rehearsal requires a valid Contingency Plan identity and revision.',
    );
  }
  const planId = plan.planId;
  const policyRevision = plan.policyRevision;
  const lifecycle = plan.lifecycle;
  const policy = plan.policy;
  if (
    typeof policy !== 'object' ||
    policy === null ||
    !PLAN_ID.test(planId) ||
    !Number.isSafeInteger(policyRevision) ||
    policyRevision < 1 ||
    (lifecycle !== 'draft' &&
      lifecycle !== 'armed' &&
      lifecycle !== 'paused' &&
      lifecycle !== 'disabled')
  ) {
    throw new DraftRehearsalError(
      'The rehearsal requires a valid Contingency Plan identity and revision.',
    );
  }
  const checkInIntervalMs = policy.checkInIntervalMs;
  const reminderLeadMs = policy.reminderLeadMs;
  const gracePeriodMs = policy.gracePeriodMs;
  if (
    !Number.isSafeInteger(checkInIntervalMs) ||
    !Number.isSafeInteger(reminderLeadMs) ||
    !Number.isSafeInteger(gracePeriodMs) ||
    checkInIntervalMs <= 0 ||
    reminderLeadMs <= 0 ||
    reminderLeadMs >= checkInIntervalMs ||
    gracePeriodMs <= 0 ||
    checkInIntervalMs + gracePeriodMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new DraftRehearsalError(
      'The rehearsal requires a valid Check-in and Concern timeline.',
    );
  }
  return {
    lifecycle,
    planId,
    policy: { checkInIntervalMs, gracePeriodMs, reminderLeadMs },
    policyRevision,
  };
}

function snapshotContacts(
  contacts: readonly DraftRehearsalContactInput[],
): readonly DraftRehearsalContactInput[] {
  if (!Array.isArray(contacts)) {
    throw new DraftRehearsalError('Rehearsal contacts must be a list.');
  }
  if (contacts.length > MAX_REHEARSAL_CONTACTS) {
    throw new DraftRehearsalError(
      `A rehearsal review accepts at most ${String(MAX_REHEARSAL_CONTACTS)} contacts.`,
    );
  }
  const seen = new Set<string>();
  const seenRoles = new Set<string>();
  const snapshots: DraftRehearsalContactInput[] = [];
  for (let index = 0; index < contacts.length; index += 1) {
    if (!(index in contacts)) {
      throw new DraftRehearsalError(
        'Rehearsal contacts must be a dense list without missing entries.',
      );
    }
    const contact = contacts[index];
    if (typeof contact !== 'object' || contact === null) {
      throw new DraftRehearsalError(
        'Rehearsal contacts must have unique bounded identities and synthetic verification.',
      );
    }
    const snapshot = {
      contactId: contact.contactId,
      label: typeof contact.label === 'string' ? contact.label.trim() : '',
      role: contact.role,
      status: contact.status,
    };
    const roleIdentity = `${snapshot.role}\0${snapshot.label}`;
    if (
      !OPAQUE_ID.test(snapshot.contactId) ||
      snapshot.label.length === 0 ||
      snapshot.label.length > 200 ||
      (snapshot.role !== 'Guardian' && snapshot.role !== 'Recipient') ||
      snapshot.status !== 'synthetic_verified' ||
      seen.has(snapshot.contactId) ||
      seenRoles.has(roleIdentity)
    ) {
      throw new DraftRehearsalError(
        'Rehearsal contacts must have unique bounded identities and synthetic verification.',
      );
    }
    seen.add(snapshot.contactId);
    seenRoles.add(roleIdentity);
    snapshots.push(snapshot);
  }
  return snapshots;
}

function snapshotEnvelopes(
  envelopes: readonly DraftRehearsalEnvelopeInput[],
): readonly EnvelopeSnapshot[] {
  if (!Array.isArray(envelopes)) {
    throw new DraftRehearsalError('Rehearsal Envelopes must be a list.');
  }
  if (envelopes.length > MAX_REHEARSAL_ENVELOPES) {
    throw new DraftRehearsalError(
      `A rehearsal review accepts at most ${String(MAX_REHEARSAL_ENVELOPES)} Envelopes.`,
    );
  }
  const seen = new Set<string>();
  const snapshots: EnvelopeSnapshot[] = [];
  let attachmentCount = 0;
  for (let index = 0; index < envelopes.length; index += 1) {
    if (!(index in envelopes)) {
      throw new DraftRehearsalError(
        'Rehearsal Envelopes must be a dense list without missing entries.',
      );
    }
    const envelope = envelopes[index];
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      typeof envelope.document !== 'object' ||
      envelope.document === null ||
      typeof envelope.document.markdown !== 'string' ||
      typeof envelope.document.recipientLabel !== 'string' ||
      typeof envelope.document.title !== 'string'
    ) {
      throw new DraftRehearsalError(
        'Rehearsal Envelopes require a bounded Editable Document input.',
      );
    }
    const envelopeId = envelope.envelopeId;
    const protectionMode = envelope.protectionMode;
    const releasePolicy = envelope.releasePolicy;
    const document = {
      markdown: envelope.document.markdown,
      recipientLabel: envelope.document.recipientLabel,
      title: envelope.document.title,
    };
    if (!Array.isArray(envelope.attachmentSourceIds)) {
      throw new DraftRehearsalError(
        'Rehearsal Attachment identities must be a list.',
      );
    }
    if (
      envelope.attachmentSourceIds.length >
      MAX_REHEARSAL_ATTACHMENTS_PER_ENVELOPE
    ) {
      throw new DraftRehearsalError(
        `A rehearsal Envelope accepts at most ${String(MAX_REHEARSAL_ATTACHMENTS_PER_ENVELOPE)} Attachment identities.`,
      );
    }
    const attachmentSourceIds = Array.from(
      envelope.attachmentSourceIds,
      (sourceId): string => {
        if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) {
          throw new DraftRehearsalError(
            'Rehearsal Envelopes require unique bounded identities and canonical Attachment source identities.',
          );
        }
        return sourceId;
      },
    );
    attachmentCount += attachmentSourceIds.length;
    if (attachmentCount > MAX_REHEARSAL_ATTACHMENTS) {
      throw new DraftRehearsalError(
        `A rehearsal review accepts at most ${String(MAX_REHEARSAL_ATTACHMENTS)} Attachment identities in total.`,
      );
    }
    if (
      !OPAQUE_ID.test(envelopeId) ||
      seen.has(envelopeId) ||
      new Set(attachmentSourceIds).size !== attachmentSourceIds.length
    ) {
      throw new DraftRehearsalError(
        'Rehearsal Envelopes require unique bounded identities and canonical Attachment source identities.',
      );
    }
    seen.add(envelopeId);
    let documentIdentity: string | null = null;
    let documentIssue: string | null = null;
    try {
      documentIdentity = serializeEditableDocument(
        createEditableDocument(document),
      );
    } catch (error) {
      documentIssue =
        error instanceof Error
          ? error.message
          : 'The Editable Document is invalid.';
    }
    snapshots.push({
      attachmentSourceIds,
      document,
      documentIdentity,
      documentIssue,
      envelopeId,
      protectionMode,
      releasePolicy,
    });
  }
  return snapshots;
}

function createChecks(
  plan: ReturnType<typeof snapshotPlan>,
  contacts: readonly DraftRehearsalContactInput[],
  envelopes: readonly EnvelopeSnapshot[],
): readonly DraftRehearsalCheck[] {
  const lifecycleReady = plan.lifecycle === 'draft';
  const documentIssues = envelopes.flatMap((envelope) =>
    envelope.documentIssue === null
      ? []
      : [
          `${envelope.document.title.trim() || 'Untitled'}: ${envelope.documentIssue}`,
        ],
  );
  const recipientLabels = new Set(
    contacts
      .filter((contact) => contact.role === 'Recipient')
      .map((contact) => contact.label),
  );
  const missingRecipients = envelopes
    .filter(
      (envelope) =>
        !recipientLabels.has(envelope.document.recipientLabel.trim()),
    )
    .map((envelope) => envelope.document.recipientLabel.trim() || 'Unassigned');
  const guardianCount = contacts.filter(
    (contact) => contact.role === 'Guardian',
  ).length;
  const contactsReady = guardianCount > 0 && missingRecipients.length === 0;
  const policyIssues = envelopes.filter(
    (envelope) =>
      envelope.protectionMode !== 'Standard' ||
      envelope.releasePolicy !== 'Guardian attestation first',
  );

  return [
    {
      detail: lifecycleReady
        ? 'The Check-in timeline remains inactive until a later Arm action.'
        : 'Only a Draft can complete this rehearsal review.',
      id: 'lifecycle',
      status: lifecycleReady ? 'ready' : 'blocked',
      title: lifecycleReady ? 'Draft remains inactive' : 'Plan is not a Draft',
    },
    {
      detail:
        envelopes.length === 0
          ? 'Add at least one synthetic Envelope before rehearsal.'
          : documentIssues.length === 0
            ? `${envelopes.length} canonical Editable Document${envelopes.length === 1 ? '' : 's'} included.`
            : documentIssues.join(' '),
      id: 'documents',
      status:
        envelopes.length > 0 && documentIssues.length === 0
          ? 'ready'
          : 'blocked',
      title:
        envelopes.length > 0 && documentIssues.length === 0
          ? 'Editable Documents validate'
          : 'Editable Documents need attention',
    },
    {
      detail: contactsReady
        ? `${contacts.length} synthetic verified contact${contacts.length === 1 ? '' : 's'} matched; ${guardianCount} Guardian included.`
        : guardianCount === 0
          ? 'Add at least one synthetic Guardian before rehearsal.'
          : `Recipient assignment is unmatched: ${missingRecipients.join(', ')}.`,
      id: 'contacts',
      status: contactsReady ? 'ready' : 'blocked',
      title: contactsReady ? 'People are matched' : 'People need attention',
    },
    {
      detail:
        policyIssues.length === 0
          ? 'Standard Mode and Guardian attestation first are labels only; neither is executable here.'
          : 'This rehearsal only accepts the current Standard and Guardian-attestation synthetic boundary.',
      id: 'policies',
      status: policyIssues.length === 0 ? 'ready' : 'blocked',
      title:
        policyIssues.length === 0
          ? 'Policy boundary is explicit'
          : 'Policy boundary is unsupported',
    },
  ];
}

function validateTimestamp(timestamp: number): void {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_TIMESTAMP
  ) {
    throw new DraftRehearsalError(
      'The rehearsal review time must be a valid Unix timestamp.',
    );
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
