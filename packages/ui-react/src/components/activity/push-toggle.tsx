import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { api } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";

/**
 * The push enable/disable control, living on the Activity surface (where the
 * alerts it governs land). The permission model is THREE-state, not a bare
 * toggle: once the browser prompt is denied, Chrome silently ignores every
 * further in-page request — so the blocked state must say where the real
 * switch lives (site settings) instead of offering a button that does
 * nothing. Where the platform has no push at all (iOS Safari in-browser,
 * pre-16.4), the control renders disabled-with-explanation, not hidden.
 */
/** The subscription's bound applicationServerKey, in the base64url form the
 *  server hands out — comparable against `pushPublicKey()` directly. */
function keyToBase64Url(key: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(key)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type PushState =
  | "unsupported"
  | "not-asked"
  | "blocked"
  | "subscribed"
  | "unsubscribed";

export function PushToggle() {
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setState("blocked");
        return;
      }
      if (Notification.permission === "default") {
        setState("not-asked");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // The browser having a subscription doesn't mean the SERVER can
        // still use it. Two disagreement cases: the server pruned/lost the
        // row (a dead-endpoint send, a DB restore) — healed by re-asserting,
        // an idempotent upsert; or the server's VAPID keypair changed, which
        // makes this subscription permanently unsendable — its
        // applicationServerKey no longer matches, so drop it and surface the
        // re-enable button. Offline, trust the browser's own state.
        try {
          const { publicKey } = await api.pushPublicKey();
          const boundKey = subscription.options.applicationServerKey;
          if (boundKey && keyToBase64Url(boundKey) !== publicKey) {
            await subscription.unsubscribe().catch(() => {});
            setState("unsubscribed");
            return;
          }
          await api.pushSubscribe(subscription.toJSON(), navigator.userAgent.slice(0, 100));
        } catch {
          // Server unreachable — keep the browser's answer.
        }
      }
      setState(subscription ? "subscribed" : "unsubscribed");
    })();
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setState("blocked");
        return;
      }
      if (permission !== "granted") {
        setState("not-asked");
        return;
      }
      const { publicKey } = await api.pushPublicKey();
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      await api.pushSubscribe(subscription.toJSON(), navigator.userAgent.slice(0, 100));
      setState("subscribed");
    } catch {
      setState("unsubscribed");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.pushUnsubscribe(subscription.endpoint).catch(() => {});
        await subscription.unsubscribe();
      }
      setState("unsubscribed");
    } finally {
      setBusy(false);
    }
  }

  if (state === "unsupported") {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60" title="This browser has no web push. On iOS, install the app to the home screen (iOS 16.4+).">
        <BellOff className="h-3.5 w-3.5" />
        No push here
      </div>
    );
  }

  if (state === "blocked") {
    return (
      <div
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        title="Notifications are blocked at the browser level. Allow them in this site's browser settings, then reload."
      >
        <BellOff className="h-3.5 w-3.5 text-destructive" />
        Blocked in browser settings
      </div>
    );
  }

  const on = state === "subscribed";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void (on ? disable() : enable())}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors disabled:opacity-50",
        on
          ? "text-primary hover:bg-surface-raised"
          : "text-muted-foreground hover:bg-surface-raised hover:text-foreground"
      )}
      title={on ? "Push notifications are on for this device" : "Get a push notification when background work fails"}
    >
      {on ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
      {on ? "Push on" : "Enable push"}
    </button>
  );
}
