/// <reference types="@vitest/browser-playwright" />
import { expect, test } from "vitest";
import type { LocalCaptureChunk } from "../../src/voice/local-capture.js";
import { updateHeld } from "../../src/lib/update-holds.js";
import { recordingCell } from "./offline/recording-cell.ts";
import { AUDIO_FIXTURES, generateWav } from "./offline/audio-fixtures.ts";
import { installWavMicrophone, watchMicrophone } from "./offline/fake-microphone.ts";

// Required native accumulation/decode proof. Ordinary limit correctness lives
// in recording-limits.offline.tsx; its short media run is not endurance proof.
test("ten-minute native endurance preserves sustained commits, full-length decode and resource cleanup", async (ctx) => {
  const c = recordingCell(ctx);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10m05s));
  c.cleanup.push(() => mic.restore());
  const microphone = watchMicrophone();
  c.cleanup.push(() => microphone.restore());
  const started = performance.now();
  const capture = await c.store.start();
  expect(await capture.ended).toBe("limit");
  expect(performance.now() - started).toBeLessThan(605_000);
  const row = (await c.store.list("account:odysseus"))[0]!;
  expect(row.savedThroughMs, "capture reaches the ten-minute boundary").toBeGreaterThan(598_000);
  expect(row.savedThroughMs).toBeLessThanOrEqual(600_000);
  expect(c.events.filter((e) => e.kind === "warning")).toHaveLength(1);
  expect(c.events.at(-1)?.message).toBe("Stopped at the 10-minute limit. Your recording is saved.");
  expect(row.state).toBe("saved");
  const commits = c.events.filter((event) => event.kind === "committed");
  const chunks = (await c.partitions.open(row.partition).list(`recording:chunk:${row.id}:`))
    .map((entry) => entry.value as LocalCaptureChunk).sort((a, b) => a.index - b.index);
  // Hundreds of sequential native writes and a full-size concatenation/hash
  // are the endurance obligations that the short callback proof cannot cover.
  expect(chunks.length, "sustained native commits across the full recording").toBeGreaterThan(500);
  expect(row.chunkCount).toBe(chunks.length);
  expect(commits.map((event) => event.savedThroughMs)).toEqual(chunks.map((chunk) => chunk.endMs));
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.index).toBe(index);
    expect(chunk.startMs).toBe(index === 0 ? 0 : chunks[index - 1]!.endMs);
    expect(chunk.endMs).toBeGreaterThan(chunk.startMs);
    expect(chunk.endMs).toBeLessThanOrEqual(600_000);
    expect(chunk.data.size).toBeGreaterThan(0);
  }
  expect(row.savedThroughMs).toBe(chunks.at(-1)!.endMs);
  expect(row.bytes).toBe(chunks.reduce((sum, chunk) => sum + chunk.data.size, 0));
  expect(row.bytes).toBeLessThanOrEqual(104_857_600);
  expect(microphone.streams).toHaveLength(1);
  expect(microphone.streams[0]!.getTracks().every((track) => track.readyState === "ended")).toBe(true);
  expect(c.store.busy()).toBe(false);
  expect(c.store.active()).toBeNull();
  expect(updateHeld(c.root)).toBe(false);
  await navigator.locks.request("brain-ui:recording", { ifAvailable: true }, (lock) => expect(lock).not.toBeNull());
  const play = await c.store.playback(row.partition, row.id);
  ctx.onTestFinished(() => play.revoke());
  const context = new AudioContext();
  ctx.onTestFinished(() => context.close());
  const bytes = await (await fetch(play.url)).arrayBuffer();
  expect(bytes.byteLength).toBe(row.bytes);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  expect(digest, "all retained encoded chunks participate in the final hash").toBe(row.contentHash);
  const decoded = await context.decodeAudioData(bytes);
  console.info("recording endurance", JSON.stringify({ elapsedMs: performance.now() - started, chunks: row.chunkCount, bytes: row.bytes, savedThroughMs: row.savedThroughMs, decodedSeconds: decoded.duration }));
  expect(decoded.duration).toBeGreaterThan(598);
  expect(decoded.duration).toBeLessThanOrEqual(600.1);
  play.revoke();
  await expect(fetch(play.url), "full-length playback URL is released").rejects.toThrow();
}, 650_000);
