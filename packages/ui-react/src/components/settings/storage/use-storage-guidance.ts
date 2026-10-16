import { useCallback, useMemo, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import type {
  StorageGuidanceResponse,
  StorageHistoryResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../../../root.js";
import { ApiRequestError } from "../../../lib/api-client.js";
import { storageApi } from "../../../lib/storage-api.js";
interface EvidenceState {
  epoch: number;
  guidance: StorageGuidanceResponse | null;
  history: StorageHistoryResponse | null;
  error: "unavailable" | "forbidden" | null;
  loading: boolean;
}
const empty = (epoch: number): EvidenceState => ({
  epoch,
  guidance: null,
  history: null,
  error: null,
  loading: false,
});
/** One read coordinator per mounted root. It retains no account data in browser storage. */
function createEvidence(root: BrainUiRoot) {
  const api = storageApi(root),
    state = createStore<EvidenceState>(() => empty(root.authLock.epoch()));
  let users = 0,
    histories = 0,
    generation = 0;
  let controller: AbortController | null = null,
    active: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null,
    unwatch: (() => void) | null = null,
    disconnect: (() => void) | null = null;
  function clear() {
    generation++;
    controller?.abort();
    controller = null;
    active = null;
    state.setState(empty(root.authLock.epoch()), true);
  }
  function refresh(): Promise<void> {
    if (!users || root.authLock.state.getState().phase !== "active")
      return Promise.resolve();
    if (active) return active;
    const request = new AbortController(),
      epoch = root.authLock.epoch(),
      account = root.stores.connection.getState().accountKey,
      owner = ++generation,
      withHistory = histories > 0;
    controller = request;
    const deadline = setTimeout(() => request.abort(), 10_000);
    state.setState({ loading: true, epoch });
    active = Promise.allSettled([
      api.guidance(request.signal),
      withHistory ? api.history(request.signal) : Promise.resolve(null),
    ])
      .then(([guidance, history]) => {
        if (
          owner !== generation ||
          account !== root.stores.connection.getState().accountKey ||
          epoch !== root.authLock.epoch() ||
          root.authLock.state.getState().phase !== "active"
        )
          return;
        const denied = [guidance, history].some(
          (value) =>
            value.status === "rejected" &&
            value.reason instanceof ApiRequestError &&
            [401, 403].includes(value.reason.status)
        );
        if (denied) {
          state.setState({ ...empty(epoch), error: "forbidden" }, true);
          return;
        }
        if (
          guidance.status === "fulfilled" &&
          guidance.value.version === 1 &&
          Array.isArray(guidance.value.capacities)
        )
          state.setState({ guidance: guidance.value, error: null });
        else state.setState({ error: "unavailable" });
        if (withHistory)
          state.setState({
            history:
              history.status === "fulfilled" &&
              history.value?.version === 1 &&
              Array.isArray(history.value.observations)
                ? history.value
                : null,
          });
      })
      .finally(() => {
        clearTimeout(deadline);
        if (owner !== generation) return;
        controller = null;
        active = null;
        state.setState({ loading: false });
        // The pane may have subscribed while an indicator-only read was in flight.
        if (!withHistory && histories && state.getState().error === null)
          void refresh();
      });
    return active;
  }
  function foreground() {
    if (document.visibilityState !== "hidden") void refresh();
  }
  return {
    state,
    refresh,
    subscribe(listener: () => void, history: boolean) {
      const stop = state.subscribe(listener);
      users++;
      if (history) histories++;
      if (users === 1) {
        if (state.getState().epoch !== root.authLock.epoch()) clear();
        unwatch = root.authLock.state.subscribe(() => {
          clear();
          if (root.authLock.state.getState().phase === "active") void refresh();
        });
        disconnect = root.stores.connection.subscribe((next, previous) => {
          if (next.accountKey !== previous.accountKey) {
            clear();
            void refresh();
          }
        });
        // This only refreshes server evidence. There is no browser warning or reminder policy.
        timer = setInterval(foreground, 60_000);
        window.addEventListener("focus", foreground);
        document.addEventListener("visibilitychange", foreground);
      }
      void refresh();
      return () => {
        stop();
        users--;
        if (history) histories--;
        if (!users) {
          clear();
          if (timer) clearInterval(timer);
          timer = null;
          unwatch?.();
          unwatch = null;
          disconnect?.();
          disconnect = null;
          window.removeEventListener("focus", foreground);
          document.removeEventListener("visibilitychange", foreground);
        }
      };
    },
  };
}
const evidence = new WeakMap<BrainUiRoot, ReturnType<typeof createEvidence>>();
export function useStorageGuidance(
  root: BrainUiRoot,
  history = false,
  enabled = true
) {
  const shared = useMemo(() => {
    let value = evidence.get(root);
    if (!value) {
      value = createEvidence(root);
      evidence.set(root, value);
    }
    return value;
  }, [root]);
  const auth = useSyncExternalStore(
    root.authLock.state.subscribe,
    () => `${root.authLock.epoch()}:${root.authLock.state.getState().phase}`,
    () => `${root.authLock.epoch()}:${root.authLock.state.getState().phase}`
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? shared.subscribe(listener, history) : () => {},
    [shared, history, enabled]
  );
  const value = useSyncExternalStore(
    subscribe,
    shared.state.getState,
    shared.state.getState
  );
  const visible = auth === `${value.epoch}:active`;
  return {
    ...(visible ? value : empty(root.authLock.epoch())),
    refresh: shared.refresh,
  };
}
