import { retainRecordingProof } from "./offline/recording-proof-client.ts";
/// <reference types="@vitest/browser-playwright" />
import { expect, test, vi } from "vitest";
import { createRecordingStore, RECORDING_MAX_BYTES, RECORDING_MAX_MS } from "../../src/lib/recordings.js";
import type { LocalCaptureStopReason } from "../../src/voice/local-capture.js";
import { updateHeld } from "../../src/lib/update-holds.js";
import { generateWav, AUDIO_FIXTURES } from "./offline/audio-fixtures.ts";
import { recordingCell } from "./offline/recording-cell.ts";
import { installWavMicrophone, watchMicrophone } from "./offline/fake-microphone.ts";

/** The user-facing m:ss for committed audio, written independently of production's formatter.
 * Native capture advances in real time, so a test that does not control the clock derives the
 * expected text from the row it read rather than assuming how far capture got. */
const savedClock = (ms: number) => `${Math.floor(ms / 60_000)}:${(Math.floor(ms / 1000) % 60).toString().padStart(2, "0")}`;

test("registered production warning and deadline finalize short native audio and release capture resources", async (ctx) => {
  const c = recordingCell(ctx);
  const microphone = watchMicrophone();
  c.cleanup.push(() => microphone.restore());
  const registered = new Map<number, () => void>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const originalTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
    if ((ms === 540_000 || ms === 599_750) && typeof handler === "function") registered.set(ms, () => handler(...args));
    return originalTimeout(handler, ms, ...args);
  });
  c.cleanup.push(() => { timer.mockRestore(); Object.defineProperty(globalThis, "setTimeout", descriptor); });
  const capture = await c.store.start({ timesliceMs: 250 });
  // Native MediaRecorder, performance.now and the audio clock all advance in
  // real time. Invoking a registered callback proves its real stop path; the
  // separate controlled-timer test proves when it is scheduled. Neither this
  // short recording nor synthetic boundary blobs prove ten-minute endurance.
  await c.committed(2);
  expect(registered.has(540_000), "production warning registered at nine minutes").toBe(true);
  expect(registered.has(599_750), "production deadline registered at ten minutes").toBe(true);
  expect(updateHeld(c.root)).toBe(true);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([]);
  registered.get(540_000)!();
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([{
    kind: "warning", message: "1 minute left in this recording",
    savedThroughMs: c.events.filter((event) => event.kind === "committed").at(-1)!.savedThroughMs,
  }]);
  registered.get(599_750)!();
  expect(await capture.ended, "registered deadline invokes production limit stop").toBe("limit");
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row.state).toBe("saved");
  expect(row.savedThroughMs).toBeGreaterThan(0);
  expect(row.savedThroughMs).toBeLessThan(10_000);
  expect(row.durationMs).toBe(row.savedThroughMs);
  expect(c.events.filter((event) => event.kind === "warning")).toHaveLength(1);
  expect(c.events.at(-1)).toEqual({ kind: "stopped", savedThroughMs: row.savedThroughMs, message: "Stopped at the 10-minute limit. Your recording is saved." });
  expect(microphone.streams).toHaveLength(1);
  expect(microphone.streams[0]!.getTracks().every((track) => track.readyState === "ended")).toBe(true);
  expect(c.store.active()).toBeNull();
  expect(c.store.busy()).toBe(false);
  expect(updateHeld(c.root)).toBe(false);
  await navigator.locks.request("brain-ui:recording", { ifAvailable: true }, (lock) => {
    expect(lock, "native recording lock is released after finalization").not.toBeNull();
  });
  const reloaded = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" });
  ctx.onTestFinished(() => reloaded.dispose());
  expect((await reloaded.recover(row.partition)).recordings).toEqual([row]);
  const play = await reloaded.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  const context = new AudioContext();
  ctx.onTestFinished(() => context.close());
  const decoded = await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer());
  await retainRecordingProof("control", await (await fetch(play.url)).arrayBuffer(), { row, decodedSeconds: decoded.duration });
  expect(decoded.duration, "real encoded audio is playable").toBeGreaterThan(0.25);
  expect(Math.abs(decoded.duration * 1000 - row.savedThroughMs), "native elapsed metadata agrees with decoded audio").toBeLessThan(150);
  play.revoke();
  await expect(fetch(play.url), "playback URL is revoked after use").rejects.toThrow();
});

