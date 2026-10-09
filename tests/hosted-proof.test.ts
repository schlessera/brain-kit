import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { categoryCommands, proofProblems, PROOF_JOBS, unitFiles } from "../scripts/ci-proof";
import { planChecks, proofSelections, workspaces, type Workspace } from "../scripts/ci-plan";
import { discoverTests } from "../scripts/test-shards";

const ROOT = resolve(import.meta.dir, "..");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function receipt(selected = true): { changeset: { result: string; outputs: Record<string, string> } } & Record<string, { result: string; outputs?: Record<string, string> }> {
  return { changeset: { result: "success", outputs: Object.fromEntries(PROOF_JOBS.map(name => [name, String(selected)])) },
    ...Object.fromEntries(PROOF_JOBS.map(name => [name, { result: selected ? "success" : "skipped" }])) };
}

test("aggregate accepts actual selected passes and intentional exclusions only", () => {
  expect(PROOF_JOBS.length).toBe(7);
  expect(proofProblems(receipt())).toEqual([]);
  expect(proofProblems(receipt(false))).toEqual([]);
  for (const name of PROOF_JOBS) for (const result of ["failure", "cancelled", "skipped", "queued", ""]) {
    const needs = receipt(); needs[name] = { result };
    expect(proofProblems(needs)).toContain(`${name}: selected proof did not pass (${result})`);
  }
  const missing = receipt(); delete missing.unit;
  expect(proofProblems(missing)).toContain("unit: selected proof did not pass (missing)");
  const invalid = receipt(); delete invalid.changeset.outputs.runtime;
  expect(proofProblems(invalid)).toContain("runtime: selection output is missing or invalid");
  for (const state of ["failure", "cancelled", "skipped"]) {
    const needs = receipt(false); needs.changeset.result = state;
    expect(proofProblems(needs)).toContain("metadata did not pass");
  }
  const unexpected = receipt(false); unexpected.browser.result = "success";
  expect(proofProblems(unexpected)).toContain("browser: unselected job must be intentionally skipped (success)");
});

test("emitted aggregate executable fails a cancelled selected job and accepts its corrected receipt", async () => {
  for (const result of ["cancelled", "success"]) {
    const needs = receipt(); needs.layout.result = result;
    const child = Bun.spawn([process.execPath, "scripts/ci-proof.ts", "aggregate"], { cwd: ROOT,
      env: { ...process.env, PROOF_NEEDS: JSON.stringify(needs) }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(result === "success" ? 0 : 1);
    if (result === "cancelled") expect(err).toContain("layout: selected proof did not pass (cancelled)");
    else expect(out).toContain("All selected hosted proof passed");
  }
});

test("affected complete discovery admits new files and reverse dependencies without unrelated packages", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-proof-")); directories.push(dir);
  const packages: Workspace[] = [
    { dir: "core", name: "@fixture/core", dependencies: [], files: ["src"] },
    { dir: "ui-server", name: "@fixture/ui-server", dependencies: ["@fixture/core"], files: ["src"] },
    { dir: "module-video", name: "@fixture/video", dependencies: [], files: ["src"] },
  ];
  for (const file of ["tests/gate.test.ts", "packages/core/tests/new.test.ts", "packages/core/tests/old.test.ts", "packages/ui-server/tests/runtime.test.ts", "packages/module-video/tests/unrelated.test.ts"]) {
    mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), "export {};\n");
  }
  const plan = planChecks(["packages/core/src/index.ts"], packages);
  const files = unitFiles(plan, dir);
  expect(files).toEqual(["packages/core/tests/new.test.ts", "packages/core/tests/old.test.ts", "packages/ui-server/tests/runtime.test.ts", "tests/gate.test.ts"]);
  const partitions = ["1/2", "2/2"].flatMap(shard => unitFiles(plan, dir, shard)).sort();
  expect(partitions).toEqual(files); expect(new Set(partitions).size).toBe(files.length);
  const global = planChecks(["scripts/unknown.ts"], packages);
  expect(unitFiles(global, dir)).toEqual(discoverTests(dir, ["packages", "tests"]));
  expect(unitFiles(global, dir)).toContain("packages/module-video/tests/unrelated.test.ts");
  expect(() => unitFiles(plan, dir, "3/2")).toThrow("Invalid proof shard");
});

test("hosted global commands retain the full local inventory and real offline namespaces", () => {
  const plan = planChecks(["package.json"], workspaces(ROOT));
  const selections = proofSelections(plan);
  expect(Object.values(selections).every(Boolean)).toBe(true);
  expect(Object.values(proofSelections(plan, true)).every(value => !value)).toBe(true);
  const cmds = ["unit", "runtime", "browser", "layout", "captures"].flatMap(category => categoryCommands(category as "unit", plan, ROOT));
  const argv = cmds.map(command => command.argv.join(" ")).join("\n");
  for (const phase of ["test:browser", "test:layout", "capture:verify", "measure-claude-runtime.ts", "measure-claude-enforcement.ts", "measure-claude-delegation.ts", "measure-claude-capability.ts", "measure-claude-haiku.ts", "tests/measurement-isolation.test.ts", "--map-current-user --keep-caps --net", "chat-focus-runtime.test.ts", "external-speech-runtime.test.ts"]) expect(argv).toContain(phase);
  const unit = cmds.find(command => command.name === "complete affected unit and integration suite")!;
  expect(unit.env?.BRAIN_REQUIRE_CHROME).toBe("1");
  expect(unit.argv.filter(arg => arg.endsWith(".test.ts")).length).toBeGreaterThan(100);
  expect(categoryCommands("layout", plan, ROOT, "1/2").at(-1)!.argv.at(-1)).toBe("--shard=1/2");
});
