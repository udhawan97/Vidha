import { createDraftPlan } from '@vidha/domain';
import { describe, expect, it } from 'vitest';

import {
  DraftRehearsalError,
  acceptDraftRehearsalReview,
  createDraftRehearsalReview,
  type DraftRehearsalInput,
} from './draftRehearsal';

const DAY = 24 * 60 * 60 * 1_000;

function input(): DraftRehearsalInput {
  return {
    plan: createDraftPlan({
      at: 1_000,
      ownerId: 'owner-0001',
      planId: 'plan-0001',
      policy: {
        checkInIntervalMs: 30 * DAY,
        gracePeriodMs: 7 * DAY,
        reminderLeadMs: 5 * DAY,
      },
    }),
    contacts: [
      {
        contactId: 'guardian-1',
        label: 'Noah Williams',
        role: 'Guardian',
        status: 'synthetic_verified',
      },
      {
        contactId: 'recipient-1',
        label: 'Mira Chen',
        role: 'Recipient',
        status: 'synthetic_verified',
      },
    ],
    envelopes: [
      {
        attachmentSourceIds: [`sha256:${'a'.repeat(64)}`],
        document: {
          markdown: '# First action\n\nUse synthetic data only.',
          recipientLabel: 'Mira Chen',
          title: 'A calm handoff',
        },
        envelopeId: 'envelope-1',
        protectionMode: 'Standard',
        releasePolicy: 'Guardian attestation first',
      },
    ],
  };
}

