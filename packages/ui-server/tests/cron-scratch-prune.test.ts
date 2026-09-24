/**
 * The periodic scratch prune (#310): the server asks `brain scratch prune`
 * to run at boot and every hour, through the brain CLI client, and a failed
 * pass is a log line, not a crash.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createBrainClient } from "../src/brain/client";
import { SCRATCH_PRUNE_INTERVAL_MS, startScratchPrune } from "../src/cron/scratch-prune";
import { createRecordingObservability } from "../src/observability/index";

/** A brain client whose prune resolves or rejects as scripted, one call at a time. */
function scriptedBrain(script: Array<"ok" | Error | "hang">) {
  const calls: number[] = [];
  let release: (() => void) | null = null;
  const brain = {
    scratchPrune: () => {
      calls.push(Date.now());
      const step = script.shift() ?? "ok";
      if (step === "hang") {
        return new Promise<string>((resolve) => {
          release = () => resolve("");
        });
      }
      return step === "ok" ? Promise.resolve("Pruned") : Promise.reject(step);
    },
  };
  return { brain, calls, release: () => release?.() };
}

function harness(script: Array<"ok" | Error | "hang"> = []) {
  const { brain, calls, release } = scriptedBrain(script);
  const observability = createRecordingObservability();
  const scheduled: Array<{ check: () => void; ms: number; cancelled: boolean }> = [];
  const pruner = startScratchPrune({
    brain,
    log: observability.logger("cron"),
    every: (check, ms) => {
      const entry = { check, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return { pruner, calls, release, observability, scheduled };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    pruner.close();
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
    pruner.close();
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
    pruner.close();
  });
});

describe("BrainClient.scratchPrune", () => {
  test("spawns `brain scratch prune` in the brain repo and surfaces a non-zero exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-scratch-prune-"));
    try {
      const binDir = join(root, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      const capture = join(root, "argv.json");
      const bin = join(binDir, "brain");
      writeFileSync(
        bin,
        `#!/usr/bin/env bun\nimport { writeFileSync } from "fs";\n` +
          `writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n` +
          `if (process.argv.includes("prune")) { console.log("Pruned .brain/scratch/: removed 0 file(s)"); process.exit(0); }\n` +
          `console.error("unknown command"); process.exit(1);\n`,
      );
      chmodSync(bin, 0o755);
      const brain = createBrainClient({ brainPath: root });
      expect(await brain.scratchPrune()).toContain("Pruned");
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["scratch", "prune"]);

      writeFileSync(bin, `#!/usr/bin/env bun\nconsole.error("unknown command"); process.exit(1);\n`);
      await expect(brain.scratchPrune()).rejects.toThrow(/brain scratch prune failed \(exit 1\): unknown command/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
