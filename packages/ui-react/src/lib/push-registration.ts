import type { BrainApi } from "./api-client.js";

/**
 * Re-assert an existing browser subscription after authentication changes.
 * This does not request permission or create a subscription: it only binds an
 * already-enabled endpoint to the newly issued server principal.
 */
export async function rebindPushSubscriptionAfterLogin(api: BrainApi, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }

  // Capture before awaiting: the page may begin navigating immediately after
  // login while the service-worker readiness promise settles.
  const serviceWorker = navigator.serviceWorker;
  const label =
    typeof navigator.userAgent === "string"
      ? navigator.userAgent.slice(0, 100)
      : undefined;
  const registration = await serviceWorker.ready;
  signal?.throwIfAborted();
  const subscription = await registration.pushManager.getSubscription();
  signal?.throwIfAborted();
  if (!subscription) return;
  if (subscription.options.applicationServerKey) {
    const { publicKey } = await api.pushPublicKey();
    signal?.throwIfAborted();
    if (!subscriptionMatchesKey(subscription, publicKey)) return;
  }
  await api.pushSubscribe(subscription.toJSON(), label);
}

/** A service-worker subscription may belong to another server's VAPID key. */
export function subscriptionMatchesKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (!key) return true;
  let bin = "";
  for (const b of new Uint8Array(key)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === publicKey;
}