describe('Draft rehearsal review', () => {
  it('builds one bounded review of the complete synthetic path', async () => {
    const review = await createDraftRehearsalReview(input(), 2_000);

    expect(review.canComplete).toBe(true);
    expect(review.reviewIdentity).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(review.timeline).toEqual([
      {
        afterMs: 25 * DAY,
        id: 'reminder',
        label: 'Reminder begins',
        stop: false,
      },
      {
        afterMs: 30 * DAY,
        id: 'due',
        label: 'Check-in due',
        stop: false,
      },
      {
        afterMs: 37 * DAY,
        id: 'concern',
        label: 'Concern may begin',
        stop: true,
      },
    ]);
    expect(review.envelopes).toEqual([
      {
        attachmentCount: 1,
        envelopeId: 'envelope-1',
        protectionMode: 'Standard',
        recipientLabel: 'Mira Chen',
        releasePolicy: 'Guardian attestation first',
        title: 'A calm handoff',
      },
    ]);
    expect(review.noticeIntents).toHaveLength(2);
    expect(review.noticeIntents.every((notice) => !notice.sent)).toBe(true);
    for (const notice of review.noticeIntents) {
      expect(notice.message).not.toContain('A calm handoff');
      expect(notice.message).not.toContain('Mira Chen');
      expect(notice.message).toContain('No private Envelope content');
    }
  });

  it('reports actionable blockers instead of marking an invalid Draft ready', async () => {
    const baseline = input();
    const envelope = baseline.envelopes[0]!;
    const candidate: DraftRehearsalInput = {
      ...baseline,
      contacts: baseline.contacts.filter(
        (contact) => contact.role !== 'Guardian',
      ),
      envelopes: [
        {
          ...envelope,
          document: {
            ...envelope.document,
            recipientLabel: 'Unknown Recipient',
            title: '   ',
          },
        },
      ],
    };

    const review = await createDraftRehearsalReview(candidate, 2_000);

    expect(review.canComplete).toBe(false);
    expect(review.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'documents', status: 'blocked' }),
        expect.objectContaining({ id: 'contacts', status: 'blocked' }),
      ]),
    );
  });

  it('blocks empty or unsupported rehearsals and rejects invalid timing', async () => {
    const baseline = input();
    const empty = await createDraftRehearsalReview(
      { ...baseline, envelopes: [] },
      2_000,
    );
    expect(empty.canComplete).toBe(false);
    expect(empty.checks).toContainEqual(
      expect.objectContaining({ id: 'documents', status: 'blocked' }),
    );

    const envelope = baseline.envelopes[0]!;
    const unsupported = await createDraftRehearsalReview(
      {
        ...baseline,
        envelopes: [
          {
            ...envelope,
            protectionMode: 'Sealed',
          } as unknown as typeof envelope,
        ],
      },
      2_000,
    );
    expect(unsupported.canComplete).toBe(false);
    expect(unsupported.checks).toContainEqual(
      expect.objectContaining({ id: 'policies', status: 'blocked' }),
    );

    const invalidTiming: DraftRehearsalInput = {
      ...baseline,
      plan: {
        ...baseline.plan,
        policy: {
          ...baseline.plan.policy,
          reminderLeadMs: baseline.plan.policy.checkInIntervalMs,
        },
      },
    };
    await expect(
      createDraftRehearsalReview(invalidTiming, 2_000),
    ).rejects.toThrow(/valid Check-in and Concern timeline/u);
  });

  it('accepts only the exact review of the current Plan and Envelopes', async () => {
    const current = input();
    const review = await createDraftRehearsalReview(current, 2_000);

    await expect(acceptDraftRehearsalReview(review, current)).resolves.toEqual({
      planId: 'plan-0001',
      policyRevision: 1,
      reviewIdentity: review.reviewIdentity,
      syntheticNoticeCount: 2,
    });

    const envelope = current.envelopes[0]!;
    const changed: DraftRehearsalInput = {
      ...current,
      envelopes: [
        {
          ...envelope,
          document: {
            ...envelope.document,
            markdown: `${envelope.document.markdown}\nChanged later.`,
          },
        },
      ],
    };
    await expect(acceptDraftRehearsalReview(review, changed)).rejects.toThrow(
      /changed after rehearsal review/u,
    );
  });

  it('snapshots accessor-backed Plan fields exactly once before validation', async () => {
    const baseline = input();
    const reads = {
      checkInIntervalMs: 0,
      gracePeriodMs: 0,
      lifecycle: 0,
      planId: 0,
      policy: 0,
      policyRevision: 0,
      reminderLeadMs: 0,
    };
    const policy = {
      get checkInIntervalMs() {
        reads.checkInIntervalMs += 1;
        return reads.checkInIntervalMs === 1
          ? baseline.plan.policy.checkInIntervalMs
          : 0;
      },
      get gracePeriodMs() {
        reads.gracePeriodMs += 1;
        return reads.gracePeriodMs === 1
          ? baseline.plan.policy.gracePeriodMs
          : 0;
      },
      get reminderLeadMs() {
        reads.reminderLeadMs += 1;
        return reads.reminderLeadMs === 1
          ? baseline.plan.policy.reminderLeadMs
          : 0;
      },
    };
    const plan = {
      get lifecycle() {
        reads.lifecycle += 1;
        return reads.lifecycle === 1 ? 'draft' : 'disabled';
      },
      get planId() {
        reads.planId += 1;
        return reads.planId === 1 ? baseline.plan.planId : 'invalid';
      },
      get policy() {
        reads.policy += 1;
        return reads.policy === 1 ? policy : null;
      },
      get policyRevision() {
        reads.policyRevision += 1;
        return reads.policyRevision === 1 ? 1 : 0;
      },
    } as unknown as DraftRehearsalInput['plan'];

    const review = await createDraftRehearsalReview(
      { ...baseline, plan },
      2_000,
    );

    expect(review.canComplete).toBe(true);
    expect(reads).toEqual({
      checkInIntervalMs: 1,
      gracePeriodMs: 1,
      lifecycle: 1,
      planId: 1,
      policy: 1,
      policyRevision: 1,
      reminderLeadMs: 1,
    });
  });

  it('rejects Attachment, contact, policy, and review tampering', async () => {
    const scenarios: Array<
      (candidate: DraftRehearsalInput) => DraftRehearsalInput
    > = [
      (candidate) => ({
        ...candidate,
        envelopes: [
          {
            ...candidate.envelopes[0]!,
            attachmentSourceIds: [`sha256:${'b'.repeat(64)}`],
          },
        ],
      }),
      (candidate) => ({
        ...candidate,
        contacts: [
          { ...candidate.contacts[0]!, label: 'Changed Guardian' },
          ...candidate.contacts.slice(1),
        ],
      }),
      (candidate) => ({
        ...candidate,
        plan: { ...candidate.plan, policyRevision: 2 },
      }),
      (candidate) => ({
        ...candidate,
        plan: { ...candidate.plan, lifecycle: 'paused' },
      }),
      (candidate) => ({
        ...candidate,
        plan: {
          ...candidate.plan,
          policy: {
            ...candidate.plan.policy,
            gracePeriodMs: candidate.plan.policy.gracePeriodMs + DAY,
          },
        },
      }),
    ];

    for (const mutate of scenarios) {
      const reviewedInput = input();
      const review = await createDraftRehearsalReview(reviewedInput, 2_000);
      const current = mutate(input());
      await expect(acceptDraftRehearsalReview(review, current)).rejects.toThrow(
        DraftRehearsalError,
      );
    }

    const current = input();
    const review = await createDraftRehearsalReview(current, 2_000);
    await expect(
      acceptDraftRehearsalReview({ ...review, canComplete: false }, current),
    ).rejects.toThrow(/changed after rehearsal review/u);
  });

  it('fails closed on duplicate identities and malformed source evidence', async () => {
    const baseline = input();
    const duplicateContacts: DraftRehearsalInput = {
      ...baseline,
      contacts: [...baseline.contacts, { ...baseline.contacts[0]! }],
    };
    await expect(
      createDraftRehearsalReview(duplicateContacts, 2_000),
    ).rejects.toThrow(/unique bounded identities/u);

    const attachmentBaseline = input();
    const malformedAttachment: DraftRehearsalInput = {
      ...attachmentBaseline,
      envelopes: [
        {
          ...attachmentBaseline.envelopes[0]!,
          attachmentSourceIds: ['not-a-digest'],
        },
      ],
    };
    await expect(
      createDraftRehearsalReview(malformedAttachment, 2_000),
    ).rejects.toThrow(/canonical Attachment source identities/u);

    const duplicateAttachment: DraftRehearsalInput = {
      ...attachmentBaseline,
      envelopes: [
        {
          ...attachmentBaseline.envelopes[0]!,
          attachmentSourceIds: [
            `sha256:${'a'.repeat(64)}`,
            `sha256:${'a'.repeat(64)}`,
          ],
        },
      ],
    };
    await expect(
      createDraftRehearsalReview(duplicateAttachment, 2_000),
    ).rejects.toThrow(/canonical Attachment source identities/u);
  });

  it('rejects sparse or oversized review collections', async () => {
    const baseline = input();
    const sparseContacts = new Array<DraftRehearsalInput['contacts'][number]>(
      2,
    );
    sparseContacts[0] = baseline.contacts[0]!;
    await expect(
      createDraftRehearsalReview(
        { ...baseline, contacts: sparseContacts },
        2_000,
      ),
    ).rejects.toThrow(/dense list/u);

    const oversizedContacts = Array.from({ length: 65 }, (_, index) => ({
      contactId: `contact-${String(index)}`,
      label: `Synthetic Contact ${String(index)}`,
      role: index === 0 ? ('Guardian' as const) : ('Recipient' as const),
      status: 'synthetic_verified' as const,
    }));
    await expect(
      createDraftRehearsalReview(
        { ...baseline, contacts: oversizedContacts },
        2_000,
      ),
    ).rejects.toThrow(/at most 64 contacts/u);

    const envelope = baseline.envelopes[0]!;
    const attachmentIds = Array.from(
      { length: 8 },
      (_, index) => `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
    );
    const oversizedEnvelopes = Array.from({ length: 33 }, (_, index) => ({
      ...envelope,
      envelopeId: `envelope-${String(index + 1)}`,
    }));
    await expect(
      createDraftRehearsalReview(
        { ...baseline, envelopes: oversizedEnvelopes },
        2_000,
      ),
    ).rejects.toThrow(/at most 32 Envelopes/u);

    await expect(
      createDraftRehearsalReview(
        {
          ...baseline,
          envelopes: [
            {
              ...envelope,
              attachmentSourceIds: [
                ...attachmentIds,
                `sha256:${'f'.repeat(64)}`,
              ],
            },
          ],
        },
        2_000,
      ),
    ).rejects.toThrow(/at most 8 Attachment identities/u);

    const tooManyAttachments = Array.from({ length: 17 }, (_, index) => ({
      ...envelope,
      attachmentSourceIds: attachmentIds,
      envelopeId: `envelope-${String(index + 1)}`,
    }));
    await expect(
      createDraftRehearsalReview(
        { ...baseline, envelopes: tooManyAttachments },
        2_000,
      ),
    ).rejects.toThrow(/at most 128 Attachment identities/u);

    const sparseEnvelopes = new Array<DraftRehearsalInput['envelopes'][number]>(
      2,
    );
    sparseEnvelopes[0] = envelope;
    await expect(
      createDraftRehearsalReview(
        { ...baseline, envelopes: sparseEnvelopes },
        2_000,
      ),
    ).rejects.toThrow(/dense list/u);
  });
});
