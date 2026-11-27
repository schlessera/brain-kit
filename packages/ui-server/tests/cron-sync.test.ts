import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installNativeBrainClientFixtures } from "./helpers/native-brain-client-fixture.js";
import { SYNC_JOB_COMMAND } from "../src/cron/emit";
import { runJob } from "../src/cron/run-job";
import { createCronScheduler } from "../src/cron/scheduler";
import { createUiDb } from "../src/db/client";

const { createFixtureBrainClient: createBrainClient } = installNativeBrainClientFixtures();

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

/** Run the crontab's sync job through its runner, then read its cron status row. */
async function scheduledSync(root: string) {
  const dbPath = join(root, "brain-ui.db");
  const discard = { write: () => {} };
  const code = await runJob({ jobName: "sync", command: [...SYNC_JOB_COMMAND], dbPath, exec: {},
    childEnv: { PATH: `${join(root, "node_modules", ".bin")}:${process.env.PATH}` }, stdout: discard, stderr: discard });
  const db = createUiDb(dbPath);
  try { return { code, sync: createCronScheduler({ db }).getCronStatus().find((s) => s.name === "sync")! }; }
  finally { db.close(); }
}

// The scheduled sync runs through the crontab's job runner (#4681).
describe("cron sync job", () => {
  test("a brain sync that exits non-zero is recorded as an error", async () => {
    const root = brainWithCli(
      `if (args[0] === "sync") { console.error("no agent runner configured"); process.exit(1); }\n`
    );
    const { code, sync } = await scheduledSync(root);
    expect(code).toBe(1);
    expect(sync.lastRunAt).not.toBeNull();
    expect(sync.lastStatus).toBe("error");
    expect(sync.lastError).toContain("no agent runner configured");
  });

  test("a brain sync that exits 0 is recorded as a success", async () => {
    const root = brainWithCli(`console.log("Already in sync");\n`);
    const { code, sync } = await scheduledSync(root);
    expect(code).toBe(0);
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

  test("a sync a conflict stopped (exit 3, report on stdout) rejects with the report", async () => {
    const root = brainWithCli(
      `console.log("brain sync: needs-judgment — a conflict no strategy resolves"); process.exit(3);\n`
    );
    const brain = createBrainClient({ brainPath: root });

    await expect(brain.sync()).rejects.toThrow(
      "brain sync failed (exit 3): brain sync: needs-judgment — a conflict no strategy resolves"
    );
  });
});
