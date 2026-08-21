import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  }),
}));

describe('Vidha Phase 1 app', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('makes the safety boundary visible on first render', () => {
    render(<App />);

    expect(
      screen.getByText('Release logic is not active in this build.'),
    ).toBeVisible();
    expect(screen.getByText('Local demo')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Rehearse Check-in' }),
    ).toBeEnabled();
  });

  it('advances the rehearsal by exactly one stage', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Advance one stage' }));

    expect(
      screen.getByLabelText('Current timeline stage: reminder'),
    ).toBeVisible();
    expect(screen.getByText('Reminder stage entered')).toBeVisible();
  });

  it('requires an explicit confirmation before recording a Check-in', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Rehearse Check-in' }));
    expect(
      screen.getByRole('dialog', {
        name: 'Confirm this rehearsal Check-in?',
      }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Confirm Check-in' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Authenticated Check-in recorded')).toBeVisible();
  });

  it('imports a small Markdown file into the temporary editor session', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const input = screen.getByLabelText('Import Markdown or plain text');
    const file = new File(['# A synthetic imported note'], 'sample-note.md', {
      type: 'text/markdown',
    });
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByLabelText('Envelope Markdown content')).toHaveValue(
        '# A synthetic imported note',
      );
    });
    expect(screen.getByDisplayValue('sample note')).toBeVisible();
  });
});
