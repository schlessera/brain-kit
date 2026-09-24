/**
 * The periodic scratch prune (#310): the server asks `brain scratch prune`
 * to run at boot and every hour, through the brain CLI client; a failed
 * pass is a log line, not a crash; a hung pass is killed at its deadline;
 * and closing the server kills a pass in flight and waits for it.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createApp } from "../src/app";
import { createBrainClient } from "../src/brain/client";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";
import {
  SCRATCH_PRUNE_DEADLINE_MS,
  SCRATCH_PRUNE_INTERVAL_MS,
  startScratchPrune,
} from "../src/cron/scratch-prune";
import { createRecordingObservability } from "../src/observability/index";

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
    writeFileSync(bin, `#!/usr/bin/env bun\n${source.replaceAll("CAPTURE", JSON.stringify(capture))}`);
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

  test("an aborted signal kills the child, and the call rejects only once it is gone", async () => {
    const { root, capture } = brainWithCli(
      `import { writeFileSync } from "fs";\n` +
        `writeFileSync(CAPTURE, String(process.pid));\n` +
        `await Bun.sleep(60_000);\n`
    );
    try {
      const brain = createBrainClient({ brainPath: root });
      const controller = new AbortController();
      const call = brain.scratchPrune({ signal: controller.signal });
      while (!existsSync(capture)) await settle(10);
      const pid = Number(readFileSync(capture, "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      controller.abort(new Error("deadline"));
      await expect(call).rejects.toThrow("deadline");
      // The child has exited by the time the rejection arrives: a zombie
      // still answers signal 0, so wait for the reaper as well.
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0);
          await settle(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BrainUiApp.close", () => {
  test("resolves only once a scratch prune in flight has been killed and has exited", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-app-close-"));
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const capture = join(root, "pid.txt");
    writeFileSync(
      join(binDir, "brain"),
      `#!/usr/bin/env bun\n` +
        `if (process.argv.includes("--version")) { console.log("0.40.0"); process.exit(0); }\n` +
        `import { writeFileSync } from "fs";\n` +
        `writeFileSync(${JSON.stringify(capture)}, String(process.pid));\n` +
        `await Bun.sleep(60_000);\n`
    );
    chmodSync(join(binDir, "brain"), 0o755);
    try {
      const app = createApp({
        config: resolveServerConfig({
          AUTH_MODE: "none",
          HOST: "127.0.0.1",
          DB_PATH: ":memory:",
          BRAIN_PATH: root,
          BRAIN_UI_PRICING_DISCOVERY: "0",
        }),
        observability: createRecordingObservability(),
        registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
      });
      // The boot prune is running: the child wrote its pid and is sleeping.
      while (!existsSync(capture)) await settle(10);
      const pid = Number(readFileSync(capture, "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      await app.close();
      // Already reaped when close resolves: the client awaited the exit
      // before rejecting, and close awaited the client. A close that only
      // fired the kill would leave a zombie here, which still answers.
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
