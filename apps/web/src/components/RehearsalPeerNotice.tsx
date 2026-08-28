import type { RehearsalPeerSummary } from '../useRehearsalPeers';

export function RehearsalPeerNotice({
  detectionAvailable,
  peerActionPending,
  peerCount,
  peerFileReviewPending,
  peerHasSessionWork,
}: RehearsalPeerSummary) {
  if (detectionAvailable && peerCount === 0) return null;

  const title = !detectionAvailable
    ? 'This browser cannot detect other rehearsal tabs.'
    : peerActionPending
      ? 'Another tab is recording an Owner action.'
      : peerFileReviewPending
        ? 'Another tab is preparing a file review.'
        : peerHasSessionWork
          ? 'Another tab contains changed rehearsal work.'
          : peerCount === 1
            ? 'Another rehearsal tab is open.'
            : `${peerCount} other rehearsal tabs are open.`;
  const guidance = !detectionAvailable
    ? 'Keep only one rehearsal tab open. This prototype cannot warn if another tab contains separate in-memory work.'
    : peerHasSessionWork || peerActionPending || peerFileReviewPending
      ? 'Tabs do not synchronize. Finish or download work in the tab you want to keep, then close the other tab before updating or starting fresh.'
      : 'Each tab has a separate in-memory rehearsal. Choose one tab before making changes; nothing is copied or merged between them.';

  return (
    <aside
      aria-label="Multi-tab rehearsal status"
      aria-live="polite"
      className="peer-notice"
    >
      <span aria-hidden="true" className="peer-notice-mark">
        {detectionAvailable ? peerCount + 1 : '?'}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{guidance}</p>
        {detectionAvailable ? (
          <small>
            Only tab presence and content-free work, action, and file-review
            flags are shared.
          </small>
        ) : null}
      </div>
    </aside>
  );
}
