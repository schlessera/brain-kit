// The Storage pane's inventory store (#4830), driven with a fake storage API
// and a controlled timer: no DOM, no browser. It pins the three reads it took
// over from `useStorage` (the initial load, the poll while a measurement
// runs, the refresh after a settled receipt) and the two measurement
// announcements. What a refused read (401 or 403) leaves behind is #4583's to
// decide, so nothing here asserts it.
import { describe, expect, test } from "bun:test";
import type {
  StorageMaintenanceReceipt,
  StorageRemovalCapability,
  StorageRemovalReceipt,
  StorageStatus,
} from "@schlessera/brain-ui-sdk/protocol";
import { createStorageInventory, POLL_MS } from "../src/components/settings/storage/storage-inventory.js";

type Read = "status" | "removal" | "maintenance";

/** Every read waits until the test answers it, in the order it was made. */
function fakeApi() {
  const reads: { kind: Read; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const read = (kind: Read) => (signal: AbortSignal) =>
    new Promise((resolve, reject) => { reads.push({ kind, signal, resolve, reject }); });
  const api = { status: read("status"), removal: read("removal"), maintenance: read("maintenance") };
  return { api: api as unknown as Parameters<typeof createStorageInventory>[0]["api"], reads };
}

/** A timer the test fires by hand. */
function fakeTimer() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    timer: { set: (run: () => void, ms: number) => { pending.set(++next, { run, ms }); return next; }, clear: (handle: unknown) => { pending.delete(handle as number); } },
    pending,
    fire() { const due = [...pending.entries()]; pending.clear(); for (const [, { run }] of due) run(); return due.map(([, { ms }]) => ms); },
  };
}

