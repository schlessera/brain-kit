import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readPiWorkerProtocol, type PiWorkerReader } from "../src/worker-reader.js";

test("validated Pi worker startup messages reach host timing with their original durations", async () => {
  const phases: Array<{ name: string; durationMs: number }> = [];
  const messages = [
    { type: "startup_timing", phase: "worker_started", durationMs: 610 },
    { type: "startup_timing", phase: "resources", durationMs: 31 },
    { type: "startup_timing", phase: "session", durationMs: 47 },
    { type: "startup_timing", phase: "initialize", durationMs: 52 },
    { type: "done", cost: 0 },
  ];
  const stdout = Readable.from(messages.map(message => Buffer.from(JSON.stringify(message) + "\n")));
  const done = Promise.withResolvers<void>();
  const reader = { child: { stdout }, state: { active: true, initialized: true, ended: false }, backend: {}, startupStarted: 0,
    startupTiming: { worker(name: string, durationMs: number) { phases.push({ name, durationMs }); } },
    done, nativeVersions: { cancelPending() {} }, reportLimitHits() {},
  } as unknown as PiWorkerReader;
  try {
    await readPiWorkerProtocol(reader); await done.promise;
    expect(reader.state.ended).toBe(true);
    expect(phases, "PI_WORKER_PHASES_REACH_HOST_TIMING").toEqual([
      { name: "bootstrap_imports", durationMs: 610 }, { name: "resources", durationMs: 31 },
      { name: "session", durationMs: 47 }, { name: "initialize", durationMs: 52 },
    ]);
  } finally { stdout.destroy(); }
});
