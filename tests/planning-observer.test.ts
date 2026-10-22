/** Real native observer controls with an owned process census and bounded CPU work. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedControl, runControl } from "./helpers/planning-control";
import { observePlanning, type PlanningRecord } from "./helpers/planning-observer";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function output() { const dir = mkdtempSync(join(tmpdir(), "planning-observer-")); scratch.push(dir); return dir; }
interface Control {
  result?: unknown;
  sameError: boolean;
  unwritableResult?: unknown;
  observation: PlanningRecord;
  competitorPids: number[];
  namespace: string;
  remaining: number[];
}
async function control(mode: string, dir = output()): Promise<Control> {
  const child = await runControl(mode, dir);
  expect(child.exit, child.stderr || child.stdout).toBe(0);
  const result = JSON.parse(child.stdout) as Control;
  for (const pid of result.competitorPids) expect(result.remaining, "OWNED_COMPETITOR_REAPED").not.toContain(pid);
  console.info("PLANNING_CONTROL_RECEIPT", JSON.stringify({ mode, ...result }));
  return result;
}

// Native namespaces are already a required Linux proof prerequisite. Never fall back to host /proc.
test.skipIf(process.platform !== "linux")("a busy call is reported as main-thread CPU, and its result passes through", async () => {
  const { result, observation: record } = await control("busy");
  expect(result, "OBSERVER_RETURNS_THE_CALL_RESULT").toBe("Ithaca");
  expect(record.outcome).toBe("returned");
  expect(record.incomplete, "CONTROLLED_RECORD_IS_COMPLETE").toEqual([]);
  expect(record.wallMs).toBeGreaterThanOrEqual(590);
  expect(record.mainThread!.cpuMs, "BUSY_CALL_IS_MAIN_THREAD_CPU").toBeGreaterThanOrEqual(500);
  expect(record.samples.length, "SAMPLER_RUNS_WHILE_THE_CALL_BLOCKS").toBeGreaterThanOrEqual(2);
});

test.skipIf(process.platform !== "linux")("complete records exclude eleven real busy processes outside the owned PID namespace", async () => {
  const dir = output();
  const measured = await control("outside-census", dir);
  const outside = JSON.parse(readFileSync(join(dir, "outside.json"), "utf8"));
  expect(outside.count).toBe(11);
  expect(outside.namespace, "EXTERNAL_CENSUS_IS_A_DIFFERENT_NAMESPACE").not.toBe(measured.namespace);
  for (let i = 0; i < 11; i++) {
    expect(JSON.parse(readFileSync(join(dir, `done-${i}`), "utf8")).cpuMs, "EXTERNAL_PROCESS_DID_REAL_CPU_WORK").toBeGreaterThanOrEqual(80);
  }
  expect(measured.observation.incomplete, "EXTERNAL_CENSUS_CANNOT_TRUNCATE_COMPLETE_RECORD").toEqual([]);
  expect(measured.result).toBe("Ithaca");
});

test.skipIf(process.platform !== "linux")("a blocked call is wall time without main-thread CPU", async () => {
  const { observation: record } = await control("blocked");
  expect(record.incomplete).toEqual([]);
  expect(record.wallMs).toBeGreaterThanOrEqual(490);
  expect(record.mainThread!.cpuMs, "BLOCKED_CALL_IS_NOT_CPU").toBeLessThan(100);
  // Host scheduling may delay wake-up. Run-queue time is distinct from the actual blocked interval.
  expect(record.wallMs - record.mainThread!.cpuMs - record.mainThread!.runQueueWaitMs,
    "BLOCKED_CALL_HAS_REAL_OFF_CPU_TIME").toBeGreaterThanOrEqual(450);
});

test.skipIf(process.platform !== "linux")("a synchronous child's CPU is reported as waited-for child CPU", async () => {
  const { observation: record } = await control("child");
  expect(record.incomplete).toEqual([]);
  expect(record.waitedChildrenCpuMs, "SYNC_CHILD_CPU_IS_COUNTED").toBeGreaterThanOrEqual(300);
});

test.skipIf(process.platform !== "linux")("a competing process busy during the call is named with its CPU", async () => {
  const { observation: record, competitorPids } = await control("competitor");
  expect(record.incomplete).toEqual([]);
  const named = record.processes.find(row => row.pid === competitorPids[0]);
  expect(named, "COMPETING_PROCESS_IS_NAMED").toBeDefined();
  expect(named!.cpuMs, "COMPETING_PROCESS_CPU_IS_COUNTED").toBeGreaterThanOrEqual(600);
  expect(named!.self).toBe(false);
  expect(named!.newDuringWindow).toBe(false);
});

for (const mode of ["cap-return", "cap-throw"]) {
  test.skipIf(process.platform !== "linux")(`${mode}: eleven real competitors stay capped and incomplete without changing the outcome`, async () => {
    const measured = await control(mode);
    const record = measured.observation;
    expect(record.limits.maxProcesses, "PRODUCTION_PROCESS_CAP_UNCHANGED").toBe(10);
    expect(record.processes.length, "PROCESS_CENSUS_STAYS_BOUNDED").toBe(10);
    expect(record.incomplete, "TRUNCATED_PROCESS_CENSUS_IS_INCOMPLETE").toEqual(["more than 10 busy processes; only the busiest are listed"]);
    expect(record.processes.some(row => measured.competitorPids.includes(row.pid))).toBe(true);
    expect(record.outcome).toBe(mode === "cap-return" ? "returned" : "threw");
    if (mode === "cap-return") expect(measured.result, "INCOMPLETE_OBSERVER_RETURNS_RESULT").toBe("Ithaca");
    else expect(measured.sameError, "INCOMPLETE_OBSERVER_RETHROWS_ORIGINAL_ERROR").toBe(true);
  });
}

test("a throwing call rethrows its own error, and an unwritable record never changes the outcome", async () => {
  if (process.platform !== "linux") {
    const failure = new Error("Scylla");
    await expect(observePlanning("/unused", "throws", () => { throw failure; }, output())).rejects.toBe(failure);
    expect(await observePlanning("/unused", "unwritable", () => 7, "/unused")).toBe(7);
    return;
  }
  const measured = await control("throws");
  expect(measured.sameError, "OBSERVER_RETHROWS_ORIGINAL_ERROR").toBe(true);
  expect(measured.observation.outcome).toBe("threw");
  expect(measured.unwritableResult, "WRITE_FAILURE_IS_IGNORED").toBe(7);
});

test.skipIf(process.platform !== "linux")("a failed observation cleans owned competitors and leaves an unrelated sibling alive", async () => {
  const sibling = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 15000)"], { stdout: "pipe", stderr: "pipe" });
  const drained = Promise.all([new Response(sibling.stdout).text(), new Response(sibling.stderr).text(), sibling.exited]);
  try {
    const measured = await control("cleanup-failure");
    expect(measured.sameError).toBe(true);
    expect(measured.competitorPids.length).toBe(1);
    expect(sibling.exitCode, "UNRELATED_SIBLING_SURVIVES_OWNED_CLEANUP").toBeNull();
    expect(() => process.kill(sibling.pid, 0)).not.toThrow();
  } finally { sibling.kill("SIGKILL"); await drained; }
});


test.skipIf(process.platform !== "linux")("cancelling an owned namespace drains both pipes and removes its descendants", async () => {
  const dir = output();
  const child = Bun.spawn(isolatedControl("hold", dir), { stdout: "pipe", stderr: "pipe" });
  const drained = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const deadline = performance.now() + 5_000;
    while (!existsSync(join(dir, "holding")) && performance.now() < deadline) await Bun.sleep(5);
    expect(existsSync(join(dir, "holding")), "OWNED_DESCENDANT_STARTED_BEFORE_CANCELLATION").toBe(true);
    const namespace = readFileSync(join(dir, "holding"), "utf8");
    child.kill("SIGKILL");
    await drained; // A descendant retaining either pipe prevents this from completing.
    const living = () => readdirSync("/proc").filter(pid => {
      if (!/^\d+$/.test(pid)) return false;
      try { return readlinkSync(`/proc/${pid}/ns/pid`) === namespace; } catch { return false; }
    });
    // EOF can precede the kernel finishing PID-namespace teardown. Await that
    // specific owned completion as well; this is not a retry of the observation.
    const cleanupDeadline = performance.now() + 2_000;
    let survivors = living();
    while (survivors.length && performance.now() < cleanupDeadline) { await Bun.sleep(5); survivors = living(); }
    expect(survivors, "CANCELLED_NAMESPACE_HAS_NO_LIVING_DESCENDANTS").toEqual([]);
    expect(child.signalCode, "CANCELLATION_REACHED_OWNED_PROCESS").toBe("SIGKILL");
  } finally { clearTimeout(timeout); child.kill("SIGKILL"); await drained; }
});
