/**
 * The job lifecycle on a fake clock (#3105): terminal exit status, source and
 * artifact identity, partial results, cancellation, lease expiry, failed
 * cleanup and unknown cost each end in a finite, explicit record.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ComputeCaller } from "../src/lib/compute/types";
import type { ComputeProvider } from "../src/lib/seams";
import { PENELOPE, fakeClock, filesContaining, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute, type MemoryComputeOptions } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

function setup(instance: Record<string, unknown> = {}, opts: { rate?: number; caps?: MemoryComputeOptions["capabilities"]; extra?: Parameters<typeof service>[2] } = {}) {
  box = sandbox();
  const clock = fakeClock();
  const memory = memoryCompute({ clock, ratePerHourUsd: opts.rate, capabilities: opts.caps });
  const svc = service(box, { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: 2, ...instance } } }, { clock, ...opts.extra });
  return { clock, memory, svc, box };
}

async function started(svc: ReturnType<typeof service>, argv: string[], extra: Record<string, unknown> = {}, caller: ComputeCaller = PENELOPE) {
  const run = await svc.run(caller, { instance: "ithaca", argv, ...extra });
  if (!run.ok) throw new Error(`${run.code}: ${run.reason}`);
  return run.job;
}

async function status(svc: ReturnType<typeof service>, id: string) {
  const result = await svc.status(PENELOPE, id);
  if (!result.ok) throw new Error(result.code);
  return result.job;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("terminal outcomes", () => {
  test("a job that exits 0 with its artifacts succeeds, keeping source and artifact identity", async () => {
    const { clock, memory, svc, box } = setup({}, { rate: 3.6 });
    const job = await started(svc, ["write", "log.txt", "twenty trees felled"], {
      source: ["notes/route.md", "notes/raft.md"],
      artifacts: [{ path: "log.txt", maxBytes: 1024 }],
    });
    expect(job.state).toBe("running");
    clock.advance(10_000);
    const done = await status(svc, job.id);
    expect(done.state).toBe("succeeded");
    expect(done.exit).toEqual({ code: 0, signal: null, reason: "exited" });
    expect(done.source.files).toBe(2);
    expect(done.artifacts).toEqual([{ path: "log.txt", status: "collected", bytes: 19, sha256: sha("twenty trees felled") }]);
    expect(done.cleanup.state).toBe("released");
    expect(done.cost.actual).toEqual({ usd: 0.01, coverage: "complete", source: "provider" });
    expect(memory.live()).toBe(0);
    const staged = [...memory.sandboxes.values()][0].files;
    expect(new TextDecoder().decode(staged.get("notes/route.md"))).toBe(readFileSync(`${box.root}/notes/route.md`, "utf8"));
    const collected = await svc.collect(PENELOPE, job.id);
    if (!collected.ok) throw new Error(collected.code);
    expect(readFileSync(collected.artifacts[0].file!, "utf8")).toBe("twenty trees felled");
  });

  test("a nonzero exit fails and keeps its code", async () => {
    const { svc } = setup();
    const job = await started(svc, ["exit", "7"]);
    const done = await status(svc, job.id);
    expect([done.state, done.exit, done.terminal?.reason, done.cleanup.state]).toEqual([
      "failed", { code: 7, signal: null, reason: "exited" }, "exited 7", "released",
    ]);
  });

  test("an out-of-memory end is a failure with its reason", async () => {
    const { svc } = setup();
    const done = await status(svc, (await started(svc, ["oom"])).id);
    expect([done.state, done.exit?.reason, done.exit?.signal]).toEqual(["failed", "oom", "SIGKILL"]);
  });

  test("exit 0 with a missing artifact fails as artifacts_missing and keeps what was collected", async () => {
    const { svc } = setup();
    const job = await started(svc, ["write", "log.txt", "kept"], {
      artifacts: [{ path: "log.txt", maxBytes: 1024 }, { path: "chart.png", maxBytes: 1024 }, { path: "notes.txt", maxBytes: 1 }],
    });
    const done = await status(svc, job.id);
    expect([done.state, done.exit?.code, done.terminal?.reason]).toEqual(["failed", 0, "artifacts_missing"]);
    expect(done.artifacts.map((a) => [a.path, a.status])).toEqual([["log.txt", "collected"], ["chart.png", "missing"], ["notes.txt", "missing"]]);
  });

  test("an artifact over its cap is too_large and never stored", async () => {
    const { svc } = setup();
    const job = await started(svc, ["write", "log.txt", "longer than four bytes"], { artifacts: [{ path: "log.txt", maxBytes: 4 }] });
    const done = await status(svc, job.id);
    expect(done.artifacts[0]).toEqual({ path: "log.txt", status: "too_large", bytes: 22, sha256: null });
  });

  test("retainOnRelease keeps the data until the provider's retention deadline", async () => {
    const { clock, svc } = setup({ retainOnRelease: true });
    const done = await status(svc, (await started(svc, ["exit", "0"])).id);
    expect([done.state, done.cleanup.state, done.cleanup.retainedUntil]).toEqual(["succeeded", "retained", clock.now() + 3_600_000]);
  });

  test("a remote-expiry provider is given the lease plus the release allowance", async () => {
    const { memory, svc } = setup({}, { extra: { releaseAllowanceSeconds: 120 } });
    await started(svc, ["sleep", "5"], { leaseSeconds: 300 });
    expect([...memory.sandboxes.values()][0].remoteExpirySeconds).toBe(420);
  });
});

describe("bounded by the host", () => {
  test("cancelling a running job kills its command and confirms release", async () => {
    const { memory, svc } = setup();
    const job = await started(svc, ["sleep", "3600"]);
    const result = await svc.cancel(PENELOPE, job.id);
    if (!result.ok) throw new Error(result.code);
    expect([result.job.state, result.job.exit?.reason, result.job.cleanup.state]).toEqual(["cancelled", "killed", "released"]);
    expect(memory.live()).toBe(0);
    expect((await svc.cancel(PENELOPE, job.id)).ok).toBe(true);
  });

  test("the lease expires: the command is killed, nothing more is collected, and the sandbox is released", async () => {
    const { clock, memory, svc } = setup();
    const job = await started(svc, ["sleep", "99999"], { artifacts: [{ path: "log.txt", maxBytes: 64 }] });
    clock.advance(599_000);
    expect((await status(svc, job.id)).state).toBe("running");
    clock.advance(1_000);
    const done = await status(svc, job.id);
    expect([done.state, done.exit?.reason, done.cleanup.state, done.artifacts[0].status]).toEqual(["expired", "killed", "released", "not_collected"]);
    expect(memory.calls.filter((c) => c.method === "collect").length).toBe(0);
    expect(memory.live()).toBe(0);
  });

  test("a provider call that never answers is uncertain by the call deadline and is never repeated", async () => {
    const { clock, memory, svc } = setup({}, { extra: { callTimeoutMs: 50 } });
    memory.hang("exec");
    const job = await started(svc, ["exit", "0"]);
    expect([job.state, job.uncertain?.step]).toEqual(["uncertain", "exec"]);
    expect((await status(svc, job.id)).state).toBe("uncertain");
    clock.advance(600_000);
    const done = await status(svc, job.id);
    expect([done.state, done.exit?.reason, done.cleanup.state]).toEqual(["expired", "unknown", "released"]);
    expect(memory.calls.filter((c) => c.method === "exec").length).toBe(1);
  });
});

describe("cleanup and cost", () => {
  test("a failed release is never success: it keeps the slot and is retried with backoff", async () => {
    const { clock, memory, svc } = setup({ maxConcurrent: 1 });
    memory.failReleases(1);
    const job = await started(svc, ["exit", "0"]);
    const done = await status(svc, job.id);
    expect([done.state, done.cleanup.state]).toEqual(["succeeded", "release_failed"]);
    expect(done.cleanup.lastError).toContain("refused to stop");
    expect(memory.live()).toBe(1);
    const blocked = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    expect(blocked.ok ? "admitted" : blocked.code).toBe("concurrency_exhausted");
    expect((await status(svc, job.id)).cleanup.state).toBe("release_failed");
    clock.advance(30_000);
    const report = await svc.reconcile();
    expect(report.ok && report.visited).toEqual([{ id: job.id, state: "succeeded", cleanup: "released" }]);
    expect(memory.live()).toBe(0);
    expect((await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
  });

  test("unknown cost stays null with an unknown coverage, never zero, and is settled as unknown", async () => {
    const settled: [string, number | null][] = [];
    const reserved: [string, number | null][] = [];
    const budget = { reserve: (id: string, usd: number | null) => (reserved.push([id, usd]), "ok" as const), settle: (id: string, usd: number | null) => void settled.push([id, usd]) };
    const { svc } = setup({}, { extra: { budget } });
    const done = await status(svc, (await started(svc, ["exit", "0"])).id);
    expect(done.cost).toEqual({ estimate: { usd: null, basis: "none" }, actual: { usd: null, coverage: "unknown", source: "provider" } });
    expect(reserved).toEqual([[done.id, null]]);
    expect(settled).toEqual([[done.id, null]]);
  });

  test("a provider without usage records cost as unknown from no source", async () => {
    const { svc } = setup({}, { caps: { usage: "none" } });
    const done = await status(svc, (await started(svc, ["exit", "0"])).id);
    expect(done.cost.actual).toEqual({ usd: null, coverage: "unknown", source: "none" });
  });

  test("an hourly ceiling reserves ceiling × lease and settles the provider's actual cost", async () => {
    const settled: [string, number | null][] = [];
    const reserved: [string, number | null][] = [];
    const budget = { reserve: (id: string, usd: number | null) => (reserved.push([id, usd]), "ok" as const), settle: (id: string, usd: number | null) => void settled.push([id, usd]) };
    const { clock, svc } = setup({ hourlyCeilingUsd: 1.2 }, { rate: 0.36, extra: { budget } });
    const job = await started(svc, ["sleep", "100"], { leaseSeconds: 300 });
    clock.advance(100_000);
    const done = await status(svc, job.id);
    expect(done.cost.estimate).toEqual({ usd: 0.1, basis: "ceiling" });
    expect(reserved).toEqual([[job.id, 0.1]]);
    expect(settled.length).toBe(1);
    expect(settled[0][1]).toBeCloseTo(0.01, 10);
  });

  test("a secret a provider echoes is redacted from stored output and absent from every record", async () => {
    box = sandbox();
    const clock = fakeClock();
    const memory = memoryCompute({ clock });
    const echoing: ComputeProvider = {
      ...memory.provider,
      poll: async (handle, ctx) => {
        const status = await memory.provider.poll(handle, ctx);
        return status.kind === "exited" ? { ...status, stdout: `${status.stdout} token=${ctx.secret}` } : status;
      },
    };
    const svc = service(box, { providers: { ithaca: { provider: echoing, apiKeyEnv: "ITHACA_KEY", lease: { maxSeconds: 600 } } } }, {
      clock,
      env: { ITHACA_KEY: "sk-ithaca-penelope-weaves" },
    });
    const job = await started(svc, ["printenv"], { env: { VOYAGE: "home" } });
    const collected = await svc.collect(PENELOPE, job.id);
    if (!collected.ok) throw new Error(collected.code);
    expect(collected.output.stdout).toBe("VOYAGE=home token=[redacted]");
    expect(filesContaining(box.state, "sk-ithaca-penelope-weaves")).toEqual([]);
  });
});

describe("a command that ended before the first visit after its lease", () => {
  test("within the release allowance: the real exit is kept, artifacts are collected, and nothing is killed", async () => {
    const { clock, memory, svc } = setup();
    const job = await started(svc, ["write", "log.txt", "the raft held"], { artifacts: [{ path: "log.txt", maxBytes: 64 }] });
    clock.advance(650_000);
    const done = await status(svc, job.id);
    expect(memory.calls.filter((c) => c.method === "kill").length).toBe(0);
    expect([done.state, done.exit, done.artifacts[0].status, done.cleanup.state]).toEqual([
      "succeeded", { code: 0, signal: null, reason: "exited" }, "collected", "released",
    ]);
  });

  test("after the release allowance: the real exit is kept and artifacts are recorded as not collected", async () => {
    const { clock, memory, svc } = setup();
    const job = await started(svc, ["write", "log.txt", "the raft held"], { artifacts: [{ path: "log.txt", maxBytes: 64 }] });
    clock.advance(1_000_000);
    const done = await status(svc, job.id);
    expect(memory.calls.filter((c) => c.method === "kill").length).toBe(0);
    expect([done.state, done.exit, done.artifacts[0].status, done.terminal?.reason, done.cleanup.state]).toEqual([
      "failed", { code: 0, signal: null, reason: "exited" }, "not_collected", "artifacts_missing", "released",
    ]);
    expect(memory.calls.filter((c) => c.method === "collect").length).toBe(0);
  });

  test("cancelling a command that already exited keeps its real exit", async () => {
    const { memory, svc } = setup();
    const job = await started(svc, ["exit", "7"]);
    const result = await svc.cancel(PENELOPE, job.id);
    if (!result.ok) throw new Error(result.code);
    expect(memory.calls.filter((c) => c.method === "kill").length).toBe(0);
    expect([result.job.state, result.job.exit, result.job.cleanup.state]).toEqual(["cancelled", { code: 7, signal: null, reason: "exited" }, "released"]);
  });
});

describe("provider cost coverage", () => {
  type Report = { usd: number | null; seconds: number | null; coverage: "complete" | "partial" | "unknown" };
  function withUsage(usage: () => Report, instance: Record<string, unknown> = {}) {
    box = sandbox();
    const clock = fakeClock();
    const memory = memoryCompute({ clock });
    const settled: [string, number | null][] = [];
    let reads = 0;
    const budget = { reserve: () => "ok" as const, settle: (id: string, usd: number | null) => void settled.push([id, usd]) };
    const provider: ComputeProvider = { ...memory.provider, usage: async () => (reads++, usage()) };
    const svc = service(box, { providers: { ithaca: { provider, lease: { maxSeconds: 600 }, hourlyCeilingUsd: 6, ...instance } } }, { clock, budget });
    return { svc, settled, reads: () => reads };
  }

  test("a zero with unknown coverage is unknown, never zero, and settles as unknown", async () => {
    const { svc, settled } = withUsage(() => ({ usd: 0, seconds: null, coverage: "unknown" }));
    const done = await status(svc, (await started(svc, ["exit", "0"])).id);
    expect(done.cost.actual).toEqual({ usd: null, coverage: "unknown", source: "provider" });
    expect(settled).toEqual([[done.id, null]]);
  });

  test("a retained sandbox's partial report is held and read again until it is complete", async () => {
    let report: Report = { usd: 0.5, seconds: 300, coverage: "partial" };
    const { svc, settled } = withUsage(() => report, { retainOnRelease: true });
    const done = await status(svc, (await started(svc, ["exit", "0"])).id);
    expect(done.cleanup.state).toBe("retained");
    expect(settled).toEqual([]);
    expect(done.cost.actual).toEqual({ usd: 0.5, coverage: "partial", source: "provider" });
    report = { usd: 0.7, seconds: 420, coverage: "complete" };
    const later = await status(svc, done.id);
    expect(later.cost.actual).toEqual({ usd: 0.7, coverage: "complete", source: "provider" });
    expect(settled).toEqual([[done.id, 0.7]]);
    await status(svc, done.id);
    expect(settled.length).toBe(1);
  });

  test("a released sandbox's partial report is final: recorded as partial and settled once as unknown", async () => {
    const { svc, settled, reads } = withUsage(() => ({ usd: 0.5, seconds: 300, coverage: "partial" }));
    const done = await status(svc, (await started(svc, ["exit", "0"])).id);
    expect([done.cleanup.state, done.cost.actual]).toEqual(["released", { usd: 0.5, coverage: "partial", source: "provider" }]);
    expect(settled).toEqual([[done.id, null]]);
    await status(svc, done.id);
    await status(svc, done.id);
    expect([settled.length, reads()]).toEqual([1, 1]);
  });

  test("a report that stays partial settles as unknown once the reads are spent, never held forever", async () => {
    const { svc, settled, reads } = withUsage(() => ({ usd: 0.5, seconds: 300, coverage: "partial" }), { retainOnRelease: true });
    const id = (await started(svc, ["exit", "0"])).id;
    for (let i = 0; i < 10; i++) await status(svc, id);
    const done = await status(svc, id);
    expect(done.cost.actual).toEqual({ usd: 0.5, coverage: "partial", source: "provider" });
    expect([settled, reads()]).toEqual([[[id, null]], 5]);
  });

  test("an unknown reading after a partial one keeps the lower bound and reads again", async () => {
    let report: Report = { usd: 0.5, seconds: 300, coverage: "partial" };
    const { svc, settled } = withUsage(() => report, { retainOnRelease: true });
    const id = (await started(svc, ["exit", "0"])).id;
    expect((await status(svc, id)).cost.actual.coverage).toBe("partial");
    report = { usd: null, seconds: null, coverage: "unknown" };
    const done = await status(svc, id);
    expect(done.cost.actual).toEqual({ usd: 0.5, coverage: "partial", source: "provider" });
    expect(settled).toEqual([]);
  });
});

describe("the instance secret in provider reasons and logs", () => {
  const SECRET = 'sk-"ithaca\\penelope';

  test("a health check that throws or reports the secret is redacted", async () => {
    box = sandbox();
    const memory = memoryCompute();
    const throwing: ComputeProvider = { ...memory.provider, health: async (ctx) => { throw new Error(`401 for key ${ctx.secret}`); } };
    const reporting: ComputeProvider = { ...memory.provider, health: async (ctx) => ({ kind: "unavailable", reason: `key ${ctx.secret} expired` }) };
    const svc = service(box, {
      providers: {
        ithaca: { provider: throwing, apiKeyEnv: "ITHACA_KEY", lease: { maxSeconds: 600 } },
        pylos: { provider: reporting, apiKeyEnv: "ITHACA_KEY", lease: { maxSeconds: 600 } },
      },
    }, { env: { ITHACA_KEY: SECRET } });
    const report = await svc.health();
    if (!report.ok) throw new Error(report.code);
    expect(report.instances.map((i) => i.reason)).toEqual(["the provider threw: 401 for key [redacted]", "key [redacted] expired"]);
  });

  test("a provider log carrying the secret inside structured data is redacted at every string, whatever it contains", async () => {
    box = sandbox();
    const memory = memoryCompute();
    const logs: { message: string; data?: Record<string, unknown> }[] = [];
    const chatty: ComputeProvider = {
      ...memory.provider,
      health: async (ctx) => {
        ctx.log.warn(`probing with ${ctx.secret}`, { header: `Bearer ${ctx.secret}`, nested: [{ key: ctx.secret, attempts: 2 }] });
        return { kind: "ok" };
      },
    };
    const log = { debug: () => {}, warn: (message: string, data?: Record<string, unknown>) => void logs.push({ message, data }) };
    const svc = service(box, { providers: { ithaca: { provider: chatty, apiKeyEnv: "ITHACA_KEY", lease: { maxSeconds: 600 } } } }, { env: { ITHACA_KEY: SECRET }, log });
    await svc.health();
    expect(logs).toEqual([{ message: "probing with [redacted]", data: { header: "Bearer [redacted]", nested: [{ key: "[redacted]", attempts: 2 }] } }]);
  });
});
