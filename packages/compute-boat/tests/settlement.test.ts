/**
 * Core's lifecycle driving the Boat adapter to settlement: a discarded
 * sandbox's usage cannot be read after deletion, so the reservation is
 * settled once with what is known, in the process that deleted it and in a
 * different one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComputeService } from "@schlessera/brain/internal";

import { createBoatProvider } from "../src/provider";
import { fakeBoat, type FakeBoat } from "./helpers/fake-boat";
import { KEY } from "./helpers/context";

const CALLER = { kind: "cli", principal: "penelope" } as const;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function brain() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "brain-boat-settle-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "brain-boat-settle-state-")));
  dirs.push(root, stateDir);
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "voyage.md"), "# Ithaca\n");
  return { root, stateDir };
}

function service(fake: FakeBoat, where: { root: string; stateDir: string }, settle: (id: string, usd: number | null) => void) {
  return createComputeService({
    ...where,
    env: { BOAT_KEY: KEY },
    fetch: fake.fetch,
    budget: { reserve: () => "ok", settle },
    config: {
      compute: {
        providers: { "boat-small": { provider: createBoatProvider(), apiKeyEnv: "BOAT_KEY", lease: { maxSeconds: 600 }, maxConcurrent: 2, hourlyCeilingUsd: 6 } },
      },
    },
  });
}

async function finish(svc: ReturnType<typeof service>, id: string) {
  for (let i = 0; i < 20; i++) {
    const status = await svc.status(CALLER, id);
    if (!status.ok) throw new Error(status.code);
    if (status.job.terminal && status.job.cleanup.state === "released") return status.job;
    await Bun.sleep(5);
  }
  throw new Error("the job did not finish");
}

describe("settling a discarded Boat sandbox", () => {
  test("the process that deleted it settles the reservation exactly once, recording the pre-deletion reading as partial", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0, secondsPerDollar: 100_000 });
    const settled: [string, number | null][] = [];
    const svc = service(fake, brain(), (id, usd) => void settled.push([id, usd]));
    const run = await svc.run(CALLER, { instance: "boat-small", argv: ["exit", "0"] });
    if (!run.ok) throw new Error(run.code);
    const job = await finish(svc, run.job.id);
    for (let i = 0; i < 3; i++) await svc.status(CALLER, job.id);
    const last = await svc.status(CALLER, job.id);
    if (!last.ok) throw new Error(last.code);
    expect(last.job.cost.actual.coverage).toBe("partial");
    expect(settled).toEqual([[job.id, null]]);
    expect(fake.liveSandboxes()).toBe(0);
  });

  test("a different process, which never saw the reading, settles it too", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0, secondsPerDollar: 100_000 });
    const where = brain();
    const settled: [string, number | null][] = [];
    // The first process deletes the sandbox, then cannot reach its ledger.
    const first = service(fake, where, () => {
      throw new Error("ledger unreachable");
    });
    const run = await first.run(CALLER, { instance: "boat-small", argv: ["exit", "0"] });
    if (!run.ok) throw new Error(run.code);
    await finish(first, run.job.id);
    // A second process, with a fresh adapter and no memory of the reading.
    const second = service(fake, where, (id, usd) => void settled.push([id, usd]));
    for (let i = 0; i < 3; i++) await second.status(CALLER, run.job.id);
    const last = await second.status(CALLER, run.job.id);
    if (!last.ok) throw new Error(last.code);
    // The first process recorded the pre-deletion reading; the unknown read after deletion keeps it.
    expect(last.job.cost.actual.coverage).toBe("partial");
    expect(settled).toEqual([[run.job.id, null]]);
  });
});
