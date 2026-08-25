import { createDraftPlan, type PlanState } from '@vidha/domain';
import { createEditableDocument, type AttachmentKind } from '@vidha/documents';

const DAY = 24 * 60 * 60 * 1_000;

export interface DemoEnvelope {
  readonly id: string;
  documentDraft: DemoEditableDocumentDraft;
  importSource: DemoImportSource | null;
  attachments: DemoAttachment[];
  protectionMode: 'Standard';
  releasePolicy: 'Guardian attestation first';
}

export interface DemoEditableDocumentDraft {
  title: string;
  recipientLabel: string;
  markdown: string;
}

export interface DemoAttachment {
  readonly sourceId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly kind: AttachmentKind;
  readonly sizeBytes: number;
  readonly originalBytes: Uint8Array;
  readonly warnings: readonly string[];
}

export interface DemoImportSource {
  readonly filename: string;
  readonly mediaType: string;
  readonly detectedMediaType: 'text/markdown' | 'text/plain';
  readonly sizeBytes: number;
  readonly sourceId: string;
  readonly scannerId: string;
  readonly converterId: string;
  readonly conversionWarnings: readonly string[];
  readonly schemaVersion: 1;
  readonly originalBytes: Uint8Array;
  readonly text: string;
}

export const demoRecipients = ['Mira Chen', 'Sam Rivera'] as const;

function createDocumentDraft(
  input: DemoEditableDocumentDraft,
): DemoEditableDocumentDraft {
  const canonical = createEditableDocument(input);
  return {
    title: canonical.title,
    recipientLabel: canonical.recipientLabel,
    markdown: canonical.markdown,
  };
}

export const demoEnvelopes: DemoEnvelope[] = [
  {
    id: 'home-notes',
    documentDraft: createDocumentDraft({
      title: 'The house, without guesswork',
      markdown: `# The house, without guesswork

This is a synthetic draft for the Vidha demonstration.

## First things first

- The spare key is with the building manager.
- The plants prefer less water than you think.
- The blue folder contains only copies, never originals.

Nothing in this demo is stored after the session ends.`,
      recipientLabel: 'Mira Chen',
    }),
    importSource: null,
    attachments: [],
    protectionMode: 'Standard',
    releasePolicy: 'Guardian attestation first',
  },
  {
    id: 'pet-routine',
    documentDraft: createDocumentDraft({
      title: 'Juniper’s ordinary week',
      markdown: `# Juniper’s ordinary week

This synthetic note demonstrates a practical handoff.

Morning walks are short. The evening walk is the one she waits for.`,
      recipientLabel: 'Sam Rivera',
    }),
    importSource: null,
    attachments: [],
    protectionMode: 'Standard',
    releasePolicy: 'Guardian attestation first',
  },
];

export function createDemoPlan(referenceTime = Date.now()): PlanState {
  const startedAt = referenceTime - 18 * DAY;
  return createDraftPlan({
    planId: 'synthetic-plan',
    ownerId: 'synthetic-owner',
    at: startedAt,
    policy: {
      checkInIntervalMs: 30 * DAY,
      reminderLeadMs: 5 * DAY,
      gracePeriodMs: 7 * DAY,
    },
  });
}