test("production warning and deadline fire at exactly 540000 and 599750 milliseconds", async (ctx) => {
  const c = recordingCell(ctx);
  expect(RECORDING_MAX_MS, "independent production duration oracle").toBe(600_000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await vi.advanceTimersByTimeAsync(539_999);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([]);
  expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([{ kind: "warning", message: "1 minute left in this recording", savedThroughMs: 0 }]);
  await vi.advanceTimersByTimeAsync(59_749);
  expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(stop.mock.calls, "production deadline fires exactly at 599750 ms").toEqual([["limit"]]);
  await sink.end!("limit");
  await vi.advanceTimersByTimeAsync(600_000);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(c.events.filter((event) => event.kind === "warning")).toHaveLength(1);
});

test("ending a recording cancels its timers and the next recording starts a fresh deadline", async (ctx) => {
  const c = recordingCell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const firstStop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const first = c.store.sink();
  await first.begin!({ mimeType: "audio/webm;codecs=opus", stop: firstStop });
  await vi.advanceTimersByTimeAsync(500_000);
  await first.end!("user");
  const nextStop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const next = c.store.sink();
  await next.begin!({ mimeType: "audio/webm;codecs=opus", stop: nextStop });
  await vi.advanceTimersByTimeAsync(539_999);
  expect(firstStop, "ended recording's deadline was cancelled").not.toHaveBeenCalled();
  expect(nextStop).not.toHaveBeenCalled();
  expect(c.events.filter((event) => event.kind === "warning"), "ended warning was cancelled; next warning has not elapsed").toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(c.events.filter((event) => event.kind === "warning")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(59_749);
  expect(nextStop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(nextStop.mock.calls).toEqual([["limit"]]);
  await next.end!("limit");
});

test("production chunk boundary accepts exactly 600000 ms and rejects the next millisecond durably", async (ctx) => {
  const c = recordingCell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await sink.chunk({ index: 0, startMs: 0, endMs: 599_999, data: new Blob(["a"]) });
  await expect(sink.chunk({ index: 1, startMs: 599_999, endMs: 600_000, data: new Blob(["b"]) }), "exact duration boundary commits").resolves.toBeUndefined();
  expect(stop, "exact boundary is accepted").not.toHaveBeenCalled();
  expect(c.events.filter((event) => event.kind === "committed").map((event) => event.savedThroughMs)).toEqual([599_999, 600_000]);
  await sink.chunk({ index: 2, startMs: 600_000, endMs: 600_001, data: new Blob(["c"]) });
  expect(stop.mock.calls, "first over-boundary chunk triggers limit stop").toEqual([["limit"]]);
  await sink.end!("limit");
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row).toMatchObject({ state: "saved", chunkCount: 2, bytes: 2, durationMs: 600_000, savedThroughMs: 600_000 });
  const chunks = await c.partitions.open(row.partition).list(`recording:chunk:${row.id}:`);
  expect(chunks.map((entry) => entry.value)).toMatchObject([{ index: 0, endMs: 599_999 }, { index: 1, endMs: 600_000 }]);
  const play = await c.store.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  expect(await (await fetch(play.url)).text(), "rejected chunk never becomes retained bytes").toBe("ab");
});

test("production aggregate budget accepts exactly 100 MiB and rejects one byte more without eviction", async (ctx) => {
  const c = recordingCell(ctx);
  expect(RECORDING_MAX_BYTES, "independent production byte oracle").toBe(104_857_600);
  const remaining = 480_000; // Production preflight minimum, independently specified.
  const retained = 104_857_600 - remaining;
  c.account("penelope");
  await c.partitions.open("account:penelope").put("recording:chunk:older", new Blob([new Uint8Array(retained / 2)]));
  c.account(null);
  await c.partitions.open("unassigned").put("recording:chunk:older", new Blob([new Uint8Array(retained / 2)]));
  c.account("odysseus");
  expect(await c.store.budget()).toMatchObject({ bytes: remaining, canRecord: true });
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await expect(sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array(remaining)]) }), "exact aggregate byte boundary commits").resolves.toBeUndefined();
  expect(stop, "exact 100-MiB boundary is accepted").not.toHaveBeenCalled();
  expect(await c.store.budget()).toMatchObject({ bytes: 0, canRecord: false });
  await expect(sink.chunk({ index: 1, startMs: 1000, endMs: 1001, data: new Blob(["x"]) })).rejects.toThrow("Recording storage is full");
  expect(stop.mock.calls, "first byte over the aggregate cap stops capture").toEqual([["storage"]]);
  await sink.end!("storage");
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row).toMatchObject({ state: "saved", bytes: remaining, chunkCount: 1, savedThroughMs: 1000 });
  expect(c.events.at(-1)?.message).toBe("Stopped: storage for recordings is full. Saved up to 0:01.");
  const sizes = await c.partitions.sizes("recording:chunk:");
  const audio = await c.partitions.open(row.partition).list(`recording:chunk:${row.id}:`);
  expect(audio).toHaveLength(1);
  // Partition size estimates include chunk metadata. The production limit is
  // retained audio bytes; inspect the durable Blob rather than that estimate.
  expect(retained + (audio[0]!.value as { data: Blob }).data.size).toBe(104_857_600);
  expect(sizes.find((entry) => entry.partition === "account:penelope")?.bytes).toBe(retained / 2);
  expect(sizes.find((entry) => entry.partition === "unassigned")?.bytes).toBe(retained / 2);
});


