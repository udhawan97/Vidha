import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

const rehearsalPeers = vi.hoisted(() => ({
  detectionAvailable: true,
  peerActionPending: false,
  peerCount: 0,
  peerFileReviewPending: false,
  peerHasSessionWork: false,
}));

vi.mock('./useRehearsalPeers', () => ({
  useRehearsalPeers: () => rehearsalPeers,
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  }),
}));

async function armDemo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Review rehearsal' }));
  await user.click(
    await screen.findByRole('button', { name: 'Run local rehearsal' }),
  );
  await user.click(
    await screen.findByRole('button', { name: 'Arm rehearsal' }),
  );
  expect(await screen.findByText('Lifecycle: armed')).toBeVisible();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Vidha synthetic foundation app', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    rehearsalPeers.detectionAvailable = true;
    rehearsalPeers.peerActionPending = false;
    rehearsalPeers.peerCount = 0;
    rehearsalPeers.peerFileReviewPending = false;
    rehearsalPeers.peerHasSessionWork = false;
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
      screen.getByRole('button', { name: 'Review rehearsal' }),
    ).toBeEnabled();
    expect(screen.getByText('Lifecycle: draft')).toBeVisible();
    expect(
      screen.getByText('Sam Rivera', { selector: 'strong' }),
    ).toBeVisible();
    expect(screen.getByText('Guardian · synthetic')).toBeVisible();
  });

  it('marks accepted document work as navigation-sensitive session state', async () => {
    const user = userEvent.setup();
    render(<App />);

    const untouched = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(untouched);
    expect(untouched.defaultPrevented).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.type(screen.getByLabelText('Document title'), '!');

    const changed = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(changed);
    expect(changed.defaultPrevented).toBe(true);
  });

  it('holds Draft rehearsal while a file review is preparing or awaiting a decision', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const read = deferred<ArrayBuffer>();
    const file = new File(['# Unsettled review'], 'unsettled-review.md', {
      type: 'text/markdown',
    });
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(read.promise);
    fireEvent.change(screen.getByLabelText('Import Markdown or plain text'), {
      target: { files: [file] },
    });
    await user.click(screen.getByRole('button', { name: 'Overview' }));

    const review = screen.getByRole('button', { name: 'Review rehearsal' });
    await waitFor(() => expect(review).toBeDisabled());
    expect(
      screen.getByText(/selected file is still being prepared for review/i),
    ).toBeVisible();
    const duringRead = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(duringRead);
    expect(duringRead.defaultPrevented).toBe(true);

    read.resolve(new TextEncoder().encode('# Unsettled review').buffer);
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Review before replacing this draft' },
        { timeout: 10_000 },
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(
      screen.getByRole('status', { name: 'Draft file review hold' }),
    ).toHaveTextContent('1 file review is waiting for a decision.');
    expect(review).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: 'Open pending file review' }),
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await waitFor(() => expect(review).toBeEnabled());
  }, 15_000);

  it('reviews the complete local rehearsal before it can be marked complete', async () => {
    const user = userEvent.setup();
    render(<App />);

    const review = screen.getByRole('button', { name: 'Review rehearsal' });
    await user.click(review);
    const dialog = await screen.findByRole('dialog', {
      name: 'Review what this local rehearsal will test',
    });
    expect(dialog).toHaveTextContent('Day 25Reminder begins');
    expect(dialog).toHaveTextContent('Day 30Check-in due');
    expect(dialog).toHaveTextContent('Day 37Concern may begin');
    expect(dialog).toHaveTextContent(
      'No Guardian Attestation or Release follows.',
    );
    expect(dialog).toHaveTextContent('3notice previews0messages sent');
    expect(dialog).toHaveTextContent(
      'No private Envelope content is included.',
    );
    expect(dialog).toHaveTextContent('The house, without guesswork');
    expect(dialog).toHaveTextContent('Juniper’s ordinary week');
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Keep Draft' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Keep Draft' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(review).toHaveFocus());

    await user.click(review);
    await user.click(
      await screen.findByRole('button', { name: 'Run local rehearsal' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Arm rehearsal' }),
    ).toBeEnabled();
    expect(screen.getByText('Locally rehearsed')).toBeVisible();
    expect(screen.getByText('Synthetic Plan rehearsed')).toBeVisible();
  });

  it('records one rehearsal when completion is activated repeatedly', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Review rehearsal' }));
    const complete = await screen.findByRole('button', {
      name: 'Run local rehearsal',
    });
    fireEvent.click(complete);
    fireEvent.click(complete);
    const dialog = screen.getByRole('dialog', {
      name: 'Review what this local rehearsal will test',
    });
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);

    expect(complete).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep Draft' })).toBeDisabled();
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Arm rehearsal' }),
    ).toBeEnabled();
    expect(screen.getAllByText('Synthetic Plan rehearsed')).toHaveLength(1);
  });

  it('requires a new review after an Editable Document changes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Review rehearsal' }));
    await user.click(
      await screen.findByRole('button', { name: 'Run local rehearsal' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Arm rehearsal' }),
    ).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.type(screen.getByLabelText('Envelope Markdown content'), '!');
    await user.click(screen.getByRole('button', { name: 'Overview' }));

    expect(
      await screen.findByRole('button', { name: 'Review changes' }),
    ).toBeEnabled();
    expect(screen.getByText('Review required')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Arm rehearsal' }),
    ).not.toBeInTheDocument();
  });

  it('shows document blockers and keeps rehearsal completion disabled', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.clear(screen.getByLabelText('Document title'));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await user.click(
      await screen.findByRole('button', { name: 'Review rehearsal' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Review what this local rehearsal will test',
    });
    expect(dialog).toHaveTextContent('Editable Documents need attention');
    expect(dialog).toHaveTextContent(/title must be 1-200 visible characters/i);
    expect(
      screen.getByRole('button', { name: 'Run local rehearsal' }),
    ).toBeDisabled();
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
      await screen.findByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).toBeVisible();
    expect(screen.getByText('sample-note.md')).toBeVisible();
    expect(
      screen.getByText(/no malware scanner or sandboxed converter is active/i),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Inspection evidence · synthetic-fixture-inspection-no-malware-scan/i,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Conversion evidence · vidha-utf8-text-v1/i),
    ).toBeVisible();
    expect(screen.getByText(/^sha256:[a-f0-9]{64}$/u)).toBeVisible();
    expect(
      screen.getByText('Exact original bytes for download until refresh'),
    ).toBeVisible();
    expect(
      screen.getByText('Markdown formatting will remain editable source text.'),
    ).toBeVisible();
    await user.click(screen.getByText('Preview converted copy'));
    expect(screen.getByText('# A synthetic imported note')).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Create editable copy' }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Envelope Markdown content')).toHaveValue(
        '# A synthetic imported note',
      );
    });
    expect(screen.getByDisplayValue('sample note')).toBeVisible();
    expect(screen.getByText('sample-note.md')).toBeVisible();
    expect(screen.getByText(/Schema v1 · vidha-utf8-text-v1/i)).toBeVisible();
    expect(
      screen.getByText(
        /Synthetic inspection · synthetic-fixture-inspection-no-malware-scan/i,
      ),
    ).toBeVisible();
    expect(screen.getByText(/^sha256:[a-f0-9]{64}$/u)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Restore imported text' }),
    ).toBeEnabled();
  });

  it('discards a reviewed conversion without changing the existing draft', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const existingDraft = screen.getByLabelText('Envelope Markdown content');
    const existingMarkdown = (existingDraft as HTMLTextAreaElement).value;
    await user.upload(
      screen.getByLabelText('Import Markdown or plain text'),
      new File(['# Replacement'], 'replacement.md', {
        type: 'text/markdown',
      }),
    );
    await screen.findByRole('heading', {
      name: 'Review before replacing this draft',
    });
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(
      screen.queryByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).not.toBeInTheDocument();
    expect(existingDraft).toHaveValue(existingMarkdown);
  });

  it('binds delayed editable imports to the Envelope that initiated them', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const firstEnvelope = screen.getByRole('button', {
      name: /The house, without guesswork/,
    });
    const secondEnvelope = screen.getByRole('button', {
      name: /Juniper’s ordinary week/,
    });
    const read = deferred<ArrayBuffer>();
    const file = new File(['# Origin-bound note'], 'origin-bound.md', {
      type: 'text/markdown',
    });
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(read.promise);

    fireEvent.change(screen.getByLabelText('Import Markdown or plain text'), {
      target: { files: [file] },
    });
    await user.click(secondEnvelope);
    read.resolve(new TextEncoder().encode('# Origin-bound note').buffer);

    await waitFor(() => {
      expect(screen.getByText('Review ready')).toBeVisible();
    });
    expect(
      screen.queryByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Recipient')).toHaveValue('Sam Rivera');

    await user.click(firstEnvelope);
    expect(
      await screen.findByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Create editable copy' }),
    );
    expect(screen.getByLabelText('Recipient')).toHaveValue('Mira Chen');
    expect(screen.getByLabelText('Envelope Markdown content')).toHaveValue(
      '# Origin-bound note',
    );

    await user.click(secondEnvelope);
    expect(screen.getByLabelText('Recipient')).toHaveValue('Sam Rivera');
    expect(screen.getByLabelText('Document title')).toHaveValue(
      'Juniper’s ordinary week',
    );
  });

  it('binds delayed Attachment candidates to the initiating Envelope', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const firstEnvelope = screen.getByRole('button', {
      name: /The house, without guesswork/,
    });
    const secondEnvelope = screen.getByRole('button', {
      name: /Juniper’s ordinary week/,
    });
    const read = deferred<ArrayBuffer>();
    const file = new File(['%PDF origin'], 'origin-bound.pdf', {
      type: 'application/pdf',
    });
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(read.promise);

    fireEvent.change(screen.getByLabelText('Add Attachment candidates'), {
      target: { files: [file] },
    });
    await user.click(secondEnvelope);
    read.resolve(new TextEncoder().encode('%PDF origin').buffer);

    await waitFor(() => {
      expect(screen.getByText('Review ready')).toBeVisible();
    });
    expect(
      screen.queryByRole('heading', {
        name: 'Keep 1 file with this Envelope?',
      }),
    ).not.toBeInTheDocument();

    await user.click(firstEnvelope);
    expect(
      await screen.findByRole('heading', {
        name: 'Keep 1 file with this Envelope?',
      }),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Keep as Attachments' }),
    );
    expect(screen.getByText('origin-bound.pdf')).toBeVisible();

    await user.click(secondEnvelope);
    expect(screen.queryByText('origin-bound.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('0/8')).toBeVisible();
  });

  it('keeps both pending file-review types with their Envelope until explicit discard', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const firstEnvelope = screen.getByRole('button', {
      name: /The house, without guesswork/,
    });
    const secondEnvelope = screen.getByRole('button', {
      name: /Juniper’s ordinary week/,
    });
    const importTrigger = screen.getByRole('button', {
      name: 'Import editable text',
    });
    await user.upload(
      screen.getByLabelText('Import Markdown or plain text'),
      new File(['# Keep review'], 'keep-review.md', { type: 'text/markdown' }),
    );
    await screen.findByRole('heading', {
      name: 'Review before replacing this draft',
    });

    await user.click(secondEnvelope);
    expect(
      screen.queryByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).not.toBeInTheDocument();
    await user.click(firstEnvelope);
    expect(
      screen.getByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(importTrigger).toHaveFocus());

    const attachmentTrigger = screen.getByRole('button', { name: 'Add files' });
    await user.upload(
      screen.getByLabelText('Add Attachment candidates'),
      new File(['%PDF keep review'], 'keep-review.pdf', {
        type: 'application/pdf',
      }),
    );
    await screen.findByRole('heading', {
      name: 'Keep 1 file with this Envelope?',
    });
    await user.click(secondEnvelope);
    await user.click(firstEnvelope);
    expect(
      screen.getByRole('heading', {
        name: 'Keep 1 file with this Envelope?',
      }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(attachmentTrigger).toHaveFocus());
  });

  it('announces a ready import without stealing focus after the Owner moves', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const read = deferred<ArrayBuffer>();
    const file = new File(['# Delayed review'], 'delayed-review.md', {
      type: 'text/markdown',
    });
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(read.promise);
    fireEvent.change(screen.getByLabelText('Import Markdown or plain text'), {
      target: { files: [file] },
    });
    const download = screen.getByRole('button', { name: 'Download copy' });
    download.focus();
    read.resolve(new TextEncoder().encode('# Delayed review').buffer);

    expect(
      await screen.findByRole('heading', {
        name: 'Review before replacing this draft',
      }),
    ).toBeVisible();
    expect(download).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Editable copy review ready',
    );
  });

  it('moves focus to a ready import review when focus stays at its trigger', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const trigger = screen.getByRole('button', {
      name: 'Import editable text',
    });
    trigger.focus();
    const read = deferred<ArrayBuffer>();
    const file = new File(['# Focused review'], 'focused-review.md', {
      type: 'text/markdown',
    });
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(read.promise);
    fireEvent.change(screen.getByLabelText('Import Markdown or plain text'), {
      target: { files: [file] },
    });
    read.resolve(new TextEncoder().encode('# Focused review').buffer);

    const heading = await screen.findByRole('heading', {
      name: 'Review before replacing this draft',
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent(
      'Editable copy review ready',
    );
  });

  it('does not report a draft update without an Owner mutation', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Envelopes' }));
      act(() => vi.advanceTimersByTime(1_000));

      expect(
        screen.queryByText('Session draft updated'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Synthetic session draft')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
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
      await screen.findByRole('heading', {
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

  it('opens the selected Envelope directly from the overview', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole('button', { name: 'Review Juniper’s ordinary week' }),
    );

    expect(screen.getByLabelText('Document title')).toHaveValue(
      'Juniper’s ordinary week',
    );
    expect(screen.getByRole('button', { name: 'Envelopes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
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

  it('contains explicit Owner confirmations and records a repeated activation once', async () => {
    const user = userEvent.setup();
    render(<App />);
    await armDemo(user);

    const checkIn = screen.getByRole('button', { name: 'Rehearse Check-in' });
    await user.click(checkIn);
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm this rehearsal Check-in?',
    });
    const cancel = screen.getByRole('button', { name: 'Go back' });
    const confirm = screen.getByRole('button', { name: 'Confirm Check-in' });
    expect(dialog).toBeVisible();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    const cancelEvent = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(checkIn).toHaveFocus());

    await user.click(checkIn);
    const repeatedConfirm = screen.getByRole('button', {
      name: 'Confirm Check-in',
    });
    fireEvent.click(repeatedConfirm);
    fireEvent.click(repeatedConfirm);

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', {
          name: 'Confirm this rehearsal Check-in?',
        }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getAllByText('Authenticated Check-in recorded')).toHaveLength(
      1,
    );
  });

  it('starts a separate disposable Draft after terminal disable', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.clear(screen.getByLabelText('Document title'));
    await user.type(screen.getByLabelText('Document title'), 'Changed session');
    await user.upload(screen.getByLabelText('Add Attachment candidates'), [
      new File(['%PDF-synthetic'], 'cleared-on-restart.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await user.click(
      await screen.findByRole('button', { name: 'Keep as Attachments' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await armDemo(user);

    await user.click(screen.getByRole('button', { name: 'Disable rehearsal' }));
    const disableDialog = screen.getByRole('dialog', {
      name: 'Disable this rehearsal Plan?',
    });
    expect(disableDialog).toHaveTextContent('this Plan will not resume');
    expect(
      screen.getByRole('button', { name: 'Keep rehearsal' }),
    ).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Confirm disable' }));

    expect(await screen.findByText('Lifecycle: disabled')).toBeVisible();
    const restart = screen.getByRole('button', {
      name: 'Start fresh local rehearsal',
    });
    await user.click(restart);
    const restartDialog = screen.getByRole('dialog', {
      name: 'Start a fresh local rehearsal?',
    });
    expect(restartDialog).toHaveTextContent(
      'The Disabled Plan remains terminal.',
    );
    expect(
      screen.getByRole('button', { name: 'Keep ended rehearsal' }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole('button', { name: 'Start fresh rehearsal' }),
    );

    expect(await screen.findByText('Lifecycle: draft')).toBeVisible();
    expect(screen.getByText('Synthetic Plan drafted')).toBeVisible();
    expect(
      screen.queryByText('Rehearsal plan disabled'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    expect(screen.getByLabelText('Document title')).toHaveValue(
      'The house, without guesswork',
    );
    expect(
      screen.queryByText('cleared-on-restart.pdf'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Review Version/u }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('0/8')).toBeVisible();
  });

  it('holds a fresh-session reset when another tab contains changed work', async () => {
    rehearsalPeers.peerCount = 1;
    rehearsalPeers.peerHasSessionWork = true;
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole('complementary', {
        name: 'Multi-tab rehearsal status',
      }),
    ).toHaveTextContent('Another tab contains changed rehearsal work.');

    await armDemo(user);
    await user.click(screen.getByRole('button', { name: 'Disable rehearsal' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disable' }));

    expect(
      await screen.findByRole('button', {
        name: 'Start fresh local rehearsal',
      }),
    ).toBeDisabled();
    expect(
      screen.getByText(/close it before starting fresh here/i),
    ).toBeVisible();
  });

  it('reviews a document-only version restore and preserves the current draft', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const originalTitle = (
      screen.getByLabelText('Document title') as HTMLInputElement
    ).value;
    const originalMarkdown = (
      screen.getByLabelText('Envelope Markdown content') as HTMLTextAreaElement
    ).value;
    await user.upload(screen.getByLabelText('Add Attachment candidates'), [
      new File(['%PDF-synthetic'], 'restore-boundary.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await user.click(
      await screen.findByRole('button', { name: 'Keep as Attachments' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await user.selectOptions(screen.getByLabelText('Recipient'), 'Sam Rivera');
    await user.clear(screen.getByLabelText('Document title'));
    await user.type(screen.getByLabelText('Document title'), 'Current draft');
    await user.clear(screen.getByLabelText('Envelope Markdown content'));
    await user.type(
      screen.getByLabelText('Envelope Markdown content'),
      '# Current draft',
    );
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.type(screen.getByLabelText('Envelope Markdown content'), '!');

    const versions = screen.getAllByRole('button', {
      name: /Review Version/,
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]).not.toHaveAttribute(
      'data-version-id',
      versions[1]?.getAttribute('data-version-id'),
    );
    await user.click(
      screen.getByRole('button', {
        name: `Review Version 1: ${originalTitle}`,
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Restore Version 1?' });
    expect(dialog).toHaveTextContent(
      `Current title: Current draft→Restored title: ${originalTitle}`,
    );
    expect(dialog).toHaveTextContent(
      'Current Recipient: Sam Rivera→Restored Recipient: Mira Chen',
    );
    expect(dialog).toHaveTextContent('Version 1 content preview');
    expect(dialog).toHaveTextContent('# The house, without guesswork');
    expect(dialog).toHaveTextContent(
      'Your current draft remains available as Version 3.',
    );
    expect(dialog).toHaveTextContent(
      'Attachments and imported-source provenance stay unchanged.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Keep current draft' }),
    );
    expect(screen.getByLabelText('Document title')).toHaveValue(
      'Current draft',
    );

    await user.click(
      screen.getByRole('button', {
        name: `Review Version 1: ${originalTitle}`,
      }),
    );
    fireEvent.change(screen.getByLabelText('Document title'), {
      target: { value: 'Changed after review' },
    });
    await user.click(screen.getByRole('button', { name: 'Restore document' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The draft or Session versions changed. Review the restore again before applying it.',
    );
    expect(screen.getByLabelText('Document title')).toHaveValue(
      'Changed after review',
    );

    await user.click(
      screen.getByRole('button', {
        name: `Review Version 1: ${originalTitle}`,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Restore document' }));

    expect(screen.getByLabelText('Recipient')).toHaveValue('Mira Chen');
    expect(screen.getByLabelText('Document title')).toHaveValue(originalTitle);
    expect(screen.getByLabelText('Envelope Markdown content')).toHaveValue(
      originalMarkdown,
    );
    expect(screen.getByText('restore-boundary.pdf')).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: /Review Version/ }),
    ).toHaveLength(3);
    expect(
      screen.getByText('Version 1 restored; the previous draft remains saved'),
    ).toBeVisible();
  });

  it('keeps imported-source metadata unchanged across a Document Version restore', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const source = '# Provenance source\n\nSynthetic source text.';
    await user.upload(
      screen.getByLabelText('Import Markdown or plain text'),
      new File([source], 'provenance-source.md', {
        type: 'text/markdown',
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Create editable copy' }),
    );
    const digest = screen.getByText(/^sha256:[a-f0-9]{64}$/u).textContent;
    const scanner =
      'Synthetic inspection · synthetic-fixture-inspection-no-malware-scan';
    const converter = 'Schema v1 · vidha-utf8-text-v1';
    const warning = 'Markdown formatting will remain editable source text.';
    expect(screen.getByText(scanner)).toBeVisible();
    expect(screen.getByText(converter)).toBeVisible();
    expect(screen.getByText(warning)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await user.clear(screen.getByLabelText('Document title'));
    await user.type(screen.getByLabelText('Document title'), 'Changed draft');
    await user.selectOptions(screen.getByLabelText('Recipient'), 'Sam Rivera');
    await user.clear(screen.getByLabelText('Envelope Markdown content'));
    await user.type(
      screen.getByLabelText('Envelope Markdown content'),
      '# Changed draft',
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Review Version 1: provenance source',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Restore document' }));

    expect(screen.getByText('provenance-source.md')).toBeVisible();
    expect(screen.getByText(digest ?? '')).toBeVisible();
    expect(screen.getByText(scanner)).toBeVisible();
    expect(screen.getByText(converter)).toBeVisible();
    expect(screen.getByText(warning)).toBeVisible();
    expect(screen.getByLabelText('Envelope Markdown content')).toHaveValue(
      source,
    );
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
      await screen.findByRole('button', { name: 'Create editable copy' }),
    );
    const editor = screen.getByLabelText('Envelope Markdown content');
    const title = screen.getByLabelText('Document title');
    await user.clear(editor);
    await user.type(editor, 'Changed in the session');
    await user.clear(title);
    await user.type(title, 'Keep this revised title');
    await user.click(
      screen.getByRole('button', { name: 'Restore imported text' }),
    );

    expect(editor).toHaveValue(source);
    expect(title).toHaveValue('Keep this revised title');
  });

  it('offers one clear portable-copy control for Markdown, text, and HTML', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    const format = screen.getByRole('combobox', {
      name: 'Portable copy format',
    });
    expect(format).toHaveValue('markdown');
    expect(screen.getByRole('button', { name: 'Download copy' })).toBeEnabled();
    await user.selectOptions(format, 'html');
    expect(format).toHaveValue('html');
    await user.selectOptions(format, 'text');
    expect(format).toHaveValue('text');
  });

  it('validates the mutable draft before creating a portable copy', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.clear(screen.getByLabelText('Document title'));
    await user.click(screen.getByRole('button', { name: 'Download copy' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      /title must be 1-200 visible characters/i,
    );
  });
});
