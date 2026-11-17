/**
 * Jobs are opaque host handles bound to the brain and the caller (#3105). A
 * caller cannot reach another caller's job, and a raw vendor id is not a job.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createComputeService } from "../src/lib/compute/service";
import type { ComputeCaller } from "../src/lib/compute/types";
import { HOSTED, PENELOPE, TELEMACHUS, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

function setup() {
  box = sandbox();
  const memory = memoryCompute();
  const config = { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: 4 } } };
  return { memory, config, svc: service(box, config), box };
}

const OPERATIONS = ["status", "cancel", "collect", "abandon"] as const;

test("another caller, another kind with the same principal, or another hosted session cannot reach the job", async () => {
  const { memory, svc } = setup();
  const own = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
  const hosted = await svc.run(HOSTED, { instance: "ithaca", argv: ["sleep", "60"] });
  if (!own.ok || !hosted.ok) throw new Error("not admitted");
  const callsBefore = memory.calls.length;
  for (const [caller, id] of [
    [TELEMACHUS, own.job.id],
    [{ kind: "mcp", principal: "penelope" }, own.job.id],
    [{ ...HOSTED, session: "s-aeaea" }, hosted.job.id],
    [PENELOPE, hosted.job.id],
  ] satisfies [ComputeCaller, string][]) {
    for (const op of OPERATIONS) {
      const result = await svc[op](caller, id);
      expect(result.ok ? `${op} reached it` : result.code).toBe("job_unknown");
    }
  }
  expect(memory.calls.length).toBe(callsBefore);
  const mine = await svc.status(PENELOPE, own.job.id);
  expect(mine.ok && mine.job.state).toBe("running");
  const sameSessionNextTurn = await svc.status({ ...HOSTED, turn: "t-2" }, hosted.job.id);
  expect(sameSessionNextTurn.ok).toBe(true);
});

test("a raw sandbox or command id is not a job id", async () => {
  const { memory, svc } = setup();
  const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
  if (!run.ok) throw new Error(run.code);
  const [sbx] = memory.sandboxes.keys();
  const [cmd] = memory.sandboxes.get(sbx)!.commands.keys();
  for (const id of [sbx, cmd, `cj_${sbx}`, run.job.id.toUpperCase(), `${run.job.id}/../x`]) {
    const result = await svc.status(PENELOPE, id);
    expect(result.ok ? "found" : result.code).toBe("job_unknown");
  }
  expect(JSON.stringify(run.job)).not.toContain(sbx);
});

test("a job of another brain sharing the state directory is unknown here", async () => {
  const { config, svc, box } = setup();
  const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
  if (!run.ok) throw new Error(run.code);
  const otherRoot = join(box.base, "other-brain");
  mkdirSync(otherRoot);
  writeFileSync(join(otherRoot, "README.md"), "# Aeaea\n");
  const other = createComputeService({ root: otherRoot, stateDir: box.state, config: { compute: config }, env: {} });
  const result = await other.status(PENELOPE, run.job.id);
  expect(result.ok ? "found" : result.code).toBe("job_unknown");
  const report = await other.reconcile();
  expect(report.ok && report.visited).toEqual([]);
});
