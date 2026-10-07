/// <reference types="@vitest/browser-playwright" />
import { expect, test, vi, type TestContext } from "vitest";
import { createBrainUiRoot } from "../../src/root.js";
import { createLocalPartitions, type PartitionId } from "../../src/lib/local-partitions.js";
import { createRecordingStore, type RecordingRecovery, type RecordingEvent } from "../../src/lib/recordings.js";
import { startLocalCapture } from "../../src/voice/local-capture.js";
import { updateHeld } from "../../src/lib/update-holds.js";
import { failIndexedDbWrites, holdIndexedDbWrite } from "./offline/indexeddb-faults.ts";
import { openScene } from "./offline/scene.ts";
import { AUDIO_FIXTURES, generateWav } from "./offline/audio-fixtures.ts";
import { installWavMicrophone, watchMicrophone } from "./offline/fake-microphone.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sceneUrl = new URL("./offline/scenes/recordings.scene.ts", import.meta.url);
function cell(ctx: TestContext) {
  let held: string | null = "odysseus";
  const name = `odysseus-recordings-${crypto.randomUUID()}`;
  const partitions = createLocalPartitions({ name, heldAccountKey: () => held });
  const root = createBrainUiRoot({ storage: null });
  const store = createRecordingStore({ root, partitions, heldAccountKey: () => held });
  const events: RecordingEvent[] = [];
  const cleanup: Array<() => void> = [];
  store.onEvent((event) => events.push(event));
  ctx.onTestFinished(async () => { for (const fn of cleanup.reverse()) fn(); await store.stop("interrupted"); store.dispose(); root.dispose(); });
  return { root, partitions, store, events, cleanup, account: (key: string | null) => { held = key; root.stores.connection.getState().setVpnStatus(key ? "connected" : "unauthorized", key); } };
}
function chunk(index: number, endMs: number, bytes = 4) {
  return { index, startMs: index * 1000, endMs, data: new Blob([new Uint8Array(bytes)]) };
}
async function saved(c: ReturnType<typeof cell>, partition: PartitionId = "account:odysseus") {
  const previous = new Set((await c.store.list(partition)).map((r) => r.id));
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await sink.chunk(chunk(0, 1000));
  await sink.end!("user");
  return (await c.store.list(partition)).find((r) => !previous.has(r.id))!;
}

test("sink construction persists nothing, and recovery never opens the microphone", async (ctx) => {
  const mic = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  const c = cell(ctx);
  ctx.onTestFinished(() => mic.mockRestore());
  await c.partitions.sizes();
  c.store.sink();
  await wait(0);
  expect(await c.partitions.sizes()).toEqual([]);
  expect((await c.store.recover("unassigned")).recordings).toEqual([]);
  expect(mic).not.toHaveBeenCalled();
});

test("savedThroughMs stays at the committed boundary while a chunk transaction is open", async (ctx) => {
  const c = cell(ctx);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await sink.chunk(chunk(0, 1000));
  const row = (await c.store.list("account:odysseus"))[0]!;
  const hold = holdIndexedDbWrite((key) => Array.isArray(key) && String(key[1]).startsWith("recording:chunk:"));
  c.cleanup.push(() => hold.restore());
  const pending = sink.chunk(chunk(1, 2000));
  await hold.started;
  expect(c.events.filter((e) => e.kind === "committed").at(-1)?.savedThroughMs, "no requested boundary before commit").toBe(1000);
  // Reads in another transaction block behind the open writer. The store's
  // event is its published committed boundary, observable without that block.
  hold.release();
  await pending;
  expect((await c.store.get(row.partition, row.id))?.savedThroughMs).toBe(2000);
  await sink.end!("user");
});

