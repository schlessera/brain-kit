import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runUnitWorkers } from "../scripts/unit-workers";
import { validateUnitReports } from "../scripts/unit-proof-report";
import { unitWorkerFixture } from "./helpers/unit-worker-fixture";

test("native queued unit processes own distinct dependencies and clean worktrees with complete reports", async () => {
  const { root, files } = unitWorkerFixture();
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
  expect(report.pass).toBe(2);
  const admissions = [0, 1].map(index => JSON.parse(readFileSync(join(root, `tmp/shared/${index}.admitted`), "utf8")));
  expect(admissions.map(value => value.uid)).toEqual([process.getuid!(), process.getuid!()]);
  expect(new Set(admissions.map(value => value.inode)).size, "PRIVATE_MAINTENANCE_LEDGER_INODES").toBe(2);
  expect(admissions.map(value => value.directory)).toEqual(Array(2).fill(`/tmp/brain-maintenance-budget-${process.getuid!()}`));
  expect(report.failures).toBe(0);
  const receipts = readdirSync(reports).filter(name => /-build-.*-probe\.json$/.test(name));
  expect(receipts.length, "PRIVATE_BUILD_RECEIPTS_COPIED_BEFORE_WORKTREE_REMOVAL").toBe(2);
  for (const name of receipts) expect(JSON.parse(readFileSync(join(reports, name), "utf8")).success).toBe(true);

  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("failed private prebuild preserves its partial receipt before cleanup", async () => {
  const { root, files } = unitWorkerFixture({ failBuild: true });
  const reports = mkdtempSync(join(root, "tmp/unit-worker-test-reports-"));
  try {
    await expect(runUnitWorkers(root, files, undefined, reports)).rejects.toThrow();
    const receipts = readdirSync(reports).filter(name => /-build-.*-probe\.json$/.test(name));
    expect(receipts.length, "FAILED_PRIVATE_BUILD_PARTIAL_RECEIPT_SURVIVES").toBeGreaterThan(0);
    for (const name of receipts) {
      const receipt = JSON.parse(readFileSync(join(reports, name), "utf8"));
      expect(receipt.state).toBe("running"); expect(receipt.success).toBe(false);
    }
    const workers = JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8"));
    for (const worker of workers) expect(existsSync(join(root, worker.workspace))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("receipt copy failure stays explicit and still removes every owned worker", async () => {
  const { root, files } = unitWorkerFixture({ failBuild: true });
  const reports = mkdtempSync(join(root, "tmp/unit-worker-test-reports-"));
  try {
    const preload = join(root, "copy-storage-preload.ts");
    writeFileSync(preload, `import fs from "node:fs";
import {mock} from "bun:test";
const copy=fs.copyFileSync;mock.module("node:fs",()=>({...fs,copyFileSync:(source,target,...args)=>{
  if(/unit-worker-.*-build-.*-probe\\.json$/.test(String(target)))fs.mkdirSync(target);
  return copy(source,target,...args);
}}));\n`);
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", `
      import {runUnitWorkers} from ${JSON.stringify(join(import.meta.dir, "../scripts/unit-workers.ts"))};
      let failure; try { await runUnitWorkers(${JSON.stringify(root)},${JSON.stringify(files)},undefined,${JSON.stringify(reports)}); } catch(error) { failure=error; }
      if(!(failure instanceof AggregateError) || !failure.errors.some(error=>String(error).includes("private package build"))) throw Error("ORIGINAL_PREBUILD_FAILURE_RETAINED");
      console.log("COLLECTOR_FAILURE_EXPLICIT",failure.errors.length);
    `], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const workers = JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8"));
    for (const worker of workers) expect(existsSync(join(root, worker.workspace)), "OWNED_WORKER_REMOVED_AFTER_RECEIPT_COPY_ERROR").toBe(false);
    expect(code, out + err).toBe(0); expect(out).toContain("COLLECTOR_FAILURE_EXPLICIT");
  } finally {
    // A cleanup-regression mutant may leave these stopped fixture worktrees.
    // Remove only roots recorded by this invocation before deleting their Git owner.
    const checkouts = join(reports, "unit-worker-checkouts.json");
    const containers = new Set<string>();
    if (existsSync(checkouts)) for (const worker of JSON.parse(readFileSync(checkouts, "utf8"))) {
      containers.add(dirname(join(root, worker.workspace)));
      if (!existsSync(join(root, worker.workspace))) continue;
      const clean = Bun.spawnSync(["git", "-C", root, "worktree", "remove", join(root, worker.workspace)], { stdout: "pipe", stderr: "pipe" });
      expect(clean.exitCode, new TextDecoder().decode(clean.stderr)).toBe(0);
    }
    for (const container of containers) if (existsSync(container)) rmdirSync(container);
    rmSync(root, { recursive: true, force: true });
  }
});
