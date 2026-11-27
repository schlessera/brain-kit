import { afterEach, describe, expect, jest, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createRecordingStore, type RecordingStore } from "../src/lib/recordings.js";
import type { BrainUiServices } from "../src/root.js";
import type { LocalPartitions } from "../src/lib/local-partitions.js";

// What a connection write costs the recording store (#4744): a write that
// moves neither the account, the socket nor the probe reads no partition,
// unless the last sync left a status to read or a tombstone to retry, and
// that work keeps the poll's pace on its own. Keyless: an in-memory
// partitions double that counts its reads, and Odysseus's account.

const ACCOUNT = "account:odysseus";
const stores: RecordingStore[] = [];
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  jest.useRealTimers();
  if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

/** Lets every queued promise of the double and the store run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

type Reads = { list: Record<string, number>; get: number };

function fixture() {
  const locks = new Set<string>();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { async request(name: string, _opts: unknown, callback: (lock: unknown) => Promise<unknown>) { if (locks.has(name)) return callback(null); locks.add(name); try { return await callback({ name }); } finally { locks.delete(name); } } } } });
  const reads: Record<string, Reads> = {};
  const faults = { deletes: false };
  const counted = (partition: string, data: Map<string, unknown>) => {
    const count: Reads = reads[partition] = { list: {}, get: 0 };
    return {
      async get(k: string) { count.get++; return structuredClone(data.get(k)); },
      async put(k: string, v: unknown) { data.set(k, structuredClone(v)); },
      async write(cs: Array<{ delete?: string; put?: string; value?: unknown }>) { if (faults.deletes && cs.some((c) => c.delete?.startsWith("recording:index:"))) throw new DOMException("Device busy", "UnknownError"); for (const c of cs) { if (c.delete) data.delete(c.delete); else data.set(c.put!, structuredClone(c.value)); } },
      async list(prefix: string) { count.list[prefix] = (count.list[prefix] ?? 0) + 1; return [...data].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })); },
    };
  };
  const data = new Map<string, unknown>();
  const handles = { [ACCOUNT]: counted(ACCOUNT, data), unassigned: counted("unassigned", new Map()) } as Record<string, ReturnType<typeof counted>>;
  const connection = createStore<{ accountKey: string | null; wsStatus: string; vpnStatus: string; lastError: string | null }>(() => ({ accountKey: "odysseus", wsStatus: "connected", vpnStatus: "connected", lastError: null }));
  const requests: string[] = [];
  let respond = (_url: string, _init?: RequestInit): Response => new Response("{}", { status: 404 });
  const root = { apiBase: () => "/api", stores: { connection }, authLock: { epoch: () => 0, state: createStore(() => ({ phase: "active" })) },
    request: async (url: string, init?: RequestInit) => { requests.push(`${init?.method ?? "GET"} ${url}`); return respond(url, init); } } as unknown as BrainUiServices;
  const partitions = { open: (partition: string) => handles[partition]!, writerGeneration: () => "initial", subscribeSignOut: () => () => {} } as unknown as LocalPartitions;
  const make = () => { const s = createRecordingStore({ root, partitions, heldAccountKey: () => connection.getState().accountKey }); stores.push(s); return s; };
  const reset = () => { for (const r of Object.values(reads)) { r.list = {}; r.get = 0; } requests.length = 0; };
  const total = () => Object.values(reads).reduce((sum, r) => sum + r.get + Object.values(r.list).reduce((a, b) => a + b, 0), 0);
  const row = (id: string, state: string, extra: Record<string, unknown> = {}) =>
    data.set(`recording:index:${id}`, { id, state, mime: "audio/webm", durationMs: 1000, bytes: 3, savedThroughMs: 1000, contentHash: `hash-${id}`, chunkCount: 1, ...extra });
  return { data, reads, connection, make, reset, total, requests, row, faults, respondWith(fn: typeof respond) { respond = fn; } };
}

describe("a connection write that changes nothing the recordings depend on", () => {
  test("reads no partition when nothing is pending; a reconnect still runs one scan and one sync", async () => {
    const f = fixture();
    f.make();
    await settle();
    f.reset();
    f.connection.setState({ lastError: "The socket closed" });
    await settle();
    expect(f.total()).toBe(0);

    f.connection.setState({ wsStatus: "disconnected" });
    await settle();
    f.reset();
    f.connection.setState({ wsStatus: "connected" });
    await settle();
    // One scan lists both partitions; the sync lists tombstones and the account's rows.
    expect(f.reads.unassigned!.list["recording:index:"]).toBe(1);
    expect(f.reads[ACCOUNT]!.list["recording:tombstone:"]).toBe(1);
    expect(f.reads[ACCOUNT]!.list["recording:index:"]).toBe(2);
  });

  test("a transcribing row the last sync left keeps being read, on any write and at the poll's pace", async () => {
    jest.useFakeTimers();
    const f = fixture();
    f.row("sirens", "transcribing", { transcribeRequestId: "req-sirens" });
    f.respondWith(() => Response.json({ recordingId: "sirens", sha256: "hash-sirens", providerId: "fixture", status: "transcribing", attemptId: "first", retryCount: 0, failures: [] }));
    f.make();
    await settle();
    f.reset();
    f.connection.setState({ lastError: "The socket closed" });
    await settle();
    expect(f.requests.filter((r) => r.startsWith("GET"))).toHaveLength(1);

    f.reset();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(f.requests.filter((r) => r.startsWith("GET"))).toHaveLength(1);
  });

  test("a tombstone whose DELETE failed is retried at the poll's pace", async () => {
    jest.useFakeTimers();
    const f = fixture();
    f.data.set("recording:tombstone:cyclops", { id: "cyclops", disposition: "discarded" });
    f.respondWith((_url, init) => new Response("{}", { status: init?.method === "DELETE" ? 503 : 404 }));
    f.make();
    await settle();
    f.reset();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(1);

    f.respondWith(() => new Response("{}", { status: 200 }));
    f.reset();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(1);
    expect(f.data.has("recording:tombstone:cyclops")).toBe(false);
    // Nothing is left, so the pace stops and an unchanged write reads nothing.
    f.reset();
    jest.advanceTimersByTime(15_000);
    f.connection.setState({ lastError: "The socket closed" });
    await settle();
    expect(f.total()).toBe(0);
  });
});

describe("a deletion owed to the host", () => {
  test("a discard whose local delete fails still sends its DELETE at the poll's pace", async () => {
    jest.useFakeTimers();
    const f = fixture();
    f.row("aeolia", "transcript-ready", { transcribeRequestId: "req-aeolia", transcript: "The bag of winds" });
    f.respondWith(() => new Response("{}", { status: 200 }));
    const store = f.make();
    await settle();
    // Nothing is pending: an unchanged write reads nothing.
    f.reset();
    f.connection.setState({ lastError: "The socket closed" });
    await settle();
    expect(f.total()).toBe(0);

    f.faults.deletes = true;
    await expect(store.discard(ACCOUNT, "aeolia")).rejects.toThrow();
    expect(f.data.has("recording:tombstone:aeolia")).toBe(true);
    f.faults.deletes = false;
    f.reset();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(1);
    expect(f.data.has("recording:tombstone:aeolia")).toBe(false);
  });
});

describe("listing a partition", () => {
  test("reads the index and every acceptance receipt once each, and no row on its own", async () => {
    const f = fixture();
    for (const id of ["ithaca", "troy", "aeolia"]) f.row(id, "transcript-ready", { transcript: `Notes from ${id}` });
    f.data.set("recording:accepted:troy", { revision: 7 });
    const store = f.make();
    await settle();
    f.reset();
    const rows = await store.list(ACCOUNT);
    expect(f.reads[ACCOUNT]!.list).toEqual({ "recording:index:": 1, "recording:accepted:": 1 });
    expect(f.reads[ACCOUNT]!.get).toBe(0);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(["aeolia", "ithaca", "troy"]);
    expect(byId.troy).toMatchObject({ partition: ACCOUNT, state: "accepted", acceptedDraftRev: 7 });
    expect(byId.ithaca).toMatchObject({ partition: ACCOUNT, state: "transcript-ready", transcript: "Notes from ithaca" });
    expect(byId.ithaca!.acceptedDraftRev).toBeUndefined();
    // The same rows a single read returns.
    for (const row of rows) expect(await store.get(ACCOUNT, row.id)).toEqual(row);
  });
});