for (const errorName of ["QuotaExceededError", "DataError"] as const) {
  test(`${errorName} stops real capture at its committed boundary and leaves other audio unchanged`, async (ctx) => {
    const c = cell(ctx);
    const other = await saved(c);
    const capture = await c.store.start({ timesliceMs: 250 });
    await expect.poll(() => c.events.filter((e) => e.kind === "committed").length).toBeGreaterThan(1);
    const boundary = c.events.filter((e) => e.kind === "committed").at(-1)!.savedThroughMs;
    const fault = failIndexedDbWrites({ next: true, errorName });
    c.cleanup.push(() => fault.restore());
    await capture.ended;
    expect(fault.failures).toBeGreaterThan(0);
    expect(c.events.at(-1)).toEqual({ kind: "stopped", savedThroughMs: boundary, message: `Stopped: this device couldn't save more audio. Saved up to ${Math.floor(boundary / 60000)}:${(Math.floor(boundary / 1000) % 60).toString().padStart(2, "0")}; the end may be missing.` });
    expect(await c.store.get(other.partition, other.id)).toEqual(other);
    const stopped = (await c.store.list(other.partition)).find((r) => r.id !== other.id)!;
    expect(stopped).toMatchObject({ state: "interrupted", savedThroughMs: boundary });
    const play = await c.store.playback(stopped.partition, stopped.id);
    ctx.onTestFinished(() => play.revoke());
    const context = new AudioContext();
    ctx.onTestFinished(() => context.close());
    expect((await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer())).duration).toBeGreaterThan(0);
  });
}

test("99.9 MiB across readable, locked and unassigned partitions refuses before the microphone without eviction", async (ctx) => {
  const c = cell(ctx);
  const mic = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  ctx.onTestFinished(() => mic.mockRestore());
  const block = new Blob([new Uint8Array(Math.floor(99.9 * 1024 * 1024 / 3))]);
  for (const account of ["odysseus", "penelope", null]) {
    c.account(account);
    await c.partitions.open(account ? `account:${account}` : "unassigned").put("recording:chunk:existing", block);
  }
  c.account("odysseus");
  const before = await c.partitions.sizes();
  expect(await c.store.budget()).toMatchObject({ canRecord: false });
  await expect(c.store.start()).rejects.toThrow("Not enough space on this device to record");
  expect(mic).not.toHaveBeenCalled();
  expect(await c.partitions.sizes()).toEqual(before);
});

test("recovery classifies all, some and no surviving chunks and retains the removal count until dismissed", async (ctx) => {
  const c = cell(ctx);
  const normal = await saved(c);
  expect(normal.state).toBe("saved");
  const partial = await saved(c);
  expect(partial.id).not.toBe(normal.id);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await sink.chunk(chunk(0, 1000));
  await sink.chunk(chunk(1, 2000));
  await sink.end!("user");
  const missing = (await c.store.list(normal.partition)).find((r) => r.id !== normal.id && r.id !== partial.id)!;
  const handle = c.partitions.open(normal.partition);
  await handle.write([{ delete: `recording:chunk:${missing.id}:00000001` }, { delete: `recording:chunk:${partial.id}:00000000` }]);
  const result = await c.store.recover(normal.partition);
  expect(result.recordings.find((r) => r.id === normal.id)).toEqual(normal);
  expect(result.recordings.find((r) => r.id === missing.id)).toMatchObject({ state: "interrupted", savedThroughMs: 1000, bytes: 4, chunkCount: 1 });
  expect(result.recordings.find((r) => r.id === partial.id)).toBeUndefined();
  expect(result.removedMessage).toBe("1 recordings were removed by the browser before they were transcribed.");
  expect((await c.store.recover(normal.partition)).removedCount).toBe(1);
  await c.store.dismissRemoved(normal.partition);
  expect((await c.store.recover(normal.partition)).removedMessage).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/last second|few seconds|gap length/);
});

test("account audio is refused at every store read boundary while locked but still consumes budget", async (ctx) => {
  const c = cell(ctx);
  const row = await saved(c);
  const before = await c.store.budget();
  c.account(null);
  await expect(c.store.list(row.partition)).rejects.toThrow("account the client does not hold");
  await expect(c.store.get(row.partition, row.id)).rejects.toThrow("account the client does not hold");
  await expect(c.store.playback(row.partition, row.id)).rejects.toThrow("account the client does not hold");
  expect((await c.store.budget()).bytes).toBe(before.bytes);
  c.account("penelope");
  await expect(c.store.list(row.partition)).rejects.toThrow("account the client does not hold");
  c.account("odysseus");
  expect(await c.store.get(row.partition, row.id)).toEqual(row);
});

