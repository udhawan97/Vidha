import { useEffect, useRef, useState } from 'react';

const CHANNEL_NAME = 'vidha-synthetic-rehearsal-tabs-v1';
const PROTOCOL = 'vidha.synthetic-rehearsal-tab.v1';
const HEARTBEAT_MS = 5_000;
const PEER_EXPIRY_MS = 15_000;

type PeerMessageType = 'hello' | 'leave' | 'state';

interface PeerMessage {
  readonly actionPending: boolean;
  readonly hasSessionWork: boolean;
  readonly protocol: typeof PROTOCOL;
  readonly senderId: string;
  readonly type: PeerMessageType;
}

interface PeerRecord {
  readonly actionPending: boolean;
  readonly hasSessionWork: boolean;
  readonly lastSeenAt: number;
}

interface RehearsalPeerInput {
  readonly actionPending: boolean;
  readonly hasSessionWork: boolean;
}

export interface RehearsalPeerSummary {
  readonly detectionAvailable: boolean;
  readonly peerActionPending: boolean;
  readonly peerCount: number;
  readonly peerHasSessionWork: boolean;
}

let fallbackTabSequence = 0;

function createTabId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackTabSequence += 1;
  return `synthetic-tab-${Date.now()}-${fallbackTabSequence}`;
}

function isPeerMessage(value: unknown): value is PeerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PeerMessage>;
  return (
    candidate.protocol === PROTOCOL &&
    (candidate.type === 'hello' ||
      candidate.type === 'leave' ||
      candidate.type === 'state') &&
    typeof candidate.senderId === 'string' &&
    candidate.senderId.length > 0 &&
    typeof candidate.hasSessionWork === 'boolean' &&
    typeof candidate.actionPending === 'boolean'
  );
}

function summarizePeers(
  peers: ReadonlyMap<string, PeerRecord>,
): Omit<RehearsalPeerSummary, 'detectionAvailable'> {
  let peerActionPending = false;
  let peerHasSessionWork = false;
  for (const peer of peers.values()) {
    peerActionPending ||= peer.actionPending;
    peerHasSessionWork ||= peer.hasSessionWork;
  }
  return {
    peerActionPending,
    peerCount: peers.size,
    peerHasSessionWork,
  };
}

export function useRehearsalPeers({
  actionPending,
  hasSessionWork,
}: RehearsalPeerInput): RehearsalPeerSummary {
  const tabIdRef = useRef(createTabId());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const leavingRef = useRef(false);
  const currentStateRef = useRef({ actionPending, hasSessionWork });
  const peersRef = useRef(new Map<string, PeerRecord>());
  const [summary, setSummary] = useState<RehearsalPeerSummary>({
    detectionAvailable: typeof window.BroadcastChannel === 'function',
    peerActionPending: false,
    peerCount: 0,
    peerHasSessionWork: false,
  });

  function publishSummary(detectionAvailable = true) {
    setSummary({
      detectionAvailable,
      ...summarizePeers(peersRef.current),
    });
  }

  function post(type: PeerMessageType) {
    const channel = channelRef.current;
    if (channel === null || (leavingRef.current && type !== 'leave')) return;
    const message: PeerMessage = {
      ...currentStateRef.current,
      protocol: PROTOCOL,
      senderId: tabIdRef.current,
      type,
    };
    try {
      channel.postMessage(message);
    } catch {
      // A pagehide or effect cleanup may close the channel first. The next
      // heartbeat or peer expiry still restores a conservative summary.
    }
  }

  useEffect(() => {
    if (typeof window.BroadcastChannel !== 'function') return;
    const peers = peersRef.current;

    let channel: BroadcastChannel;
    try {
      channel = new window.BroadcastChannel(CHANNEL_NAME);
    } catch {
      publishSummary(false);
      return;
    }
    channelRef.current = channel;
    publishSummary();

    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isPeerMessage(event.data)) return;
      const message = event.data;
      if (message.senderId === tabIdRef.current) return;
      if (message.type === 'leave') {
        peersRef.current.delete(message.senderId);
        publishSummary();
        return;
      }
      peersRef.current.set(message.senderId, {
        actionPending: message.actionPending,
        hasSessionWork: message.hasSessionWork,
        lastSeenAt: Date.now(),
      });
      publishSummary();
      if (message.type === 'hello') post('state');
    };

    function announceCurrentState() {
      post('state');
    }

    function leave() {
      leavingRef.current = true;
      post('leave');
    }

    function rejoin() {
      leavingRef.current = false;
      post('hello');
    }

    const heartbeat = window.setInterval(() => {
      const expiresBefore = Date.now() - PEER_EXPIRY_MS;
      let changed = false;
      for (const [peerId, peer] of peersRef.current) {
        if (peer.lastSeenAt < expiresBefore) {
          peersRef.current.delete(peerId);
          changed = true;
        }
      }
      if (changed) publishSummary();
      announceCurrentState();
    }, HEARTBEAT_MS);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', rejoin);
    document.addEventListener('visibilitychange', announceCurrentState);
    post('hello');

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', rejoin);
      document.removeEventListener('visibilitychange', announceCurrentState);
      leave();
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
      peers.clear();
    };
  }, []);

  useEffect(() => {
    currentStateRef.current = { actionPending, hasSessionWork };
    post('state');
  }, [actionPending, hasSessionWork]);

  return summary;
}
