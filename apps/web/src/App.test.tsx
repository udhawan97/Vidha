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
    expect(
      screen.getByText('Sam Rivera', { selector: 'strong' }),
    ).toBeVisible();
    expect(screen.getByText('Guardian · synthetic')).toBeVisible();
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
    expect(screen.getByText('sample-note.md')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Restore imported text' }),
    ).toBeEnabled();
  });

  it('reassigns a synthetic Recipient with undo and redo controls', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const recipient = screen.getByLabelText('Recipient');
    await user.selectOptions(recipient, 'Sam Rivera');
    expect(recipient).toHaveValue('Sam Rivera');

    await user.click(screen.getByRole('button', { name: 'Undo session edit' }));
    expect(recipient).toHaveValue('Mira Chen');

    await user.click(screen.getByRole('button', { name: 'Redo session edit' }));
    expect(recipient).toHaveValue('Sam Rivera');
  });

  it('keeps undo history and checkpoints across workspace navigation', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    await user.selectOptions(screen.getByLabelText('Recipient'), 'Sam Rivera');
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));

    await user.click(screen.getByRole('button', { name: 'Undo session edit' }));
    expect(screen.getByLabelText('Recipient')).toHaveValue('Mira Chen');
    await user.click(screen.getByRole('button', { name: 'Redo session edit' }));
    expect(screen.getByLabelText('Recipient')).toHaveValue('Sam Rivera');

    await user.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    const checkpoints = screen.getAllByRole('button', {
      name: /Restore .*checkpoint/,
    });
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).not.toHaveAttribute(
      'data-checkpoint-id',
      checkpoints[1]?.getAttribute('data-checkpoint-id'),
    );
    await user.click(
      screen.getByRole('button', { name: 'Restore checkpoint 2' }),
    );

    expect(screen.getByLabelText('Recipient')).toHaveValue('Mira Chen');
    expect(screen.getByText('Session checkpoint restored')).toBeVisible();
  });

  it('restores decoded imported text after an in-session edit', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const source = '# Imported source';
    await user.upload(
      screen.getByLabelText('Import Markdown or plain text'),
      new File([source], 'source.md', { type: 'text/markdown' }),
    );
    const editor = screen.getByLabelText('Envelope Markdown content');
    await user.clear(editor);
    await user.type(editor, 'Changed in the session');
    await user.click(
      screen.getByRole('button', { name: 'Restore imported text' }),
    );

    expect(editor).toHaveValue(source);
  });

  it('offers Markdown, plain-text, and standalone HTML copies', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    expect(
      screen.getByRole('button', { name: 'Export Markdown' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export text' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export HTML' })).toBeEnabled();
  });
});
