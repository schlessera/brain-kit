import { expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createWorkerSpawn } from "../src/worker-spawn.js";

async function exerciseObserver(timing: NonNullable<StartTurnRequest["startupTiming"]>, initializedBeforeSpawn = false) {
  const root = mkdtempSync(join(tmpdir(), "ithaca-startup-observer-")), brain = join(root, "brain"); mkdirSync(brain);
  const stateRoot = join(root, "state"); mkdirSync(stateRoot);
  const ledger = internal.createStateLedger(), reservations: ReturnType<typeof ledger.reserve>[] = [];
  const reserve = ledger.reserve.bind(ledger);
  const reserved = spyOn(ledger, "reserve").mockImplementation((...args) => { const held = reserve(...args); reservations.push(held); return held; });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const exited = Promise.withResolvers<number>(), started = Promise.withResolvers<"started" | "error">();
  let stateClosed = 0, tempClosed = 0, released = 0;
  const finish = () => { stderr.end(); stdout.end(); exited.resolve(0); };
  const host = spyOn(internal, "requireWorkerHostAsync").mockResolvedValue({ ok: true });
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async () => ({ stdin, stdout, stderr,
    exited: exited.promise, kill: finish, released: async () => { released++; }, limitReport: () => ({ hits: [], fatal: false }),
    state: { root: stateRoot, space: () => ({ free: 1024 * 1024 }), closeAsync: async () => { stateClosed++; } },
    turnTemp: { root: stateRoot, closeAsync: async () => { tempClosed++; } },
  }) as unknown as internal.LaunchedWorker);
  try {
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, { inferenceDir: root }, undefined, undefined, undefined,
      { ledger, startupTiming: timing, limits: { allowanceBytes: 4 * 1024 * 1024, budgetBytes: 8 * 1024 * 1024 },
        turnTempLimits: { allowanceBytes: 1024 * 1024, budgetBytes: 2 * 1024 * 1024 } }, undefined, () => started.resolve("started"));
    if (initializedBeforeSpawn) spawner.sdkInitialized();
    const child = spawner.spawn({ command: "/bin/true", args: [], env: { HOME: root }, signal: new AbortController().signal } as never);
    child.on("error", () => started.resolve("error")); child.stdout.resume(); child.stdin.end();
    const outcome = await started.promise;
    expect(outcome, "TIMING_OBSERVER_MUST_NOT_ORPHAN_WORKER").toBe("started");
    spawner.sdkInitialized(); child.kill("SIGKILL"); await spawner.finish();
    expect({ stateClosed, tempClosed, released, live: ledger.live }, "TIMING_OBSERVER_PRESERVES_CLEANUP_OWNERSHIP")
      .toEqual({ stateClosed: 1, tempClosed: 1, released: 1, live: 0 });
  } finally {
    finish(); stdin.destroy(); stdout.destroy(); stderr.destroy();
    for (const held of reservations) held.release();
    launch.mockRestore(); host.mockRestore(); reserved.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
}

for (const fault of ["worker_launch:start", "worker_launch:end", "runtime_to_sdk_init:start"] as const) {
  test(`a throwing ${fault} observer cannot orphan the launched worker or its reservation`, async () => {
    await exerciseObserver({ start(name) {
      if (`${name}:start` === fault) throw Error("Ithaca timing unavailable");
      return () => { if (`${name}:end` === fault) throw Error("Ithaca timing unavailable"); };
    }, missing() {}, worker() {}, received() {} });
  });
}

test("initialization observed before worker launch never invents a runtime-to-SDK interval", async () => {
  const names: string[] = [], missing: string[] = [];
  await exerciseObserver({ start(name) { names.push(name); return () => {}; }, missing(name) { missing.push(name); }, worker() {}, received() {} }, true);
  expect(names, "EARLY_HANDSHAKE_CANNOT_START_LATE_SDK_TIMING").toEqual(["worker_host_probe", "worker_launch"]);
  expect(missing).toEqual(["runtime_to_sdk_init"]);
});
