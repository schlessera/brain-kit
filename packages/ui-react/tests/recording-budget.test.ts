import { afterEach, describe, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createRecordingStore, type RecordingStore } from "../src/lib/recordings.js";
import type { BrainUiServices } from "../src/root.js";
import type { LocalPartitions } from "../src/lib/local-partitions.js";
import type { LocalCaptureStopReason } from "../src/voice/local-capture.js";

// The capture sink's storage budget (#4745): read once when a recording
// begins and kept as a running remainder, read again only close to running
// out, and a chunk that does not fit still stops the capture with `storage`.
// Keyless: an in-memory partitions double that counts `sizes`, stand-ins for
// `navigator.locks` and `navigator.storage`, and Odysseus's account.

const ACCOUNT = "account:odysseus";
const SAFETY = 1024 * 1024;
const stores: RecordingStore[] = [];
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

function fixture(free: number) {
  const data = new Map<string, unknown>();
  const storedChunkBytes = () => [...data].filter(([k]) => k.startsWith("recording:chunk:")).reduce((sum, [, v]) => sum + ((v as { data: Blob }).data.size), 0);
  // The device's free space as the estimate reports it, less what was written.
  const device = { free };
  const locks = new Set<string>();
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: {
    locks: { async request(name: string, _opts: unknown, callback: (lock: unknown) => Promise<unknown>) { if (locks.has(name)) return callback(null); locks.add(name); try { return await callback({ name }); } finally { locks.delete(name); } } },
    storage: { async estimate() { return { quota: device.free + SAFETY + storedChunkBytes(), usage: storedChunkBytes() }; } },
  } });
  const handle = {
    async get(k: string) { return data.get(k); },
    async put(k: string, v: unknown) { data.set(k, v); },
    async write(cs: Array<{ delete?: string; put?: string; value?: unknown }>) {
      for (const c of cs) {
        if (c.delete) data.delete(c.delete);
        else { data.set(c.put!, c.value); if (c.put!.startsWith("recording:chunk:")) device.free -= (c.value as { data: Blob }).data.size; }
      }
    },
    async list(prefix: string) { return [...data].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
  };
  let sizesCalls = 0;
  const partitions = {
    open: () => handle, writerGeneration: () => "initial", subscribeSignOut: () => () => {},
    async sizes(prefix = "") { sizesCalls++; return [{ partition: ACCOUNT, bytes: [...data].filter(([k]) => k.startsWith(prefix)).reduce((sum, [, v]) => sum + ((v as { data?: Blob }).data?.size ?? 0), 0), records: 0 }]; },
  } as unknown as LocalPartitions;
  const connection = createStore(() => ({ accountKey: "odysseus", wsStatus: "disconnected", vpnStatus: "checking" }));
  const root = { apiBase: () => "/api", stores: { connection }, authLock: { epoch: () => 0, state: createStore(() => ({ phase: "active" })) }, request: async () => new Response("{}", { status: 404 }) } as unknown as BrainUiServices;
  const store = createRecordingStore({ root, partitions, heldAccountKey: () => "odysseus" });
  stores.push(store);
  const stops: LocalCaptureStopReason[] = [];
  const kept = () => [...data.keys()].filter((k) => k.startsWith("recording:chunk:")).length;
  return { store, device, stops, kept, sizesCalls: () => sizesCalls };
}

/** Drives the capture sink with `count` one-second chunks of `size` bytes; returns the index of a refused chunk. */
async function record(f: ReturnType<typeof fixture>, count: number, size: number, between?: (index: number) => void): Promise<number | null> {
  const sink = f.store.sink();
  await sink.begin?.({ mimeType: "audio/webm", stop: async (reason) => { f.stops.push(reason); return reason; } });
  let refused: number | null = null;
  for (let index = 0; index < count; index++) {
    between?.(index);
    try {
      await sink.chunk({ index, data: new Blob([new Uint8Array(size)]), startMs: index * 1000, endMs: (index + 1) * 1000 });
    } catch (error) {
      expect(String(error)).toContain("Recording storage is full");
      refused = index;
      break;
    }
  }
  await sink.end?.(refused === null ? "user" : "storage");
  return refused;
}

describe("the recording budget", () => {
  test("a recording well inside its budget reads the stored sizes once, at begin", async () => {
    const f = fixture(1024 * 1024 * 1024);
    expect(await record(f, 60, 1000)).toBeNull();
    expect(f.sizesCalls()).toBe(1);
    expect(f.kept()).toBe(60);
  });

  test("a recording larger than its budget stops with `storage` at the first chunk that does not fit, keeping the rest", async () => {
    // Room for seven 100 kB chunks and a margin of 30 s of audio, not eight.
    const f = fixture(730_000);
    expect(await record(f, 20, 100_000)).toBe(7);
    expect(f.stops).toEqual(["storage"]);
    expect(f.kept()).toBe(7);
  });

  test("close to running out the budget is read again, and space freed meanwhile lets the recording go on", async () => {
    const f = fixture(730_000);
    // Another app frees 2 MB once the second chunk is written.
    expect(await record(f, 20, 100_000, (index) => { if (index === 2) f.device.free += 2_000_000; })).toBeNull();
    expect(f.stops).toEqual([]);
    expect(f.kept()).toBe(20);
    expect(f.sizesCalls()).toBeGreaterThan(1);
  });
});