test("unassigned association and discard are explicit and account audio cannot transfer", async (ctx) => {
  const c = cell(ctx);
  c.account(null);
  const row = await saved(c, "unassigned");
  const play = await c.store.playback("unassigned", row.id);
  const peer = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" });
  ctx.onTestFinished(() => peer.dispose());
  const peerPlay = await peer.playback("unassigned", row.id);
  expect((await fetch(play.url)).ok).toBe(true);
  await expect(c.store.assign(row.id)).rejects.toThrow("Sign in");
  c.account("odysseus");
  await c.store.assign(row.id);
  await expect(fetch(play.url)).rejects.toThrow();
  await expect(fetch(peerPlay.url)).rejects.toThrow();
  expect(await c.store.list("unassigned")).toEqual([]);
  expect(await c.store.get("account:odysseus", row.id)).toMatchObject({ ...row, partition: "account:odysseus" });
  c.account("penelope");
  await expect(c.store.assign(row.id)).rejects.toThrow("Unassigned recording not found");
  c.account("odysseus");
  await c.store.discard("account:odysseus", row.id);
  expect(await c.store.list("account:odysseus")).toEqual([]);
  expect(await c.partitions.sizes("recording:chunk:")).toEqual([]);
});

test("auth stop accepts at most the in-flight chunk and holds updates until finalization", async (ctx) => {
  const c = cell(ctx);
  const capture = await c.store.start({ timesliceMs: 250 });
  await expect.poll(() => c.events.some((e) => e.kind === "committed")).toBe(true);
  expect(updateHeld(c.root)).toBe(true);
  const hold = holdIndexedDbWrite((key) => Array.isArray(key) && String(key[1]).startsWith("recording:chunk:"));
  c.cleanup.push(() => hold.restore());
  await hold.started;
  const previous = c.events.filter((e) => e.kind === "committed").at(-1)!.savedThroughMs;
  await wait(600); // more chunks queue while the one writer is still held.
  const stopping = c.store.stop("auth");
  await wait(100);
  expect(updateHeld(c.root)).toBe(true);
  hold.restore();
  const final = holdIndexedDbWrite((key) => Array.isArray(key) && String(key[1]).startsWith("recording:index:"));
  c.cleanup.push(() => final.restore());
  await final.started;
  expect(updateHeld(c.root), "final metadata has not committed yet").toBe(true);
  final.release();
  await stopping;
  expect(await capture.ended).toBe("auth");
  const rows = await c.store.list("account:odysseus");
  expect(rows[0]).toMatchObject({ state: "interrupted", partition: "account:odysseus" });
  expect(c.events.filter((e) => e.kind === "committed" && e.savedThroughMs > previous)).toHaveLength(1);
  expect(updateHeld(c.root)).toBe(false);
});

test("page termination at 5.5 seconds recovers committed playable audio with no microphone restart", async (ctx) => {
  const scene = await openScene(sceneUrl);
  ctx.onTestFinished(() => scene.close());
  await scene.call("start");
  await expect.poll(async () => (await scene.call<{ elapsed: number }>("boundary")).elapsed, { timeout: 8000 }).toBeGreaterThan(5500);
  const before = await scene.call<{ committed: number }>("boundary");
  expect(before.committed).toBeGreaterThan(0);
  await scene.terminate();
  expect(await scene.call("micCalls")).toBe(0);
  const recovered = await scene.call<RecordingRecovery>("recover");
  expect(recovered.recordings).toHaveLength(1);
  expect(recovered.recordings[0]).toMatchObject({ state: "interrupted", savedThroughMs: before.committed });
  const duration = await scene.call<number>("playback", recovered.recordings[0]!.id);
  expect(duration).toBeGreaterThan(0);
  expect(Math.abs(duration * 1000 - before.committed)).toBeLessThan(100);
  await scene.reload();
  expect(await scene.call("micCalls")).toBe(0);
});

test("a second real tab cannot open the microphone while another tab records", async (ctx) => {
  const scene = await openScene(sceneUrl);
  ctx.onTestFinished(() => scene.close());
  await scene.call("start");
  const sibling = await scene.sibling();
  ctx.onTestFinished(() => sibling.close());
  expect(await sibling.call("tryStart")).toBe("Recording in another Brain tab");
  expect(await sibling.call("micCalls")).toBe(0);
  await scene.call("stop");
  expect(await sibling.call("tryStart")).toBe("started");
  await sibling.call("stop");
});

