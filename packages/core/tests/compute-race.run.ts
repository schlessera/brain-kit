/**
 * Child processes for the compute recovery and race tests. Not a test file:
 * compute-race.test.ts and compute-recovery.test.ts spawn it, one mode per
 * process, and assert its exit. It installs the repository network guard
 * itself, since a plain `bun` child does not run the test preload.
 *
 *   race <spec>   print "ready", wait for a barrier file, then run one job;
 *                 print the result
 *   hold <path>   take a compute lock, print "held", and keep it until killed
 *   crash <spec>  run a job on the local-process provider and SIGKILL this
 *                 process at a named point, leaving the record mid-lifecycle
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { installNetworkGuard } from "../../../scripts/test-network-guard";
import { acquireLock } from "../src/lib/compute/lock";
import { createComputeService } from "../src/lib/compute/service";
import type { ComputeBudget } from "../src/lib/compute/types";
import type { ComputeProvider } from "../src/lib/seams";
import { PENELOPE } from "./helpers/compute/fixture";
import { localProcessCompute } from "./helpers/compute/local-process-provider";
import { memoryCompute } from "./helpers/compute/memory-provider";

const guard = installNetworkGuard();
const [mode, arg] = process.argv.slice(2);

/** A file ledger that admits reservations up to `cap`; slow on purpose, to widen any race. */
function fileBudget(ledger: string, cap: number): ComputeBudget {
  return {
    async reserve(id, usd) {
      const held = existsSync(ledger) ? (JSON.parse(readFileSync(ledger, "utf8")) as Record<string, number>) : {};
      await Bun.sleep(50);
      const total = Object.values(held).reduce((a, b) => a + b, 0) + (usd ?? 0);
      if (total > cap) return "exceeded";
      writeFileSync(ledger, JSON.stringify({ ...held, [id]: usd ?? 0 }));
      return "ok";
    },
    settle() {},
  };
}

const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

if (mode === "race") {
  const spec = JSON.parse(readFileSync(arg, "utf8")) as {
    root: string; state: string; barrier: string; maxConcurrent: number; ceiling?: number; ledger: string; cap: number;
  };
  const memory = memoryCompute();
  const svc = createComputeService({
    root: spec.root,
    stateDir: spec.state,
    env: {},
    lockWaitMs: 20_000,
    budget: fileBudget(spec.ledger, spec.cap),
    config: { compute: { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: spec.maxConcurrent, hourlyCeilingUsd: spec.ceiling } } } },
  });
  // Every racer reports "ready" here; the test writes the barrier only once all have.
  console.log("ready");
  while (!existsSync(spec.barrier)) await Bun.sleep(2);
  const result = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "3600"] });
  console.log(JSON.stringify(result.ok ? { ok: true, id: result.job.id } : { ok: false, code: result.code }));
} else if (mode === "hold") {
  const lock = await acquireLock(arg, 5_000);
  if (!lock) throw new Error(`could not take ${arg}`);
  console.log("held");
  await new Promise(() => {});
} else if (mode === "crash") {
  const spec = JSON.parse(readFileSync(arg, "utf8")) as {
    root: string; state: string; work: string; at: string; argv: string[]; source?: string[]; artifacts?: { path: string; maxBytes: number }[];
  };
  const local = localProcessCompute(spec.work);
  const base = local.provider;
  const crashing = (method: keyof ComputeProvider) =>
    (async (...args: unknown[]) => {
      if (spec.at === `${method}-before`) die();
      const result = await (base[method] as (...a: unknown[]) => Promise<unknown>)(...args);
      if (spec.at === method) die();
      return result;
    }) as never;
  const provider: ComputeProvider = {
    ...base,
    allocate: crashing("allocate"),
    stage: crashing("stage"),
    exec: crashing("exec"),
    collect: crashing("collect"),
    release: crashing("release"),
  };
  let publishes = 0;
  const svc = createComputeService({
    root: spec.root,
    stateDir: spec.state,
    env: {},
    storeHooks: { beforePublish: () => void (spec.at === "admitted" && ++publishes === 2 && die()) },
    config: { compute: { providers: { ithaca: { provider, lease: { maxSeconds: 600 }, maxConcurrent: 4 } } } },
  });
  const run = await svc.run(PENELOPE, { instance: "ithaca", argv: spec.argv, source: spec.source, artifacts: spec.artifacts });
  if (!run.ok) throw new Error(run.code);
  for (let i = 0; i < 500; i++) {
    const status = await svc.status(PENELOPE, run.job.id);
    if (status.ok && status.job.terminal) break;
    await Bun.sleep(10);
  }
  throw new Error(`no crash at ${spec.at}`);
} else {
  throw new Error("run through compute-race.test.ts or compute-recovery.test.ts");
}
guard.assertNoEscapes();
