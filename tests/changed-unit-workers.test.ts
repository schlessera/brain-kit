import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runUnitWorkers } from "../scripts/unit-workers";
import { validateChangedUnitReports, validateUnitReports } from "../scripts/unit-proof-report";
import { changedSelection, timingSeed } from "../scripts/changed-unit-worker";
import { localUnitWorkerCount } from "../scripts/unit-workers";
import { unitInputKey } from "../scripts/unit-worker-inputs";
import { unitWorkerFixture } from "./helpers/unit-worker-fixture";
import { invocationFixture } from "./helpers/test-invocation-fixture";

function changedFixture() {
  const fixture = unitWorkerFixture();
  const { root } = fixture;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const write = (file: string, text: string) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  for (const name of ["shared", "staged", "committed"]) write(`packages/raft/${name}.ts`, "export const value = 1;\n");
  write("remove.txt", "Odysseus removes this input.\n");
  for (const [name, source] of [["odysseus", "shared"], ["penelope", "shared"], ["telemachus", "staged"], ["athena", "committed"]]) {
    write(`tests/${name}.test.ts`, `import {test,expect} from "bun:test";
import {value} from "../packages/raft/${source}";
import {existsSync} from "node:fs";
test("${name} receives the same working inputs",()=>{expect(value).toBe(2);expect(existsSync("remove.txt")).toBe(false);});\n`);
  }
  write("tests/unrelated.test.ts", 'import {test} from "bun:test";test("UNRELATED_MUST_NOT_RUN",()=>{throw Error("UNRELATED_MUST_NOT_RUN")});\n');
  // The production worker observer is copied when present, so the first receipt
  // can exercise the old queue's rejection rather than fail at module loading.
  const observer = join(import.meta.dir, "../scripts/changed-unit-worker.ts");
  if (existsSync(observer)) cpSync(observer, join(root, "scripts/changed-unit-worker.ts"));
  git("add", ".");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Changed selection fixture");
  const base = git("rev-parse", "HEAD");
  write("packages/raft/committed.ts", "export const value = 2;\n");
  git("add", "packages/raft/committed.ts");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Committed input");
  write("packages/raft/staged.ts", "export const value = 2;\n");
  git("add", "packages/raft/staged.ts");
  write("packages/raft/staged.ts", "export const value = 2;\n// Penelope keeps this additional working edit.\n");
  write("packages/raft/shared.ts", "export const value = 2;\n");
  rmSync(join(root, "remove.txt"));
  write("tests/new.test.ts", 'import {test,expect} from "bun:test";import {existsSync} from "node:fs";test("untracked input",()=>{expect(2).toBe(2);expect(existsSync("tmp/unit-output.log"),"ACTIVE_LOG_STAYS_OUTSIDE_PUBLIC_TREE").toBe(false)});\n');
  return { ...fixture, base, write };
}

