import { createArmedPlan, type PlanState } from '@vidha/domain';

const DAY = 24 * 60 * 60 * 1_000;

export interface DemoEnvelope {
  readonly id: string;
  title: string;
  body: string;
  recipient: string;
  importSource: DemoImportSource | null;
  protectionMode: 'Standard';
  releasePolicy: 'Guardian attestation first';
}

export interface DemoImportSource {
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly text: string;
}

export const demoRecipients = ['Mira Chen', 'Sam Rivera'] as const;

export const demoEnvelopes: DemoEnvelope[] = [
  {
    id: 'home-notes',
    title: 'The house, without guesswork',
    body: `# The house, without guesswork

This is a synthetic draft for the Vidha demonstration.

## First things first

- The spare key is with the building manager.
- The plants prefer less water than you think.
- The blue folder contains only copies, never originals.

Nothing in this demo is stored after the session ends.`,
    recipient: 'Mira Chen',
    importSource: null,
    protectionMode: 'Standard',
    releasePolicy: 'Guardian attestation first',
  },
  {
    id: 'pet-routine',
    title: 'Juniper’s ordinary week',
    body: `# Juniper’s ordinary week

This synthetic note demonstrates a practical handoff.

Morning walks are short. The evening walk is the one she waits for.`,
    recipient: 'Sam Rivera',
    importSource: null,
    protectionMode: 'Standard',
    releasePolicy: 'Guardian attestation first',
  },
];

export function createDemoPlan(referenceTime = Date.now()): PlanState {
  return createArmedPlan({
    planId: 'synthetic-plan',
    ownerId: 'synthetic-owner',
    at: referenceTime - 18 * DAY,
    policy: {
      checkInIntervalMs: 30 * DAY,
      reminderLeadMs: 5 * DAY,
      gracePeriodMs: 7 * DAY,
    },
  });
}
