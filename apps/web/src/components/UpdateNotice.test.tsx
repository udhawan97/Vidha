import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateNotice } from './UpdateNotice';

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
  });

  it('updates an untouched disposable rehearsal without another confirmation', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork={false}
        otherTabBlocksUpdate={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Update now' }));

    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledOnce();
    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires explicit data-loss confirmation when the session contains work', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        otherTabBlocksUpdate={false}
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

    await user.click(
      screen.getByRole('button', { name: 'Update and clear session' }),
    );

    expect(serviceWorker.updateServiceWorker).toHaveBeenCalledWith(true);
    const afterConfirmation = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterConfirmation);
    expect(afterConfirmation.defaultPrevented).toBe(false);
  });

  it('returns focus after canceling the update confirmation', async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork
        otherTabBlocksUpdate={false}
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
        otherTabBlocksUpdate={false}
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
        otherTabBlocksUpdate={false}
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
        otherTabBlocksUpdate={false}
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
  });

  it('holds an update while another tab contains changed work', () => {
    render(
      <UpdateNotice
        actionPending={false}
        fileReviewPending={false}
        hasSessionWork={false}
        otherTabBlocksUpdate
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
