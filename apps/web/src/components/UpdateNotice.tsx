import { useRegisterSW } from 'virtual:pwa-register/react';

export function UpdateNotice() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh && !offlineReady) {
    return null;
  }

  return (
    <aside className="update-notice" aria-live="polite">
      <div>
        <strong>
          {needRefresh ? 'A new build is ready.' : 'Ready offline.'}
        </strong>
        <p>
          {needRefresh
            ? 'Update when you are not editing a draft.'
            : 'The application shell can reopen without a connection.'}
        </p>
      </div>
      <div className="update-actions">
        {needRefresh ? (
          <button
            className="button button-primary"
            onClick={() => void updateServiceWorker(true)}
            type="button"
          >
            Update now
          </button>
        ) : null}
        <button
          aria-label="Dismiss update notice"
          className="notice-dismiss"
          onClick={() => {
            setNeedRefresh(false);
            setOfflineReady(false);
          }}
          type="button"
        >
          ×
        </button>
      </div>
    </aside>
  );
}
