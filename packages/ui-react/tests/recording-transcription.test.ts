import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createRecordingStore, type RecordingStore } from "../src/lib/recordings.js";
import { updateHeld } from "../src/lib/update-holds.js";
import type { BrainUiServices } from "../src/root.js";
import type { LocalPartitions } from "../src/lib/local-partitions.js";

const stores: RecordingStore[] = [];
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(async () => { for (const s of stores.splice(0)) s.dispose(); await Bun.sleep(5); if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator"); });
function fixture() {
  const locks = new Set<string>();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { async request(name: string, _opts: unknown, callback: (lock: unknown) => Promise<unknown>) { if (locks.has(name)) return callback(null); locks.add(name); try { return await callback({ name }); } finally { locks.delete(name); } } } } });
  const data = new Map<string, unknown>();
  const handle = { async get(k: string) { return structuredClone(data.get(k)); }, async put(k: string, v: unknown) { data.set(k, structuredClone(v)); }, async write(cs: Array<{ delete?: string; put?: string; value?: unknown }>) { for (const c of cs) { if (c.delete) data.delete(c.delete); else data.set(c.put!, structuredClone(c.value)); } }, async list(prefix: string) { return [...data].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })); } };
  const connection = createStore(() => ({ accountKey: "odysseus", wsStatus: "connected" }));
  const root = { apiBase: () => "/api", stores: { connection }, authLock: { epoch: () => 0, state: createStore(() => ({ phase: "active" })) }, request: async () => new Response("{}", { status: 404 }) } as unknown as BrainUiServices;
  const partitions = { open: () => handle, writerGeneration: () => "initial", subscribeSignOut: () => () => {} } as unknown as LocalPartitions;
  const make = () => { const s = createRecordingStore({ root, partitions, heldAccountKey: () => connection.getState().accountKey }); stores.push(s); return s; };
  const id = crypto.randomUUID(), blob = new Blob([new Uint8Array([1, 2, 3])]);
  return { data, connection, root, make, id, blob, async seed(state = "transcribing") { const hash = Buffer.from(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())).toString("hex"); data.set(`recording:index:${id}`, { id, state, mime: "audio/webm", durationMs: 1000, bytes: 3, savedThroughMs: 1000, contentHash: hash, chunkCount: 1, ...(state !== "saved" ? { transcribeRequestId: id } : {}) }); data.set(`recording:chunk:${id}:00000000`, { index: 0, startMs: 0, endMs: 1000, data: blob }); return { recordingId: id, sha256: hash, providerId: "fixture", status: "done", attemptId: "first", retryCount: 0, failures: [], text: "Odysseus original" }; } };
}
test("delayed status recovery cannot overwrite another tab's durable edit", async () => {
  const f = fixture(), done = await f.seed(); let release!: () => void, queries = 0;
  const gate = new Promise<void>(r => { release = r; });
  f.root.request = async () => { if (++queries === 1) await gate; return Response.json(done); };
  const a = f.make(), b = f.make(); const pending = a.syncTranscriptions();
  while (!queries) await Bun.sleep(5);
  try { await b.syncTranscriptions(); await b.saveTranscript("account:odysseus", f.id, "Penelope edited"); expect((await b.get("account:odysseus", f.id))!.transcript).toBe("Penelope edited"); }
  finally { release(); }
  await pending;
  expect((await a.get("account:odysseus", f.id))!.transcript, "delayed receipt preserves newer local text").toBe("Penelope edited");
});
test("offline discard replays only its explicit DELETE after reconnect without a mounted tray", async () => {
  const f = fixture(); await f.seed(); const methods: string[] = [];
  f.root.request = async (_url, init) => { methods.push(init?.method ?? "GET"); return Response.json({ status: "consumed" }); };
  const s = f.make(); f.connection.setState({ wsStatus: "disconnected" }); await s.discard("account:odysseus", f.id);
  expect(methods).toEqual([]); expect(f.data.has(`recording:tombstone:${f.id}`)).toBe(true);
  f.connection.setState({ wsStatus: "connected" }); await Bun.sleep(30);
  expect(methods, "reconnect flushes queued deletion without audio").toEqual(["DELETE"]);
  expect(f.data.has(`recording:tombstone:${f.id}`)).toBe(false);
});
test("transcribing receipt holds service worker update reloads", async () => {
  const f = fixture(), done = await f.seed(); f.root.request = async () => Response.json({ ...done, status: "transcribing", text: undefined }); f.make(); await Bun.sleep(10);
  expect(updateHeld(f.root), "a saved upload in progress holds update reload").toBe(true);
});
test("a request transport without progress cannot claim lost audio was not sent", async () => {
  const f = fixture(); await f.seed("saved"); let calls = 0;
  f.root.request = async (url, init) => { if (url.endsWith("capabilities")) return Response.json({ capabilities: { savedAudio: true } }); if (init?.method === "PUT") { calls++; throw new TypeError("Lost reply after processing"); } return new Response("{}", { status: 404 }); };
  const s = f.make(); await expect(s.transcribe("account:odysseus", f.id, () => {})).rejects.toThrow();
  expect(calls).toBe(1);
  const row = (await s.get("account:odysseus", f.id))!;
  expect(row.state, "missing progress leaves result unconfirmed").toBe("transcribing");
  expect(row.transcriptionMessage).toContain("Could not confirm");
});

