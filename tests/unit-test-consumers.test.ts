import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { planChecks, workspaces } from "../scripts/ci-plan";
import { unitFiles } from "../scripts/ci-proof";
import { addUnitImportConsumers, discoverUnitImports, selectUnitImportConsumers } from "../scripts/unit-test-consumers";
import { browserInventory } from "../scripts/proof-inputs";
import { auditUnitConsumers } from "./helpers/unit-consumer-audit";

const ROOT = resolve(import.meta.dir, "..");

test.each([
  ["packages/ui-server/src/brain/application.ts", "packages/ui-react/tests/share-draft-runtime.test.ts"],
  ["packages/module-jobs/src/types.ts", "packages/ui-server/tests/jobs-board-selection-http.test.ts"],
])("production unit proof includes the cross-workspace consumer of %s", (changed, consumer) => {
  const plan = planChecks([changed], workspaces(ROOT), ROOT);
  expect(unitFiles(plan, ROOT), `CROSS_WORKSPACE_CONSUMER: ${consumer}`).toContain(consumer);
});

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "unit-consumers-")); scratch.push(root);
  const write = (file: string, source: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  for (const dir of ["source", "consumer", "helpers", "unrelated"]) {
    write(`packages/${dir}/package.json`, JSON.stringify({
      name: `@schlessera/brain-${dir}`, files: ["src"],
      exports: { ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./detail": { bun: "./src/detail.ts", default: "./dist/detail.js" } },
    }));
    write(`packages/${dir}/src/index.ts`, "export const value = 1;");
    write(`packages/${dir}/tests/own.test.ts`, 'import {test} from "bun:test"; test("own", () => {});');
    mkdirSync(join(root, "node_modules/@schlessera"), { recursive: true });
    symlinkSync(join(root, `packages/${dir}`), join(root, `node_modules/@schlessera/brain-${dir}`));
  }
  write("tests/root.test.ts", 'import {test} from "bun:test"; test("root", () => {});');
  // An independent declared reverse dependant still contributes its WHOLE suite.
  write("packages/helpers/package.json", JSON.stringify({
    name: "@schlessera/brain-helpers", dependencies: { "@schlessera/brain-source": "*" },
  }));
  return { root, write };
}
const consumer = "packages/consumer/tests/cross.test.ts";
const changed = "packages/source/src/index.ts";

test("ordinary module properties do not imply a runtime loader", () => {
  const f = fixture();
  f.write(consumer, 'const module = {name: "fixture", setup() {}}; module.setup(); console.log(module.name);');
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "ORDINARY_MODULE_PROPERTIES").not.toContain(consumer);
  expect(discoverUnitImports(f.root).unresolved.size).toBe(0);
});

test.each(["exports", "main", "nested scope", "helper imports"])(
  "resolution metadata retains the consumer when only %s changes", kind => {
    const f = fixture();
    f.write("packages/source/src/other.ts", "export const value = 2;");
    let metadata = "packages/source/package.json";
    if (kind === "main") {
      f.write(metadata, JSON.stringify({ name: "@schlessera/brain-source", main: "./src/other.ts" }));
    } else if (kind === "nested scope") {
      metadata = "packages/source/src/package.json";
      f.write(metadata, '{"type":"module"}');
    } else if (kind === "helper imports") {
      metadata = "packages/helpers/package.json";
      f.write(metadata, JSON.stringify({ name: "@schlessera/brain-helpers", imports: { "#value": "@schlessera/brain-source" } }));
      f.write("packages/helpers/tests/loader.ts", 'export {value} from "#value";');
    } else {
      // Both targets exist unchanged; only the Bun export routing is edited.
      f.write(metadata, JSON.stringify({ name: "@schlessera/brain-source",
        exports: { ".": { bun: "./src/other.ts", default: "./src/index.ts" } } }));
    }
    f.write(consumer, kind === "helper imports" ?
      'import {value} from "../../helpers/tests/loader";' : 'import {value} from "@schlessera/brain-source";');
    // Fixture validation uses Bun itself, independently of the planner resolver.
    expect(Bun.resolveSync("@schlessera/brain-source", join(f.root, "packages/consumer/tests")))
      .toBe(join(f.root, `packages/source/src/${kind === "exports" || kind === "main" ? "other" : "index"}.ts`));
    if (kind === "helper imports")
      expect(Bun.resolveSync("#value", join(f.root, "packages/helpers/tests")))
        .toBe(join(f.root, "packages/source/src/index.ts"));
    const baseline = planChecks([metadata], workspaces(f.root));
    const plan = planChecks([metadata], workspaces(f.root), f.root);
    expect(unitFiles(plan, f.root), "RESOLUTION_METADATA_CONSUMER").toContain(consumer);
    expect(unitFiles(baseline, f.root).every(file => unitFiles(plan, f.root).includes(file))).toBe(true);
    expect(plan.global).toBe(false);
    expect(plan.affected).toEqual(baseline.affected);
    expect(plan.local).toEqual(baseline.local);
    expect(discoverUnitImports(f.root).unresolved.size).toBe(0);
  },
);

