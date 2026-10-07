import { useEffect, useRef } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { holdsUnsaved } from "../stores/draft-state.js";
import { anyStagedTracks, subscribeAllTracks } from "../lib/draft-tracks.js";

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
  /** Store-backed work that a reload would interrupt. */
  isBusy: boolean;
  /** Override the DOM draft probe, primarily for deterministic tests. */
  hasUnsentText?: () => boolean;
  /** Shell-controlled production gate. Default true. */
  enabled?: boolean;
  /** Test hook for observing the one-shot reload without navigating. */
  reload?: () => void;
}

/** Register the worker and reload once an update takeover can do so safely. */
export function useServiceWorkerUpdates({
  isBusy,
  hasUnsentText: probeUnsentText = hasUnsentText,
  enabled = true,
  reload,
}: UseServiceWorkerUpdatesOptions): void {
  // Every session's draft lives in the root, not on screen (#951): one the
  // host has not acknowledged, or a send nothing has settled, is unsaved work.
  // So is a staged track in any view (#1112): it lives in this page only.
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

    const busy = () => isBusyRef.current || probeUnsentTextRef.current() || holdsUnsaved(rootRef.current.stores.drafts.getState()) || anyStagedTracks(rootRef.current);
    // A draft saved, a send settled or a queue emptied may be the transition back to idle.
    const unsubscribeDrafts = rootRef.current.stores.drafts.subscribe(() => tryReloadRef.current());
    const unsubscribeTracks = subscribeAllTracks(rootRef.current, () => tryReloadRef.current());
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

    // DOM drafts are component-local rather than store-backed. An input event
    // supplies their transition-to-idle signal while a reload is pending.
    const onInput = () => tryReloadRef.current();
    document.addEventListener("input", onInput);

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
      document.removeEventListener("input", onInput);
      unsubscribeDrafts();
      unsubscribeTracks();
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

  // Store-driven state changes rerender the caller. This is the normal idle
  // transition; the input listener above covers the DOM-only equivalent.
  useEffect(() => {
    tryReloadRef.current();
  }, [isBusy, probeUnsentText]);
}
