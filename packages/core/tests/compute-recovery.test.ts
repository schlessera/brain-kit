/**
 * Lost effects and restart (#3105). A lost allocation response is resolved
 * by the capability the provider has — retrying the same key, or looking it
 * up — and with neither it stays uncertain and allocates nothing more. A
 * lost exec is never re-run. A process killed at each point of the lifecycle
 * leaves a record a fresh service reconciles without a duplicate effect.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createComputeService } from "../src/lib/compute/service";
import { PENELOPE, fakeClock, jobDirs, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { localProcessCompute } from "./helpers/compute/local-process-provider";
import { memoryCompute, type MemoryComputeOptions } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  box?.dispose();
});

function setup(caps: MemoryComputeOptions["capabilities"] = {}) {
  box = sandbox();
  const clock = fakeClock();
  const memory = memoryCompute({ clock, capabilities: caps });
  const svc = service(box, { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: 3 } } }, { clock });
  const allocations = () => memory.calls.filter((c) => c.method === "allocate").length;
  return { clock, memory, svc, allocations };
}

async function state(svc: ReturnType<typeof service>, id: string) {
  const result = await svc.status(PENELOPE, id);
  if (!result.ok) throw new Error(result.code);
  return result.job;
}

describe("a lost allocation response", () => {
  test("idempotent allocation and lookup: the job finds its sandbox and runs on one allocation", async () => {
    const { memory, svc, allocations } = setup();
    memory.lose("allocate");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    expect(run.ok && [run.job.state, run.job.uncertain?.step]).toEqual(["uncertain", "allocate"]);
    const job = await state(svc, run.ok ? run.job.id : "");
    expect(job.state).toBe("running");
    expect([memory.created(), allocations()]).toEqual([1, 1]);
  });

  test("idempotent allocation only: the retry sends the same key and yields the same sandbox", async () => {
    const { memory, svc, allocations } = setup({ findByKey: false });
    memory.lose("allocate");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    expect(run.ok && run.job.state).toBe("uncertain");
    expect((await state(svc, run.ok ? run.job.id : "")).state).toBe("running");
    expect([memory.created(), allocations()]).toEqual([1, 2]);
    expect(new Set([...memory.sandboxes.values()].map((s) => s.key)).size).toBe(1);
  });

  test("lookup only: the host looks before anything else and finds the sandbox", async () => {
    const { memory, svc, allocations } = setup({ idempotentAllocate: false });
    memory.lose("allocate");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    expect((await state(svc, run.ok ? run.job.id : "")).state).toBe("running");
    expect([memory.created(), allocations()]).toEqual([1, 1]);
  });

  test("lookup only, and the lookup is empty: nothing is provisioned on an empty listing", async () => {
    const { memory, svc, allocations } = setup({ idempotentAllocate: false });
    memory.failTransport("allocate");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    const id = run.ok ? run.job.id : "";
    for (let i = 0; i < 3; i++) expect((await state(svc, id)).state).toBe("uncertain");
    expect((await svc.reconcile()).ok).toBe(true);
    expect([memory.created(), allocations(), memory.calls.filter((c) => c.method === "find").length]).toEqual([0, 1, 4]);
  });

  test("neither: the job stays uncertain, allocates nothing more, and an operator can abandon it", async () => {
    const { clock, memory, svc, allocations } = setup({ idempotentAllocate: false, findByKey: false });
    memory.lose("allocate");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    const id = run.ok ? run.job.id : "";
    clock.advance(3_600_000);
    expect((await state(svc, id)).state).toBe("uncertain");
    expect((await svc.reconcile()).ok).toBe(true);
    expect([memory.created(), allocations()]).toEqual([1, 1]);
    const abandoned = await svc.abandon(PENELOPE, id);
    expect(abandoned.ok && [abandoned.job.state, abandoned.job.cleanup.state]).toEqual(["abandoned", "unknown"]);
    const again = await svc.abandon(PENELOPE, id);
    expect(again.ok ? "abandoned twice" : again.code).toBe("policy_denied");
  });
});

describe("a lost exec response", () => {
  test("the command is never started again; after the lease it is released with its exit unknown", async () => {
    const { clock, memory, svc } = setup();
    memory.lose("exec");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    const id = run.ok ? run.job.id : "";
    expect(run.ok && [run.job.state, run.job.uncertain?.step]).toEqual(["uncertain", "exec"]);
    expect((await state(svc, id)).state).toBe("uncertain");
    expect((await svc.reconcile()).ok).toBe(true);
    expect(memory.calls.filter((c) => c.method === "exec").length).toBe(1);
    clock.advance(600_000);
    const done = await state(svc, id);
    expect([done.state, done.exit?.reason, done.cleanup.state]).toEqual(["expired", "unknown", "released"]);
    expect(memory.calls.filter((c) => c.method === "exec").length).toBe(1);
    expect(memory.live()).toBe(0);
  });

  test("an operator abandoning an uncertain exec still releases the known sandbox", async () => {
    const { memory, svc } = setup();
    memory.lose("exec");
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    const abandoned = await svc.abandon(PENELOPE, run.ok ? run.job.id : "");
    expect(abandoned.ok && [abandoned.job.state, abandoned.job.cleanup.state]).toEqual(["abandoned", "released"]);
    expect(memory.live()).toBe(0);
  });
});

describe("restart after a process dies mid-lifecycle", () => {
  const RUNNER = join(import.meta.dir, "compute-race.run.ts");

  async function crashAt(at: string, request: { argv: string[]; source?: string[]; artifacts?: { path: string; maxBytes: number }[] }) {
    box = sandbox();
    const work = join(box.base, "work");
    const spec = join(box.base, "crash.json");
    writeFileSync(spec, JSON.stringify({ root: box.root, state: box.state, work, at, ...request }));
    const child = Bun.spawn([process.execPath, RUNNER, "crash", spec], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect({ code: child.exitCode, signal: child.signalCode, stderr: child.signalCode ? "" : stderr }).toEqual({ code: null, signal: "SIGKILL", stderr: "" });
    const local = localProcessCompute(work);
    disposers.push(() => local.dispose());
    const svc = createComputeService({
      root: box.root,
      stateDir: box.state,
      env: {},
      config: { compute: { providers: { ithaca: { provider: local.provider, lease: { maxSeconds: 600 }, maxConcurrent: 4 } } } },
    });
    const [id] = jobDirs(box.state);
    const before = readFileSync(join(box.state, "jobs", id, "job.json"), "utf8");
    return { local, svc, id, work, recorded: JSON.parse(before) as { state: string } };
  }

  const sandboxDirs = (work: string) => (existsSync(work) ? readdirSync(work).length : 0);
  const commandDirs = (work: string) => readdirSync(work).flatMap((d) => (existsSync(join(work, d, "cmd")) ? readdirSync(join(work, d, "cmd")) : []));

  async function settle(svc: ReturnType<typeof createComputeService>, id: string) {
    for (let i = 0; i < 300; i++) {
      const report = await svc.reconcile();
      if (!report.ok) throw new Error(report.code);
      const status = await svc.status(PENELOPE, id);
      if (status.ok && status.job.terminal && status.job.cleanup.state !== "release_failed") return status.job;
      await Bun.sleep(10);
    }
    throw new Error("did not settle");
  }

  test("admitted: the starter died before allocating, so the job is cancelled with nothing allocated", async () => {
    const { svc, id, work, recorded } = await crashAt("admitted", { argv: ["sh", "-c", "exit 0"] });
    expect(recorded.state).toBe("admitted");
    const report = await svc.reconcile();
    expect(report.ok && report.visited).toEqual([{ id, state: "cancelled", cleanup: "none" }]);
    expect(sandboxDirs(work)).toBe(0);
  });

  test("allocating, response lost: the restart finds the sandbox by key and finishes on it", async () => {
    const { svc, id, work, recorded } = await crashAt("allocate", { argv: ["sh", "-c", "exit 3"] });
    expect(recorded.state).toBe("allocating");
    const done = await settle(svc, id);
    expect([done.state, done.exit?.code, done.cleanup.state]).toEqual(["failed", 3, "released"]);
    expect(sandboxDirs(work)).toBe(0);
  });

  test("allocating, never sent: an empty lookup after restart provisions nothing", async () => {
    const { svc, id, work, recorded } = await crashAt("allocate-before", { argv: ["sh", "-c", "exit 0"] });
    expect(recorded.state).toBe("allocating");
    await svc.reconcile();
    await svc.reconcile();
    const job = await svc.status(PENELOPE, id);
    expect(job.ok && [job.job.state, job.job.uncertain?.step]).toEqual(["uncertain", "allocate"]);
    expect(sandboxDirs(work)).toBe(0);
  });

  test("staging: the restart stages again and runs the command once", async () => {
    const { svc, id, work, recorded } = await crashAt("stage", { argv: ["sh", "-c", "cat notes/raft.md > copy.md"], source: ["notes/raft.md"], artifacts: [{ path: "copy.md", maxBytes: 4096 }] });
    expect(recorded.state).toBe("staging");
    const done = await settle(svc, id);
    expect([done.state, done.artifacts[0].status]).toEqual(["succeeded", "collected"]);
    expect(sandboxDirs(work)).toBe(0);
  });

  test("running without a recorded handle: the command is never started again", async () => {
    const { svc, id, work, recorded } = await crashAt("exec", { argv: ["sh", "-c", "exit 0"] });
    expect(recorded.state).toBe("running");
    await svc.reconcile();
    const job = await svc.status(PENELOPE, id);
    expect(job.ok && [job.job.state, job.job.uncertain?.step]).toEqual(["uncertain", "exec"]);
    expect(commandDirs(work).length).toBe(1);
  });

  test("collecting: the restart collects again and releases", async () => {
    const { svc, id, work, recorded } = await crashAt("collect", { argv: ["sh", "-c", "printf ithaca > out.txt"], artifacts: [{ path: "out.txt", maxBytes: 64 }] });
    expect(recorded.state).toBe("collecting");
    const done = await settle(svc, id);
    expect([done.state, done.artifacts[0].sha256 !== null, done.cleanup.state]).toEqual(["succeeded", true, "released"]);
    expect(commandDirs(work).length + sandboxDirs(work)).toBe(0);
  });

  test("releasing: the restart releases again, which is not an error", async () => {
    const { svc, id, work, recorded } = await crashAt("release", { argv: ["sh", "-c", "exit 0"] });
    expect(recorded.state).toBe("releasing");
    const done = await settle(svc, id);
    expect([done.state, done.cleanup.state]).toEqual(["succeeded", "released"]);
    expect(sandboxDirs(work)).toBe(0);
  });
});