test("a lost PUT reply cannot invalidate a transcript edited after status recovery", async () => {
  const f = fixture(), done = await f.seed("saved"); let uploaded = false, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  f.root.request = async (url, init) => {
    if (url.endsWith("capabilities")) return Response.json({ capabilities: { savedAudio: true } });
    if (init?.method === "PUT") { uploaded = true; await gate; throw new TypeError("Lost reply"); }
    return uploaded ? Response.json(done) : new Response("{}", { status: 404 });
  };
  const a = f.make(), b = f.make(); await Bun.sleep(5);
  const pending = a.transcribe("account:odysseus", f.id, () => {}).catch(() => {});
  while (!uploaded) await Bun.sleep(1);
  try { await b.syncTranscriptions(); await b.saveTranscript("account:odysseus", f.id, "Penelope edited"); } finally { release(); }
  await pending;
  expect((await a.get("account:odysseus", f.id))!.state, "late transport error preserves ready state").toBe("transcript-ready");
  await a.syncTranscriptions();
  expect((await a.get("account:odysseus", f.id))!.transcript, "later sync keeps the durable correction").toBe("Penelope edited");
});
test("a delayed missing receipt cannot regress a newer transcript edit", async () => {
  const f = fixture(), done = await f.seed(); let release!: () => void, queries = 0;
  const gate = new Promise<void>(r => { release = r; });
  f.root.request = async () => { if (++queries === 1) { await gate; return new Response("{}", { status: 404 }); } return Response.json(done); };
  const a = f.make(), b = f.make(); const pending = a.syncTranscriptions(); while (!queries) await Bun.sleep(1);
  try { await b.syncTranscriptions(); await b.saveTranscript("account:odysseus", f.id, "Penelope edited"); } finally { release(); }
  await pending;
  expect((await a.get("account:odysseus", f.id))!.state, "delayed 404 preserves ready state").toBe("transcript-ready");
  await a.syncTranscriptions(); expect((await a.get("account:odysseus", f.id))!.transcript).toBe("Penelope edited");
});
test("a transcript edited during upload preflight cannot be replaced by provider work", async () => {
  const f = fixture(); await f.seed("saved"); let preflight = false, calls = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  f.root.request = async (url, init) => { if (url.endsWith("capabilities")) { preflight = true; await gate; return Response.json({ capabilities: { savedAudio: true } }); } if (init?.method === "PUT") { calls++; return Response.json({}); } return new Response("{}", { status: 404 }); };
  const a = f.make(), b = f.make(); const pending = a.transcribe("account:odysseus", f.id, () => {}).catch(() => {});
  while (!preflight) await Bun.sleep(1);
  try { await b.saveTranscript("account:odysseus", f.id, "Penelope edited"); } finally { release(); }
  await pending;
  expect(calls, "new local review stops the stale upload preflight").toBe(0);
  expect((await a.get("account:odysseus", f.id))!.state).toBe("transcript-ready");
});
