import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UPDATE_HANDOFF_STORAGE_KEY } from '../updateHandoffReceipt';
import { UPDATE_HANDOFF_TIMEOUT_MS, UpdateNotice } from './UpdateNotice';

const emptySessionLossReview = {
  affectedEnvelopes: [],
  counts: {
    attachments: 0,
    documentVersions: 0,
    editHistorySteps: 0,
    editedDocuments: 0,
    importedSources: 0,
    localPlanEvents: 0,
  },
} as const;

const onReviewEnvelope = vi.fn();

const serviceWorker = vi.hoisted(() => ({
  needRefresh: true,
  offlineReady: false,
  setNeedRefresh: vi.fn(),
  setOfflineReady: vi.fn(),
  updateServiceWorker: vi.fn<() => Promise<void>>(),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [serviceWorker.needRefresh, serviceWorker.setNeedRefresh],
    offlineReady: [serviceWorker.offlineReady, serviceWorker.setOfflineReady],
    updateServiceWorker: serviceWorker.updateServiceWorker,
  }),
}));

describe('UpdateNotice', () => {
  beforeEach(() => {
    serviceWorker.needRefresh = true;
    serviceWorker.offlineReady = false;
    serviceWorker.setNeedRefresh.mockReset();
    serviceWorker.setOfflineReady.mockReset();
    serviceWorker.updateServiceWorker.mockReset();
    serviceWorker.updateServiceWorker.mockResolvedValue(undefined);
    onReviewEnvelope.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it('updates an untouched disposable rehearsal without another confirmation', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork={false}
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Update now' }));

    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledOnce();
    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledWith(true);
    expect(
      JSON.parse(
        window.sessionStorage.getItem(UPDATE_HANDOFF_STORAGE_KEY) ?? '',
      ),
    ).toEqual({
      protocol: 'vidha.update-handoff.v1',
      sourceBuildIdentity: 'local-development',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires explicit data-loss confirmation when the session contains work', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    const beforeConfirmation = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeConfirmation);
    expect(beforeConfirmation.defaultPrevented).toBe(true);

    const reviewUpdate = screen.getByRole('button', { name: 'Review update' });
    await user.click(reviewUpdate);

    const dialog = screen.getByRole('dialog', {
      name: 'Update and clear this rehearsal?',
    });
    expect(dialog).toHaveTextContent('Plan timeline');
    expect(dialog).toHaveTextContent('Document Versions');
    expect(screen.getByRole('button', { name: 'Keep working' })).toHaveFocus();
    expect(
      window.sessionStorage.getItem(UPDATE_HANDOFF_STORAGE_KEY),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'Update and clear session' }),
    );

    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledWith(true);
    const afterConfirmation = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterConfirmation);
    expect(afterConfirmation.defaultPrevented).toBe(false);
  });

  it('shows exact current losses and returns to an affected Envelope', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={{
          affectedEnvelopes: [
            {
              envelopeId: 'home-notes',
              label: 'Changed locally',
              reasons: ['document', 'attachments', 'versions'],
            },
          ],
          counts: {
            attachments: 1,
            documentVersions: 2,
            editHistorySteps: 3,
            editedDocuments: 1,
            importedSources: 0,
            localPlanEvents: 4,
          },
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Review update' }));

    const review = screen.getByRole('region', {
      name: 'Current session-loss review',
    });
    expect(review).toHaveTextContent('1 edited document');
    expect(review).toHaveTextContent('1 Attachment');
    expect(review).toHaveTextContent('2 Document Versions');
    expect(review).toHaveTextContent('3 undo/redo steps');
    expect(review).toHaveTextContent('4 local Plan events');
    expect(review).toHaveTextContent('Changed locally');

    await user.click(screen.getByRole('button', { name: 'Review Envelope' }));

    expect(onReviewEnvelope).toHaveBeenCalledWith('home-notes');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(serviceWorker.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('returns focus after canceling the update confirmation', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    const reviewUpdate = screen.getByRole('button', { name: 'Review update' });
    await user.click(reviewUpdate);
    const dialog = screen.getByRole('dialog', {
      name: 'Update and clear this rehearsal?',
    });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(reviewUpdate).toHaveFocus());
    expect(serviceWorker.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('waits for an in-flight Owner action before offering an update', () => {
    render(
      <UpdateNotice
        actionPending
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Owner action in progress' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/finish the current Owner action before updating/i),
    ).toBeVisible();
  });

  it('holds an update and ordinary reload while a file review is preparing', () => {
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending
        hasSessionWork={false}
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'File review in progress' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/finish the current file review before updating/i),
    ).toBeVisible();
    const duringReview = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(duringReview);
    expect(duringReview.defaultPrevented).toBe(true);
    expect(serviceWorker.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('keeps the confirmation open and restores unload protection after failure', async () => {
    const user = userEvent.setup();
    serviceWorker.updateServiceWorker.mockRejectedValue(
      new Error('synthetic update failure'),
    );
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Review update' }));
    await user.click(
      screen.getByRole('button', { name: 'Update and clear session' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The update did not start. Your local rehearsal is still open.',
    );
    expect(
      screen.getByRole('dialog', { name: 'Update and clear this rehearsal?' }),
    ).toBeVisible();
    const afterFailure = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterFailure);
    expect(afterFailure.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Keep working' })).toHaveFocus();
    expect(
      window.sessionStorage.getItem(UPDATE_HANDOFF_STORAGE_KEY),
    ).toBeNull();
  });

  it('restores the decision when an accepted update leaves this tab alive', async () => {
    vi.useFakeTimers();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Update and clear session' }),
    );

    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledWith(true);
    const duringHandoff = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(duringHandoff);
    expect(duringHandoff.defaultPrevented).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_HANDOFF_TIMEOUT_MS);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The update did not replace this tab in time.',
    );
    expect(screen.getByRole('button', { name: 'Keep working' })).toHaveFocus();
    const afterTimeout = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterTimeout);
    expect(afterTimeout.defaultPrevented).toBe(true);
    expect(
      window.sessionStorage.getItem(UPDATE_HANDOFF_STORAGE_KEY),
    ).toBeNull();
  });

  it('ignores a stale rejection after the handoff timeout restores the decision', async () => {
    vi.useFakeTimers();
    let rejectUpdate: ((reason?: unknown) => void) | undefined;
    serviceWorker.updateServiceWorker.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectUpdate = reject;
        }),
    );
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Update and clear session' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_HANDOFF_TIMEOUT_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The update did not replace this tab in time.',
    );

    await act(async () => {
      rejectUpdate?.(new Error('late synthetic rejection'));
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The update did not replace this tab in time.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'The update did not start.',
    );
  });

  it('restores the decision when an accepted update returns from page history', async () => {
    serviceWorker.updateServiceWorker.mockImplementation(
      () => new Promise(() => undefined),
    );
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Review update' }));
    await user.click(
      screen.getByRole('button', { name: 'Update and clear session' }),
    );
    fireEvent(window, new Event('pageshow'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This tab returned before the update finished.',
    );
    expect(screen.getByRole('button', { name: 'Keep working' })).toHaveFocus();
    const afterReturn = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterReturn);
    expect(afterReturn.defaultPrevented).toBe(true);
    expect(
      window.sessionStorage.getItem(UPDATE_HANDOFF_STORAGE_KEY),
    ).toBeNull();
  });

  it('acknowledges a changed application build after the tab returns', async () => {
    serviceWorker.needRefresh = false;
    window.sessionStorage.setItem(
      UPDATE_HANDOFF_STORAGE_KEY,
      JSON.stringify({
        protocol: 'vidha.update-handoff.v1',
        sourceBuildIdentity: 'previous-build-123',
      }),
    );

    render(
      <UpdateNotice
        actionPending={false}
        buildIdentity="current-build-456"
        fileReviewPending={false}
        hasSessionWork={false}
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Build current-buil is now open.',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'changed from build previous-bui to current-buil',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'does not inspect the service worker, caches, or update safety',
    );
    await waitFor(() =>
      expect(
        window.sessionStorage.getItem(UPDATE_HANDOFF_STORAGE_KEY),
      ).toBeNull(),
    );
  });

  it('reports an unverified return when the build identity did not change', () => {
    serviceWorker.needRefresh = false;
    window.sessionStorage.setItem(
      UPDATE_HANDOFF_STORAGE_KEY,
      JSON.stringify({
        protocol: 'vidha.update-handoff.v1',
        sourceBuildIdentity: 'same-build',
      }),
    );

    render(
      <UpdateNotice
        actionPending={false}
        buildIdentity="same-build"
        fileReviewPending={false}
        hasSessionWork={false}
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'The requested update is unverified.',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'a different application build was not observed',
    );
  });

  it('does not start an update when the receipt cannot be recorded', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        buildIdentity="current-build"
        fileReviewPending={false}
        hasSessionWork={false}
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate={false}
        sessionLossReview={emptySessionLossReview}
        storage={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Update now' }));

    expect(serviceWorker.updateServiceWorker).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not record a content-free update receipt',
    );
  });

  it('holds an update while another tab contains changed work', () => {
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork={false}
        onReviewEnvelope={onReviewEnvelope}
        otherTabBlocksUpdate
        sessionLossReview={emptySessionLossReview}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Other tab needs attention' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/close it before updating; tabs do not synchronize/i),
    ).toBeVisible();
    expect(serviceWorker.updateServiceWorker).not.toHaveBeenCalled();
  });
});
