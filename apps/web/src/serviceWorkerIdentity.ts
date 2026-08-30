import { isBuildIdentity } from './buildIdentity';

export const SERVICE_WORKER_IDENTITY_PROTOCOL =
  'vidha.service-worker-identity.v1';
export const SERVICE_WORKER_IDENTITY_TIMEOUT_MS = 1_500;

const REQUEST_TYPE = 'identify-service-worker';
const RESPONSE_TYPE = 'service-worker-identity';

interface ServiceWorkerIdentityRequest {
  readonly protocol: typeof SERVICE_WORKER_IDENTITY_PROTOCOL;
  readonly type: typeof REQUEST_TYPE;
}

interface ServiceWorkerIdentityResponse {
  readonly buildIdentity: string;
  readonly protocol: typeof SERVICE_WORKER_IDENTITY_PROTOCOL;
  readonly type: typeof RESPONSE_TYPE;
}

export interface ServiceWorkerIdentityTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

interface QueryOptions {
  readonly createChannel?: () => MessageChannel;
  readonly timeoutMs?: number;
}

export const serviceWorkerIdentityRequest: ServiceWorkerIdentityRequest = {
  protocol: SERVICE_WORKER_IDENTITY_PROTOCOL,
  type: REQUEST_TYPE,
};

export function isServiceWorkerIdentityRequest(
  value: unknown,
): value is ServiceWorkerIdentityRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).sort().join(',') === 'protocol,type' &&
    request.protocol === SERVICE_WORKER_IDENTITY_PROTOCOL &&
    request.type === REQUEST_TYPE
  );
}

export function createServiceWorkerIdentityResponse(
  buildIdentity: string,
): ServiceWorkerIdentityResponse | null {
  if (!isBuildIdentity(buildIdentity)) return null;
  return {
    buildIdentity,
    protocol: SERVICE_WORKER_IDENTITY_PROTOCOL,
    type: RESPONSE_TYPE,
  };
}

export function readServiceWorkerIdentityResponse(
  value: unknown,
): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).sort().join(',') !== 'buildIdentity,protocol,type' ||
    response.protocol !== SERVICE_WORKER_IDENTITY_PROTOCOL ||
    response.type !== RESPONSE_TYPE ||
    !isBuildIdentity(response.buildIdentity)
  ) {
    return null;
  }
  return response.buildIdentity;
}

export function requestServiceWorkerIdentity(
  target: ServiceWorkerIdentityTarget,
  options: QueryOptions = {},
): Promise<string> {
  const createChannel =
    options.createChannel ?? (() => new globalThis.MessageChannel());
  const timeoutMs = options.timeoutMs ?? SERVICE_WORKER_IDENTITY_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let channel: MessageChannel;
    try {
      channel = createChannel();
    } catch {
      reject(
        new Error('The browser could not open a worker identity channel.'),
      );
      return;
    }

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      if (result === null) {
        reject(new Error('The service worker returned an invalid identity.'));
      } else {
        resolve(result);
      }
    };
    const timeout = globalThis.setTimeout(
      () => finish(null),
      Math.max(0, timeoutMs),
    );

    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      finish(readServiceWorkerIdentityResponse(event.data));
    };
    channel.port1.start();

    try {
      target.postMessage(serviceWorkerIdentityRequest, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

export function browserServiceWorkerController(): ServiceWorker | null {
  try {
    return navigator.serviceWorker?.controller ?? null;
  } catch {
    return null;
  }
}
