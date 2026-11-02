/**
 * The additive host hooks hosted admission uses (#3108): an operation set a
 * host builds with its own ledger, approval, frozen data-to-provider rules
 * and a last-word recheck of its caller under the admission lock, and the
 * `compute` summary `brain config check --json` reports as data.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { computeSummary } from "../src/cli/commands/config";
import { createComputeOps } from "../src/lib/ops/compute";
import type { ComputeBudget } from "../src/lib/compute/types";
import { fakeClock, HOSTED, jobDirs, sandbox, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

const boxes: Sandbox[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.dispose();
});

function ledger() {
  const reserved: string[] = [];
  const settled: { id: string; usd: number | null }[] = [];
  const budget: ComputeBudget = {
    reserve: (id) => {
      reserved.push(id);
      return "ok";
    },
    settle: (id, usd) => void settled.push({ id, usd }),
  };
  return { budget, reserved, settled };
}

function setup(hosted: Partial<NonNullable<Parameters<typeof createComputeOps>[0]["hosted"]>> = {}, env: NodeJS.ProcessEnv = {}) {
  const box = sandbox();
  boxes.push(box);
  const clock = fakeClock();
  const memory = memoryCompute({ clock });
  const books = ledger();
  const config = { compute: { providers: { "pylos-memory": { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: 2 } } } };
  const ops = createComputeOps({
    root: box.root,
    config,
    caller: HOSTED,
    env,
    serviceOptions: { stateDir: box.state, clock, callTimeoutMs: 2_000 },
    hosted: { sourcePolicy: { providers: [] }, approve: () => "approved", budget: books.budget, ...hosted },
  });
  return { box, clock, memory, ops, books };
}

describe("hosted operation set", () => {
  test("a host's own process is not a worker: the worker launch marker does not refuse hosted admission", async () => {
    const { ops, books } = setup({}, { BRAIN_WORKER_DATA_ROOT: "/tmp/brain-worker-data" });
    const run = await ops.run({ provider: "pylos-memory", argv: ["true"] });
    expect(run.ok, "HOSTED_SKIPS_WORKER_MARKER").toBe(true);
    expect(books.reserved).toHaveLength(1);
  });

  test("the frozen data-to-provider rules apply with the instance as recipient, not the policy file", async () => {
    const { ops, memory } = setup({ sourcePolicy: { providers: [{ paths: ["notes/**"], allow: [] }] as never } });
    const run = await ops.run({ provider: "pylos-memory", argv: ["true"], source: ["notes/raft.md"] });
    expect(run, "HOSTED_FROZEN_SOURCE_POLICY").toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect(memory.created()).toBe(0);
  });

  test("a recheck that fails under the admission lock refuses before any reservation or record", async () => {
    const { ops, books, box, memory } = setup({ recheck: () => false });
    const run = await ops.run({ provider: "pylos-memory", argv: ["true"] });
    expect(run, "HOSTED_RECHECK_REFUSES").toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect({ reserved: books.reserved.length, jobs: jobDirs(box.state).length, created: memory.created() }).toEqual({ reserved: 0, jobs: 0, created: 0 });
  });

  test("a recheck that throws refuses the same way", async () => {
    const { ops, books } = setup({ recheck: () => { throw new Error("revoked"); } });
    expect(await ops.run({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect(books.reserved).toHaveLength(0);
  });

  test("the host's ledger settles through any operation that advances the job", async () => {
    const { ops, books, clock } = setup();
    const run = await ops.run({ provider: "pylos-memory", argv: ["sleep", "5"] });
    if (!run.ok) throw new Error(run.error.code);
    clock.advance(6_000);
    await ops.status({ job: run.job.id });
    expect(books.settled.map((s) => s.id), "HOSTED_LEDGER_SETTLES_ON_STATUS").toEqual([run.job.id]);
  });

  test("an approval the host withholds refuses with approval_required and allocates nothing", async () => {
    const { ops, memory, books } = setup({ approve: () => "required" });
    expect(await ops.run({ provider: "pylos-memory", argv: ["true"] })).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect({ created: memory.created(), reserved: books.reserved.length }).toEqual({ created: 0, reserved: 0 });
  });
});

describe("config check compute summary", () => {
  test("no compute key reports disabled", () => {
    expect(computeSummary({} as never)).toEqual({ enabled: false, providers: {} });
  });

  test("a built-in is reported as data and a provider value by id only", () => {
    const value = { id: "ssh", capabilities: {}, health() {}, allocate() {}, exec() {}, poll() {}, kill() {}, release() {} };
    const summary = computeSummary({
      compute: {
        providers: {
          "boat-small": { provider: "boat", apiKeyEnv: "BOAT_CI_KEY", options: { machine: "small", from: "odysseus-ci" }, lease: { maxSeconds: 3600 }, maxConcurrent: 2 },
          "ithaca-host": { provider: value, lease: { maxSeconds: 1800 }, maxConcurrent: 4, options: { host: "ithaca.example" } },
        },
      },
    } as never);
    expect(summary, "CONFIG_CHECK_COMPUTE_SUMMARY").toEqual({
      enabled: true,
      providers: {
        "boat-small": { provider: "boat", byValue: false, apiKeyEnv: "BOAT_CI_KEY", options: { machine: "small", from: "odysseus-ci" }, lease: { maxSeconds: 3600 }, maxConcurrent: 2, hourlyCeilingUsd: null, retainOnRelease: null },
        "ithaca-host": { provider: null, byValue: true, apiKeyEnv: null, options: null, lease: { maxSeconds: 1800 }, maxConcurrent: 4, hourlyCeilingUsd: null, retainOnRelease: null },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("ithaca.example");
  });
});