test("source starvation reports only encoded audio", async (ctx) => {
  const c = recordingCell(ctx);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s));
  c.cleanup.push(() => mic.restore());
  const start = performance.now();
  const capture = await c.store.start({ timesliceMs: 250 });
  await c.committed(2);
  await mic.contexts[0]!.suspend();
  // Kept: the starvation is real time under test. The suspended source must
  // stay silent for longer than the 800 ms margin asserted below, while the
  // wall clock runs, so no condition or fake clock can stand in for it.
  await new Promise(resolve => setTimeout(resolve, 1200));
  await mic.contexts[0]!.resume();
  await c.committed(c.committedCount() + 2);
  await capture.stop("user");
  const elapsed = performance.now() - start;
  const row = (await c.store.list("account:odysseus"))[0]!;
  const play = await c.store.playback(row.partition, row.id);
  c.cleanup.push(() => play.revoke());
  const context = new AudioContext();
  c.cleanup.push(() => context.close());
  const decoded = await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer());
  await retainRecordingProof("starvation", await (await fetch(play.url)).arrayBuffer(), { row, decodedSeconds: decoded.duration, elapsed });
  expect(decoded.duration * 1000, "source suspension did not starve encoder").toBeLessThan(elapsed - 800);
  expect(Math.abs(decoded.duration * 1000 - row.savedThroughMs), "saved duration agrees with emitted samples").toBeLessThan(150);
});

test("wall backstop fires at 660000 and retains interrupted audio", async (ctx) => {
  const c = recordingCell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const sink = c.store.sink();
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob(["a"]) });
  await vi.advanceTimersByTimeAsync(659_999);
  expect(stop.mock.calls.filter(([r]) => r === "interrupted")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(stop.mock.calls.filter(([r]) => r === "interrupted")).toEqual([["interrupted"]]);
  await sink.end!("interrupted");
  expect((await c.store.list("account:odysseus"))[0]).toMatchObject({ state: "interrupted", savedThroughMs: 1000, interruptedAt: 1000 });
});