test("the 10-minute-5-second fixture stops at the hard duration cap with warning, copy and playable audio", async (ctx) => {
  const c = cell(ctx);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10m05s));
  ctx.onTestFinished(() => mic.restore());
  const started = performance.now();
  const capture = await c.store.start();
  await capture.ended;
  expect(performance.now() - started).toBeLessThan(605_000);
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row.savedThroughMs, "capture reaches the ten-minute boundary").toBeGreaterThan(598_000);
  expect(row.savedThroughMs).toBeLessThanOrEqual(600_000);
  expect(c.events.filter((e) => e.kind === "warning")).toHaveLength(1);
  expect(c.events.at(-1)?.message).toBe("Stopped at the 10-minute limit. Your recording is saved.");
  const play = await c.store.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  const context = new AudioContext();
  ctx.onTestFinished(() => context.close());
  const decoded = await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer());
  expect(decoded.duration).toBeGreaterThan(598);
  expect(decoded.duration).toBeLessThanOrEqual(600.1);
}, 650_000);


test("caller-owned capture stops the microphone before releasing recording and update holds", async (ctx) => {
  const c = cell(ctx);
  const microphone = watchMicrophone();
  ctx.onTestFinished(() => microphone.restore());
  const capture = await startLocalCapture({ sink: c.store.sink(), timesliceMs: 250 });
  ctx.onTestFinished(async () => { await capture.stop("interrupted"); });
  await expect.poll(() => c.events.some((e) => e.kind === "committed")).toBe(true);
  expect(updateHeld(c.root)).toBe(true);
  await c.store.stop("auth");
  expect(microphone.streams[0]!.getAudioTracks()[0]!.readyState, "the caller's microphone has stopped").toBe("ended");
  expect(await capture.ended).toBe("auth");
  expect(c.store.busy()).toBe(false);
  expect(updateHeld(c.root)).toBe(false);
  const boundary = c.events.filter((e) => e.kind === "committed").at(-1)!.savedThroughMs;
  await wait(600);
  expect(c.events.filter((e) => e.kind === "committed").at(-1)!.savedThroughMs).toBe(boundary);
});

test("disposal while caller-owned begin is pending stops the microphone and retains its update hold until cleanup", async (ctx) => {
  const c = cell(ctx);
  const microphone = watchMicrophone();
  ctx.onTestFinished(() => microphone.restore());
  const hold = holdIndexedDbWrite((key) => Array.isArray(key) && String(key[1]).startsWith("recording:index:"));
  c.cleanup.push(() => hold.restore());
  const capture = await startLocalCapture({ sink: c.store.sink(), timesliceMs: 250 });
  ctx.onTestFinished(async () => { hold.restore(); await capture.stop("interrupted"); });
  await hold.started;
  c.store.dispose();
  await wait(0);
  expect(microphone.streams[0]!.getAudioTracks()[0]!.readyState, "disposal stops the microphone during begin").toBe("ended");
  expect(updateHeld(c.root), "begin cleanup still owns the update hold").toBe(true);
  hold.release();
  expect(await capture.ended).toBe("interrupted");
  await expect.poll(() => c.store.busy()).toBe(false);
  expect(updateHeld(c.root)).toBe(false);
  expect(await c.store.list("account:odysseus")).toEqual([]);
  const peer = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" });
  ctx.onTestFinished(() => peer.dispose());
  await expect(peer.recover("account:odysseus")).resolves.toMatchObject({ recordings: [] });
});

test("playback awaiting its reads cannot create a URL after disposal", async (ctx) => {
  const c = cell(ctx);
  const row = await saved(c);
  const handle = c.partitions.open(row.partition);
  const get = handle.get;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const open = vi.spyOn(c.partitions, "open").mockImplementation(() => ({ ...handle, async get(key) { entered(); await held; return get(key); } }));
  ctx.onTestFinished(() => open.mockRestore());
  const createUrl = vi.spyOn(URL, "createObjectURL");
  ctx.onTestFinished(() => createUrl.mockRestore());
  const pending = c.store.playback(row.partition, row.id);
  await waiting;
  c.store.dispose();
  release();
  await expect(pending).rejects.toThrow("Recording store is closed");
  expect(createUrl).not.toHaveBeenCalled();
});


