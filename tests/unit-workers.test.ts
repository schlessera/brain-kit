import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runUnitWorkers } from "../scripts/unit-workers";
import { validateUnitReports } from "../scripts/unit-proof-report";
import { unitWorkerFixture } from "./helpers/unit-worker-fixture";

type Fixture = ReturnType<typeof unitWorkerFixture>;
function workerCheckouts(reports: string): { workspace: string }[] {
  return JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8"));
}
function diagnosticOutput(root: string, reports: string, worker: { workspace: string }, index: number) {
  return join(reports, "unit-worker-diagnostics", basename(dirname(join(root, worker.workspace))), `worker-${index + 1}`);
}
function expectDiagnostics(fixture: Fixture, reports: string, skipped: readonly string[] = []) {
  for (const [index, worker] of workerCheckouts(reports).entries()) {
    const output = diagnosticOutput(fixture.root, reports, worker, index);
    for (const path of fixture.diagnosticPaths.filter(path => !skipped.includes(path))) {
      const file = join(output, path);
      expect(existsSync(file), `WORKER_DIAGNOSTIC_SURVIVES_REMOVAL: ${path}`).toBe(true);
      const bytes = JSON.stringify({ worker: basename(worker.workspace), world: "Odysseus", date: "2026-07-12", kind: "path control, not raster proof" }) + "\n";
      expect(readFileSync(file, "utf8"), "WORKER_COLLISION_PRESERVES_EXACT_PRODUCER_BYTES").toBe(bytes);
    }
    for (const path of fixture.referencePaths) expect(existsSync(join(output, path)), "TRACKED_REFERENCE_IS_NOT_FAILURE_EVIDENCE").toBe(false);
  }
}
function removeFixture(fixture: Fixture, reports: string) {
  // Failure controls may deliberately leave stopped worktrees. Remove only the
  // fixture's known, newly generated counter paths, then use normal Git removal.
  const checkouts = join(reports, "unit-worker-checkouts.json");
  const containers = new Set<string>();
  if (existsSync(checkouts)) for (const worker of workerCheckouts(reports)) {
    const workspace = join(fixture.root, worker.workspace);
    containers.add(dirname(workspace));
    if (!existsSync(workspace)) continue;
    for (const path of fixture.diagnosticPaths.filter(path => path.includes("/__screenshots__/"))) {
      const file = join(workspace, path);
      // These paths are absent from the fixture's immutable HEAD by construction.
      if (existsSync(file)) unlinkSync(file);
    }
    const clean = Bun.spawnSync(["git", "-C", fixture.root, "worktree", "remove", workspace], { stdout: "pipe", stderr: "pipe" });
    expect(clean.exitCode, new TextDecoder().decode(clean.stderr)).toBe(0);
  }
  for (const container of containers) if (existsSync(container)) rmdirSync(container);
  rmSync(fixture.root, { recursive: true, force: true });
}

test("native queued unit processes own distinct dependencies and clean worktrees with complete reports", async () => {
  const fixture = unitWorkerFixture({ diagnostics: true });
  const { root, files } = fixture;
  const reports = mkdtempSync(join(root, "tmp/unit-worker-test-reports-"));
  mkdirSync(join(root, "tmp/svg-proof"), { recursive: true });
  const parentArtifact = join(root, "tmp/svg-proof/svg-print.html.png");
  writeFileSync(parentArtifact, "Odysseus keeps the root artifact.\n");
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
  expectDiagnostics(fixture, reports);
  const namespace = join(reports, "unit-worker-diagnostics");
  const first = readdirSync(namespace);
  const firstReceipt = join(namespace, first[0]!, "worker-1/.vitest-attachments/worker/.receipt.json");
  const original = readFileSync(firstReceipt);
  // Reusing a report directory cannot overwrite an earlier invocation's files.
  await runUnitWorkers(root, files, undefined, reports);
  expect(readdirSync(namespace)).toHaveLength(2);
  expect(readFileSync(parentArtifact, "utf8")).toBe("Odysseus keeps the root artifact.\n");
  expect(readFileSync(firstReceipt)).toEqual(original);
  expectDiagnostics(fixture, reports);
  expect(readFileSync(join(root, "tmp/outside-diagnostics/kept.png"), "utf8")).toBe("Odysseus keeps this outside the worker.\n");

  } finally { removeFixture(fixture, reports); }
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
  const fixture = unitWorkerFixture({ failBuild: true, diagnostics: true });
  const { root, files } = fixture;
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
    expectDiagnostics(fixture, reports);
  } finally {
    removeFixture(fixture, reports);
  }
});


test("failed unit children hand off both workers' diagnostics before normal removal", async () => {
  const fixture = unitWorkerFixture({ failAfterDiagnostics: true });
  const reports = mkdtempSync(join(fixture.root, "tmp/unit-worker-test-reports-"));
  try {
    await expect(runUnitWorkers(fixture.root, fixture.files, undefined, reports)).rejects.toThrow("complete unit worker");
    expectDiagnostics(fixture, reports);
    for (const worker of workerCheckouts(reports)) expect(existsSync(join(fixture.root, worker.workspace))).toBe(false);
  } finally { removeFixture(fixture, reports); }
});

