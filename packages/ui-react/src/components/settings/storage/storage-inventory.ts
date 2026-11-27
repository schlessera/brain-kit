/**
 * The Storage pane's inventory (#4830): status, the snapshot on screen, the
 * removal capability and its latest receipt, the maintenance list, the
 * pane's error and its announcement, and the three places that read them.
 *
 * - `load()` reads status, removal capability and the maintenance list
 *   together and applies whichever succeeded. A reply is dropped when its
 *   load was aborted or superseded, or the auth epoch moved since the store
 *   was made.
 * - While status says a measurement is running, status is read again after
 *   `POLL_MS`; each new status restarts that wait.
 * - Once a removal or maintenance receipt settles, status and the
 *   maintenance list are read once per receipt id.
 *
 * The poll and the receipt refresh check only their own abort signal, as the
 * effects they replace did: the pane is keyed to the auth epoch by
 * `StorageTab`, so its unmount already disposes of them.
 *
 * Local to one mounted pane, as the guidance store is; not on the root.
 */
import { createStore } from "zustand/vanilla";
import type {
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
  StorageRemovalCapability,
  StorageRemovalReceipt,
  StorageSnapshot,
  StorageStatus,
} from "@schlessera/brain-ui-sdk/protocol";
import type { storageApi } from "../../../lib/storage-api.js";

/** How long a running measurement waits before status is read again. */
export const POLL_MS = 750;

const running = (state: string | undefined) => state === "waiting" || state === "running";

type Updater<T> = T | ((previous: T) => T);
const apply = <T,>(next: Updater<T>, previous: T): T =>
  typeof next === "function" ? (next as (previous: T) => T)(previous) : next;

export interface StorageInventoryState {
  status: StorageStatus | null;
  snapshot: StorageSnapshot | null;
  capability: StorageRemovalCapability | null;
  maintenance: StorageMaintenanceRow[];
  /** The latest removal receipt: as first loaded, then as the pane's actions update it. */
  receipt: StorageRemovalReceipt | null;
  error: string | null;
  announcement: string;
  /** Start the pane's lifetime and read the inventory. */
  load(): void;
  /** End the pane's lifetime: every read in flight is dropped. */
  dispose(): void;
  /** The pane's lifetime, which its actions run under. */
  lifetime(): AbortController | null;
  /** A reply under `controller` may still be applied. */
  current(controller: AbortController): boolean;
  /** Take a status: it may end a requested measurement, and it restarts the poll. */
  acceptStatus(next: StorageStatus): void;
  /** A measurement this pane asked for: its end is announced. */
  requestScan(next: StorageStatus): void;
  /** Read the inventory again for each receipt that settled since the last time. */
  receiptsChanged(receipt: StorageRemovalReceipt | null, maintenance: StorageMaintenanceReceipt | null): void;
  setReceipt(next: Updater<StorageRemovalReceipt | null>): void;
  setSnapshot(next: StorageSnapshot | null): void;
  setError(error: string | null): void;
  setAnnouncement(announcement: string): void;
}

interface InventoryOptions {
  api: Pick<ReturnType<typeof storageApi>, "status" | "removal" | "maintenance">;
  authLock: { epoch(): number };
  /** Injected in tests; production waits on the real clock. */
  timer?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export function createStorageInventory({ api, authLock, timer = realTimer }: InventoryOptions) {
  const epoch = authLock.epoch();
  let lifetime: AbortController | null = null;
  let requestedScan: string | null = null;
  let poll: { handle: unknown; controller: AbortController } | null = null;
  let refresh: AbortController | null = null;
  const refreshed = new Set<string>();

  const store = createStore<StorageInventoryState>((set, get) => {
    function current(controller: AbortController) {
      return !controller.signal.aborted && authLock.epoch() === epoch && lifetime === controller;
    }
    function stopPoll() {
      if (!poll) return;
      timer.clear(poll.handle);
      poll.controller.abort();
      poll = null;
    }
    function acceptStatus(next: StorageStatus) {
      let announcement: string | undefined;
      if (next.state === "idle" && requestedScan && (next.snapshot?.id === requestedScan || next.previous?.id === requestedScan || next.lastFailure?.scanId === requestedScan)) {
        const requestedScanId = requestedScan;
        requestedScan = null;
        announcement = next.lastFailure?.scanId === requestedScanId ? "Storage measurement did not complete. Previous observations remain available." : "Storage measurement updated. Existing file selections remain unchanged.";
      }
      set((state) => ({ status: next, snapshot: state.snapshot ?? next.snapshot, ...(announcement !== undefined ? { announcement } : {}) }));
      // As the effect did on every new status: drop the wait for the last one.
      stopPoll();
      if (next.state !== "scanning") return;
      const controller = new AbortController();
      poll = {
        controller,
        handle: timer.set(() => {
          void api
            .status(controller.signal)
            .then((value) => {
              if (!controller.signal.aborted) get().acceptStatus(value);
            })
            .catch(() => {
              if (!controller.signal.aborted) set({ error: "Measurement response unavailable. Check measurement status." });
            });
        }, POLL_MS),
      };
    }
    return {
      status: null,
      snapshot: null,
      capability: null,
      maintenance: [],
      receipt: null,
      error: null,
      announcement: "",
      load() {
        const controller = new AbortController();
        lifetime = controller;
        void Promise.allSettled([
          api.status(controller.signal),
          api.removal(controller.signal),
          api.maintenance(controller.signal),
        ]).then(([inventory, removal, owners]) => {
          if (!current(controller)) return;
          if (inventory.status === "fulfilled") acceptStatus(inventory.value);
          else set({ error: "Storage inspection is unavailable. Human-owner access is required." });
          if (removal.status === "fulfilled") set({ capability: removal.value, receipt: removal.value.latest });
          if (owners.status === "fulfilled") set({ maintenance: owners.value.operations });
        });
      },
      dispose() {
        lifetime?.abort();
        stopPoll();
        refresh?.abort();
        refresh = null;
      },
      lifetime: () => lifetime,
      current,
      acceptStatus,
      requestScan(next) {
        requestedScan = next.activeScanId;
        set({ announcement: "" });
        acceptStatus(next);
      },
      receiptsChanged(receipt, maintenance) {
        // As the effect did whenever either receipt changed: a refresh still
        // in flight is dropped, and its receipts are refreshed again below.
        refresh?.abort();
        refresh = null;
        const done = [
          receipt && receipt.state !== "review" && !running(receipt.state) && receipt.state !== "unknown" ? receipt.review.id : null,
          maintenance && !running(maintenance.state) && maintenance.state !== "unknown" ? maintenance.id : null,
        ].filter((id): id is string => !!id && !refreshed.has(id));
        if (!done.length) return;
        const controller = new AbortController();
        refresh = controller;
        void Promise.allSettled([api.status(controller.signal), api.maintenance(controller.signal)]).then(([inventory, owners]) => {
          if (controller.signal.aborted) return;
          done.forEach((id) => refreshed.add(id));
          if (inventory.status === "fulfilled") acceptStatus(inventory.value);
          if (owners.status === "fulfilled") set({ maintenance: owners.value.operations });
        });
      },
      setReceipt: (next) => set((state) => ({ receipt: apply(next, state.receipt) })),
      setSnapshot: (snapshot) => set({ snapshot }),
      setError: (error) => set({ error }),
      setAnnouncement: (announcement) => set({ announcement }),
    };
  });
  return store;
}

const realTimer = {
  set: (run: () => void, ms: number) => setTimeout(run, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type StorageInventory = ReturnType<typeof createStorageInventory>;
