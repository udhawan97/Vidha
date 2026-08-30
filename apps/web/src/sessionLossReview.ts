import type { PlanState } from '@vidha/domain';

import type { DemoEnvelope } from './demo';

export interface EnvelopeWorkspaceHistory {
  readonly envelopeId: string;
  readonly redoSteps: number;
  readonly undoSteps: number;
  readonly versionCount: number;
}

export interface WorkspaceSessionState {
  readonly envelopes: readonly EnvelopeWorkspaceHistory[];
}

export type SessionLossReason =
  'attachments' | 'document' | 'edit-history' | 'import-source' | 'versions';

export interface SessionLossEnvelope {
  readonly envelopeId: string;
  readonly label: string;
  readonly reasons: readonly SessionLossReason[];
}

export interface SessionLossReview {
  readonly affectedEnvelopes: readonly SessionLossEnvelope[];
  readonly counts: {
    readonly attachments: number;
    readonly documentVersions: number;
    readonly editHistorySteps: number;
    readonly editedDocuments: number;
    readonly importedSources: number;
    readonly localPlanEvents: number;
  };
}

interface CreateSessionLossReviewInput {
  readonly baselineEnvelopes: readonly DemoEnvelope[];
  readonly baselinePlan: PlanState;
  readonly envelopes: readonly DemoEnvelope[];
  readonly plan: PlanState;
  readonly workspace: WorkspaceSessionState;
}

function documentChanged(
  envelope: DemoEnvelope,
  baseline: DemoEnvelope | undefined,
): boolean {
  return (
    baseline === undefined ||
    envelope.documentDraft.markdown !== baseline.documentDraft.markdown ||
    envelope.documentDraft.recipientLabel !==
      baseline.documentDraft.recipientLabel ||
    envelope.documentDraft.title !== baseline.documentDraft.title
  );
}

function importSourceChanged(
  envelope: DemoEnvelope,
  baseline: DemoEnvelope | undefined,
): boolean {
  return envelope.importSource?.sourceId !== baseline?.importSource?.sourceId;
}

function attachmentCountChanged(
  envelope: DemoEnvelope,
  baseline: DemoEnvelope | undefined,
): number {
  const baselineIds = new Set(
    baseline?.attachments.map((attachment) => attachment.sourceId) ?? [],
  );
  return envelope.attachments.filter(
    (attachment) => !baselineIds.has(attachment.sourceId),
  ).length;
}

export function createSessionLossReview({
  baselineEnvelopes,
  baselinePlan,
  envelopes,
  plan,
  workspace,
}: CreateSessionLossReviewInput): SessionLossReview {
  const baselines = new Map(
    baselineEnvelopes.map((envelope) => [envelope.id, envelope]),
  );
  const histories = new Map(
    workspace.envelopes.map((history) => [history.envelopeId, history]),
  );
  let attachments = 0;
  let documentVersions = 0;
  let editHistorySteps = 0;
  let editedDocuments = 0;
  let importedSources = 0;

  const affectedEnvelopes = envelopes.flatMap((envelope) => {
    const baseline = baselines.get(envelope.id);
    const history = histories.get(envelope.id);
    const reasons: SessionLossReason[] = [];
    if (documentChanged(envelope, baseline)) {
      editedDocuments += 1;
      reasons.push('document');
    }
    if (importSourceChanged(envelope, baseline)) {
      importedSources += 1;
      reasons.push('import-source');
    }
    const addedAttachments = attachmentCountChanged(envelope, baseline);
    if (addedAttachments > 0) {
      attachments += addedAttachments;
      reasons.push('attachments');
    }
    const versions = history?.versionCount ?? 0;
    if (versions > 0) {
      documentVersions += versions;
      reasons.push('versions');
    }
    const historySteps = (history?.undoSteps ?? 0) + (history?.redoSteps ?? 0);
    if (historySteps > 0) {
      editHistorySteps += historySteps;
      reasons.push('edit-history');
    }
    return reasons.length === 0
      ? []
      : [
          {
            envelopeId: envelope.id,
            label: envelope.documentDraft.title,
            reasons,
          },
        ];
  });

  return {
    affectedEnvelopes,
    counts: {
      attachments,
      documentVersions,
      editHistorySteps,
      editedDocuments,
      importedSources,
      localPlanEvents: Math.max(
        plan.events.length - baselinePlan.events.length,
        0,
      ),
    },
  };
}

export const emptyWorkspaceSessionState: WorkspaceSessionState = {
  envelopes: [],
};