for (const diagnosticLink of ["file", "directory", "ancestor"] as const) test(`unit handoff rejects ${diagnosticLink} links without following external bytes`, async () => {
  const fixture = unitWorkerFixture({ diagnosticLink });
  const reports = mkdtempSync(join(fixture.root, "tmp/unit-worker-test-reports-"));
  try {
    await expect(runUnitWorkers(fixture.root, fixture.files, undefined, reports)).rejects.toThrow("diagnostic preservation or cleanup failed");
    expectDiagnostics(fixture, reports, diagnosticLink === "ancestor" ? ["tmp/share-review/signout-320.png"] : []);
    for (const [index, worker] of workerCheckouts(reports).entries()) {
      expect(existsSync(join(fixture.root, worker.workspace))).toBe(false);
      const output = diagnosticOutput(fixture.root, reports, worker, index);
      expect(existsSync(join(output, "tmp/svg-proof/linked.png"))).toBe(false);
      expect(existsSync(join(output, "tmp/svg-proof/linked"))).toBe(false);
      expect(existsSync(join(output, "tmp/share-review/kept.png"))).toBe(false);
    }
    expect(readFileSync(join(fixture.root, "tmp/outside-diagnostics/kept.png"), "utf8")).toBe("Odysseus keeps this outside the worker.\n");
  } finally { removeFixture(fixture, reports); }
});

for (const fault of ["copy", "corrupt", "replace"] as const) test(`unit diagnostic ${fault} failure preserves the unignored source and normal removal refusal`, async () => {
  const fixture = unitWorkerFixture({ failAfterDiagnostics: true });
  const { root, files } = fixture;
  const reports = mkdtempSync(join(root, "tmp/unit-worker-test-reports-"));
  const failedPath = "packages/ui-kit/tests/visual/__screenshots__/worker.visual.tsx/owned-failure-12.png";
  try {
    const preload = join(root, "diagnostic-storage-preload.ts");
    writeFileSync(preload, `import fs from "node:fs";
import {mock} from "bun:test";
const open=fs.openSync,write=fs.writeFileSync;const outputs=new Set();let source;
mock.module("node:fs",()=>({...fs,openSync:(path,...args)=>{
  const name=String(path);
  if(name.startsWith("/proc/self/fd/")&&name.endsWith("/owned-failure-12.png"))source=fs.realpathSync(path);
  const output=name.includes("/unit-worker-diagnostics/")&&name.endsWith("/owned-failure-12.png");
  if(output&&${JSON.stringify(fault)}==="copy")throw Error("PLANNED_DIAGNOSTIC_COPY_FAILURE");
  const fd=open(path,...args);if(output)outputs.add(fd);return fd;
},writeFileSync:(file,bytes,...args)=>{
  if(!outputs.has(file))return write(file,bytes,...args);
  outputs.delete(file);
  if(${JSON.stringify(fault)}==="corrupt")return write(file,Buffer.alloc(bytes.length,0),...args);
  const result=write(file,bytes,...args);
  if(${JSON.stringify(fault)}==="replace"){fs.unlinkSync(source);fs.symlinkSync(${JSON.stringify(join(root, "tmp/outside-diagnostics/kept.png"))},source);}
  return result;
}}));\n`);
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", `
      import {runUnitWorkers} from ${JSON.stringify(join(import.meta.dir, "../scripts/unit-workers.ts"))};
      const messages=error=>[String(error),...(error instanceof AggregateError?error.errors.flatMap(messages):[])];
      let failure;try{await runUnitWorkers(${JSON.stringify(root)},${JSON.stringify(files)},undefined,${JSON.stringify(reports)});}catch(error){failure=error;}
      const all=messages(failure).join("\\n");
      if(!(failure instanceof AggregateError)||!all.includes(${JSON.stringify(fault === "copy" ? "PLANNED_DIAGNOSTIC_COPY_FAILURE" : fault === "corrupt" ? "Changed unit diagnostic copy" : "Replaced unit diagnostic output")})||!all.includes("Unit workspace git failed")||!all.includes("complete unit worker"))throw Error("PRIMARY_DIAGNOSTIC_AND_NORMAL_REMOVAL_FAILURE_REQUIRED: "+all);
      console.log("DIAGNOSTIC_FAILURE_AND_REMOVAL_REFUSAL",all);
    `], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    expect(out).toContain("DIAGNOSTIC_FAILURE_AND_REMOVAL_REFUSAL");
    expectDiagnostics(fixture, reports, [failedPath]);
    for (const [index, worker] of workerCheckouts(reports).entries()) {
      const source = join(root, worker.workspace, failedPath);
      expect(existsSync(source), "COPY_FAILURE_LEAVES_ORIGINAL_FOR_NORMAL_GIT_REFUSAL").toBe(true);
      if (fault !== "replace") expect(JSON.parse(readFileSync(source, "utf8")).worker).toBe(basename(worker.workspace));
      else expect(readFileSync(source, "utf8")).toBe("Odysseus keeps this outside the worker.\n");
      if (fault === "copy") expect(existsSync(join(diagnosticOutput(root, reports, worker, index), failedPath))).toBe(false);
    }
    expect(readFileSync(join(root, "tmp/outside-diagnostics/kept.png"), "utf8")).toBe("Odysseus keeps this outside the worker.\n");
  } finally { removeFixture(fixture, reports); }
});
