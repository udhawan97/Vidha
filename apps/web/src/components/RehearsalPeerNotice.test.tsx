import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RehearsalPeerNotice } from './RehearsalPeerNotice';

describe('RehearsalPeerNotice', () => {
  it('stays absent when the current tab is the only rehearsal', () => {
    render(
      <RehearsalPeerNotice
        detectionAvailable
        peerActionPending={false}
        peerCount={0}
        peerHasSessionWork={false}
      />,
    );

    expect(
      screen.queryByRole('complementary', {
        name: 'Multi-tab rehearsal status',
      }),
    ).not.toBeInTheDocument();
  });

  it('names the unsynchronized work boundary without sharing content', () => {
    render(
      <RehearsalPeerNotice
        detectionAvailable
        peerActionPending={false}
        peerCount={1}
        peerHasSessionWork
      />,
    );

    const notice = screen.getByRole('complementary', {
      name: 'Multi-tab rehearsal status',
    });
    expect(notice).toHaveTextContent(
      'Another tab contains changed rehearsal work.',
    );
    expect(notice).toHaveTextContent('Tabs do not synchronize.');
    expect(notice).toHaveTextContent(
      'Only tab presence and content-free work/action flags are shared.',
    );
  });

  it('fails visibly when the browser cannot detect peer tabs', () => {
    render(
      <RehearsalPeerNotice
        detectionAvailable={false}
        peerActionPending={false}
        peerCount={0}
        peerHasSessionWork={false}
      />,
    );

    expect(
      screen.getByRole('complementary', {
        name: 'Multi-tab rehearsal status',
      }),
    ).toHaveTextContent('This browser cannot detect other rehearsal tabs.');
  });
});
