/// <reference lib="webworker" />

import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

import { currentBuildIdentity } from './buildIdentity';
import {
  createServiceWorkerIdentityResponse,
  isServiceWorkerIdentityRequest,
} from './serviceWorkerIdentity';

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: Array<{
    readonly revision?: string | null;
    readonly url: string;
  }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    !Array.isArray(event.data) &&
    Object.keys(event.data as Record<string, unknown>).join(',') === 'type' &&
    (event.data as Record<string, unknown>).type === 'SKIP_WAITING'
  ) {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (!isServiceWorkerIdentityRequest(event.data)) return;
  const replyPort = event.ports[0];
  const response = createServiceWorkerIdentityResponse(currentBuildIdentity);
  if (replyPort === undefined || response === null) return;
  replyPort.postMessage(response);
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
