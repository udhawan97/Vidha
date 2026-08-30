import { describe, expect, it } from 'vitest';

import { createDemoPlan, demoEnvelopes, type DemoEnvelope } from './demo';
import { createSessionLossReview } from './sessionLossReview';

function cloneEnvelopes(): DemoEnvelope[] {
  return demoEnvelopes.map((envelope) => ({
    ...envelope,
    attachments: [...envelope.attachments],
    documentDraft: { ...envelope.documentDraft },
  }));
}

describe('createSessionLossReview', () => {
  it('reports an untouched synthetic rehearsal without invented losses', () => {
    const plan = createDemoPlan(2_000_000_000_000);

    expect(
      createSessionLossReview({
        baselineEnvelopes: demoEnvelopes,
        baselinePlan: plan,
        envelopes: cloneEnvelopes(),
        plan,
        workspace: { envelopes: [] },
      }),
    ).toEqual({
      affectedEnvelopes: [],
      counts: {
        attachments: 0,
        documentVersions: 0,
        editHistorySteps: 0,
        editedDocuments: 0,
        importedSources: 0,
        localPlanEvents: 0,
      },
    });
  });

  it('combines current Envelope material and workspace history by identity', () => {
    const baselinePlan = createDemoPlan(2_000_000_000_000);
    const envelopes = cloneEnvelopes();
    const changed = envelopes[0]!;
    changed.documentDraft.title = 'Changed locally';
    changed.attachments = [
      {
        filename: 'synthetic.pdf',
        kind: 'document',
        mediaType: 'application/pdf',
        originalBytes: Uint8Array.from([1, 2, 3]),
        sizeBytes: 3,
        sourceId: 'sha256-synthetic',
        warnings: [],
      },
    ];
    changed.importSource = {
      conversionWarnings: [],
      converterId: 'synthetic-converter',
      detectedMediaType: 'text/plain',
      filename: 'synthetic.txt',
      mediaType: 'text/plain',
      originalBytes: Uint8Array.from([4, 5]),
      scannerId: 'synthetic-scanner',
      schemaVersion: 1,
      sizeBytes: 2,
      sourceId: 'sha256-import',
      text: 'Synthetic source',
    };
    const plan = {
      ...baselinePlan,
      events: [
        ...baselinePlan.events,
        {
          at: baselinePlan.lastCommandAt + 1,
          id: 'event-2',
          type: 'PLAN_REHEARSED' as const,
        },
      ],
    };

    expect(
      createSessionLossReview({
        baselineEnvelopes: demoEnvelopes,
        baselinePlan,
        envelopes,
        plan,
        workspace: {
          envelopes: [
            {
              envelopeId: changed.id,
              redoSteps: 1,
              undoSteps: 3,
              versionCount: 2,
            },
          ],
        },
      }),
    ).toEqual({
      affectedEnvelopes: [
        {
          envelopeId: 'home-notes',
          label: 'Changed locally',
          reasons: [
            'document',
            'import-source',
            'attachments',
            'versions',
            'edit-history',
          ],
        },
      ],
      counts: {
        attachments: 1,
        documentVersions: 2,
        editHistorySteps: 4,
        editedDocuments: 1,
        importedSources: 1,
        localPlanEvents: 1,
      },
    });
  });
});
