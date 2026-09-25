import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBrainClient } from "../src/brain/client";
import { createCronScheduler } from "../src/cron/scheduler";
import { createUiDb } from "../src/db/client";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

/** A brain root whose CLI runs `source` with the argv in `args`. */
function brainWithCli(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "cron-sync-test-"));
  temporaryRoots.push(root);
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "brain");
  writeFileSync(bin, `#!/usr/bin/env bun\nconst args = process.argv.slice(2);\n${source}`);
  chmodSync(bin, 0o755);
  return root;
}

/** triggerJob starts the run without awaiting it; wait for its row to settle. */
async function settledSync(cron: ReturnType<typeof createCronScheduler>) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const sync = cron.getCronStatus().find((s) => s.name === "sync")!;
    if (sync.lastStatus !== "running" || Date.now() > deadline) return sync;
    await Bun.sleep(10);
  }
}

describe("cron sync job", () => {
  test("a brain sync that exits non-zero is recorded as an error", async () => {
    const root = brainWithCli(
      `if (args[0] === "sync") { console.error("no agent runner configured"); process.exit(1); }\n`
    );
    const db = createUiDb(":memory:");
    const cron = createCronScheduler({ db, brain: createBrainClient({ brainPath: root }) });

    expect(await cron.triggerJob("sync")).toBe(true);

    const sync = await settledSync(cron);
    expect(sync.lastRunAt).not.toBeNull();
    expect(sync.lastStatus).toBe("error");
    expect(sync.lastError).toContain("no agent runner configured");
  });

  test("a brain sync that exits 0 is recorded as a success", async () => {
    const root = brainWithCli(`console.log("Already in sync");\n`);
    const db = createUiDb(":memory:");
    const cron = createCronScheduler({ db, brain: createBrainClient({ brainPath: root }) });

    expect(await cron.triggerJob("sync")).toBe(true);

    const sync = await settledSync(cron);
    expect(sync.lastRunAt).not.toBeNull();
    expect(sync.lastStatus).toBe("success");
  });
});

describe("brain client sync", () => {
  test("plain-text output on exit 0 comes back as a result object, not the raw string", async () => {
    const root = brainWithCli(`console.log("Already in sync");\n`);
    const brain = createBrainClient({ brainPath: root });

    const result = await brain.sync();

    expect(typeof result).toBe("object");
    expect(result).toEqual({ message: "Already in sync" });
  });

  test("a non-zero exit rejects with the CLI's stderr", async () => {
    const root = brainWithCli(`console.error("sync could not finish"); process.exit(2);\n`);
    const brain = createBrainClient({ brainPath: root });

    await expect(brain.sync()).rejects.toThrow("brain sync failed (exit 2): sync could not finish");
  });
});
