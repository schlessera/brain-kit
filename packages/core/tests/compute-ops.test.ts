/**
 * The shared compute operation set behind `brain compute` and
 * `brain_compute_*` (#3107), in process with the offline memory provider and
 * a fake clock: envelopes, refusals that allocate nothing, the governance
 * policy as data-to-provider rules, the per-job retain choice, the MCP
 * background driver, and that neither wrapper reaches past the operation set.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { attach, describeCost, runExitCode } from "../src/cli/commands/compute";
import { createComputeDriver, createComputeOps, jobOutput, localPrincipal, type ComputeJobOutput, type ComputeOps } from "../src/lib/ops/compute";
import { fakeClock, jobDirs, PENELOPE, sandbox, START, TELEMACHUS, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

const boxes: Sandbox[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.dispose();
});

function setup(capabilities = {}, instance: Record<string, unknown> = {}) {
  const box = sandbox();
  boxes.push(box);
  const clock = fakeClock();
  const memory = memoryCompute({ clock, capabilities });
  const config = { compute: { providers: { "pylos-memory": { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: 2, ...instance } } } };
  const ops = (caller = PENELOPE) => createComputeOps({ root: box.root, config, caller, env: {}, serviceOptions: { stateDir: box.state, clock, callTimeoutMs: 2_000 } });
  return { box, clock, memory, ops };
}

describe("envelopes", () => {
  test("run, status, cancel and collect share one job shape with ISO times", async () => {
    const { ops, clock } = setup();
    const run = await ops().run({ provider: "pylos-memory", argv: ["sleep", "60"], source: ["notes/raft.md"] });
    if (!run.ok) throw new Error(run.error.code);
    expect(run.job).toMatchObject({ instance: "pylos-memory", provider: "memory", state: "running", createdAt: new Date(START).toISOString(), source: { files: 1 }, blocked: null });
    expect(run.job.lease).toEqual({ seconds: 600, deadline: new Date(START + 600_000).toISOString() });
    clock.advance(61_000);
    const status = await ops().status({ job: run.job.id });
    expect(status).toMatchObject({ ok: true, job: { state: "succeeded", exit: { code: 0, reason: "exited" }, cleanup: { state: "released" } } });
    if (!status.ok) throw new Error();
    expect(status.job.terminal?.at).toBe(new Date(START + 61_000).toISOString());
    const collect = await ops().collect({ job: run.job.id });
    expect(collect).toMatchObject({ ok: true, output: { stdout: "", stderr: "", truncated: false }, artifacts: [] });
  });

  test("plan writes nothing: no state directory appears when none existed", async () => {
    const { ops, box, memory } = setup();
    expect(existsSync(box.state)).toBe(false);
    expect(await ops().plan({ provider: "pylos-memory", argv: ["true"], source: ["notes/raft.md"] })).toMatchObject({ ok: true, plan: { slots: { used: 0, max: 2 } } });
    expect(existsSync(box.state)).toBe(false);
    expect(memory.created()).toBe(0);
  });

  test("unknown cost stays null in the envelope and reads 'unknown' to a person", async () => {
    const { ops } = setup();
    const run = await ops().run({ provider: "pylos-memory", argv: ["exit", "0"] });
    if (!run.ok) throw new Error(run.error.code);
    const job = (await ops().status({ job: run.job.id })) as { ok: true; job: ComputeJobOutput };
    expect(job.job.cost.actual.usd).toBeNull();
    expect(job.job.cost.estimate).toEqual({ usd: null, basis: "none" });
    expect(describeCost(job.job)).toBe("unknown (unknown); no estimate");
    expect(describeCost({ cost: { estimate: { usd: 0.05, basis: "ceiling" }, actual: { usd: 0.0125, coverage: "complete", source: "provider" } } })).toBe(
      "$0.0125 (complete); estimate $0.0500 (ceiling)"
    );
  });

  test("jobOutput keeps every view field and adds nothing", () => {
    const view = {
      id: "cj_x", instance: "i", provider: "p", state: "running" as const, createdAt: START, updatedAt: START,
      lease: { seconds: 1, deadline: START }, source: { hash: "h", files: 0 }, exit: null, artifacts: [],
      cleanup: { state: "none" as const, retainedUntil: null, lastError: null },
      cost: { estimate: { usd: null, basis: "none" as const }, actual: { usd: null, coverage: "unknown" as const, source: "none" as const } },
      cancelRequested: false, uncertain: null, terminal: null, blocked: null, settled: false,
    };
    expect(Object.keys(jobOutput(view)).sort()).toEqual(Object.keys(view).sort());
  });
});

describe("refusals allocate nothing", () => {
  test("compute_disabled touches no state directory", async () => {
    const box = sandbox();
    boxes.push(box);
    const ops = createComputeOps({ root: box.root, config: {}, caller: PENELOPE, env: {}, serviceOptions: { stateDir: box.state } });
    for (const result of [
      await ops.plan({ provider: "pylos-memory", argv: ["true"] }),
      await ops.run({ provider: "pylos-memory", argv: ["true"] }),
      await ops.status({ job: "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      await ops.reconcile(),
    ]) {
      expect(result).toEqual({ ok: false, error: { code: "compute_disabled", message: expect.any(String) } });
    }
    expect(await ops.health({})).toEqual({ ok: true, enabled: false, instances: [] });
    expect(jobDirs(box.state)).toEqual([]);
  });

  test("policy_denied inside a hosted or maintenance worker: hosted admission (#3108) is the only way in", async () => {
    const box = sandbox();
    boxes.push(box);
    const clock = fakeClock();
    const memory = memoryCompute({ clock });
    const config = { compute: { providers: { "pylos-memory": { provider: memory.provider, lease: { maxSeconds: 600 } } } } };
    const ops = createComputeOps({
      root: box.root, config, caller: PENELOPE,
      env: { BRAIN_WORKER_DATA_ROOT: "/run/brain-worker/ithaca" },
      serviceOptions: { stateDir: box.state, clock },
    });
    for (const result of [
      await ops.plan({ provider: "pylos-memory", argv: ["true"] }),
      await ops.run({ provider: "pylos-memory", argv: ["true"] }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "policy_denied", message: expect.stringContaining("worker") } });
    }
    expect(memory.created()).toBe(0);
    expect(jobDirs(box.state)).toEqual([]);
  });

  test("capability_unsupported: staging on a provider that cannot stage", async () => {
    const { ops, memory, box } = setup({ stage: false });
    const r = await ops().run({ provider: "pylos-memory", argv: ["true"], source: ["notes/raft.md"] });
    expect(r).toMatchObject({ ok: false, error: { code: "capability_unsupported" } });
    expect(memory.created()).toBe(0);
    expect(jobDirs(box.state)).toEqual([]);
  });

  test("capability_unsupported: retain on a provider that cannot retain, unless the job declines it", async () => {
    const { ops, memory } = setup({ retain: false }, { retainOnRelease: true });
    expect(await ops().plan({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: false, error: { code: "capability_unsupported" } });
    expect(await ops().run({ provider: "pylos-memory", argv: ["true"], retain: true })).toMatchObject({ ok: false, error: { code: "capability_unsupported" } });
    expect(memory.created()).toBe(0);
    const declined = await ops().plan({ provider: "pylos-memory", argv: ["true"], retain: false });
    expect(declined).toMatchObject({ ok: true, plan: { retain: false } });
  });

  test("retain: true keeps the sandbox's data on release where the instance allows retention", async () => {
    const { ops, clock } = setup({}, { retainOnRelease: true });
    const run = await ops().run({ provider: "pylos-memory", argv: ["exit", "0"], retain: true });
    if (!run.ok) throw new Error(run.error.code);
    clock.advance(1_000);
    const status = await ops().status({ job: run.job.id });
    expect(status).toMatchObject({ ok: true, job: { cleanup: { state: "retained" } } });
  });

  test("a job may only narrow retention: retain: true is policy_denied unless the instance sets retainOnRelease", async () => {
    const { ops, memory, box } = setup();
    for (const r of [
      await ops().plan({ provider: "pylos-memory", argv: ["true"], retain: true }),
      await ops().run({ provider: "pylos-memory", argv: ["true"], retain: true }),
    ]) {
      expect(r).toMatchObject({ ok: false, error: { code: "policy_denied", message: expect.stringContaining("retainOnRelease") } });
    }
    expect(memory.created()).toBe(0);
    expect(jobDirs(box.state)).toEqual([]);
    expect(await ops().plan({ provider: "pylos-memory", argv: ["true"], retain: false })).toMatchObject({ ok: true, plan: { retain: false } });

    const allowed = setup({}, { retainOnRelease: true });
    expect(await allowed.ops().plan({ provider: "pylos-memory", argv: ["true"], retain: false })).toMatchObject({ ok: true, plan: { retain: false } });
    expect(await allowed.ops().plan({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: true, plan: { retain: true } });
  });

  test("a retained job holds its slot until its retention ends", async () => {
    const { ops, clock } = setup({}, { retainOnRelease: true });
    for (let i = 0; i < 2; i++) {
      const run = await ops().run({ provider: "pylos-memory", argv: ["exit", "0"] });
      if (!run.ok) throw new Error(run.error.code);
      clock.advance(1_000);
      expect(await ops().status({ job: run.job.id })).toMatchObject({ ok: true, job: { state: "succeeded", cleanup: { state: "retained" } } });
    }
    expect(await ops().plan({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: true, plan: { slots: { used: 2, max: 2 } } });
    expect(await ops().run({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: false, error: { code: "concurrency_exhausted" } });
    clock.advance(3_600_000);
    expect(await ops().run({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: true });
  });

  test("an invalid governance policy refuses plan and run with policy_denied", async () => {
    const { ops, memory, box } = setup();
    mkdirSync(join(box.root, "context/policies"), { recursive: true });
    writeFileSync(join(box.root, "context/policies/governance.md"), "---\nschema_version: 1\nunknown_key: true\n---\n");
    for (const r of [await ops().plan({ provider: "pylos-memory", argv: ["true"] }), await ops().run({ provider: "pylos-memory", argv: ["true"] })]) {
      expect(r).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    }
    expect(memory.created()).toBe(0);
  });

  test("the governance policy's provider rules apply with the instance id as recipient", async () => {
    const { ops, memory, box } = setup();
    mkdirSync(join(box.root, "context/policies"), { recursive: true });
    writeFileSync(join(box.root, "context/policies/governance.md"), "---\nschema_version: 1\nproviders:\n  - types: [health]\n    allow: [asclepius]\n---\n");
    const refused = await ops().run({ provider: "pylos-memory", argv: ["true"], source: ["health/sea-sickness.md"] });
    expect(refused).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect((refused as { error: { message: string } }).error.message).toContain("health/sea-sickness.md");
    expect(memory.created()).toBe(0);
    expect(await ops().plan({ provider: "pylos-memory", argv: ["true"], source: ["notes/raft.md"] })).toMatchObject({ ok: true });
  });
});

describe("caller binding", () => {
  test("a job belongs to the caller kind and principal the host supplied", async () => {
    const { ops } = setup();
    const run = await ops(PENELOPE).run({ provider: "pylos-memory", argv: ["sleep", "60"] });
    if (!run.ok) throw new Error(run.error.code);
    for (const other of [TELEMACHUS, { kind: "mcp" as const, principal: PENELOPE.principal }, { kind: "cli" as const, principal: "telemachus" }]) {
      expect(await ops(other).status({ job: run.job.id })).toMatchObject({ ok: false, error: { code: "job_unknown" } });
      expect(await ops(other).cancel({ job: run.job.id })).toMatchObject({ ok: false, error: { code: "job_unknown" } });
    }
    expect(await ops(PENELOPE).status({ job: run.job.id })).toMatchObject({ ok: true });
  });

  test("the local principal is the operating-system user", () => {
    expect(localPrincipal()).toBe(require("node:os").userInfo().username);
  });
});

describe("the background driver", () => {
  /**
   * `ops` whose `status` answers count as visits: `visited(n)` resolves once
   * the driver's nth status call has answered, before the driver continues.
   */
  function counted(ops: ComputeOps) {
    let visits = 0;
    const waiting: { n: number; resolve: () => void }[] = [];
    const wrapped: ComputeOps = {
      ...ops,
      status: async (input) => {
        const result = await ops.status(input);
        visits++;
        for (const w of waiting.filter((w) => w.n <= visits)) w.resolve();
        return result;
      },
    };
    const visited = (n: number) => (visits >= n ? Promise.resolve() : new Promise<void>((resolve) => waiting.push({ n, resolve })));
    return { ops: wrapped, visited };
  }
  /** One macrotask: the driver's continuation after an answered visit has run. */
  const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

  test("advances tracked jobs through status until settled, then stops visiting", async () => {
    const { ops, clock, memory } = setup();
    const o = ops(TELEMACHUS);
    const run = await o.run({ provider: "pylos-memory", argv: ["sleep", "5"] });
    if (!run.ok) throw new Error(run.error.code);
    const visits = counted(o);
    const driver = createComputeDriver(visits.ops, { initialDelayMs: 5, maxDelayMs: 20 });
    driver.track(run.job.id);
    expect(driver.tracked()).toEqual([run.job.id]);
    // Each visit answers "running"; the next is armed at least 8 ms later, after this macrotask.
    for (const n of [1, 2]) {
      await visits.visited(n);
      await macrotask();
      expect(driver.tracked()).toEqual([run.job.id]);
    }
    clock.advance(6_000);
    for (let i = 0; i < 100 && driver.tracked().length > 0; i++) await Bun.sleep(10);
    expect(driver.tracked()).toEqual([]);
    expect(await o.status({ job: run.job.id })).toMatchObject({ ok: true, job: { state: "succeeded", cleanup: { state: "released" } } });
    const polls = memory.calls.filter((c) => c.method === "poll").length;
    // Nothing is tracked, so the driver arms no timer and no visit is due.
    // A visit it wrongly scheduled would fire within maxDelayMs (20 ms); the
    // window gives it three of those, and there is no event for "no timer".
    await Bun.sleep(60);
    expect(memory.calls.filter((c) => c.method === "poll").length).toBe(polls);
    driver.stop();
  });

  test("stop ends every visit and cancels nothing", async () => {
    const { ops, memory } = setup();
    const o = ops(TELEMACHUS);
    const run = await o.run({ provider: "pylos-memory", argv: ["sleep", "600"] });
    if (!run.ok) throw new Error(run.error.code);
    const visits = counted(o);
    const driver = createComputeDriver(visits.ops, { initialDelayMs: 5, maxDelayMs: 5 });
    driver.track(run.job.id);
    // Stop once a visit has answered, before the driver re-tracks the job.
    await visits.visited(1);
    driver.stop();
    const calls = memory.calls.length;
    // Stopped, the driver clears its timer and arms no other. A visit it still
    // ran would come within its 5 ms delay; the window gives it eight, and
    // there is no event for "no timer".
    await Bun.sleep(40);
    expect(memory.calls.length).toBe(calls);
    expect(memory.calls.some((c) => c.method === "kill" || c.method === "release")).toBe(false);
    driver.track(run.job.id);
    expect(driver.tracked()).toEqual([]);
  });

  test("drops a job whose status keeps throwing, after a bounded run of throws, and logs it", async () => {
    let visits = 0;
    const ops = { status: async () => { visits++; throw new Error("the state directory is unreadable"); } } as unknown as ComputeOps;
    const logged: string[] = [];
    const driver = createComputeDriver(ops, { initialDelayMs: 1, maxDelayMs: 1, maxFailures: 3, log: (line) => void logged.push(line) });
    driver.track("cj_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    for (let i = 0; i < 200 && driver.tracked().length > 0; i++) await Bun.sleep(5);
    expect(driver.tracked()).toEqual([]);
    expect(visits).toBe(3);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("cj_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    driver.stop();
  });

  test("a job that throws and then answers starts its count again", async () => {
    let visits = 0;
    const ops = {
      status: async () => {
        visits++;
        if (visits % 2 === 1) throw new Error("transient");
        return { ok: true, job: { terminal: null, cleanup: { state: "none" } } };
      },
    } as unknown as ComputeOps;
    const driver = createComputeDriver(ops, { initialDelayMs: 1, maxDelayMs: 1, maxFailures: 2, log: () => {} });
    driver.track("cj_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    for (let i = 0; i < 200 && visits < 8; i++) await Bun.sleep(5);
    expect(visits).toBeGreaterThanOrEqual(8);
    expect(driver.tracked()).toEqual(["cj_aaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    driver.stop();
  });

  test("more jobs than one pass visits are all tracked and driven, least recently visited first", async () => {
    const order: string[] = [];
    // A pass's visits run back to back without yielding to the event loop;
    // passes are timer-separated. A setImmediate counter tells them apart.
    let generation = 0;
    let spinning = true;
    const spin = () => {
      generation++;
      if (spinning) setImmediate(spin);
    };
    spin();
    const passOf: number[] = [];
    const ops = {
      status: async ({ job }: { job: string }) => {
        order.push(job);
        passOf.push(generation);
        return { ok: true, job: { terminal: null, cleanup: { state: "none" } } };
      },
    } as unknown as ComputeOps;
    const driver = createComputeDriver(ops, { initialDelayMs: 1, maxDelayMs: 1 });
    const ids = Array.from({ length: 20 }, (_, i) => `job-${String(i).padStart(2, "0")}`);
    for (const id of ids) driver.track(id);
    expect(driver.tracked().length).toBe(20);
    for (let i = 0; i < 200 && order.length < 32; i++) await Bun.sleep(5);
    driver.stop();
    spinning = false;
    // Sixteen visits a pass: the first pass takes the oldest sixteen, the
    // second the four it left out before any job is visited again.
    expect(new Set(passOf.slice(0, 16)).size).toBe(1);
    expect(passOf[16]).not.toBe(passOf[15]);
    expect(order.slice(0, 16)).toEqual(ids.slice(0, 16));
    expect(order.slice(16, 20)).toEqual(ids.slice(16));
    expect(order.slice(20, 32)).toEqual(ids.slice(0, 12));
  });

  test("tracks at most maxJobs", () => {
    const { ops } = setup();
    const driver = createComputeDriver(ops(), { maxJobs: 2, initialDelayMs: 60_000 });
    for (const id of ["a", "b", "c"]) driver.track(id);
    expect(driver.tracked()).toEqual(["a", "b"]);
    driver.stop();
  });
});

describe("an attached run", () => {
  const ended = (cleanup: ComputeJobOutput["cleanup"]["state"]): ComputeJobOutput => ({
    id: "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa", instance: "pylos-memory", provider: "memory", state: "succeeded",
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    lease: { seconds: 60, deadline: new Date(START + 60_000).toISOString() }, source: { hash: "h", files: 0 },
    exit: { code: 0, signal: null, reason: "exited" }, artifacts: [],
    cleanup: { state: cleanup, retainedUntil: null, lastError: cleanup === "release_failed" ? "failed: the harbour is closed" : null },
    cost: { estimate: { usd: null, basis: "none" }, actual: { usd: null, coverage: "unknown", source: "none" } },
    cancelRequested: false, uncertain: null, terminal: { state: "succeeded", at: new Date(START).toISOString(), reason: "exited 0" }, blocked: null,
    settled: cleanup !== "pending" && cleanup !== "release_failed",
  });
  const fakeOps = (states: ComputeJobOutput["cleanup"]["state"][]) => {
    let visits = 0;
    const ops = {
      status: async () => ({ ok: true as const, job: ended(states[Math.min(visits++, states.length - 1)]!) }),
      cancel: async () => { throw new Error("nothing to cancel"); },
    } as unknown as Parameters<typeof attach>[0];
    return { ops, visits: () => visits };
  };
  const noSignal = { signal: null, sleep: async () => {} };

  test("keeps visiting a job that ended until its cleanup is settled", async () => {
    const { ops, visits } = fakeOps(["release_failed", "release_failed", "released"]);
    const final = await attach(ops, ended("pending"), () => {}, noSignal);
    expect(visits()).toBe(3);
    expect(final).toMatchObject({ ok: true, job: { cleanup: { state: "released" } } });
    expect(runExitCode(final, true)).toBe(0);
  });

  test("gives up after a bounded number of visits and reports the unconfirmed cleanup as exit 2", async () => {
    const { ops, visits } = fakeOps(["release_failed"]);
    const final = await attach(ops, ended("release_failed"), () => {}, noSignal, { cleanupVisits: 4 });
    expect(visits()).toBe(4);
    expect(runExitCode(final, true)).toBe(2);
    for (const state of ["pending", "unknown"] as const) expect(runExitCode({ ok: true, job: ended(state) }, true)).toBe(2);
    expect(runExitCode({ ok: true, job: ended("retained") }, true)).toBe(0);
  });
});

describe("the wrappers stay thin", () => {
  const src = (path: string) => readFileSync(resolve(import.meta.dir, "../src", path), "utf8");

  test("neither the CLI command nor the MCP server reaches the job service directly", () => {
    for (const file of ["cli/commands/compute.ts", "mcp-server.ts"]) {
      const text = src(file);
      expect(text).not.toMatch(/lib\/compute\//);
      expect(text).not.toMatch(/createComputeService|computeJobView|ComputeJobStore/);
    }
  });

  test("every MCP compute handler calls the operation set", () => {
    const text = src("mcp-server.ts");
    const block = text.slice(text.indexOf("export function registerComputeTools"), text.indexOf("export async function startMcpServer"));
    for (const op of ["health", "plan", "run", "status", "cancel", "collect"]) expect(block).toContain(`ops.${op}(input)`);
  });
});
