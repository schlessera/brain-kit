/**
 * The service-worker half of the Web Share Target API, as a deployment shell
 * registers it: `registerShareTarget()` on the worker scope, and
 * `readShareLaunchParams()` in the app it redirects to. The request handler
 * itself lives in `./share-target-handler.ts` and is first-party only
 * (`./internal/client`, #1053); its reasoning is documented there.
 */
import {
  DEFAULT_SHARE_TARGET_PATH,
  SHARE_ERROR_PARAM,
  SHARE_QUERY_PARAM,
  handleShareTargetRequest,
  isShareTargetRequest,
  type ShareTargetOptions,
  type ShareTargetScope,
} from "./share-target-handler.js";

export {
  DEFAULT_SHARE_TARGET_PATH,
  SHARE_ERROR_PARAM,
  SHARE_QUERY_PARAM,
  type ShareFetchEvent,
  type ShareTargetOptions,
  type ShareTargetScope,
} from "./share-target-handler.js";

/**
 * Register the share target on a service-worker scope.
 *
 * Workbox never competes for this request: `registerRoute()` defaults to `GET`
 * and its router looks routes up by method, so a POST finds none and falls
 * through without calling `respondWith`. Ordering is NOT what protects us —
 * every fetch listener runs regardless of registration order, and a second
 * `respondWith` on one event throws `InvalidStateError` while the first
 * response still stands. The invariant to keep is simply that nothing else
 * registers a POST route, or a POST default handler, on this path.
 */
export function registerShareTarget(
  options: ShareTargetOptions = {},
  scope: ShareTargetScope = globalThis as unknown as ShareTargetScope
): void {
  const path = options.path ?? DEFAULT_SHARE_TARGET_PATH;
  scope.addEventListener("fetch", (event) => {
    if (!isShareTargetRequest(event.request, path)) return;
    // respondWith must be called synchronously, in the same turn as the event:
    // await anything first and the browser has already gone to the network
    // with a body it cannot replay.
    event.respondWith(handleShareTargetRequest(event.request, options));
  });
}

/** Read `?share=` / `?share_error=` off a URL the app booted on. */
export function readShareLaunchParams(url: string): {
  shareId?: string;
  error?: string;
} {
  try {
    const params = new URL(url).searchParams;
    const shareId = params.get(SHARE_QUERY_PARAM);
    const error = params.get(SHARE_ERROR_PARAM);
    return {
      ...(shareId ? { shareId } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return {};
  }
}

// The store is deliberately NOT re-exported as a pluggable thing: persistence
// for a stashed share is IndexedDB, full stop. What the app needs is the store
// itself (to claim and drop a share); the swap and in-memory implementations
// stay unexported and are imported straight from the module by tests. The
// TTL prune is first-party (`./internal/client`, #1053): the worker and the
// app's intake run it themselves.
export {
  getShareStore,
  type ShareStore,
  type StoredShare,
} from "./share-store.js";
