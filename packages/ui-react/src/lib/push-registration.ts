import type { BrainApi } from "./api-client.js";

/**
 * This runtime's IANA zone, as the client environment already reads it.
 * The server validates it again; Action notice timing (quiet hours and the
 * 09:00/17:00 digest) follows it, while server clocks keep every timestamp.
 */
export function currentTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length <= 64 ? zone : undefined;
  } catch {
    return undefined;
  }
}

const CLIENT_ID_KEY = "brain-ui:notice-client";

/**
 * This browser's persisted notice-context identifier. One principal can serve
 * several browsers (ambient and proxy modes share one), so the server keeps
 * zone, digest coverage and dismissal per identifier. It is a preference key,
 * never a credential. Without storage the context is principal-wide ("").
 */
export function noticeClientId(): string {
  try {
    const storage = typeof localStorage === "undefined" ? null : localStorage;
    if (!storage) return "";
    const saved = storage.getItem(CLIENT_ID_KEY);
    if (saved && /^[A-Za-z0-9_-]{1,64}$/.test(saved)) return saved;
    const created = crypto.randomUUID();
    storage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    // Safari throws on storage access with cookies disabled.
    return "";
  }
}

const zoneListeners = new WeakMap<BrainApi, Set<() => void>>();

/** @internal A root's guarded client reports the same zone as its injected transport. */
export function shareNotificationZoneReports(guarded: BrainApi, source: BrainApi): void {
  let listeners = zoneListeners.get(source);
  if (!listeners) zoneListeners.set(source, (listeners = new Set()));
  zoneListeners.set(guarded, listeners);
}

/** Run `listener` after each successful zone report through this API client. */
export function onNotificationZoneReported(api: BrainApi, listener: () => void): () => void {
  let listeners = zoneListeners.get(api);
  if (!listeners) zoneListeners.set(api, (listeners = new Set()));
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Re-assert an existing browser subscription after authentication changes.
 * This does not request permission or create a subscription: it only binds an
 * already-enabled endpoint to the newly issued server principal.
 */
export async function rebindPushSubscriptionAfterLogin(api: BrainApi, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const subscription = await existingSubscription(signal);
  if (!subscription) return;
  const label =
    typeof navigator.userAgent === "string"
      ? navigator.userAgent.slice(0, 100)
      : undefined;
  if (subscription.options.applicationServerKey) {
    const { publicKey } = await api.pushPublicKey();
    signal?.throwIfAborted();
    if (!subscriptionMatchesKey(subscription, publicKey)) return;
  }
  await api.pushSubscribe(subscription.toJSON(), label, currentTimeZone() ?? "");
}

/**
 * Report this client's zone for its own client context and, when the browser
 * holds a push subscription, for that destination. An unavailable zone is
 * reported as unusable rather than omitted, so the server keeps timed notices
 * visibly pending instead of trusting a zone this client no longer reports.
 * Returns the zone that was reported.
 */
export async function reportNotificationZone(api: BrainApi, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const zone = currentTimeZone() ?? "";
  let endpoint: string | undefined;
  try {
    // Never wait on `serviceWorker.ready`: it does not settle in a shell
    // without an active worker, and the client context needs its zone anyway.
    endpoint = (await existingSubscription(signal, false))?.endpoint;
  } catch (error) {
    if (signal?.aborted) throw error;
    // No service worker answer: still refresh the client context.
  }
  signal?.throwIfAborted();
  await api.pushZone(zone, endpoint, noticeClientId());
  for (const listener of zoneListeners.get(api) ?? []) listener();
  return zone;
}

/**
 * Decides when to refresh the reported zone: always after a lifecycle event
 * (first authenticated probe, reconnection, foreground return), otherwise only
 * when the runtime's zone changed since the last successful report. One report
 * is in flight at a time; a failure leaves the refresh owed.
 */
export function createZoneRefresher(
  report: (signal?: AbortSignal) => Promise<string>,
  readZone: () => string | undefined = currentTimeZone
) {
  let reported: string | undefined;
  let owed = true;
  let inFlight = false;
  return {
    /** A lifecycle event: the next opportunity reports regardless of change. */
    markLifecycle(): void {
      owed = true;
    },
    /** Called on every successful authenticated probe. */
    async refresh(signal?: AbortSignal): Promise<boolean> {
      if (inFlight) return false;
      if (!owed && (readZone() ?? "") === reported) return false;
      inFlight = true;
      try {
        reported = await report(signal);
        owed = false;
        return true;
      } catch {
        owed = true;
        return false;
      } finally {
        inFlight = false;
      }
    },
  };
}

async function existingSubscription(signal?: AbortSignal, waitForWorker = true): Promise<PushSubscription | null> {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return null;
  }
  // Capture before awaiting: the page may begin navigating immediately after
  // login while the service-worker readiness promise settles.
  const serviceWorker = navigator.serviceWorker;
  const registration = waitForWorker ? await serviceWorker.ready : await serviceWorker.getRegistration();
  signal?.throwIfAborted();
  if (!registration) return null;
  const subscription = await registration.pushManager.getSubscription();
  signal?.throwIfAborted();
  return subscription;
}

/** A service-worker subscription may belong to another server's VAPID key. */
export function subscriptionMatchesKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (!key) return true;
  let bin = "";
  for (const b of new Uint8Array(key)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === publicKey;
}