test("recovery returns committed audio even when full storage prevents repair writes", async (ctx) => {
  const c = cell(ctx);
  const capture = await c.store.start({ timesliceMs: 250 });
  await expect.poll(() => c.events.some((e) => e.kind === "committed")).toBe(true);
  const boundary = c.events.filter((e) => e.kind === "committed").at(-1)!.savedThroughMs;
  const fault = failIndexedDbWrites({ afterBytes: 0 });
  c.cleanup.push(() => fault.restore());
  await capture.ended;
  const reloaded = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" });
  ctx.onTestFinished(() => reloaded.dispose());
  await expect(reloaded.recover("account:odysseus")).resolves.toMatchObject({ recordings: [{ state: "interrupted", savedThroughMs: boundary }] });
  const row = (await reloaded.list("account:odysseus"))[0]!;
  expect(row.state).toBe("interrupted");
  const play = await reloaded.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  const context = new AudioContext();
  ctx.onTestFinished(() => context.close());
  expect((await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer())).duration).toBeGreaterThan(0);
});


test("content hash and playback preserve each committed chunk once in order", async (ctx) => {
  const c = cell(ctx);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array([1, 2])]) });
  await sink.chunk({ index: 1, startMs: 1000, endMs: 2000, data: new Blob([new Uint8Array([3, 4])]) });
  await sink.end!("user");
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row.contentHash).toBe("9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
  const play = await c.store.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  expect([...new Uint8Array(await (await fetch(play.url)).arrayBuffer())]).toEqual([1, 2, 3, 4]);
});

test("a running recording stops at its byte budget without evicting older audio", async (ctx) => {
  const c = cell(ctx);
  c.account("penelope");
  await c.partitions.open("account:penelope").put("recording:chunk:locked", new Blob([new Uint8Array(99.5 * 1024 * 1024)]));
  c.account("odysseus");
  const older = await saved(c);
  const stop = vi.fn(async (reason: "user" | "limit" | "storage" | "auth" | "interrupted") => reason);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  await sink.chunk(chunk(0, 1000));
  await expect(sink.chunk(chunk(1, 2000, 1024 * 1024))).rejects.toThrow("Recording storage is full");
  expect(stop).toHaveBeenCalledWith("storage");
  await sink.end!("storage");
  expect(c.events.at(-1)?.message).toBe("Stopped: storage for recordings is full. Saved up to 0:01.");
  expect(await c.store.get(older.partition, older.id)).toEqual(older);
  expect((await c.partitions.sizes("recording:chunk:")).find((r) => r.partition === "account:penelope")?.bytes).toBe(99.5 * 1024 * 1024);
});