test("changed queued workers match serial Bun for committed, staged, unstaged, deleted and untracked inputs", async () => {
  const fixture = changedFixture();
  const { root, base } = fixture;
  const reports = join(root, "tmp/queued");
  try {
    const serial = Bun.spawn([process.execPath, "run", "test", `--changed=${base}`, "--shard=1/1", "--reporter=junit", "--reporter-outfile=tmp/serial.xml", "--timings=tmp/serial.json", "--update-timings"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([serial.exited, new Response(serial.stdout).text(), new Response(serial.stderr).text()]);
    expect(code, out + err).toBe(0);
    const times = JSON.parse(readFileSync(join(root, "tmp/serial.json"), "utf8"));
    const files = Object.keys(times.files).sort();
    expect(files).toHaveLength(5);
    validateUnitReports(files, readFileSync(join(root, "tmp/serial.xml"), "utf8"), times);
    await runUnitWorkers(root, [], undefined, reports, { changed: base, workers: 3 });
    const queued = JSON.parse(readFileSync(join(reports, "unit-timings.json"), "utf8"));
    expect(Object.keys(queued.files).sort(), "QUEUED_CHANGED_UNION_EQUALS_SERIAL").toEqual(files);
    expect(validateUnitReports(files, readFileSync(join(reports, "unit-report.xml"), "utf8"), queued).pass).toBe(5);
    const receipts = [1, 2, 3].map(index => ({
      xml: readFileSync(join(reports, `unit-worker-${index}-report.xml`), "utf8"),
      timings: JSON.parse(readFileSync(join(reports, `unit-worker-${index}-timings.json`), "utf8")),
      selection: JSON.parse(readFileSync(join(reports, `unit-worker-${index}-selection.json`), "utf8")),
    }));
    expect(validateChangedUnitReports(receipts)).toEqual(files);
    expect(() => validateChangedUnitReports(receipts.slice(1)), "MISSING_CHANGED_SHARD_REFUSED").toThrow("exactly once");
    expect(() => validateChangedUnitReports([...receipts, receipts[0]!] ), "DUPLICATE_CHANGED_SHARD_REFUSED").toThrow("exactly once");
    const missing = structuredClone(receipts); delete missing[0]!.timings.files[Object.keys(missing[0]!.timings.files)[0]!];
    expect(() => validateChangedUnitReports(missing), "INCOMPLETE_CHANGED_FILE_REFUSED").toThrow("omits selected files");
    const disagreement = structuredClone(receipts); disagreement[0]!.selection.selected++;
    expect(() => validateChangedUnitReports(disagreement)).toThrow("disagree");
    const checkouts = JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8"));
    expect(checkouts).toHaveLength(3);
    const phases = JSON.parse(readFileSync(join(reports, "unit-worker-summary.json"), "utf8")).workerPhases;
    expect(phases).toHaveLength(3);
    for (const phase of phases) {
      expect(phase.checkoutMs).toBeGreaterThan(0);
      expect(phase.dependencyCopyMs).toBeGreaterThan(0);
      expect(phase.preparationMs).toBeGreaterThan(0);
      expect(phase.testMs, "WORKER_TEST_TIME_SEPARATE_FROM_SETUP").toBeGreaterThan(0);
    }
    for (const worker of checkouts) expect(existsSync(join(root, worker.workspace))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changed queues accept empty selections and empty shards without hiding missing reports", async () => {
  const fixture = changedFixture();
  const { root, base } = fixture;
  try {
    const reports = join(root, "tmp/empty-shards");
    await runUnitWorkers(root, [], undefined, reports, { changed: base, workers: 8 });
    expect(Object.keys(JSON.parse(readFileSync(join(reports, "unit-timings.json"), "utf8")).files)).toHaveLength(5);
    const empty = join(root, "tmp/no-selection");
    // Capture current staged/unstaged/untracked inputs into a fixture commit.
    const staged = Bun.spawnSync(["git", "-C", root, "add", "."]); expect(staged.exitCode).toBe(0);
    const commit = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Current inputs"]); expect(commit.exitCode).toBe(0);
    await runUnitWorkers(root, [], undefined, empty, { changed: "HEAD", workers: 2 });
    const summary = JSON.parse(readFileSync(join(empty, "unit-worker-summary.json"), "utf8"));
    expect(summary.selectedFiles).toBe(0);
    const emptyXml = readFileSync(join(empty, "unit-report.xml"), "utf8");
    expect(() => validateUnitReports([], emptyXml, { version: 1, files: {} })).toThrow("passing execution");
    expect(() => validateUnitReports([], emptyXml.replace('tests="0"', 'tests="1"'), { version: 1, files: {} }, true)).toThrow("passing execution");
    fixture.write("README.md", "Odysseus plans the return.\n");
    await runUnitWorkers(root, [], undefined, join(root, "tmp/prose-only"), { changed: "HEAD", workers: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changed costs use milliseconds and selection receipts fail closed on absent or mismatched Bun counts", () => {
  expect(timingSeed({ "tests/odysseus.test.ts": 2.5 })).toEqual({ version: 1, files: { "tests/odysseus.test.ts": 2500 } });
  expect(() => timingSeed({ "tests/odysseus.test.ts": -1 })).toThrow("cost");
  expect(changedSelection("--changed: 1 changed file, running 5/12 test files\n--shard=2/3: running 1/5 test files\n", "2/3")).toEqual({ selected: 5, assigned: 1 });
  expect(changedSelection("--changed: 1 changed file, but no test files are affected\n", "1/2")).toEqual({ selected: 0, assigned: 0 });
  expect(changedSelection("\u001b[0m\u001b[2m--changed:\u001b[0m 1 changed file, but no test files are affected\n", "1/2")).toEqual({ selected: 0, assigned: 0 });
  expect(() => changedSelection("", "2/3")).toThrow("did not report");
  expect(() => changedSelection("--changed: 1 changed file, running 5/12 test files\n--shard=2/3: running 1/12 test files\n", "2/3")).toThrow("complete changed-file selection");
  expect(localUnitWorkerCount(32, 47 * 1024 ** 3)).toBe(16);
  expect(localUnitWorkerCount(2, 47 * 1024 ** 3)).toBe(1);
  expect(localUnitWorkerCount(32, 4 * 1024 ** 3)).toBe(1);
});

test("a deliberately failing selected test fails the changed queue with its filename and retained output", async () => {
  const fixture = changedFixture();
  const { root, base } = fixture;
  const reports = join(root, "tmp/failing");
  try {
    fixture.write("tests/new.test.ts", 'import {test,expect} from "bun:test";test("SELECTED_QUEUE_MUTATION",()=>expect("broken").toBe("restored"));\n');
    const child = Bun.spawn([process.execPath, "-e", `import {runUnitWorkers} from ${JSON.stringify(join(import.meta.dir, "../scripts/unit-workers.ts"))}; await runUnitWorkers(${JSON.stringify(root)},[],undefined,${JSON.stringify(reports)},{changed:${JSON.stringify(base)},workers:2});`], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, "FAILING_SELECTED_TEST_MUST_FAIL_QUEUE\n" + out + err).not.toBe(0);
    expect(out + err).toContain("tests/new.test.ts");
    expect(out + err).toContain("SELECTED_QUEUE_MUTATION");
    expect(existsSync(join(reports, "unit-worker-1-output.log"))).toBe(true);
    expect(existsSync(join(reports, "unit-worker-2-output.log"))).toBe(true);
    const measurement = JSON.parse(readFileSync(join(reports, "unit-worker-summary.json"), "utf8"));
    expect(measurement.proofPassed, "FAILED_QUEUE_CANNOT_HAVE_PASSING_MEASUREMENT").toBe(false);
    expect(measurement.checkoutMs).toBeGreaterThan(0);
    expect(measurement.dependencyCopyMs).toBeGreaterThan(0);
    expect(measurement.preparationMs, "FAILED_QUEUE_RETAINS_PREPARATION_MEASUREMENT").toBeGreaterThan(0);
    expect(measurement.selections.some((value: { exitCode?: number } | null) => value?.exitCode === 1)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a new HEAD invalidates unit input identity even when the worktree stays clean", () => {
  const fixture = unitWorkerFixture();
  try {
    const before = unitInputKey(fixture.root);
    const commit = Bun.spawnSync(["git", "-C", fixture.root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "--allow-empty", "-qm", "New invocation input identity"]);
    expect(commit.exitCode).toBe(0);
    expect(unitInputKey(fixture.root)).not.toBe(before);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("changed workers retain new automatic diagnostics and preserve pending screenshot inputs", async () => {
  const fixture = changedFixture();
  const { root, base } = fixture;
  const reports = join(root, "tmp/screenshots");
  const pending = "packages/ui-kit/tests/visual/__screenshots__/odysseus/pending-2.png";
  const produced = "packages/ui-kit/tests/visual/__screenshots__/odysseus/failure-3.png";
  try {
    fixture.write(pending, "Odysseus owns this input; byte control, not raster proof.\n");
    fixture.write("tests/new.test.ts", `import {test,expect} from "bun:test";import {writeFileSync} from "node:fs";test("automatic diagnostic byte control",()=>{writeFileSync(${JSON.stringify(produced)},"Odysseus retains this diagnostic; byte control, not raster proof.\\n");expect(1).toBe(1)});\n`);
    await runUnitWorkers(root, [], undefined, reports, { changed: base, workers: 2 });
    expect(readFileSync(join(root, pending), "utf8")).toContain("owns this input");
    const diagnostics = join(reports, "unit-worker-diagnostics");
    const invocation = join(diagnostics, readdirSync(diagnostics)[0]!);
    const retained = readdirSync(invocation).map(worker => join(invocation, worker, produced)).filter(path => existsSync(path));
    expect(retained, "AUTOMATIC_DIAGNOSTIC_SURVIVES_CHANGED_WORKER_REMOVAL").toHaveLength(1);
    expect(readFileSync(retained[0]!, "utf8")).toContain("retains this diagnostic");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared changed workers share one live build through private views and revoke copied authority after a nested write", async () => {
  const fixture = invocationFixture(dirname(resolve(import.meta.dir, "..")));
  const { root, write } = fixture;
  const reports = join(root, "tmp/prepared-reports"), shared = join(root, "tmp/shared");
  mkdirSync(shared, { recursive: true });
  write("scripts/changed-unit-worker.ts", readFileSync(join(import.meta.dir, "../scripts/changed-unit-worker.ts"), "utf8"));
  write("remove.txt", "Odysseus removes this source input.\n");
  const pending = "packages/ui-kit/tests/visual/__screenshots__/odysseus/pending-2.png";
  const produced = "packages/ui-kit/tests/visual/__screenshots__/odysseus/failure-3.png";
  for (const [index, name] of ["odysseus", "penelope"].entries()) {
    const pkg = index === 0 ? "ithaca" : "troy";
    write(`tests/${name}.test.ts`, `import {test,expect} from "bun:test";
import {cargo} from "../packages/${pkg}/src/index";
import {readFileSync,writeFileSync,existsSync,statSync} from "node:fs";
import {join} from "node:path";
import {invocationBuild} from "../scripts/test-invocation";
import {runtimePackageBuild} from "../packages/ui-react/tests/fixtures/runtime-package-build";
import {runtimeHookPhases} from "../packages/ui-react/tests/fixtures/runtime-hook-phases";
test("${name} keeps copied output, source, lease and generation private",async()=>{
 expect(cargo).toBe(2);expect(existsSync("remove.txt")).toBe(false);expect(readFileSync("pending.txt","utf8")).toBe("Odysseus owns this pending input.\\n");
 const root=process.cwd(),record=invocationBuild(root,["ithaca","troy"]);
 expect(record?.preparedSource,"PRIVATE_VIEW_USES_PREPARED_BUILD").toBeDefined();
 expect(record!.build.kind).toBe("workspace-build-copy");
 expect(process.env.BRAIN_TEST_PREPARED_TREE,"PREPARED_ADMISSION_IS_NOT_INHERITED_BY_NESTED_INVOCATIONS").toBeUndefined();
 const source=record!.preparedSource!.root;
 const parentOutput=join(source,"packages/${pkg}/dist/index.js"),ownOutput=join(root,"packages/${pkg}/dist/index.js");
 const parentBytes=readFileSync(parentOutput,"utf8");
 expect(()=>writeFileSync(parentOutput,"export const cargo=0;\\n"),"PREPARED_SOURCE_IS_READ_ONLY").toThrow();
 writeFileSync(ownOutput,"export const cargo=${7 + index};\\n");
 expect(readFileSync(parentOutput,"utf8"),"WORKER_WRITES_STAY_IN_ITS_UPPER_LAYER").toBe(parentBytes);
 const native=Bun.spawnSync(["bwrap","--unshare-net","--ro-bind","/","/","--tmpfs","/tmp","--proc","/proc","--dev","/dev",process.execPath,"-e",'console.log(require("fs").readFileSync(process.argv[1],"utf8"))',ownOutput],{stdout:"pipe",stderr:"pipe"});
 expect(native.exitCode,"NATIVE_CHILD_SEES_PRIVATE_PREPARED_OUTPUT: "+new TextDecoder().decode(native.stderr)).toBe(0);
 expect(new TextDecoder().decode(native.stdout)).toContain("cargo=${7 + index}");
 expect(record!.build.generation,"EACH_WORKER_REPLACES_THE_SOURCE_GENERATION").not.toBe(readFileSync(join(source,"tmp/workspace-operation/output.generation"),"utf8").trim());
 writeFileSync(join(${JSON.stringify(shared)},"${name}.json"),JSON.stringify({nonce:record!.nonce,lease:record!.lease.dev+":"+record!.lease.ino,generation:record!.build.generation,source,build:record!.build.id,dependency:statSync("node_modules/typescript/package.json").ino}));
 ${index === 0 ? `writeFileSync(${JSON.stringify(produced)},"Odysseus keeps this diagnostic; byte control, not raster proof.\\n");
 const child=Bun.spawn([process.execPath,"scripts/build.ts","--for","ithaca"],{stdout:"pipe",stderr:"pipe"});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(invocationBuild(root,["ithaca"]),"NESTED_WRITER_REVOKES_COPIED_AUTHORITY").toBeUndefined();
 await runtimePackageBuild(root,["ithaca"],runtimeHookPhases("copied-worker-revocation"));` : ""}
});\n`);
  }
  write("tests/unrelated.test.ts", 'import {test} from "bun:test";test("UNRELATED_MUST_NOT_RUN",()=>{throw Error("UNRELATED_MUST_NOT_RUN")});\n');
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    return new TextDecoder().decode(child.stdout).trim();
  };
  git("init", "-q"); git("add", "."); git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Prepared source fixture");
  const base = git("rev-parse", "HEAD");
  write("packages/ithaca/src/index.ts", "export const cargo=2;\n");
  git("add", "packages/ithaca/src/index.ts"); git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Committed source input");
  write("packages/troy/src/index.ts", "export const cargo=2;\n"); git("add", "packages/troy/src/index.ts");
  write("packages/troy/src/index.ts", "export const cargo=2; export const port='Ithaca';\n");
  rmSync(join(root, "remove.txt"));
  write("pending.txt", "Odysseus owns this pending input.\n"); write(pending, "Odysseus owns this screenshot input.\n");
  const key = unitInputKey(root);
  let passed = false;
  try {
    await runUnitWorkers(root, [], undefined, reports, { changed: base, workers: 2, preparedTree: true });
    expect(unitInputKey(root), "PREPARED_QUEUE_PRESERVES_ALL_CALLER_INPUTS").toBe(key);
    const own = ["odysseus", "penelope"].map(name => JSON.parse(readFileSync(join(shared, `${name}.json`), "utf8")));
    expect(new Set(own.map(value => value.build)).size, "ONE_FRESH_PREPARED_BUILD").toBe(1);
    for (const field of ["nonce", "lease", "generation"]) expect(new Set(own.map(value => value[field])).size, `PRIVATE_WORKER_${field}`).toBe(2);
    const times = JSON.parse(readFileSync(join(reports, "unit-timings.json"), "utf8"));
    expect(Object.keys(times.files).sort()).toEqual(["tests/odysseus.test.ts", "tests/penelope.test.ts"]);
    const summary = JSON.parse(readFileSync(join(reports, "unit-worker-summary.json"), "utf8"));
    expect(summary.proofPassed).toBe(true); expect(summary.cleanupPassed).toBe(true);
    expect(summary.preparedTree.preparationMs).toBeGreaterThan(0);
    for (const phase of summary.workerPhases) expect(phase.dependencyCopyMs).toBe(0);
    expect(readFileSync(join(root, pending), "utf8")).toContain("owns this screenshot");
    const diagnosticRoot = join(reports, "unit-worker-diagnostics");
    const invocation = join(diagnosticRoot, readdirSync(diagnosticRoot)[0]!);
    expect(readdirSync(invocation).some(worker => existsSync(join(invocation, worker, produced))), "COW_DIAGNOSTICS_SURVIVE_VIEW_REMOVAL").toBe(true);
    const checkouts = JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8"));
    for (const checkout of checkouts) expect(existsSync(resolve(root, checkout.workspace))).toBe(false);
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true });
    else console.error(`Prepared queue control retained its owned fixture for diagnosis: ${root}`);
  }
}, 60_000);
