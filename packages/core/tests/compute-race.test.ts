/**
 * Admission serialises across real processes (#3105): racing processes
 * cannot both take the last concurrency slot or the last reserved budget. A
 * lock whose holder died is free again; a live holder's lock is never
 * stolen, and a job a live process owns is never advanced by another.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Subprocess } from "bun";

import { PENELOPE, jobDirs, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

const RUNNER = join(import.meta.dir, "compute-race.run.ts");
const RACERS = 6;

let box: Sandbox | undefined;
const children: Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  box?.dispose();
});

/** A child's stdout one line at a time; `next()` is undefined once the stream ends without one. */
function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<string | undefined> {
      while (!buffered.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const at = buffered.indexOf("\n");
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      return line;
    },
  };
}

async function race(spec: { maxConcurrent: number; ceiling?: number; cap: number }) {
  box = sandbox();
  const barrier = join(box.base, "go");
  const file = join(box.base, "race.json");
  writeFileSync(file, JSON.stringify({ root: box.root, state: box.state, barrier, ledger: join(box.base, "ledger.json"), ...spec }));
  const racers = Array.from({ length: RACERS }, () => {
    const child = Bun.spawn([process.execPath, RUNNER, "race", file], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    children.push(child);
    return { child, stdout: lines(child.stdout) };
  });
  // Release the barrier only once every racer is waiting at it, so all of them contend for admission.
  // Bounded, so a racer that never reports ready fails here; the file's
  // teardown kills every child it spawned.
  let bound: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<string>(resolve => { bound = setTimeout(() => resolve("RACER_NEVER_READY"), 10_000); });
    for (const racer of racers) expect(await Promise.race([racer.stdout.next(), timedOut])).toBe("ready");
  } finally { clearTimeout(bound); }
  writeFileSync(barrier, "");
  const results = await Promise.all(
    racers.map(async ({ child, stdout }) => {
      const [result, stderr] = await Promise.all([stdout.next(), new Response(child.stderr).text(), child.exited]);
      expect({ code: child.exitCode, stderr: child.exitCode === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(result ?? "null") as { ok: boolean; code?: string };
    })
  );
  return { admitted: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).map((r) => r.code) };
}

async function hold(lockPath: string): Promise<Subprocess> {
  const child = Bun.spawn([process.execPath, RUNNER, "hold", lockPath], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  children.push(child);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value).trim()).toBe("held");
  return child;
}

async function killed(child: Subprocess): Promise<void> {
  child.kill("SIGKILL");
  await child.exited;
  expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: null, signal: "SIGKILL" });
}

describe("racing processes", () => {
  test(`${RACERS} processes racing for one slot admit exactly one`, async () => {
    const { admitted, refused } = await race({ maxConcurrent: 1, cap: 1_000 });
    expect(admitted).toBe(1);
    expect(refused).toEqual(Array(RACERS - 1).fill("concurrency_exhausted"));
    expect(jobDirs(box!.state).length).toBe(1);
  });

  test(`${RACERS} processes racing for one reservation admit exactly one`, async () => {
    // Each job reserves 0.6 × 600 / 3600 = 0.1; the ledger holds 0.15.
    const { admitted, refused } = await race({ maxConcurrent: RACERS, ceiling: 0.6, cap: 0.15 });
    expect(admitted).toBe(1);
    expect(refused).toEqual(Array(RACERS - 1).fill("budget_exceeded"));
  });
});

describe("lock ownership", () => {
  test("a lock whose holder died is free again", async () => {
    box = sandbox();
    const svc = service(box, { providers: { ithaca: { provider: memoryCompute().provider, lease: { maxSeconds: 600 } } } }, { lockWaitMs: 200 });
    expect((await svc.plan(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
    // Plan creates nothing; the holder needs the state directory to exist.
    mkdirSync(box.state, { recursive: true, mode: 0o700 });
    await killed(await hold(join(box.state, "admission.lock")));
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    expect(run.ok).toBe(true);
  });

  test("a live holder's lock is never stolen: admission refuses after its bounded wait", async () => {
    box = sandbox();
    const memory = memoryCompute();
    const svc = service(box, { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 } } } }, { lockWaitMs: 200 });
    expect((await svc.plan(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] })).ok).toBe(true);
    // Plan creates nothing; the holder needs the state directory to exist.
    mkdirSync(box.state, { recursive: true, mode: 0o700 });
    const holder = await hold(join(box.state, "admission.lock"));
    const started = performance.now();
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["exit", "0"] });
    expect(run.ok ? "admitted" : run.code).toBe("concurrency_exhausted");
    expect(performance.now() - started).toBeGreaterThan(150);
    expect(memory.calls.length).toBe(0);
    expect(jobDirs(box.state)).toEqual([]);
    await killed(holder);
  });

  test("a job owned by a live process is skipped by reconciliation and not advanced by status", async () => {
    box = sandbox();
    const memory = memoryCompute();
    const svc = service(box, { providers: { ithaca: { provider: memory.provider, lease: { maxSeconds: 600 } } } });
    const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "3600"] });
    if (!run.ok) throw new Error(run.code);
    const holder = await hold(join(box.state, "jobs", run.job.id, "owner.lock"));
    const polls = () => memory.calls.filter((c) => c.method === "poll").length;
    const report = await svc.reconcile();
    expect(report.ok && report.skipped).toEqual([{ id: run.job.id, reason: "held by a live process" }]);
    expect((await svc.status(PENELOPE, run.job.id)).ok).toBe(true);
    expect(polls()).toBe(0);
    await killed(holder);
    await svc.status(PENELOPE, run.job.id);
    expect(polls()).toBe(1);
  });
});