test("the nine-minute warning fires once at the tuning boundary", async (ctx) => {
  const c = cell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await vi.advanceTimersByTimeAsync(539_999);
  expect(c.events.filter((e) => e.kind === "warning")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(c.events.filter((e) => e.kind === "warning")).toEqual([{ kind: "warning", message: "1 minute left in this recording", savedThroughMs: 0 }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.events.filter((e) => e.kind === "warning")).toHaveLength(1);
  await sink.end!("user");
});

test("completed recovery relinquishes its lock before an immediate next recovery", async (ctx) => {
  const c = cell(ctx);
  const nativeRequest = navigator.locks.request.bind(navigator.locks);
  let release!: () => void;
  let returned!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  const nativeReturned = new Promise<void>((resolve) => { returned = resolve; });
  const request = vi.spyOn(navigator.locks, "request").mockImplementation((async (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
    const value = await nativeRequest(name, options, callback);
    returned();
    await completion; // delay the provider's ownership-release acknowledgement.
    return value;
  }) as LockManager["request"]);
  c.cleanup.push(() => { release(); request.mockRestore(); });
  let completed = false;
  const recovery = c.store.recover("unassigned").then(() => { completed = true; });
  await nativeReturned;
  await wait(0);
  expect(completed, "recovery waits for the lock provider's completion").toBe(false);
  release();
  await recovery;
  request.mockRestore();
  for (let i = 0; i < 30; i++) await expect(c.store.recover("unassigned")).resolves.toMatchObject({ recordings: [] });
});

test("association preserves a recovered prefix when its repair initially could not commit", async (ctx) => {
  const c = cell(ctx);
  c.account(null);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  for (let index = 0; index < 3; index++) await sink.chunk({ ...chunk(index, (index + 1) * 1000), data: new Blob([new Uint8Array([index + 1])]) });
  await sink.end!("user");
  const row = (await c.store.list("unassigned"))[0]!;
  await c.partitions.open("unassigned").write([{ delete: `recording:chunk:${row.id}:00000001` }]);
  const fault = failIndexedDbWrites({ afterBytes: 0 });
  c.cleanup.push(() => fault.restore());
  expect((await c.store.recover("unassigned")).recordings[0]).toMatchObject({ state: "interrupted", savedThroughMs: 1000, chunkCount: 1 });
  fault.restore();
  c.account("odysseus");
  await c.store.assign(row.id);
  const assigned = await c.store.get("account:odysseus", row.id);
  expect(assigned, "association keeps the recovered committed prefix").toMatchObject({ state: "interrupted", savedThroughMs: 1000, bytes: 1, chunkCount: 1 });
  const play = await c.store.playback("account:odysseus", row.id);
  ctx.onTestFinished(() => play.revoke());
  expect([...new Uint8Array(await (await fetch(play.url)).arrayBuffer())]).toEqual([1]);
  expect(await c.store.list("unassigned")).toEqual([]);
});

test("dismissing a removed notice deletes a witness with no playable prefix after a failed repair", async (ctx) => {
  const c = cell(ctx);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await sink.chunk(chunk(0, 1000));
  await sink.chunk(chunk(1, 2000));
  await sink.end!("user");
  const row = (await c.store.list("account:odysseus"))[0]!;
  await c.partitions.open(row.partition).write([{ delete: `recording:chunk:${row.id}:00000000` }]);
  const fault = failIndexedDbWrites({ afterBytes: 0 });
  c.cleanup.push(() => fault.restore());
  expect((await c.store.recover(row.partition)).removedCount).toBe(1);
  fault.restore();
  await c.store.dismissRemoved(row.partition);
  expect((await c.store.recover(row.partition)).removedCount, "dismissal removes the durable loss witness").toBe(0);
  expect(await c.partitions.sizes("recording:chunk:")).toEqual([]);
});

test("a transient repair failure does not count the same lost recording twice", async (ctx) => {
  const c = cell(ctx);
  const first = await saved(c);
  const second = await saved(c);
  const handle = c.partitions.open(first.partition);
  await handle.write([first, second].map((row) => ({ delete: `recording:chunk:${row.id}:00000000` })));
  const fault = failIndexedDbWrites({ next: true });
  c.cleanup.push(() => fault.restore());
  expect((await c.store.recover(first.partition)).removedCount).toBe(2);
  expect(fault.failures).toBe(1);
  fault.restore();
  expect((await c.store.recover(first.partition)).removedCount, "each lost recording is counted once").toBe(2);
});

test("caller-owned begin holds updates while the initial index transaction is pending", async (ctx) => {
  const c = cell(ctx);
  const hold = holdIndexedDbWrite((key) => Array.isArray(key) && String(key[1]).startsWith("recording:index:"));
  c.cleanup.push(() => hold.restore());
  const capture = await startLocalCapture({ sink: c.store.sink(), timesliceMs: 250 });
  ctx.onTestFinished(async () => { hold.restore(); await capture.stop("interrupted"); });
  await hold.started;
  expect(updateHeld(c.root), "pending begin owns the update hold").toBe(true);
  hold.release();
  await capture.stop("interrupted");
});

test("notice dismissal cannot delete an active recording before its first chunk", async (ctx) => {
  const c = cell(ctx);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  ctx.onTestFinished(async () => { await sink.end!("interrupted"); });
  const row = (await c.store.list("account:odysseus"))[0]!;
  await expect(c.store.dismissRemoved(row.partition), "dismissal must acquire the recording lock").rejects.toThrow("Recording in another Brain tab");
  expect(await c.store.get(row.partition, row.id)).toMatchObject({ state: "recording", chunkCount: 0 });
  await sink.chunk(chunk(0, 1000));
  await sink.end!("user");
  expect((await c.store.recover(row.partition)).recordings[0]).toMatchObject({ id: row.id, state: "saved", savedThroughMs: 1000 });
});