function setup() {
  const { api, reads } = fakeApi();
  const clock = fakeTimer();
  let epoch = 1;
  const authLock = { epoch: () => epoch };
  const store = createStorageInventory({ api, authLock, timer: clock.timer });
  return { store, reads, clock, nextEpoch: () => { epoch++; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const snapshot = (id: string, observedAt = 1) => ({ id, observedAt, roots: [] }) as unknown as NonNullable<StorageStatus["snapshot"]>;
const status = (state: string, extra: Partial<StorageStatus> = {}) => ({ state, snapshot: snapshot("ithaca-1"), ...extra }) as unknown as StorageStatus;
const capability = { available: true, latest: { review: { id: "review-1" }, state: "completed", items: [] }, limits: { items: 10, totalBytes: 1 } } as unknown as StorageRemovalCapability;
const owners = { operations: [{ id: "op-1" }] };
const pending = (reads: ReturnType<typeof fakeApi>["reads"], kind: Read) => reads.filter((r) => r.kind === kind && !r.signal.aborted);

describe("the initial load", () => {
  test("applies a fulfilled status when the removal read rejects", async () => {
    const { store, reads } = setup();
    store.getState().load();
    expect(reads.map((r) => r.kind)).toEqual(["status", "removal", "maintenance"]);
    reads[0]!.resolve(status("idle"));
    reads[1]!.reject(new Error("refused"));
    reads[2]!.resolve(owners);
    await settle();
    const state = store.getState();
    expect(state.status?.state).toBe("idle");
    expect(state.snapshot?.id).toBe("ithaca-1");
    expect(state.capability).toBeNull();
    expect(state.maintenance).toEqual(owners.operations as never);
    expect(state.error).toBeNull();
  });

  test("applies the removal capability and its receipt when the status read rejects", async () => {
    const { store, reads } = setup();
    store.getState().load();
    reads[0]!.reject(new Error("unavailable"));
    reads[1]!.resolve(capability);
    reads[2]!.reject(new Error("unavailable"));
    await settle();
    const state = store.getState();
    expect(state.status).toBeNull();
    expect(state.capability).toBe(capability);
    expect(state.receipt).toBe(capability.latest);
    expect(state.error).toBe("Storage inspection is unavailable. Human-owner access is required.");
  });

  test("drops a reply that arrives after the auth epoch changed", async () => {
    const { store, reads, nextEpoch } = setup();
    store.getState().load();
    const before = store.getState();
    nextEpoch();
    reads[0]!.resolve(status("idle"));
    reads[1]!.resolve(capability);
    reads[2]!.resolve(owners);
    await settle();
    const after = store.getState();
    expect(after.status).toBe(before.status);
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.capability).toBe(before.capability);
    expect(after.receipt).toBe(before.receipt);
    expect(after.maintenance).toBe(before.maintenance);
  });

  test("drops a reply that arrives after the store was disposed", async () => {
    const { store, reads } = setup();
    store.getState().load();
    store.getState().dispose();
    reads[0]!.resolve(status("idle"));
    reads[1]!.resolve(capability);
    reads[2]!.resolve(owners);
    await settle();
    expect(store.getState().status).toBeNull();
    expect(store.getState().capability).toBeNull();
    expect(store.getState().maintenance).toEqual([]);
  });
});

describe("the poll while a measurement runs", () => {
  test("reads status once per tick while scanning, and stops once it is not", async () => {
    const { store, reads, clock } = setup();
    store.getState().acceptStatus(status("scanning"));
    expect(pending(reads, "status")).toHaveLength(0);
    expect(clock.fire()).toEqual([POLL_MS]);
    expect(POLL_MS).toBe(750);
    expect(pending(reads, "status")).toHaveLength(1);
    // Still scanning: one more read on the next tick, and only one.
    reads.at(-1)!.resolve(status("scanning"));
    await settle();
    expect(clock.pending.size).toBe(1);
    clock.fire();
    expect(reads.filter((r) => r.kind === "status")).toHaveLength(2);
    reads.at(-1)!.resolve(status("idle"));
    await settle();
    expect(clock.pending.size).toBe(0);
    expect(clock.fire()).toEqual([]);
    expect(reads.filter((r) => r.kind === "status")).toHaveLength(2);
  });

  test("a failed poll read says so", async () => {
    const { store, reads, clock } = setup();
    store.getState().acceptStatus(status("scanning"));
    clock.fire();
    reads.at(-1)!.reject(new Error("away"));
    await settle();
    expect(store.getState().error).toBe("Measurement response unavailable. Check measurement status.");
  });
});

describe("the refresh after a settled receipt", () => {
  const removal = (state: string) => ({ review: { id: "review-7" }, state, items: [] }) as unknown as StorageRemovalReceipt;
  const upkeep = (state: string) => ({ id: "upkeep-3", state }) as unknown as StorageMaintenanceReceipt;

  test("reads the inventory once per settled receipt id", async () => {
    const { store, reads } = setup();
    store.getState().receiptsChanged(removal("running"), null);
    expect(reads).toHaveLength(0);
    store.getState().receiptsChanged(removal("completed"), null);
    expect(reads.map((r) => r.kind)).toEqual(["status", "maintenance"]);
    reads[0]!.resolve(status("idle", { snapshot: snapshot("ithaca-2") }));
    reads[1]!.resolve(owners);
    await settle();
    expect(store.getState().status?.snapshot?.id).toBe("ithaca-2");
    expect(store.getState().maintenance).toEqual(owners.operations as never);
    // The same receipt seen again, and the same receipt object again: nothing more.
    store.getState().receiptsChanged(removal("completed"), null);
    store.getState().receiptsChanged(removal("completed"), upkeep("running"));
    expect(reads).toHaveLength(2);
    // A maintenance receipt that settles is a new id: one more refresh.
    store.getState().receiptsChanged(removal("completed"), upkeep("completed"));
    expect(reads).toHaveLength(4);
  });
});

describe("the measurement announcements", () => {
  test("a requested measurement that became the snapshot", () => {
    const { store } = setup();
    store.getState().setAnnouncement("Visible file list copied.");
    store.getState().requestScan(status("scanning", { activeScanId: "scan-9" } as Partial<StorageStatus>));
    expect(store.getState().announcement).toBe("");
    store.getState().acceptStatus(status("idle", { snapshot: snapshot("scan-9") }));
    expect(store.getState().announcement).toBe("Storage measurement updated. Existing file selections remain unchanged.");
  });

  test("a requested measurement that failed", () => {
    const { store } = setup();
    store.getState().requestScan(status("scanning", { activeScanId: "scan-9" } as Partial<StorageStatus>));
    store.getState().acceptStatus(status("idle", { lastFailure: { scanId: "scan-9" } } as Partial<StorageStatus>));
    expect(store.getState().announcement).toBe("Storage measurement did not complete. Previous observations remain available.");
  });
});
