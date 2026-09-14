import { api } from "./api-client.js";

/**
 * Re-assert an existing browser subscription after authentication changes.
 * This does not request permission or create a subscription: it only binds an
 * already-enabled endpoint to the newly issued server principal.
 */
export async function rebindPushSubscriptionAfterLogin(): Promise<void> {
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
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api.pushSubscribe(subscription.toJSON(), label);
}
