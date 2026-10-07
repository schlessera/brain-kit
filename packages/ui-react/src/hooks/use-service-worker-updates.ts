import { useEffect, useRef } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { registerUpdateHold, subscribeUpdateHolds, updateHeld } from "../lib/update-holds.js";

/** Default unsaved-text probe used by the service-worker reload guard. */
export function hasUnsentText(): boolean {
  if (typeof document === "undefined") return false;
  const fields = document.querySelectorAll("textarea, input[type='text']");
  for (const element of fields) {
    if ((element as HTMLInputElement).value.trim().length > 0) return true;
  }
  return false;
}

export interface UseServiceWorkerUpdatesOptions {
  /**
   * Shell-specific work that a reload would interrupt, in addition to the
   * root's registered update holds (`registerUpdateHold`).
   */
  isBusy: boolean;
  /** Override the DOM draft probe, primarily for deterministic tests. */
  hasUnsentText?: () => boolean;
  /** Shell-controlled production gate. Default true. */
  enabled?: boolean;
  /** Test hook for observing the one-shot reload without navigating. */
  reload?: () => void;
}

/**
 * Register the worker and reload once an update takeover can do so safely.
 *
 * The reload waits while the shell's `isBusy` is true or any update hold
 * registered on the root is busy (`registerUpdateHold`, #1015): an unsaved
 * draft or unsettled send, a staged track, a live dictation, dictated text
 * under review, or a nonempty text field (the DOM probe). It fires once, on
 * the first change that leaves all of them idle.
 *
 * A reload held back this way is not a failure state and shows nothing: the
 * page keeps running its current version until its work is done. A client
 * the server refuses as incompatible still fails loudly through the existing
 * stale-client checks (D31), which this guard does not change.
 */
export function useServiceWorkerUpdates({
  isBusy,
  hasUnsentText: probeUnsentText = hasUnsentText,
  enabled = true,
  reload,
}: UseServiceWorkerUpdatesOptions): void {
  // Drafts, tracks and voice work live in the root, not on screen, and hold
  // the reload through the root's update holds (#951, #1112, #1015).
  const root = useBrainUiRoot();
  const rootRef = useRef(root);
  rootRef.current = root;
  const isBusyRef = useRef(isBusy);
  const probeUnsentTextRef = useRef(probeUnsentText);
  const reloadRef = useRef(reload);
  const updateReadyRef = useRef(false);
  const reloadPendingRef = useRef(false);
  const refreshingRef = useRef(false);
  const tryReloadRef = useRef<() => void>(() => {});

  isBusyRef.current = isBusy;
  probeUnsentTextRef.current = probeUnsentText;
  reloadRef.current = reload;

  useEffect(() => {
    if (
      !enabled ||
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    const serviceWorker = navigator.serviceWorker;
    let disposed = false;
    const trackedWorkers = new Set<ServiceWorker>();
    const workerStateListeners = new Map<ServiceWorker, () => void>();
    let registrationListener:
      | {
          registration: ServiceWorkerRegistration;
          onUpdateFound: () => void;
        }
      | undefined;

    const busy = () => isBusyRef.current || updateHeld(rootRef.current);
    const doReload = () => {
      if (refreshingRef.current || disposed) return;
      refreshingRef.current = true;
      (reloadRef.current ?? (() => window.location.reload()))();
    };

    // A reload never fires while busy. If takeover happens mid-work, latch it
    // and fire on the transition back to idle instead.
    const reloadWhenIdle = () => {
      if (refreshingRef.current || disposed) return;
      if (busy()) {
        reloadPendingRef.current = true;
        return;
      }
      reloadPendingRef.current = false;
      doReload();
    };
    tryReloadRef.current = () => {
      if (reloadPendingRef.current) reloadWhenIdle();
    };

    const onControllerChange = () => {
      // A first install never reloads. Only a worker observed installing over
      // an existing controller arms the update-takeover reload.
      if (!updateReadyRef.current) return;
      reloadWhenIdle();
    };
    serviceWorker.addEventListener("controllerchange", onControllerChange);

    const trackInstalling = (worker: ServiceWorker | null) => {
      if (!worker || trackedWorkers.has(worker)) return;
      trackedWorkers.add(worker);
      const onStateChange = () => {
        if (worker.state === "installed" && serviceWorker.controller) {
          updateReadyRef.current = true;
        }
      };
      worker.addEventListener("statechange", onStateChange);
      workerStateListeners.set(worker, onStateChange);
    };

    serviceWorker
      .register("/service-worker.js")
      .then((registration) => {
        if (disposed) return;
        trackInstalling(registration.installing);
        const onUpdateFound = () => trackInstalling(registration.installing);
        registration.addEventListener("updatefound", onUpdateFound);
        registrationListener = { registration, onUpdateFound };
      })
      .catch((error) => {
        if (!disposed) console.error("[sw] Registration failed:", error);
      });

    return () => {
      disposed = true;
      serviceWorker.removeEventListener("controllerchange", onControllerChange);
      if (registrationListener) {
        registrationListener.registration.removeEventListener(
          "updatefound",
          registrationListener.onUpdateFound
        );
      }
      for (const [worker, listener] of workerStateListeners) {
        worker.removeEventListener("statechange", listener);
      }
      tryReloadRef.current = () => {};
    };
  }, [enabled]);

  // Any hold changing (a draft saved, a send settled, a queue emptied, a
  // dictation stopped, a review accepted) may be the transition back to
  // idle. Bound to the root in use, so a replaced root's changes are the
  // ones heard; the new root may already be idle.
  useEffect(() => {
    const unsubscribe = subscribeUpdateHolds(root, () => tryReloadRef.current());
    // DOM drafts are component-local rather than store-backed. An input
    // event supplies their transition-to-idle signal.
    const releaseProbe = typeof document === "undefined" ? () => {} : registerUpdateHold(root, {
      busy: () => probeUnsentTextRef.current(),
      subscribe: (onChange) => {
        document.addEventListener("input", onChange);
        return () => document.removeEventListener("input", onChange);
      },
    });
    tryReloadRef.current();
    // Stop listening first: releasing the probe notifies, and a replaced
    // root must not be judged before its own probe is registered.
    return () => { unsubscribe(); releaseProbe(); };
  }, [root]);

  // Store-driven state changes rerender the caller. This is the normal idle
  // transition for the shell's own `isBusy`.
  useEffect(() => {
    tryReloadRef.current();
  }, [isBusy, probeUnsentText]);
}
