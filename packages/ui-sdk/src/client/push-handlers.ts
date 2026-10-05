/**
 * The service-worker half of web push, packaged like the share-target
 * handler: the SDK ships the logic, the deployment shell wires it in one
 * line (`registerPushHandlers(self)` in its service worker).
 *
 * Three listeners:
 *
 * - `push` shows the (already-minimized) notification. The server coalesces
 *   repeats per run via `tag`, so a flapping job re-notifies in place
 *   instead of stacking.
 * - `notificationclick` focuses an open app window and navigates it to the
 *   deep link, or opens a new one. An expired session lands on the login
 *   screen with the hash preserved — the app restores the target after
 *   authentication, because the hash never leaves the client.
 * - `pushsubscriptionchange` re-subscribes with the server. It can fire
 *   while offline; the re-subscribe POST simply fails and the next app
 *   open's subscription check heals it (the client compares its live
 *   subscription against the server's list). The renewal reports the
 *   worker's IANA zone, so a renewed endpoint keeps client-local timing for
 *   Action notices instead of waiting for the next app open.
 */

export interface PushHandlerOptions {
  /** Where the re-subscribe POST goes. Default: "/api/push/subscribe". */
  subscribeUrl?: string;
  /** Fallback deep link when the payload carries none. */
  defaultUrl?: string;
}

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

/** Structural slice of ServiceWorkerGlobalScope — keeps this module compilable
 *  outside a webworker lib context, like the share-target module. */
export interface PushCapableScope {
  addEventListener(type: string, listener: (event: any) => void): void;
  registration: {
    showNotification(title: string, options?: Record<string, unknown>): Promise<void>;
    pushManager: {
      subscribe(options: {
        userVisibleOnly: boolean;
        applicationServerKey: Uint8Array | string;
      }): Promise<unknown>;
    };
  };
  clients: {
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<
      Array<{ url: string; focus(): Promise<unknown>; navigate?(url: string): Promise<unknown> }>
    >;
    openWindow(url: string): Promise<unknown>;
  };
}

/** The runtime's IANA zone, or nothing: the server validates it again. */
function reportedTimeZone(): { timeZone?: string } {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone ? { timeZone } : {};
  } catch {
    return {};
  }
}

export function registerPushHandlers(
  scope: PushCapableScope,
  options: PushHandlerOptions = {}
): void {
  const subscribeUrl = options.subscribeUrl ?? "/api/push/subscribe";
  const defaultUrl = options.defaultUrl ?? "/#/activity";

  scope.addEventListener("push", (event: any) => {
    let payload: PushPayload = {};
    try {
      payload = event.data?.json() ?? {};
    } catch {
      // A payload we cannot parse still deserves a visible notification —
      // silence is the one unacceptable outcome for the accelerator tier.
    }
    event.waitUntil(
      scope.registration.showNotification(payload.title ?? "Brain activity", {
        body: payload.body ?? "",
        tag: payload.tag ?? "brain-activity",
        data: { url: payload.url ?? defaultUrl },
      })
    );
  });

  scope.addEventListener("notificationclick", (event: any) => {
    event.notification?.close?.();
    const url: string = event.notification?.data?.url ?? defaultUrl;
    event.waitUntil(
      (async () => {
        const windows = await scope.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const existing = windows[0];
        if (existing) {
          await existing.focus();
          // navigate() is not universal; falling back to focus-only still
          // brings the app up, and the app itself surfaces the inbox badge.
          if (existing.navigate) await existing.navigate(url);
          return;
        }
        await scope.clients.openWindow(url);
      })()
    );
  });

  scope.addEventListener("pushsubscriptionchange", (event: any) => {
    const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
    if (!applicationServerKey) return;
    event.waitUntil(
      (async () => {
        try {
          const subscription = await scope.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          });
          await fetch(subscribeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subscription, ...reportedTimeZone() }),
          });
        } catch {
          // Offline or logged out — the next app open's subscription check
          // re-subscribes with a fresh key.
        }
      })()
    );
  });
}
