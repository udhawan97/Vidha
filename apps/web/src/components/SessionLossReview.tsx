import type {
  SessionLossReason,
  SessionLossReview as SessionLossReviewModel,
} from '../sessionLossReview';

import './SessionLossReview.css';

interface SessionLossReviewProps {
  readonly onReviewEnvelope: (envelopeId: string) => void;
  readonly review: SessionLossReviewModel;
}

const reasonLabels: Record<SessionLossReason, string> = {
  attachments: 'Attachments',
  document: 'edited document',
  'edit-history': 'undo/redo history',
  'import-source': 'import source',
  versions: 'Document Versions',
};

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function SessionLossReview({
  onReviewEnvelope,
  review,
}: SessionLossReviewProps) {
  const countItems = [
    countLabel(review.counts.editedDocuments, 'edited document'),
    countLabel(review.counts.importedSources, 'import source'),
    countLabel(review.counts.attachments, 'Attachment'),
    countLabel(review.counts.documentVersions, 'Document Version'),
    countLabel(review.counts.editHistorySteps, 'undo/redo step'),
    countLabel(review.counts.localPlanEvents, 'local Plan event'),
  ];

  return (
    <section
      aria-label="Current session-loss review"
      className="session-loss-review"
    >
      <div className="session-loss-heading">
        <div>
          <span className="review-label">Current tab inventory</span>
          <h3>What this action will clear</h3>
        </div>
        <span>Live counts</span>
      </div>
      <ul className="session-loss-counts">
        {countItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {review.affectedEnvelopes.length === 0 ? (
        <p>No changed Envelope material is currently counted.</p>
      ) : (
        <div className="session-loss-envelopes">
          <span className="review-label">Affected Envelopes</span>
          {review.affectedEnvelopes.map((envelope) => (
            <div key={envelope.envelopeId}>
              <div>
                <strong>{envelope.label}</strong>
                <span>
                  {envelope.reasons
                    .map((reason) => reasonLabels[reason])
                    .join(' · ')}
                </span>
              </div>
              <button
                className="button button-quiet session-loss-review-action"
                onClick={() => onReviewEnvelope(envelope.envelopeId)}
                type="button"
              >
                Review Envelope
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="session-loss-boundary">
        This local inventory does not save, recover, or prove a download of any
        material.
      </p>
    </section>
  );
}
