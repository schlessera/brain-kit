/**
 * The periodic scratch prune (#310): the server asks `brain scratch prune`
 * to run at boot and every hour, through the brain CLI client; a failed
 * pass is a log line, not a crash; a hung pass is killed at its deadline;
 * and closing the server kills a pass in flight and waits for it.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { installNativeBrainClientFixtures } from "./helpers/native-brain-client-fixture.js";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";
import {
  SCRATCH_PRUNE_DEADLINE_MS,
  SCRATCH_PRUNE_INTERVAL_MS,
  startScratchPrune,
} from "../src/cron/scratch-prune";
import { createRecordingObservability } from "../src/observability/index";
import { createTestApp } from "./helpers/test-app";

const { createFixtureBrainClient: createBrainClient } = installNativeBrainClientFixtures();

/**
 * Host pids of the processes running `marker` (the fixture CLI's path). A
 * pid the CLI records itself is its PID namespace's when it runs in a
 * maintenance worker (#1648), so the host's process table is asked instead;
 * the worker's own launcher names the same path.
 */
function hostPidsRunning(marker: string): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { return readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0")[1] === marker ? [Number(name)] : []; } catch { return []; }
  });
}
/** Whether `pid` still answers signal 0, which a zombie does until it is reaped. */
function answers(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type Step = "ok" | Error | "hang";

/**
 * A brain client whose prune resolves or rejects as scripted, one call at a
 * time. A hanging call honours the abort signal the way the real client
 * does: it rejects once the signal fires (the child is dead by then).
 */
function scriptedBrain(script: Step[]) {
  const calls: number[] = [];
  const aborted: string[] = [];
  let release: (() => void) | null = null;
  const brain = {
    scratchPrune: (opts?: { signal?: AbortSignal }) => {
      calls.push(Date.now());
      const step = script.shift() ?? "ok";
      if (step === "hang") {
        return new Promise<string>((resolve, reject) => {
          release = () => resolve("");
          opts?.signal?.addEventListener("abort", () => {
            aborted.push(String((opts.signal!.reason as Error).message));
            reject(opts.signal!.reason);
          });
        });
      }
      return step === "ok" ? Promise.resolve("Pruned") : Promise.reject(step);
    },
  };
  return { brain, calls, aborted, release: () => release?.() };
}

function harness(script: Step[] = [], deadlineMs?: number) {
  const { brain, calls, aborted, release } = scriptedBrain(script);
  const observability = createRecordingObservability();
  const scheduled: Array<{ check: () => void; ms: number; cancelled: boolean }> = [];
  const pruner = startScratchPrune({
    brain,
    log: observability.logger("cron"),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    every: (check, ms) => {
      const entry = { check, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return { pruner, calls, aborted, release, observability, scheduled };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startScratchPrune", () => {
  test("runs once at boot and schedules an hourly pass", async () => {
    const { calls, scheduled, pruner } = harness();
    await settle();
    expect(calls).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(SCRATCH_PRUNE_INTERVAL_MS);
    expect(SCRATCH_PRUNE_INTERVAL_MS).toBe(60 * 60 * 1000);
    scheduled[0].check();
    await settle();
    expect(calls).toHaveLength(2);
    await pruner.close();
    expect(scheduled[0].cancelled).toBe(true);
  });

  test("a failed pass is logged at WARN and the timer keeps going", async () => {
    const { calls, scheduled, observability, pruner } = harness([new Error("brain scratch prune failed (exit 1): unknown command")]);
    await settle();
    expect(observability.logs.count({ scope: "cron", severity: "WARN", body: "scratch prune failed" })).toBe(1);
    scheduled[0].check();
    await settle();
    expect(calls).toHaveLength(2);
    expect(observability.logs.count({ scope: "cron", severity: "WARN" })).toBe(1);
    await pruner.close();
  });

  test("a pass still running when the next is due is not doubled", async () => {
    const { calls, scheduled, release, pruner } = harness(["hang"]);
    await settle();
    expect(calls).toHaveLength(1);
    scheduled[0].check();
    scheduled[0].check();
    await settle();
    expect(calls).toHaveLength(1);
    release();
    await settle();
    scheduled[0].check();
    await settle();
    expect(calls).toHaveLength(2);
    await pruner.close();
  });

  test("a hung pass is killed at the deadline, logged, and the next pass runs", async () => {
    expect(SCRATCH_PRUNE_DEADLINE_MS).toBe(5 * 60 * 1000);
    const { calls, scheduled, aborted, observability, pruner } = harness(["hang"], 20);
    await settle();
    expect(calls).toHaveLength(1);
    await settle(60);
    expect(aborted).toEqual(["scratch prune exceeded 20ms and was killed"]);
    expect(observability.logs.count({ scope: "cron", severity: "WARN", body: "scratch prune failed" })).toBe(1);
    scheduled[0].check();
    await settle();
    expect(calls).toHaveLength(2);
    await pruner.close();
  });

  test("closing during a pass kills it, resolves once it has ended, and runs nothing afterwards", async () => {
    const { calls, scheduled, aborted, pruner } = harness(["hang"]);
    await settle();
    expect(calls).toHaveLength(1);
    let closed = false;
    const closing = pruner.close().then(() => {
      closed = true;
    });
    await settle();
    expect(aborted).toEqual(["the server is shutting down"]);
    await closing;
    expect(closed).toBe(true);
    scheduled[0].check();
    await pruner.tick();
    expect(calls).toHaveLength(1);
  });
});

describe("BrainClient.scratchPrune", () => {
  /** A fake `brain` bin; `CAPTURE` in its source is replaced by a path it may write to. */
  function brainWithCli(source: string): { root: string; capture: string; bin: string } {
    const root = mkdtempSync(join(tmpdir(), "brain-scratch-prune-"));
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const capture = join(root, "capture.txt");
    const bin = join(binDir, "brain");
    writeFileSync(bin, `#!/usr/bin/env bun\n${source.replaceAll("CAPTURE", `(process.env.BRAIN_WORKER_DATA_ROOT ? process.env.BRAIN_WORKER_DATA_ROOT + "/capture.txt" : ${JSON.stringify(capture)})`)}`);
    chmodSync(bin, 0o755);
    return { root, capture, bin };
  }

  test("spawns `brain scratch prune` in the brain repo and surfaces a non-zero exit", async () => {
    const { root, capture, bin } = brainWithCli(
      `import { writeFileSync } from "fs";\n` +
        `writeFileSync(CAPTURE, JSON.stringify(process.argv.slice(2)));\n` +
        `if (process.argv.includes("prune")) { console.log("Pruned .brain/scratch/: removed 0 file(s)"); process.exit(0); }\n` +
        `console.error("unknown command"); process.exit(1);\n`
    );
    try {
      const brain = createBrainClient({ brainPath: root });
      expect(await brain.scratchPrune()).toContain("Pruned");
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["scratch", "prune"]);

      writeFileSync(bin, `#!/usr/bin/env bun\nconsole.error("unknown command"); process.exit(1);\n`);
      await expect(brain.scratchPrune()).rejects.toThrow(/brain scratch prune failed \(exit 1\): unknown command/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pass that left a file it could not remove (exit 2, report printed) rejects with the report, so the pruner warns", async () => {
    const { root } = brainWithCli(
      `console.log(JSON.stringify({ action: "prune", removed: [], failed: [{ path: ".brain/scratch/stuck.pdf", reason: "EPERM" }], bytes: 5, files: 1 }));\n` +
        `process.exit(2);\n`
    );
    try {
      const brain = createBrainClient({ brainPath: root });
      await expect(brain.scratchPrune()).rejects.toThrow(/exit 2.*stuck\.pdf/s);
      const observability = createRecordingObservability();
      const pruner = startScratchPrune({ brain, log: observability.logger("cron"), every: () => () => {} });
      await pruner.tick();
      expect(observability.logs.count({ scope: "cron", severity: "WARN", body: "scratch prune failed" })).toBe(1);
      await pruner.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an aborted signal kills the child, and the call rejects only once it is gone", async () => {
    const { root, bin } = brainWithCli(
      `await Bun.sleep(60_000);\n`
    );
    const controller = new AbortController();
    let call: Promise<string> | undefined;
    try {
      const brain = createBrainClient({ brainPath: root });
      call = brain.scratchPrune({ signal: controller.signal });
      // Observe an early refusal rather than polling until the outer timeout.
      let outcome: unknown;
      void call.catch(error => { outcome = error; });
      const pids = await observeBootPrune(bin, createRecordingObservability(), { pids: marker => {
        if (outcome) throw outcome;
        return hostPidsRunning(marker);
      } });
      expect(pids.length).toBeGreaterThan(0);
      controller.abort(new Error("deadline"));
      await expect(call).rejects.toThrow("deadline");
      // The child has exited by the time the rejection arrives: a zombie
      // still answers signal 0, so wait for the reaper as well.
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        alive = pids.some(answers);
        if (alive) await settle(20);
      }
      expect(alive).toBe(false);
    } finally {
      controller.abort(new Error("fixture teardown"));
      try { await call?.catch(() => {}); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});

// A failure maximum, not a settling delay or a new product deadline. Leave
// the rest of the unchanged 30-second test budget for owned app/child teardown.
const BOOT_CHILD_OBSERVATION_MS = 5_000;

async function observeBootPrune(bin: string, observability: ReturnType<typeof createRecordingObservability>, options: {
  pids?: typeof hostPidsRunning;
  deadline?: number;
} = {}) {
  const started = Date.now(), deadline = options.deadline ?? started + BOOT_CHILD_OBSERVATION_MS;
  let iterations = 0;
  for (;;) {
    iterations++;
    let pids: number[];
    try { pids = (options.pids ?? hostPidsRunning)(bin); }
    catch (cause) { throw new Error(`BOOT_PRUNE_OBSERVATION_FAILED phase=observe-child command=${bin} iterations=${iterations}`, { cause }); }
    // The path alone also matches the worker launcher: require the actual
    // owned scratch-prune command, rather than a version probe or another CLI.
    pids = pids.filter(pid => {
      try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(2, 4).join(" ") === "scratch prune"; }
      catch { return false; }
    });
    if (pids.length) return pids;
    const failed = observability.logs.count({ scope: "cron", severity: "WARN", body: "scratch prune failed" });
    if (failed || Date.now() >= deadline) {
      // The outcome alone cannot distinguish admission/setup refusal from a
      // CLI failure. Retain the real pruner's already-recorded error on failure.
      const pruneErrors = observability.logs.find({ scope: "cron", severity: "WARN", body: "scratch prune failed" })
        .map(record => record.attributes.error);
      throw new Error(`BOOT_PRUNE_CHILD_NOT_OBSERVED phase=observe-child command=${bin} outcome=${failed ? "prune-failed" : "observation-deadline"} elapsedMs=${Date.now() - started} iterations=${iterations} pruneErrors=${JSON.stringify(pruneErrors)}`);
    }
    await settle(10);
  }
}

async function withBootPruneApp(source: string, action: (fixture: {
  app: Awaited<ReturnType<typeof createApp>>; root: string; bin: string;
  observability: ReturnType<typeof createRecordingObservability>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "brain-app-close-"));
  const bin = join(root, "node_modules", ".bin", "brain");
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const failures: unknown[] = [];
  try {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(bin, `#!/usr/bin/env bun\n` +
      `if (process.argv.includes("--version")) { console.log("0.42.0"); process.exit(0); }\n` + source);
    chmodSync(bin, 0o755);
    const observability = createRecordingObservability();
    app = await createApp({
      config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: ":memory:",
        BRAIN_PATH: root, BRAIN_UI_PRICING_DISCOVERY: "0" }),
      observability,
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
    });
    await action({ app, root, bin, observability });
  } catch (error) { failures.push(error); }
  finally {
    // Close even when observing the boot child failed, and attempt state
    // removal even when close rejects. Preserve the original failure as well.
    try { await app?.close(); } catch (error) { failures.push(error); }
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "BOOT_PRUNE_FIXTURE_TEARDOWN_FAILED");
}

describe("BrainUiApp.close", () => {
  test("resolves only once a scratch prune in flight has been killed and has exited", async () => {
    await withBootPruneApp(`await Bun.sleep(60_000);\n`, async ({ app, bin, observability }) => {
      const pids = await observeBootPrune(bin, observability);
      expect(pids.length).toBeGreaterThan(0);
      await app.close();
      // Already reaped when close resolves: a zombie still answers signal 0.
      expect(pids.filter(answers)).toEqual([]);
    });
  });

  test("boot-prune refusal reports a named outcome and removes owned app state", async () => {
    let ownedRoot = "", ownedApp: Awaited<ReturnType<typeof createApp>> | undefined;
    let failure: unknown;
    try {
      await withBootPruneApp(`process.exit(23);\n`, async ({ app, root, bin, observability }) => {
        ownedRoot = root; ownedApp = app;
        // Deliberately hide the short-lived child: observe the actual pruner's
        // refusal log rather than winning a race with its process exit.
        await observeBootPrune(bin, observability, { pids: () => [] });
      });
    } catch (error) { failure = error; }
    expect(String(failure), "BOOT_REFUSAL_HAS_NAMED_FAILURE").toContain("BOOT_PRUNE_CHILD_NOT_OBSERVED");
    expect(String(failure)).toContain("outcome=prune-failed");
    expect(String(failure), "BOOT_REFUSAL_RETAINS_PRUNE_ERROR").toContain("exit 23");
    expect(ownedApp).toBeDefined();
    expect(() => ownedApp!.db.query("SELECT 1").get(), "BOOT_REFUSAL_CLOSED_DB").toThrow();
    expect(existsSync(ownedRoot), "BOOT_REFUSAL_REMOVED_STATE").toBe(false);
  });

  for (const mode of ["deadline", "observer-error"] as const) {
    test(`boot-prune ${mode} reports a named failure and reaps its real owned child`, async () => {
      let ownedRoot = "", pids: number[] = [], ownedApp: Awaited<ReturnType<typeof createApp>> | undefined;
      let failure: unknown;
      try {
        await withBootPruneApp(`await Bun.sleep(60_000);\n`, async ({ app, root, bin, observability }) => {
          ownedRoot = root; ownedApp = app;
          pids = await observeBootPrune(bin, observability);
          expect(pids.length).toBeGreaterThan(0);
          // Fault the observation after proving that a real owned child runs.
          await observeBootPrune(bin, observability, { deadline: Date.now(), pids: () => {
            if (mode === "observer-error") throw new Error("controlled /proc observation refusal");
            return [];
          } });
        });
      } catch (error) { failure = error; }
      expect(String(failure), "BOOT_OBSERVATION_HAS_NAMED_FAILURE").toContain(mode === "deadline" ? "BOOT_PRUNE_CHILD_NOT_OBSERVED" : "BOOT_PRUNE_OBSERVATION_FAILED");
      expect(pids.filter(answers), "BOOT_FAILURE_REAPED_CHILD").toEqual([]);
      expect(ownedApp).toBeDefined();
      expect(() => ownedApp!.db.query("SELECT 1").get(), "BOOT_FAILURE_CLOSED_DB").toThrow();
      expect(existsSync(ownedRoot), "BOOT_FAILURE_REMOVED_STATE").toBe(false);
    });
  }
});

describe("the shared test-app helper", () => {
  test("teardown awaits the app's close: the prune child is gone before state is removed", async () => {
    const observability = createRecordingObservability();
    const harness = await createTestApp({
      appOptions: { observability },
      prepare: (brainPath) => {
        const binDir = join(brainPath, "node_modules", ".bin");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
          join(binDir, "brain"),
          `#!/usr/bin/env bun\n` +
            `if (process.argv.includes("--version")) { console.log("0.42.0"); process.exit(0); }\n` +
            `await Bun.sleep(60_000);\n`
        );
        chmodSync(join(binDir, "brain"), 0o755);
      },
    });
    try {
      const pids = await observeBootPrune(join(harness.brainPath, "node_modules", ".bin", "brain"), observability);
      expect(pids.length).toBeGreaterThan(0);
      await harness.teardown();
      expect(pids.filter(answers)).toEqual([]);
      expect(existsSync(harness.brainPath)).toBe(false);
    } finally { await harness.teardown(); }
  });
});