test.each([
  ["namespace", 'import * as mod from "node:module"; const load = mod.createRequire(import.meta.url);'],
  ["default", 'import mod from "node:module"; const load = mod.createRequire(import.meta.url);'],
  ["destructured", 'import * as mod from "module"; const {createRequire: factory} = mod; const load = factory(import.meta.url);'],
  ["property alias", 'import mod from "node:module"; const factory = mod["createRequire"]; const load = factory(import.meta.url);'],
  ["namespace alias", 'import * as mod from "node:module"; const alias = mod; const load = alias.createRequire(import.meta.url);'],
  ["dynamic module", 'const mod = await import("node:module"); const load = mod.createRequire(import.meta.url);'],
  ["required module", 'const {createRequire: factory} = require("module"); const load = factory(import.meta.url);'],
  ["re-exported factory", 'import {factory} from "./loader"; const load = factory(import.meta.url);'],
  ["global module property", 'const load = module["require"].bind(module);'],
  ["Bun resolver alias", 'const {resolveSync: load} = Bun;'],
  ["meta resolver alias", 'const meta = import.meta; const load = meta.resolve;'],
])("unsupported %s loader retains its actual unit owner", (_name, setup) => {
  const f = fixture();
  f.write("packages/consumer/tests/loader.ts", 'export {createRequire as factory} from "node:module";');
  f.write(consumer, `${setup} const value = load("@schlessera/brain-source");`);
  const baseline = planChecks([changed], workspaces(f.root));
  expect(unitFiles(baseline, f.root)).not.toContain(consumer);
  const plan = planChecks([changed], workspaces(f.root), f.root);
  expect(unitFiles(plan, f.root), "INDIRECT_LOADER_CONSUMER").toContain(consumer);
  expect(discoverUnitImports(f.root).unresolved.size).toBeGreaterThan(0);
  expect(plan.local).toEqual(baseline.local);
  expect(plan.affected).toEqual(baseline.affected);
  expect(unitFiles(plan, f.root)).not.toContain("packages/unrelated/tests/own.test.ts");
});

test.each([
  ["package", 'import {value} from "@schlessera/brain-source";'],
  ["relative JS to TS", 'import {value} from "../../source/src/index.js";'],
  ["literal dynamic", 'const loaded = import("@schlessera/brain-source");'],
  ["CommonJS", 'const loaded = require("@schlessera/brain-source");'],
  ["import assignment", 'import loaded = require("@schlessera/brain-source");'],
  ["type-only", 'import type {value} from "@schlessera/brain-source";'],
  ["import type expression", 'type Value = import("@schlessera/brain-source").value;'],
])("production planning adds %s consumers without widening categories", (_name, source) => {
  const f = fixture(); f.write(consumer, source);
  const before = planChecks([changed], workspaces(f.root));
  const after = planChecks([changed], workspaces(f.root), f.root);
  const files = unitFiles(after, f.root);
  expect(files, "RESOLVED_IMPORT_CONSUMER").toContain(consumer);
  expect(unitFiles(before, f.root).every(file => files.includes(file)), "MANIFEST_AND_ROOT_FLOOR").toBe(true);
  expect(files).not.toContain("packages/consumer/tests/own.test.ts");
  expect(files).not.toContain("packages/unrelated/tests/own.test.ts");
  expect(after.affected).toEqual(before.affected);
  expect(after.local).toEqual(before.local);
  expect(after.pack).toBe(before.pack);
});

test("Bun export subpaths and transitive helper/re-export cycles retain actual targets", () => {
  const f = fixture();
  f.write("packages/source/src/detail.ts", "export const detail = 1;");
  f.write("packages/source/dist/detail.js", "export const wrong = 0;");
  f.write("packages/helpers/tests/first.ts", 'export * from "./second.js";');
  f.write("packages/helpers/tests/second.ts", 'export * from "./first.js"; export * from "@schlessera/brain-source/detail";');
  f.write(consumer, 'import {detail} from "../../helpers/tests/first.js";');
  const graph = discoverUnitImports(f.root);
  expect(selectUnitImportConsumers(graph, ["packages/source/src/detail.ts"]).tests, "HELPER_CYCLE_TARGET").toEqual([consumer]);
  expect(selectUnitImportConsumers(graph, [changed]).tests, "UNRELATED_INDEX_IS_NOT_A_TARGET").toEqual([]);
  expect(selectUnitImportConsumers(graph, ["packages/source/dist/detail.js"]).tests).toEqual([]);
  expect(graph.unresolved.size).toBe(0);
  const plan = planChecks(["packages/source/src/detail.ts"], workspaces(f.root), f.root);
  expect(unitFiles(plan, f.root)).toContain(consumer);
});

