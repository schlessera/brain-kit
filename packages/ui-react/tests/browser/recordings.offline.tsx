/// <reference types="@vitest/browser-playwright" />
import { expect, test, vi, type TestContext } from "vitest";
import { createBrainUiRoot } from "../../src/root.js";
import { createLocalPartitions } from "../../src/lib/local-partitions.js";
import { createRecordingStore, type RecordingRecovery, type RecordingEvent } from "../../src/lib/recordings.js";
import { updateHeld } from "../../src/lib/update-holds.js";
import { failIndexedDbWrites, holdIndexedDbWrite } from "./offline/indexeddb-faults.ts";
import { openScene } from "./offline/scene.ts";
import { AUDIO_FIXTURES, generateWav } from "./offline/audio-fixtures.ts";
import { installWavMicrophone } from "./offline/fake-microphone.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sceneUrl = new URL("./offline/scenes/recordings.scene.ts", import.meta.url);
function cell(ctx: TestContext) {
  let held: string | null = "odysseus";
  const name = `odysseus-recordings-${crypto.randomUUID()}`;
  const partitions = createLocalPartitions({ name, heldAccountKey: () => held });
  const root = createBrainUiRoot({ storage: null });
  const store = createRecordingStore({ root, partitions, heldAccountKey: () => held });
  const events: RecordingEvent[] = [];
  store.onEvent((event) => events.push(event));
  ctx.onTestFinished(async () => { await store.stop("interrupted"); store.dispose(); root.dispose(); });
  return { root, partitions, store, events, account: (key: string | null) => { held = key; } };
}
function chunk(index: number, endMs: number, bytes = 4) {
  return { index, startMs: index * 1000, endMs, data: new Blob([new Uint8Array(bytes)]) };
}
async function saved(c: ReturnType<typeof cell>, partition = "account:odysseus" as const) {
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  await sink.chunk(chunk(0, 1000));
  await sink.end!("user");
  return (await c.store.list(partition))[0]!;
}

test("sink construction persists nothing, and recovery never opens the microphone", async (ctx) => {
  const c = cell(ctx);
  const mic = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  ctx.onTestFinished(() => mic.mockRestore());
  c.store.sink();
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
  ctx.onTestFinished(() => hold.restore());
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
    ctx.onTestFinished(() => fault.restore());
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
  const partial = await saved(c);
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
  await expect(c.store.assign(row.id)).rejects.toThrow("Sign in");
  c.account("odysseus");
  await c.store.assign(row.id);
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
  ctx.onTestFinished(() => hold.restore());
  await hold.started;
  const previous = c.events.filter((e) => e.kind === "committed").at(-1)!.savedThroughMs;
  const stopping = c.store.stop("auth");
  await wait(100);
  expect(updateHeld(c.root)).toBe(true);
  hold.release();
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
  expect(c.events.filter((e) => e.kind === "warning")).toHaveLength(1);
  expect(c.events.at(-1)?.message).toBe("Stopped at the 10-minute limit. Your recording is saved.");
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row.savedThroughMs).toBeGreaterThan(598_000);
  expect(row.savedThroughMs).toBeLessThanOrEqual(600_000);
  const play = await c.store.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  const context = new AudioContext();
  ctx.onTestFinished(() => context.close());
  const decoded = await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer());
  expect(decoded.duration).toBeGreaterThan(598);
  expect(decoded.duration).toBeLessThanOrEqual(600.1);
}, 650_000);
