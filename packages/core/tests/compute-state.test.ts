/**
 * Compute state lives outside the brain and outside brain.db (#3105): a
 * per-brain default under the user's state home, an absolute override that
 * may not point into the checkout, private modes, atomic records, and
 * nothing `brain index --force` reads or rebuilds.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createComputeService } from "../src/lib/compute/service";
import { ComputeStateError, computeBrainKey } from "../src/lib/compute/state-dir";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { HOSTED, PENELOPE, fakeClock, filesContaining, jobDirs, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

const compute = (provider = memoryCompute().provider) => ({ providers: { ithaca: { provider, lease: { maxSeconds: 600 }, maxConcurrent: 4 } } });

describe("where state lives", () => {
  test("by default, a per-brain directory under XDG_STATE_HOME", async () => {
    box = sandbox();
    const home = join(box.base, "xdg-state");
    const svc = createComputeService({ root: box.root, config: { compute: compute() }, env: { XDG_STATE_HOME: home } });
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    if (!run.ok) throw new Error(run.code);
    const key = createHash("sha256").update(realpathSync(box.root)).digest("hex").slice(0, 16);
    expect(computeBrainKey(box.root)).toBe(key);
    const dir = join(home, "brain", "compute", key);
    expect(existsSync(join(dir, "jobs", run.job.id, "job.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "brain.json"), "utf8")).brain).toBe(key);
  });

  test("BRAIN_COMPUTE_STATE_DIR overrides the default, and a host option overrides both", async () => {
    box = sandbox();
    const fromEnv = join(box.base, "from-env");
    const fromHost = join(box.base, "from-host");
    const a = createComputeService({ root: box.root, config: { compute: compute() }, env: { BRAIN_COMPUTE_STATE_DIR: fromEnv } });
    expect((await a.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
    const b = createComputeService({ root: box.root, stateDir: fromHost, config: { compute: compute() }, env: { BRAIN_COMPUTE_STATE_DIR: fromEnv } });
    expect((await b.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
    expect([jobDirs(fromEnv).length, jobDirs(fromHost).length]).toEqual([1, 1]);
  });

  test("a state directory inside the brain checkout, or a relative one, is refused before anything is written", async () => {
    box = sandbox();
    for (const stateDir of [join(box.root, ".compute"), box.root, "relative/state"]) {
      const svc = createComputeService({ root: box.root, stateDir, config: { compute: compute() }, env: {} });
      await expect(svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).rejects.toBeInstanceOf(ComputeStateError);
    }
    const viaEnv = createComputeService({ root: box.root, config: { compute: compute() }, env: { BRAIN_COMPUTE_STATE_DIR: join(box.root, "notes", "jobs") } });
    await expect(viaEnv.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).rejects.toBeInstanceOf(ComputeStateError);
    expect(existsSync(join(box.root, "notes", "jobs", "jobs"))).toBe(false);
  });

  test("a refused state directory creates nothing inside the brain, even through a symlinked ancestor", async () => {
    box = sandbox();
    symlinkSync(box.root, join(box.base, "brain-link"));
    for (const stateDir of [join(box.root, ".compute", "state"), join(box.root, "notes", "jobs"), join(box.base, "brain-link", "compute")]) {
      const svc = createComputeService({ root: box.root, stateDir, config: { compute: compute() }, env: {} });
      await expect(svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).rejects.toBeInstanceOf(ComputeStateError);
    }
    expect([".compute", "notes/jobs", "compute"].filter((p) => existsSync(join(box!.root, p)))).toEqual([]);
  });

  test("directories are 0700 and records 0600", async () => {
    box = sandbox();
    const svc = service(box, compute());
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    if (!run.ok) throw new Error(run.code);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect([mode(box.state), mode(join(box.state, "jobs")), mode(join(box.state, "jobs", run.job.id))]).toEqual([0o700, 0o700, 0o700]);
    expect(mode(join(box.state, "jobs", run.job.id, "job.json"))).toBe(0o600);
  });
});

describe("records", () => {
  test("a failed publish keeps the previous record whole", async () => {
    box = sandbox();
    let fail = false;
    const svc = service(box, compute(), { storeHooks: { beforePublish: () => { if (fail) throw new Error("disk full"); } } });
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    if (!run.ok) throw new Error(run.code);
    const path = join(box.state, "jobs", run.job.id, "job.json");
    const before = readFileSync(path, "utf8");
    fail = true;
    await expect(svc.status(PENELOPE, run.job.id)).rejects.toThrow("disk full");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(before).state).toBe("running");
    fail = false;
    const done = await svc.status(PENELOPE, run.job.id);
    expect(done.ok && done.job.state).toBe("succeeded");
  });

  test("a record this version cannot read is skipped and reported, never touched, and never blocks other jobs", async () => {
    box = sandbox();
    const svc = service(box, compute());
    expect((await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
    const foreign = `cj_${"a".repeat(26)}`;
    const broken = `cj_${"b".repeat(26)}`;
    const records = { [foreign]: `${JSON.stringify({ schema: 2, id: foreign, state: "running" })}\n`, [broken]: "{ not json" };
    for (const [id, text] of Object.entries(records)) {
      mkdirSync(join(box.state, "jobs", id), { recursive: true });
      writeFileSync(join(box.state, "jobs", id, "job.json"), text);
    }
    const plan = await svc.plan(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    expect(plan.ok).toBe(true);
    expect((await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
    const report = await svc.reconcile();
    expect(report.ok && report.skipped.filter((s) => s.id === foreign || s.id === broken).map((s) => s.id).sort()).toEqual([foreign, broken]);
    for (const [id, text] of Object.entries(records)) expect(readFileSync(join(box.state, "jobs", id, "job.json"), "utf8")).toBe(text);
    expect(readdirSync(join(box.state, "jobs", foreign))).toEqual(["job.json"]);
  });

  test("no record, output or receipt holds a credential", async () => {
    box = sandbox();
    const clock = fakeClock();
    const memory = memoryCompute({ clock });
    const svc = service(box, { providers: { ithaca: { provider: memory.provider, apiKeyEnv: "ITHACA_KEY", lease: { maxSeconds: 600 } } } }, {
      clock,
      env: { ITHACA_KEY: "sk-ithaca-the-loom-unravels" },
    });
    const run = await svc.run(HOSTED, { instance: "ithaca", argv: ["printenv"], env: { VOYAGE: "home" }, source: ["notes/raft.md"] });
    if (!run.ok) throw new Error(run.code);
    await svc.status(HOSTED, run.job.id);
    expect(memory.calls.filter((c) => c.secret !== "sk-ithaca-the-loom-unravels").map((c) => c.method)).toEqual([]);
    expect(filesContaining(box.state, "sk-ithaca-the-loom-unravels")).toEqual([]);
  });
});

describe("brain.db is not the authority", () => {
  test("brain index --force neither reads nor rebuilds compute state, and brain.db holds none", async () => {
    const root = makeTempBrain();
    const base = sandbox();
    try {
      const state = join(base.base, "compute-state");
      mkdirSync(state);
      const svc = createComputeService({ root, stateDir: state, config: { compute: compute() }, env: {} });
      const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
      if (!run.ok) throw new Error(run.code);
      const record = join(state, "jobs", run.job.id, "job.json");
      const before = readFileSync(record, "utf8");
      const index = await runCli(root, ["index", "--force", "--json"], { BRAIN_COMPUTE_STATE_DIR: state });
      expect(index.code).toBe(0);
      expect(readFileSync(record, "utf8")).toBe(before);
      const db = new Database(join(root, ".brain-index", "brain.db"), { readonly: true });
      try {
        const names = db.query("SELECT name FROM sqlite_master").all() as { name: string }[];
        expect(names.filter((n) => /compute|sandbox|lease/i.test(n.name))).toEqual([]);
      } finally {
        db.close();
      }
      const status = await svc.status(PENELOPE, run.job.id);
      expect(status.ok && status.job.state).toBe("running");
    } finally {
      cleanup(root);
      base.dispose();
    }
  });
});
