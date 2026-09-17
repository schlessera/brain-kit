import { useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { useBrainUiRoot } from "../../root-context.js";
import { subscriptionMatchesKey } from "../../lib/push-registration.js";
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
type PushState =
  | "unsupported"
  | "not-asked"
  | "blocked"
  | "subscribed"
  | "unsubscribed";

export function PushToggle() {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(new AbortController());
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    lifetime.current = controller;
    setState("unsupported");
    setBusy(false);
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
      if (signal.aborted) return;
      const subscription = await registration.pushManager.getSubscription();
      if (signal.aborted) return;
      if (subscription) {
        // Heal a lost server-side binding, but do not delete a browser
        // subscription merely because this UI displays a different server.
        try {
          const { publicKey } = await api.pushPublicKey();
          if (signal.aborted) return;
          if (!subscriptionMatchesKey(subscription, publicKey)) {
            setState("unsubscribed");
            return;
          }
          await api.pushSubscribe(subscription.toJSON(), navigator.userAgent.slice(0, 100));
        } catch {
          // Server unreachable — keep the browser's answer.
        }
      }
      if (!signal.aborted) setState(subscription ? "subscribed" : "unsubscribed");
    })().catch(() => { if (!signal.aborted) setState("unsubscribed"); });
    return () => controller.abort();
  }, [root, api]);

  async function enable() {
    const signal = lifetime.current.signal;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (signal.aborted) return;
      if (permission === "denied") {
        setState("blocked");
        return;
      }
      if (permission !== "granted") {
        setState("not-asked");
        return;
      }
      const { publicKey } = await api.pushPublicKey();
      if (signal.aborted) return;
      const registration = await navigator.serviceWorker.ready;
      if (signal.aborted) return;
      const existing = await registration.pushManager.getSubscription();
      if (signal.aborted) return;
      // Key rotation (or switching servers) is an explicit user action.
      if (existing && !subscriptionMatchesKey(existing, publicKey)) {
        await existing.unsubscribe();
        if (signal.aborted) return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      if (signal.aborted) return;
      await api.pushSubscribe(subscription.toJSON(), navigator.userAgent.slice(0, 100));
      if (!signal.aborted) setState("subscribed");
    } catch {
      if (!signal.aborted) setState("unsubscribed");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  async function disable() {
    const signal = lifetime.current.signal;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      if (signal.aborted) return;
      const subscription = await registration.pushManager.getSubscription();
      if (signal.aborted) return;
      if (subscription) {
        await api.pushUnsubscribe(subscription.endpoint).catch(() => {});
        if (signal.aborted) return;
        await subscription.unsubscribe();
      }
      if (!signal.aborted) setState("unsubscribed");
    } catch {
      // Preserve the current state when the browser rejects an unsubscribe.
    } finally {
      if (!signal.aborted) setBusy(false);
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
