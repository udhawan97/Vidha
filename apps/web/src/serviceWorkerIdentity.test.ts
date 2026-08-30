import { describe, expect, it, vi } from 'vitest';

import {
  createServiceWorkerIdentityResponse,
  isServiceWorkerIdentityRequest,
  readServiceWorkerIdentityResponse,
  requestServiceWorkerIdentity,
  serviceWorkerIdentityRequest,
  type ServiceWorkerIdentityTarget,
} from './serviceWorkerIdentity';

function channelHarness(): {
  readonly channel: MessageChannel;
  readonly reply: (value: unknown) => void;
} {
  let onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  const port1 = {
    close: vi.fn(),
    set onmessage(handler: ((event: MessageEvent<unknown>) => void) | null) {
      onmessage = handler;
    },
    start: vi.fn(),
  };
  const port2 = {};
  return {
    channel: { port1, port2 } as unknown as MessageChannel,
    reply: (value) => onmessage?.({ data: value } as MessageEvent<unknown>),
  };
}

describe('service worker identity protocol', () => {
  it('accepts only the exact content-free request', () => {
    expect(isServiceWorkerIdentityRequest(serviceWorkerIdentityRequest)).toBe(
      true,
    );
    expect(
      isServiceWorkerIdentityRequest({
        ...serviceWorkerIdentityRequest,
        envelopeId: 'must-not-cross-the-channel',
      }),
    ).toBe(false);
    expect(
      isServiceWorkerIdentityRequest({
        protocol: 'vidha.service-worker-identity.v2',
        type: 'identify-service-worker',
      }),
    ).toBe(false);
  });

  it('creates and parses only a strict validated identity response', () => {
    const response = createServiceWorkerIdentityResponse('build-target-456');

    expect(response).toEqual({
      buildIdentity: 'build-target-456',
      protocol: 'vidha.service-worker-identity.v1',
      type: 'service-worker-identity',
    });
    expect(readServiceWorkerIdentityResponse(response)).toBe(
      'build-target-456',
    );
    expect(createServiceWorkerIdentityResponse('<invalid>')).toBeNull();
    expect(
      readServiceWorkerIdentityResponse({
        ...response,
        filename: 'must-not-cross-the-channel',
      }),
    ).toBeNull();
  });

  it('queries one worker over a dedicated message channel', async () => {
    const harness = channelHarness();
    const target: ServiceWorkerIdentityTarget = {
      postMessage: vi.fn((message, transfer) => {
        expect(message).toEqual(serviceWorkerIdentityRequest);
        expect(transfer).toEqual([harness.channel.port2]);
        harness.reply(createServiceWorkerIdentityResponse('build-target-456'));
      }),
    };

    await expect(
      requestServiceWorkerIdentity(target, {
        createChannel: () => harness.channel,
        timeoutMs: 50,
      }),
    ).resolves.toBe('build-target-456');
    expect(harness.channel.port1.close).toHaveBeenCalledOnce();
  });

  it('fails closed on an invalid or missing worker response', async () => {
    vi.useFakeTimers();
    const invalidHarness = channelHarness();
    const invalidTarget: ServiceWorkerIdentityTarget = {
      postMessage: () => invalidHarness.reply({ buildIdentity: 'target' }),
    };
    const invalid = requestServiceWorkerIdentity(invalidTarget, {
      createChannel: () => invalidHarness.channel,
      timeoutMs: 50,
    });
    await expect(invalid).rejects.toThrow('invalid identity');

    const timeoutHarness = channelHarness();
    const silentTarget: ServiceWorkerIdentityTarget = {
      postMessage: vi.fn(),
    };
    const timedOut = requestServiceWorkerIdentity(silentTarget, {
      createChannel: () => timeoutHarness.channel,
      timeoutMs: 50,
    });
    const timedOutExpectation =
      expect(timedOut).rejects.toThrow('invalid identity');
    await vi.advanceTimersByTimeAsync(50);
    await timedOutExpectation;
    vi.useRealTimers();
  });
});
