import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readPiWorkerProtocol, type PiWorkerReader } from "../src/worker-reader.js";

const startup = [
  { type: "startup_timing", phase: "worker_started", durationMs: 610 },
  { type: "startup_timing", phase: "resources", durationMs: 31 },
  { type: "startup_timing", phase: "session", durationMs: 47 },
  { type: "startup_timing", phase: "initialize", durationMs: 52 },
];

async function readStartup(beforeReady: object[], afterReady: object[] = []) {
  const phases: Array<{ name: string; durationMs: number }> = [];
  const logs: string[] = [];
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const messages = [...beforeReady, { type: "ready", sessionId, levels: ["off"], cost: 0 }, ...afterReady, { type: "done", cost: 0 }];
  const stdout = Readable.from(messages.map(message => Buffer.from(JSON.stringify(message) + "\n")));
  const done = Promise.withResolvers<void>();
  const state = { active: false, initialized: false, ended: false };
  const reader = { child: { stdout }, state, sessionId, backend: { log(_level: string, _message: string, meta: { phase?: string }) { if (meta.phase) logs.push(meta.phase); } }, startupStarted: 0,
    startupTiming: { worker(name: string, durationMs: number) { phases.push({ name, durationMs }); } },
    ready: { resolve() { state.active = true; } }, proof: { loaded() {} },
    done, nativeVersions: { cancelPending() {} }, reportLimitHits() {},
  } as unknown as PiWorkerReader;
  try {
    await readPiWorkerProtocol(reader); await done.promise;
    expect(reader.state.ended).toBe(true);
    return { phases, logs };
  } finally { stdout.destroy(); }
}

test("validated Pi worker startup messages reach host timing with their original durations", async () => {
  const { phases } = await readStartup(startup);
  expect(phases, "PI_WORKER_PHASES_REACH_HOST_TIMING").toEqual([
    { name: "bootstrap_imports", durationMs: 610 }, { name: "resources", durationMs: 31 },
    { name: "session", durationMs: 47 }, { name: "initialize", durationMs: 52 },
  ]);
});

test("duplicate Pi startup reports are bounded and retain the first observation for each worker", async () => {
  const repeated = Array.from({ length: 2000 }, () => ({ ...startup[0], durationMs: 999 }));
  const { phases, logs } = await readStartup([startup[0]!, ...repeated, ...startup.slice(1)]);
  expect(phases, "PI_STARTUP_REPORTS_ARE_BOUNDED").toHaveLength(4);
  expect(logs).toEqual(["worker_started", "resources", "session", "initialize"]);
  expect(phases[0]).toEqual({ name: "bootstrap_imports", durationMs: 610 });
  const nextWorker = await readStartup(startup);
  expect(nextWorker.phases).toHaveLength(4);
});

test("Pi startup evidence stops at readiness even for a phase not reported earlier", async () => {
  const { phases, logs } = await readStartup([startup[0]!], [startup[1]!]);
  expect(phases, "PI_STARTUP_REPORTS_END_AT_READINESS").toEqual([{ name: "bootstrap_imports", durationMs: 610 }]);
  expect(logs).toEqual(["worker_started"]);
});