test("resumed chunk cannot beat the overdue wall backstop", async (ctx) => {
  const c = recordingCell(ctx);
  const original = Object.getOwnPropertyDescriptor(performance, "now");
  let clock = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
  c.cleanup.push(() => { if (original) Object.defineProperty(performance, "now", original); else delete (performance as {now?: unknown}).now; });
  const sink = c.store.sink();
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob(["a"]) });
  clock = 660_000;
  await sink.chunk({ index: 1, startMs: 1000, endMs: 2000, data: new Blob(["b"]) });
  expect(stop.mock.calls).toEqual([["interrupted"]]);
  await sink.end!("interrupted");
  expect((await c.store.list("account:odysseus"))[0]).toMatchObject({ bytes: 1, chunkCount: 1, savedThroughMs: 1000, interruptedAt: 1000 });
});

test("late limit past the wall backstop retains interrupted audio without limit copy", async (ctx) => {
  const c = recordingCell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let clock = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
  c.cleanup.push(() => { if (descriptor) Object.defineProperty(performance, "now", descriptor); else delete (performance as { now?: unknown }).now; });
  const sink = c.store.sink();
  let first: LocalCaptureStopReason | undefined;
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => first ??= reason);
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!(first ?? "interrupted"); });
  await sink.chunk({ index: 0, startMs: 0, endMs: 300_000, data: new Blob(["a"]) });
  clock = 700_000;
  await vi.advanceTimersByTimeAsync(299_750);
  expect(first, "expired wall deadline takes precedence before first-stop-wins").toBe("interrupted");
  await sink.end!(first!);
  expect((await c.store.list("account:odysseus"))[0]).toMatchObject({ state: "interrupted", savedThroughMs: 300_000, interruptedAt: 300_000 });
  expect(c.events.filter(e => e.kind === "warning"), "five minutes of audio must not announce one minute left").toEqual([]);
  expect(c.events.at(-1)?.message).toBe("Recording stopped. Saved up to 5:00; the end may be missing.");
});

for (const timerKind of ["warning", "limit"]) {
test(`late ${timerKind} below backstop re-arms from short saved audio`, async (ctx) => {
  const c = recordingCell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let clock = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
  c.cleanup.push(() => { if (descriptor) Object.defineProperty(performance, "now", descriptor); else delete (performance as { now?: unknown }).now; });
  const callbacks = new Map<number, () => void>();
  const armed: number[] = [];
  const timeout = globalThis.setTimeout;
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
    if (typeof handler === "function") { callbacks.set(ms!, () => handler(...args)); armed.push(ms!); }
    return timeout(handler, ms, ...args);
  });
  c.cleanup.push(() => { timer.mockRestore(); Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor); });
  const sink = c.store.sink();
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await sink.chunk({ index: 0, startMs: 0, endMs: 10_000, data: new Blob(["a"]) });
  clock = 650_000;
  const wallCallback = callbacks.get(660_000);
  const armedBefore = armed.length;
  callbacks.get(timerKind === "warning" ? 530_000 : 589_750)!();
  // Ten seconds of saved audio leaves 530 s to the warning and 589.75 s to the limit.
  expect(armed.slice(armedBefore).filter(ms => ms === 530_000 || ms === 589_750), `late ${timerKind} re-arms both audio timers from the saved audio`).toEqual([530_000, 589_750]);
  expect(c.events.filter(e => e.kind === "warning"), "late warning does not mistake elapsed wall for audio").toEqual([]);
  expect(stop, "late limit does not save ten seconds as ten minutes").not.toHaveBeenCalled();
  expect(c.events.filter(e => e.kind === "stopped")).toEqual([]);
  expect(callbacks.get(660_000), "independent wall backstop was not re-armed").toBe(wallCallback);
  wallCallback!();
  expect(stop.mock.calls).toEqual([["interrupted"]]);
  await sink.end!("interrupted");
});

}

