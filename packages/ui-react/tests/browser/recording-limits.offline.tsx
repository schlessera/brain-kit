/// <reference types="@vitest/browser-playwright" />
import { expect, test, vi } from "vitest";
import { createRecordingStore, RECORDING_MAX_BYTES, RECORDING_MAX_MS } from "../../src/lib/recordings.js";
import type { LocalCaptureStopReason } from "../../src/voice/local-capture.js";
import { updateHeld } from "../../src/lib/update-holds.js";
import { recordingCell } from "./offline/recording-cell.ts";
import { watchMicrophone } from "./offline/fake-microphone.ts";

test("registered production warning and deadline finalize short native audio and release capture resources", async (ctx) => {
  const c = recordingCell(ctx);
  const microphone = watchMicrophone();
  c.cleanup.push(() => microphone.restore());
  const registered = new Map<number, () => void>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const originalTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
    if ((ms === 540_000 || ms === 600_000) && typeof handler === "function") registered.set(ms, () => handler(...args));
    return originalTimeout(handler, ms, ...args);
  });
  c.cleanup.push(() => { timer.mockRestore(); Object.defineProperty(globalThis, "setTimeout", descriptor); });
  const capture = await c.store.start({ timesliceMs: 250 });
  // Native MediaRecorder, performance.now and the audio clock all advance in
  // real time. Invoking a registered callback proves its real stop path; the
  // separate controlled-timer test proves when it is scheduled. Neither this
  // short recording nor synthetic boundary blobs prove ten-minute endurance.
  await expect.poll(() => c.events.filter((event) => event.kind === "committed").length).toBeGreaterThanOrEqual(2);
  expect(registered.has(540_000), "production warning registered at nine minutes").toBe(true);
  expect(registered.has(600_000), "production deadline registered at ten minutes").toBe(true);
  expect(updateHeld(c.root)).toBe(true);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([]);
  registered.get(540_000)!();
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([{
    kind: "warning", message: "1 minute left in this recording",
    savedThroughMs: c.events.filter((event) => event.kind === "committed").at(-1)!.savedThroughMs,
  }]);
  registered.get(600_000)!();
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
  expect(decoded.duration, "real encoded audio is playable").toBeGreaterThan(0.25);
  expect(Math.abs(decoded.duration * 1000 - row.savedThroughMs), "native elapsed metadata agrees with decoded audio").toBeLessThan(150);
  play.revoke();
  await expect(fetch(play.url), "playback URL is revoked after use").rejects.toThrow();
});

test("production warning and deadline fire at exactly 540000 and 600000 milliseconds", async (ctx) => {
  const c = recordingCell(ctx);
  expect(RECORDING_MAX_MS, "independent production duration oracle").toBe(600_000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  c.cleanup.push(() => vi.useRealTimers());
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
  await vi.advanceTimersByTimeAsync(539_999);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([]);
  expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(c.events.filter((event) => event.kind === "warning")).toEqual([{ kind: "warning", message: "1 minute left in this recording", savedThroughMs: 0 }]);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(stop.mock.calls, "production deadline fires exactly at 600000 ms").toEqual([["limit"]]);
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
  await vi.advanceTimersByTimeAsync(59_999);
  expect(nextStop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(nextStop.mock.calls).toEqual([["limit"]]);
  await next.end!("limit");
});

test("production chunk boundary accepts exactly 600000 ms and rejects the next millisecond durably", async (ctx) => {
  const c = recordingCell(ctx);
  const stop = vi.fn(async (reason: LocalCaptureStopReason) => reason);
  const sink = c.store.sink();
  await sink.begin!({ mimeType: "audio/webm;codecs=opus", stop });
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
