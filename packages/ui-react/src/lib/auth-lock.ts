import { createStore, type StoreApi } from "zustand/vanilla";
import type { BrainUiServices } from "../root.js";
import { disposeTracks } from "./draft-tracks.js";
import { registerUpdateHold } from "./update-holds.js";

/** The ordered warm-auth transition (#1018, #578 §1). No account content is kept here. */
export function createAuthLock(root: BrainUiServices, lifecycle: { drop(): void; restore(): void }) {
  const state = createStore(() => ({ phase: "active" as "active" | "saving" | "locked" | "restoring", revoked: false, snapshotFailed: false, savedThroughMs: null as number | null }));
  const stops = new Set<() => Promise<unknown>>();
  let lockedKey: string | null = null;
  let transition: Promise<void> | null = null;
  let restoring: Promise<boolean> | null = null;
  let snapshot = false;
  let disposed = false;
  let dropped = false;
  let epoch = 0;
  const releaseHold = registerUpdateHold(root, { busy: () => state.getState().phase !== "active", subscribe: (fn) => state.subscribe(fn) });
  const unwatch = root.recordings?.onEvent((event) => {
    if (state.getState().phase === "saving" && event.kind === "stopped") state.setState({ savedThroughMs: event.savedThroughMs });
  });
  function dropContext() {
    if (disposed || dropped || state.getState().phase !== "locked") return;
    dropped = true;
    lifecycle.drop();
    root.localWork?.lock();
    root.stores.connection.getState().setVpnStatus("unauthorized");
    root.stores.drafts.getState().release();
    disposeTracks(root);
    root.stores.file.getState().reset();
    root.stores.graph.getState().reset();
    root.stores.graph.clearSceneCache();
    root.stores.activity.getState().setSupported(false);
    root.stores.activity.getState().clear();
    root.stores.inbox.getState().clear();
    // Keep the store objects/hooks, drop their account payloads. Methods stay
    // the same; reads started under the old epoch are refused by root.request.
    for (const [name, store] of Object.entries(root.stores)) {
      if (name === "connection") continue;
      // These two initial states include boot-time persisted account metadata.
      // Drop it from the reset target as well as the live state.
      if (name === "chat") Object.assign(store.getInitialState(), { activeSessionId: null, turnRetries: {} });
      if (name === "trackers") Object.assign(store.getInitialState(), { records: {}, evidence: {}, principalKey: null });
      (store as StoreApi<unknown>).setState(store.getInitialState(), true);
    }
  }
  return {
    state,
    epoch: () => epoch,
    hasSnapshot: () => snapshot && !disposed,
    registerStop(stop: () => Promise<unknown>) { stops.add(stop); return () => { stops.delete(stop); }; },
    expire(reason = "", discardLocalWork = false) {
      if (/revok|signed out|invalidated/i.test(reason)) state.setState({ revoked: true });
      if (!disposed && state.getState().phase === "restoring") {
        // The gate is still neutral. Invalidate the pending read before its
        // completion can remount anything or install connection managers.
        epoch++;
        state.setState({ phase: "locked" });
        dropped = false;
        dropContext();
        return Promise.resolve();
      }
      if (transition || disposed || state.getState().phase !== "active") return transition ?? Promise.resolve();
      const connection = root.stores.connection.getState();
      // A cold unauthenticated visit has no protected work to lock.
      if (!connection.accountKey && connection.vpnStatus !== "connected" && connection.wsStatus !== "connected") return Promise.resolve();
      lockedKey = connection.accountKey;
      epoch++;
      state.setState({ phase: "saving", snapshotFailed: false, savedThroughMs: null });
      // Stop immediately, including permission/session requests still opening.
      // The durable store accepts at most its one already-started chunk write.
      transition = (async () => {
        await Promise.allSettled([root.recordings?.stop("auth"), ...[...stops].map((stop) => stop())]);
        if (disposed) return;
        try { if (discardLocalWork) { await root.localWork?.quiesce(); snapshot = false; } else { await root.localWork?.snapshotNow(); snapshot = root.localWork !== null; } }
        catch { state.setState({ snapshotFailed: true }); snapshot = false; }
        if (!disposed) state.setState({ phase: "locked" });
      })();
      return transition;
    },
    /** Called in the gate's layout effect, after React removed the protected DOM. */
    dropContext,
    /** Only the explicit successful sign-in path may unlock a warm page. */
    signedIn(key: string | null): Promise<boolean> {
      if (!key || key !== lockedKey) return Promise.resolve(false);
      if (restoring) return restoring;
      restoring = (async () => {
        await transition;
        if (disposed || !dropped || !snapshot) return false;
        const generation = ++epoch;
        state.setState({ phase: "restoring" });
        root.stores.connection.getState().setVpnStatus("connected", key);
        const restored = await root.localWork!.resume();
        if (disposed || !restored || generation !== epoch || state.getState().phase !== "restoring") return false;
        lifecycle.restore();
        transition = null; dropped = false; lockedKey = null; snapshot = false;
        state.setState({ phase: "active", revoked: false });
        return true;
      })().finally(() => { restoring = null; });
      return restoring;
    },
    dispose() { disposed = true; epoch++; stops.clear(); unwatch?.(); releaseHold(); },
  };
}
