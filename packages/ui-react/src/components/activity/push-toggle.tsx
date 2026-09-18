import { useEffect, useRef, useState } from "react";

import { useBrainUiRoot } from "../../root-context.js";
import { subscriptionMatchesKey } from "../../lib/push-registration.js";
import { PushSwitch, type PushState } from "./push-switch.js";

/**
 * The push enable/disable CONTAINER, living on the Activity surface (where
 * the alerts it governs land). It owns the browser permission, the service
 * worker subscription, the server binding, and the lifetime guards that keep
 * a late response from a superseded root or an unmounted panel from acting;
 * `PushSwitch` owns what it looks like (S6). Nothing here renders markup.
 */

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

  const on = state === "subscribed";
  return <PushSwitch state={state} busy={busy} onToggle={() => void (on ? disable() : enable())} />;
}