test("explicit JavaScript executes instead of its adjacent declaration", () => {
  const f = fixture();
  f.write("packages/helpers/tests/runtime.js", 'export * from "../../source/src/index.ts";');
  f.write("packages/helpers/tests/runtime.d.ts", "export declare const wrong: number;");
  f.write(consumer, 'import {value} from "../../helpers/tests/runtime.js";');
  const graph = discoverUnitImports(f.root);
  expect(selectUnitImportConsumers(graph, [changed]).tests, "EXECUTABLE_JS_EDGE").toEqual([consumer]);
  expect(graph.reverse.get("packages/helpers/tests/runtime.d.ts")).toBeUndefined();
});

test("a spawned fixture's import reaches its runnable unit owner", () => {
  const f = fixture();
  f.write("packages/consumer/tests/fixtures/probe.ts", 'import {value} from "@schlessera/brain-source";');
  f.write(consumer, 'Bun.spawn([process.execPath, new URL("./fixtures/probe.ts", import.meta.url).pathname]);');
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "SPAWNED_FIXTURE_OWNER").toContain(consumer);
});

test.each([
  'nativeFixture("probe");',
  'const command = `bun ./fixtures/probe.ts\\necho finished`; Bun.spawn(["sh", "-c", command]);',
])("fixed fixture names inside launch helpers and shell payloads retain owners: %s", source => {
  const f = fixture();
  f.write("packages/consumer/tests/fixtures/probe.ts", 'import "@schlessera/brain-source";');
  f.write(consumer, source);
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "INDIRECT_FIXTURE_OWNER").toContain(consumer);
});

test("resolved imports do not acquire unrelated same-basename fixture inputs", () => {
  const f = fixture();
  f.write("packages/helpers/tests/index.ts", "await import(process.env.UNKNOWN);");
  f.write(consumer, 'import {value} from "../../source/src/index.ts";');
  const graph = discoverUnitImports(f.root);
  expect(graph.unresolved.size, "NO_BASENAME_FIXTURE_COLLISION").toBe(0);
  expect(selectUnitImportConsumers(graph, ["packages/unrelated/src/index.ts"]).tests).toEqual([]);
});

test.each([
  ["computed", 'const path = process.env.MODULE; await import(path);'],
  ["missing", 'import {value} from "../../missing/src/value.js";'],
  ["aliased", "const loader = require; loader(process.env.MODULE);"],
  ["factory alias", 'import {createRequire as factory} from "node:module"; const load = factory(import.meta.url); load(process.env.MODULE);'],
  ["require factory", 'import {createRequire} from "node:module"; const load = createRequire(import.meta.url); load(process.env.MODULE);'],
  ["glob", 'const loaded = import.meta.glob("../../*/src/*.ts");'],
  ["computed fixture ownership", 'Bun.spawn([process.execPath, `./fixtures/${process.env.PROBE}.ts`]);'],
  ["invalid", "import { value from ;"],
])("%s imports conservatively select consumers outside the manifest floor", (_name, source) => {
  const f = fixture(); f.write(consumer, source);
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "FALLBACK_ADDS_MISSING_CONSUMER").toContain(consumer);
  const graph = discoverUnitImports(f.root);
  expect(selectUnitImportConsumers(graph, [changed]).fallbackTests, "UNRESOLVED_OWNER_FALLBACK").toContain(consumer);
});

test.each(["unreadable", "symlink", "deleted"])("%s shared helpers cannot lose their consumers", kind => {
  const f = fixture(), helper = "packages/helpers/tests/unknown.ts";
  f.write(consumer, 'import "./../../helpers/tests/unknown.js";');
  f.write(helper, 'import "@schlessera/brain-source";');
  if (kind === "unreadable") chmodSync(join(f.root, helper), 0);
  if (kind === "symlink") {
    rmSync(join(f.root, helper));
    symlinkSync(join(f.root, changed), join(f.root, helper));
  }
  if (kind === "deleted") rmSync(join(f.root, helper));
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "UNKNOWN_HELPER_OWNER").toContain(consumer);
});

test("a custom runtime resolution base cannot silently use the importer's directory", () => {
  const f = fixture();
  f.write("packages/consumer/tests/index.ts", "export {};");
  f.write(consumer, 'Bun.resolveSync("./index.ts", process.env.SOURCE_DIRECTORY);');
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "CUSTOM_RESOLVER_BASE_FALLBACK").toContain(consumer);
});

