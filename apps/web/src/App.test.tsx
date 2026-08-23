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

async function armDemo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Rehearse Draft' }));
  await user.click(
    await screen.findByRole('button', { name: 'Arm rehearsal' }),
  );
  expect(await screen.findByText('Lifecycle: armed')).toBeVisible();
}

describe('Vidha synthetic foundation app', () => {
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
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Rehearse Draft' }),
    ).toBeEnabled();
    expect(screen.getByText('Lifecycle: draft')).toBeVisible();
    expect(
      screen.getByText('Sam Rivera', { selector: 'strong' }),
    ).toBeVisible();
    expect(screen.getByText('Guardian · synthetic')).toBeVisible();
  });

  it('advances the rehearsal by exactly one stage', async () => {
    const user = userEvent.setup();
    render(<App />);
    await armDemo(user);

    await user.click(screen.getByRole('button', { name: 'Advance one stage' }));

    expect(
      screen.getByLabelText('Current timeline stage: reminder'),
    ).toBeVisible();
    expect(screen.getByText('Reminder stage entered')).toBeVisible();
  });

  it('requires an explicit confirmation before recording a Check-in', async () => {
    const user = userEvent.setup();
    render(<App />);
    await armDemo(user);

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

    expect(
      screen.getByRole('heading', { name: 'Review sample-note.md' }),
    ).toBeVisible();
    expect(
      screen.getByText(/no malware scanner or sandboxed converter is active/i),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Approve decoded text' }),
    );

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

  it('stages multiple file types as reviewable Attachment candidates', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.upload(screen.getByLabelText('Add Attachment candidates'), [
      new File(['%PDF-synthetic'], 'care-sheet.pdf', {
        type: 'application/pdf',
      }),
      new File(['synthetic contact'], 'helper.vcf', {
        type: 'text/vcard',
      }),
    ]);

    expect(
      screen.getByRole('heading', {
        name: 'Keep 2 files with this Envelope?',
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/no malware scan, safe preview, upload, encryption/i),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Keep as Attachments' }),
    );

    expect(screen.getByText('care-sheet.pdf')).toBeVisible();
    expect(screen.getByText('helper.vcf')).toBeVisible();
    expect(screen.getByText('No file was uploaded or sent.')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Download care-sheet.pdf' }),
    ).toBeEnabled();

    await user.click(
      screen.getByRole('button', { name: 'Remove care-sheet.pdf' }),
    );
    expect(screen.queryByText('care-sheet.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('1/8')).toBeVisible();
  });

  it('explains the full rehearsal and consequence boundaries in the Owner guide', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Guide' }));

    expect(
      screen.getByRole('heading', {
        name: 'Build a handoff someone can actually follow.',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', {
        name: 'This build rehearses; it does not relay.',
      }),
    ).toBeVisible();
    expect(screen.getByText('Guardian Attestation first')).toBeVisible();
    expect(screen.getByText(/HTML, SVG, scripts, executables/i)).toBeVisible();
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

  it('pauses, resumes with a fresh interval, and confirms terminal disable', async () => {
    const user = userEvent.setup();
    render(<App />);
    await armDemo(user);

    await user.click(screen.getByRole('button', { name: 'Pause rehearsal' }));
    expect(await screen.findByText('Lifecycle: paused')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Timeline is not armed' }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: 'Resume with fresh interval' }),
    );
    expect(await screen.findByText('Lifecycle: armed')).toBeVisible();

    for (let stage = 0; stage < 3; stage += 1) {
      await user.click(
        screen.getByRole('button', { name: 'Advance one stage' }),
      );
    }
    expect(await screen.findByText('Concern is active')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Disable rehearsal' }));
    expect(
      screen.getByRole('dialog', { name: 'Disable this rehearsal Plan?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm disable' }));
    expect(await screen.findByText('Lifecycle: disabled')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'This rehearsal has ended.' }),
    ).toBeVisible();
    expect(
      screen.queryByLabelText('Next Check-in due date'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Timeline inactive')).toBeVisible();
    expect(screen.queryByText('Concern is active')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disable rehearsal' }),
    ).not.toBeInTheDocument();
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
    await user.click(
      screen.getByRole('button', { name: 'Approve decoded text' }),
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
