/**
 * Offline controls for the #2465 planning observer: it must be transparent to
 * the observed call, and each quantity it reports must move when, and only
 * when, the condition it claims to measure is present.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observePlanning, type PlanningRecord } from "./helpers/planning-observer";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function output() { const dir = mkdtempSync(join(tmpdir(), "planning-observer-")); scratch.push(dir); return dir; }
const record = (dir: string, label: string): PlanningRecord => JSON.parse(readFileSync(join(dir, `${label}-${process.pid}.json`), "utf8"));
const busy = (ms: number) => { const end = performance.now() + ms; let spins = 0; while (performance.now() < end) spins++; return spins; };
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test.skipIf(process.platform !== "linux")("a busy call is reported as main-thread CPU, and its result passes through", async () => {
  const dir = output();
  const result = await observePlanning("/unused", "busy", () => { busy(600); return "Ithaca"; }, dir);
  expect(result, "OBSERVER_RETURNS_THE_CALL_RESULT").toBe("Ithaca");
  const busyRecord = record(dir, "busy");
  expect(busyRecord.outcome).toBe("returned");
  expect(busyRecord.incomplete).toEqual([]);
  expect(busyRecord.wallMs).toBeGreaterThanOrEqual(590);
  expect(busyRecord.mainThread!.cpuMs, "BUSY_CALL_IS_MAIN_THREAD_CPU").toBeGreaterThan(busyRecord.wallMs * 0.6);
  expect(busyRecord.samples.length, "SAMPLER_RUNS_WHILE_THE_CALL_BLOCKS").toBeGreaterThanOrEqual(2);
});

test.skipIf(process.platform !== "linux")("a blocked call is wall time without main-thread CPU", async () => {
  const dir = output();
  await observePlanning("/unused", "sleep", () => sleep(500), dir);
  const sleepRecord = record(dir, "sleep");
  expect(sleepRecord.wallMs).toBeGreaterThanOrEqual(490);
  expect(sleepRecord.mainThread!.cpuMs, "BLOCKED_CALL_IS_NOT_CPU").toBeLessThan(100);
  expect(sleepRecord.mainThread!.runQueueWaitMs, "BLOCKED_CALL_IS_NOT_RUN_QUEUE_WAIT").toBeLessThan(100);
});

test.skipIf(process.platform !== "linux")("a synchronous child's CPU is reported as waited-for child CPU", async () => {
  const dir = output();
  await observePlanning("/unused", "child", () => Bun.spawnSync([process.execPath, "-e", "const end = Date.now() + 500; while (Date.now() < end) {}"]), dir);
  expect(record(dir, "child").waitedChildrenCpuMs, "SYNC_CHILD_CPU_IS_COUNTED").toBeGreaterThanOrEqual(300);
});

test.skipIf(process.platform !== "linux")("a competing process busy during the call is named with its CPU", async () => {
  const dir = output();
  const competitor = Bun.spawn([process.execPath, "-e", "const end = Date.now() + 4000; while (Date.now() < end) {}"]);
  try {
    await Bun.sleep(200);
    await observePlanning("/unused", "competitor", () => sleep(1_000), dir);
    const named = record(dir, "competitor").processes.find(row => row.pid === competitor.pid);
    expect(named, "COMPETING_PROCESS_IS_NAMED").toBeDefined();
    expect(named!.cpuMs, "COMPETING_PROCESS_CPU_IS_COUNTED").toBeGreaterThanOrEqual(600);
    expect(named!.self).toBe(false);
  } finally { competitor.kill("SIGKILL"); await competitor.exited; }
});

test("a throwing call rethrows its own error, and an unwritable record never changes the outcome", async () => {
  const dir = output();
  const failure = new Error("Scylla");
  await expect(observePlanning("/unused", "throws", () => { throw failure; }, dir)).rejects.toBe(failure);
  if (process.platform === "linux") expect(record(dir, "throws").outcome).toBe("threw");
  const blocked = join(output(), "file");
  writeFileSync(blocked, "");
  expect(await observePlanning("/unused", "unwritable", () => 7, join(blocked, "under-a-file")), "WRITE_FAILURE_IS_IGNORED").toBe(7);
  expect(readdirSync(dir).length).toBeLessThanOrEqual(1);
});