test("mixed root/package plans retain explicit consumers and reject malformed inventories", () => {
  const f = fixture(); f.write(consumer, "export {};");
  const before = planChecks([changed], workspaces(f.root));
  const after = addUnitImportConsumers({ ...before, tests: [consumer] }, f.root);
  expect(unitFiles(after, f.root)).toContain(consumer);
  const files = unitFiles(after, f.root);
  expect([1, 2, 3, 4].flatMap(n => unitFiles(after, f.root, `${n}/4`)).sort(), "EXACT_SHARD_UNION").toEqual(files);
  for (const inventory of [[], [consumer, consumer], ["tests/missing.test.ts"]]) {
    expect(() => unitFiles({ ...after, unitTests: inventory }, f.root), "INVALID_INVENTORY_REFUSED").toThrow();
    expect(() => addUnitImportConsumers({ ...before, unitTests: inventory }, f.root), "EXPANSION_CANNOT_REPAIR_INVALID_INVENTORY").toThrow();
  }
  const global = planChecks(["bun.lock"], workspaces(f.root), f.root);
  expect(addUnitImportConsumers(global, f.root)).toBe(global);
  expect(unitFiles(global, f.root)).toContain("packages/unrelated/tests/own.test.ts");
});

test("the independent census retains an unresolved relative cross-workspace edge", () => {
  const f = fixture();
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: f.root }).exitCode).toBe(0);
  f.write(consumer, 'import "../../source/src/missing.ts";');
  expect(auditUnitConsumers(f.root, []), "CENSUS_CANNOT_DROP_UNRESOLVED_RELATIVE_TARGET").toContainEqual({
    importer: consumer, specifier: "../../source/src/missing.ts", target: "packages/source/src/missing.ts",
    resolved: false, workspace: "source", declared: false, unitOwners: [consumer], runnerOwners: [],
  });
  expect(unitFiles(planChecks([changed], workspaces(f.root), f.root), f.root), "UNRESOLVED_CENSUS_EDGE_RETAINS_UNIT_OWNER").toContain(consumer);
});

test("the whole cross-workspace source class retains every independently discovered unit owner", async () => {
  const browser = await browserInventory(ROOT);
  const records = auditUnitConsumers(ROOT, browser.map(spec => spec.file));
  const pairs = new Set(records.filter(record => !record.declared)
    .map(record => `${record.importer.split("/")[1]} -> ${record.workspace}`));
  for (const pair of [
    "core -> module-images", "geo -> ui-sdk", "module-travel -> module-speaking",
    "render-template -> ui-kit", "ui-backend-claude -> core", "ui-backend-claude -> module-jobs",
    "ui-backend-claude -> ui-server", "ui-backend-pi -> ui-backend-claude", "ui-kit -> ui-react",
    "ui-react -> common", "ui-react -> core", "ui-react -> geo", "ui-react -> module-diagrams",
    "ui-react -> render-template", "ui-react -> ui-backend-claude", "ui-react -> ui-server",
    "ui-sdk -> ui-backend-claude", "ui-sdk -> ui-backend-pi", "ui-sdk -> ui-server",
    "ui-server -> module-jobs", "ui-server -> ui-react",
  ]) expect(pairs, `CURRENT_SOURCE_PAIR: ${pair}`).toContain(pair);
  const graph = discoverUnitImports(ROOT), packages = workspaces(ROOT), inventories = new Map<string, Set<string>>();
  for (const record of records) {
    // A missing runnable owner is a census failure, never a passing unit case.
    expect(record.unitOwners.length + record.runnerOwners.length, `UNRESOLVED_OWNERSHIP: ${record.importer}`).toBeGreaterThan(0);
    let files = inventories.get(record.target);
    if (!files) {
      // Same production additive selection and final inventory validation,
      // sharing just this immutable scan instead of rerunning browser discovery.
      files = new Set(unitFiles(addUnitImportConsumers(planChecks([record.target], packages), ROOT, graph), ROOT));
      inventories.set(record.target, files);
    }
    for (const owner of record.unitOwners)
      expect(files, `WHOLE_CLASS_OWNER: ${record.target} -> ${record.importer} -> ${owner}`).toContain(owner);
  }
  const conformance = records.filter(record => record.importer.endsWith("/paid-provider-qualification-probe.ts"));
  expect(conformance.length).toBeGreaterThan(0);
  for (const record of conformance)
    expect(record.unitOwners, "SPAWNED_CONFORMANCE_IS_UNIT_OWNED").toContain("packages/core/tests/paid-provider-qualification.test.ts");
});
