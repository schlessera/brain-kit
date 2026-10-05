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
    endpoint = (await existingSubscription(signal))?.endpoint;
  } catch (error) {
    if (signal?.aborted) throw error;
    // No service worker answer: still refresh the client context.
  }
  signal?.throwIfAborted();
  await api.pushZone(zone, endpoint);
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

async function existingSubscription(signal?: AbortSignal): Promise<PushSubscription | null> {
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
  const registration = await serviceWorker.ready;
  signal?.throwIfAborted();
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
