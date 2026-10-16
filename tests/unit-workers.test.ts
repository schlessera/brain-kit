import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runUnitWorkers } from "../scripts/unit-workers";
import { validateUnitReports } from "../scripts/unit-proof-report";

test("native queued unit processes own distinct dependencies and clean worktrees with complete reports", async () => {
  const root = resolve(import.meta.dir, "..");
  const files = ["tests/labels.test.ts", "tests/test-network-guard.test.ts"];
  const reports = mkdtempSync(join(root, "tmp/unit-worker-test-reports-"));
  try {
  await runUnitWorkers(root, files, undefined, reports);
  const workers = JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8")) as {
    workspace: string; files: string[]; checkout: string; dependency: { dev: number; ino: number };
  }[];
  expect(workers).toHaveLength(2);
  expect(workers.flatMap(worker => worker.files).sort()).toEqual(files);
  expect(new Set(workers.map(worker => worker.checkout)).size).toBe(1);
  expect(new Set(workers.map(worker => `${worker.dependency.dev}:${worker.dependency.ino}`)).size).toBe(2);
  for (const worker of workers) expect(existsSync(join(root, worker.workspace))).toBe(false);
  const report = validateUnitReports(files, readFileSync(join(reports, "unit-report.xml"), "utf8"), JSON.parse(readFileSync(join(reports, "unit-timings.json"), "utf8")));
  expect(report.files).toEqual(files);
  expect(report.pass).toBeGreaterThan(40);
  expect(report.failures).toBe(0);
  } finally { rmSync(reports, { recursive: true, force: true }); }
});