test("registered wall backstop finalizes native audio as interrupted", async (ctx) => {
  const c = recordingCell(ctx);
  const microphone = watchMicrophone();
  c.cleanup.push(() => microphone.restore());
  const registered = new Map<number, () => void>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const originalTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
    if ((ms === 540_000 || ms === 599_750 || ms === 660_000) && typeof handler === "function") registered.set(ms, () => handler(...args));
    return originalTimeout(handler, ms, ...args);
  });
  c.cleanup.push(() => { timer.mockRestore(); Object.defineProperty(globalThis, "setTimeout", descriptor); });
  const capture = await c.store.start({ timesliceMs: 250 });
  // Native MediaRecorder, performance.now and the audio clock all advance in
  // real time. Invoking a registered callback proves its real stop path; the
  // separate controlled-timer test proves when it is scheduled. Neither this
  // short recording nor synthetic boundary blobs prove ten-minute endurance.
  await c.committed(2);
  expect(registered.has(540_000), "production warning registered at nine minutes").toBe(true);
  expect(registered.has(599_750), "production deadline registered at ten minutes").toBe(true);
  expect(updateHeld(c.root)).toBe(true);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([]);
  registered.get(540_000)!();
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([{
    kind: "warning", message: "1 minute left in this recording",
    savedThroughMs: c.events.filter((event) => event.kind === "committed").at(-1)!.savedThroughMs,
  }]);
  registered.get(660_000)!();
  expect(await capture.ended, "registered deadline invokes production limit stop").toBe("interrupted");
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row.state).toBe("interrupted");
  expect(row.savedThroughMs).toBeGreaterThan(0);
  expect(row.savedThroughMs).toBeLessThan(10_000);
  expect(row.durationMs).toBe(row.savedThroughMs);
  expect(c.events.filter((event) => event.kind === "warning")).toHaveLength(1);
  expect(c.events.at(-1)).toEqual({ kind: "stopped", savedThroughMs: row.savedThroughMs, message: `Recording stopped. Saved up to ${savedClock(row.savedThroughMs)}; the end may be missing.` });
  expect(microphone.streams).toHaveLength(1);
  expect(microphone.streams[0]!.getTracks().every((track) => track.readyState === "ended")).toBe(true);
  expect(c.store.active()).toBeNull();
  expect(c.store.busy()).toBe(false);
  expect(updateHeld(c.root)).toBe(false);
  await navigator.locks.request("brain-ui:recording", { ifAvailable: true }, (lock) => {
    expect(lock, "native recording lock is released after finalization").not.toBeNull();
  });
  const reloaded = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" });
  ctx.onTestFinished(() => reloaded.dispose());
  expect((await reloaded.recover(row.partition)).recordings).toEqual([row]);
  const play = await reloaded.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  const context = new AudioContext();
  ctx.onTestFinished(() => context.close());
  const decoded = await context.decodeAudioData(await (await fetch(play.url)).arrayBuffer());
  expect(decoded.duration, "real encoded audio is playable").toBeGreaterThan(0.25);
  expect(Math.abs(decoded.duration * 1000 - row.savedThroughMs), "native elapsed metadata agrees with decoded audio").toBeLessThan(150);
  play.revoke();
  await expect(fetch(play.url), "playback URL is revoked after use").rejects.toThrow();
});

test("late limit at the committed flush target stops without a zero-delay re-arm loop", async (ctx) => {
  const c = recordingCell(ctx);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let clock = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
  c.cleanup.push(() => { if (descriptor) Object.defineProperty(performance, "now", descriptor); else delete (performance as { now?: unknown }).now; });
  const sink = c.store.sink();
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  c.cleanup.push(async () => { await sink.end!("interrupted"); });
  await sink.chunk({ index: 0, startMs: 0, endMs: 599_750, data: new Blob(["a"]) });
  clock = 650_000;
  await vi.advanceTimersByTimeAsync(0);
  expect(stop.mock.calls).toEqual([["limit"]]);
  await sink.end!("limit");
});

test("caller stop at expired wall deadline normalizes before first-stop-wins", async (ctx) => {
  const c = recordingCell(ctx);
  const capture = await c.store.start({ timesliceMs: 250 });
  await c.committed(2);
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", { configurable: true, value: () => 1e12 });
  c.cleanup.push(() => { if (descriptor) Object.defineProperty(performance, "now", descriptor); else delete (performance as { now?: unknown }).now; });
  expect(await capture.stop("user")).toBe("interrupted");
  expect(await capture.stop("limit")).toBe("interrupted");
  expect((await c.store.list("account:odysseus"))[0]?.state).toBe("interrupted");
});
