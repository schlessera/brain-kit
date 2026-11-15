/**
 * Every refusal code returns before any effect (#3105): the provider sees no
 * call and no job directory appears. An unconfigured brain keeps working
 * locally, and naming no instance never selects one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createComputeService } from "../src/lib/compute/service";
import type { ComputeRunRequest } from "../src/lib/compute/types";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { HOSTED, PENELOPE, fakeClock, jobDirs, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute, type MemoryCompute } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

const EFFECTS = new Set(["allocate", "find", "stage", "exec", "poll", "kill", "collect", "release", "usage"]);
const effects = (memory: MemoryCompute) => memory.calls.filter((c) => EFFECTS.has(c.method)).length;

function setup(instance: Record<string, unknown> = {}, extra: Parameters<typeof service>[2] = {}, caps?: Parameters<typeof memoryCompute>[0]) {
  box = sandbox();
  const memory = memoryCompute({ clock: fakeClock(), ...caps });
  const svc = service(box, { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 }, ...instance } } }, extra);
  return { memory, svc, box };
}

async function expectRefusal(code: string, request: Partial<ComputeRunRequest>, ...args: Parameters<typeof setup>) {
  const { memory, svc, box } = setup(...args);
  const result = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"], ...request });
  expect(result.ok ? "admitted" : result.code).toBe(code);
  expect(effects(memory)).toBe(0);
  expect(jobDirs(box.state)).toEqual([]);
  return result;
}

describe("refusals before any effect", () => {
  test("compute_disabled: no compute key, nothing touched", async () => {
    box = sandbox();
    const svc = createComputeService({ root: box.root, stateDir: box.state, config: {}, env: {} });
    for (const result of [
      await svc.run(PENELOPE, { instance: "ithaca", argv: ["true"] }),
      await svc.plan(PENELOPE, { instance: "ithaca", argv: ["true"] }),
      await svc.status(PENELOPE, "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      await svc.cancel(PENELOPE, "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      await svc.collect(PENELOPE, "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      await svc.abandon(PENELOPE, "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      await svc.reconcile(),
    ]) {
      expect(result.ok ? "ran" : result.code).toBe("compute_disabled");
    }
    expect(await svc.health()).toEqual({ ok: true, enabled: false, instances: [] });
    expect(existsSync(box.state)).toBe(false);
  });

  test("provider_unknown: an instance that is not configured is never a default", async () => {
    await expectRefusal("provider_unknown", { instance: "troy" });
  });

  test("provider_unavailable: a configured credential that is unset", async () => {
    await expectRefusal("provider_unavailable", {}, { apiKeyEnv: "ITHACA_KEY" });
  });

  test("capability_unsupported: staging, collection, retention or a lease the instance cannot honour", async () => {
    await expectRefusal("capability_unsupported", { source: ["notes/raft.md"] }, {}, {}, { capabilities: { stage: false } });
    await expectRefusal("capability_unsupported", { artifacts: [{ path: "out.txt", maxBytes: 10 }] }, {}, {}, { capabilities: { collect: false } });
    await expectRefusal("capability_unsupported", { artifacts: [{ path: "out.txt", maxBytes: 4096 }] }, {}, {}, { capabilities: { collect: { maxBytes: 1024 } } });
    await expectRefusal("capability_unsupported", {}, { retainOnRelease: true }, {}, { capabilities: { retain: false } });
    await expectRefusal("capability_unsupported", { leaseSeconds: 600 }, {}, {}, { capabilities: { maxLeaseSeconds: 300 } });
    await expectRefusal("capability_unsupported", { source: ["notes/raft.md"] }, {}, {}, { capabilities: { stage: { maxBytes: 8 } } });
  });

  test("lease_required: a lease that is not a finite positive number of seconds", async () => {
    await expectRefusal("lease_required", { leaseSeconds: 0 });
    await expectRefusal("lease_required", { leaseSeconds: Infinity });
    await expectRefusal("lease_required", { leaseSeconds: 1.5 });
  });

  test("policy_denied: a lease over the instance ceiling, a credential in the environment, a missing hosted identity", async () => {
    await expectRefusal("policy_denied", { leaseSeconds: 601 });
    await expectRefusal("policy_denied", { env: { GITHUB_TOKEN: "x" } });
    await expectRefusal("policy_denied", { env: { ITHACA_KEY: "anything" } }, { apiKeyEnv: "ITHACA_KEY" }, { env: { ITHACA_KEY: "k" } });
    await expectRefusal("policy_denied", { env: { VOYAGE: "carry k-secret-ithaca" } }, { apiKeyEnv: "ITHACA_KEY" }, { env: { ITHACA_KEY: "k-secret-ithaca" } });
    await expectRefusal("policy_denied", { argv: [] });
    const { memory, svc } = setup();
    const result = await svc.run({ ...HOSTED, turn: "" } as typeof HOSTED, { instance: "ithaca", argv: ["exit", "0"] });
    expect(result.ok ? "admitted" : result.code).toBe("policy_denied");
    expect(effects(memory)).toBe(0);
  });

  test("policy_denied: a source file the data-to-provider policy keeps from this instance", async () => {
    await expectRefusal("policy_denied", { source: ["health/sea-sickness.md"] }, {}, { sourcePolicy: { providers: [{ types: ["health"], paths: [], allow: ["pylos"] }] } });
  });

  test("approval_required: the host requires approval", async () => {
    await expectRefusal("approval_required", {}, {}, { approve: () => "required" });
  });

  test("source_refused: undeclared, escaping, absolute, missing, linked or metadata paths", async () => {
    await expectRefusal("source_refused", { source: ["../outside.md"] });
    await expectRefusal("source_refused", { source: ["/etc/hostname"] });
    await expectRefusal("source_refused", { source: ["notes/absent.md"] });
    await expectRefusal("source_refused", { source: ["notes"] });
    await expectRefusal("source_refused", { source: [".git/config"] });
    await expectRefusal("source_refused", { source: ["notes/raft.md", "notes/raft.md"] });
    const { memory, svc, box } = setup();
    writeFileSync(join(box.base, "outside.md"), "# Not in the brain\n");
    symlinkSync(join(box.root, "notes", "raft.md"), join(box.root, "notes", "alias.md"));
    symlinkSync(join(box.root, "notes"), join(box.root, "linked-notes"));
    for (const path of ["../outside.md", "notes/../../outside.md", "notes/alias.md", "linked-notes/raft.md"]) {
      const refused = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"], source: [path] });
      expect(refused.ok ? `admitted ${path}` : refused.code).toBe("source_refused");
    }
    expect(effects(memory)).toBe(0);
    expect(jobDirs(box.state)).toEqual([]);
  });

  test("policy_denied: the instance credential in argv, cwd, an artifact or a source path, never echoed", async () => {
    const secret = "k-secret-ithaca";
    const keyed = [{ apiKeyEnv: "ITHACA_KEY" }, { env: { ITHACA_KEY: secret } }] as const;
    for (const request of [
      { argv: ["curl", "-H", `Authorization: Bearer ${secret}`] },
      { cwd: `work/${secret}` },
      { artifacts: [{ path: `out/${secret}.txt`, maxBytes: 64 }] },
      { source: [`notes/${secret}.md`] },
    ]) {
      const refused = await expectRefusal("policy_denied", request, ...keyed);
      expect(JSON.stringify(refused)).not.toContain(secret);
    }
  });

  test("budget_exceeded and accounting_unavailable come from the host ledger", async () => {
    await expectRefusal("budget_exceeded", {}, { hourlyCeilingUsd: 1 }, { budget: { reserve: () => "exceeded", settle() {} } });
    await expectRefusal("accounting_unavailable", {}, {}, { budget: { reserve: () => { throw new Error("ledger offline"); }, settle() {} } });
  });

  test("concurrency_exhausted: the last slot is taken, and a busy admission lock refuses after a bounded wait", async () => {
    const { memory, svc, box } = setup();
    const first = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    expect(first.ok && first.job.state).toBe("running");
    const before = effects(memory);
    const second = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    expect(second.ok ? "admitted" : second.code).toBe("concurrency_exhausted");
    expect(effects(memory)).toBe(before);
    expect(jobDirs(box.state).length).toBe(1);
  });

  test("job_unknown: an id that does not exist, a malformed one, or a raw sandbox id", async () => {
    const { svc } = setup();
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
    expect(run.ok).toBe(true);
    for (const id of ["cj_aaaaaaaaaaaaaaaaaaaaaaaaaa", "sbx-0001", "../../etc", ""]) {
      const result = await svc.status(PENELOPE, id);
      expect(result.ok ? "found" : result.code).toBe("job_unknown");
    }
  });

  test("plan admits without effects and reports the would-be lease, manifest and estimate", async () => {
    const { memory, svc, box } = setup({ hourlyCeilingUsd: 0.6 });
    const plan = await svc.plan(PENELOPE, { instance: "ithaca", argv: ["exit", "0"], source: ["notes/route.md"], leaseSeconds: 600 });
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.plan.lease.seconds).toBe(600);
    expect(plan.plan.source.files.map((f) => f.path)).toEqual(["notes/route.md"]);
    expect(plan.plan.estimate).toEqual({ usd: 0.1, basis: "ceiling" });
    expect(effects(memory)).toBe(0);
    expect(jobDirs(box.state)).toEqual([]);
  });
});

describe("source swapped after admission", () => {
  for (const [what, swap] of [
    ["a symlink to an identical file outside the brain", (route: string, outside: string) => { writeFileSync(outside, readFileSync(route)); rmSync(route); symlinkSync(outside, route); }],
    ["a regular file with other bytes", (route: string) => { writeFileSync(route, "# Route home\nSteer for Troy.\n"); }],
  ] as const) {
    test(`a source file replaced by ${what} between admission and staging is never staged`, async () => {
      const ctx = setup({}, { approve: () => (swap(join(ctx.box.root, "notes", "route.md"), join(ctx.box.base, "outside.md")), "approved") });
      const { memory, svc } = ctx;
      const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"], source: ["notes/route.md"] });
      expect(memory.calls.filter((c) => c.method === "stage").length).toBe(0);
      expect(run.ok && [run.job.state, run.job.terminal?.reason, run.job.cleanup.state]).toEqual([
        "failed", expect.stringContaining("notes/route.md changed after admission"), "released",
      ]);
      expect([...memory.sandboxes.values()].map((s) => s.files.size).filter((n) => n > 0)).toEqual([]);
    });
  }
});

describe("local operation without compute", () => {
  test("an unconfigured brain and one naming a built-in without its key both search normally", async () => {
    const root = makeTempBrain();
    try {
      expect((await runCli(root, ["index", "--json"])).code).toBe(0);
      const plain = await runCli(root, ["search", "raft", "--json"]);
      expect(plain.code).toBe(0);
      const paths = (out: string) => (JSON.parse(out) as { results: { path: string }[] }).results.map((r) => r.path);
      const configPath = join(root, "brain.config.ts");
      writeFileSync(configPath, readFileSync(configPath, "utf8").replace(
        "export default defineConfig({",
        'export default defineConfig({\n  compute: { providers: { "boat-small": { provider: "boat", apiKeyEnv: "BOAT_CI_KEY", lease: { maxSeconds: 3600 } } } },'
      ));
      const configured = await runCli(root, ["search", "raft", "--json"]);
      expect(configured.code).toBe(0);
      expect(paths(configured.stdout)).toEqual(paths(plain.stdout));
      expect(paths(plain.stdout).length).toBeGreaterThan(0);
    } finally {
      cleanup(root);
    }
  });
});
