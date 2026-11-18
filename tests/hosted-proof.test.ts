import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BROWSER_DETERMINISM_REPORT, browserDeterminismPairs, categoryCommands, DETERMINISM_REPORT, determinismFiles, proofProblems, PROOF_JOBS, unitFiles } from "../scripts/ci-proof";
import { browserDeterminismShards, determinismShards, planChecks, proofSelections, unitShards, workspaces, type ProofCadence, type Workspace } from "../scripts/ci-plan";
import { discoverTests } from "../scripts/test-shards";
import { BROWSER_DETERMINISM_PARTITIONS, DETERMINISM_PARTITIONS } from "../scripts/proof-shards";
import { planRepetitions } from "../scripts/test-determinism";
import { localChecks } from "../scripts/check-pr";
import { POST_MERGE_CATEGORIES } from "../scripts/red-main";

const ROOT = resolve(import.meta.dir, "..");
const directories: string[] = [];
test("only hosted single-workspace pack and browser builds opt into two compilers", async () => {
  const plan = planChecks(["package.json"], workspaces(ROOT));
  for (const category of ["browser", "layout", "endurance"] as const) {
    const commands = categoryCommands(category, plan, ROOT);
    expect(commands.filter(command => command.argv.includes("--jobs=2")).map(command => command.name))
      .toEqual(["workspace build for real browser checks"]);
  }
  expect(localChecks(plan, true).some(command => command.argv.includes("--jobs=2"))).toBe(false);
  for (const category of ["unit", "runtime", "runtime_host", "captures"] as const) {
    expect(categoryCommands(category, plan, ROOT).some(command => command.argv.includes("--jobs=2"))).toBe(false);
  }
  expect(await Bun.file(join(ROOT, "scripts/unit-workers.ts")).text()).not.toContain("--jobs=2");
});
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function receipt(selected = true): { changeset: { result: string; outputs: Record<string, string> } } & Record<string, { result: string; outputs?: Record<string, string> }> {
  return { changeset: { result: "success", outputs: Object.fromEntries(PROOF_JOBS.map(name => [name, String(selected)])) },
    ...Object.fromEntries(PROOF_JOBS.map(name => [name, { result: selected ? "success" : "skipped" }])) };
}

test("aggregate accepts actual selected passes and intentional exclusions only", () => {
  expect(PROOF_JOBS.length).toBe(11);
  expect(proofProblems(receipt())).toEqual([]);
  expect(proofProblems(receipt(false))).toEqual([]);
  for (const name of PROOF_JOBS) for (const result of ["failure", "cancelled", "skipped", "queued", ""]) {
    const needs = receipt(); needs[name] = { result };
    expect(proofProblems(needs)).toContain(`${name}: selected proof did not pass (${result})`);
  }
  const missing = receipt(); delete missing.unit;
  expect(proofProblems(missing)).toContain("unit: selected proof did not pass (missing)");
  // Retention is retired (#4107): nothing excuses a selected browser or layout job that did not run.
  for (const name of ["browser", "layout"] as const) {
    const dropped = receipt(); delete dropped[name];
    expect(proofProblems(dropped), `DROPPED_SELECTED_JOB_FAILS:${name}`).toEqual([`${name}: selected proof did not pass (missing)`]);
    const skipped = receipt(); skipped[name] = { result: "skipped" };
    expect(proofProblems(skipped), `SKIPPED_SELECTED_JOB_FAILS:${name}`).toEqual([`${name}: selected proof did not pass (skipped)`]);
  }
  const invalid = receipt(); delete invalid.changeset.outputs.runtime;
  expect(proofProblems(invalid)).toContain("runtime: selection output is missing or invalid");
  for (const state of ["failure", "cancelled", "skipped"]) {
    const needs = receipt(false); needs.changeset.result = state;
    expect(proofProblems(needs)).toContain("metadata did not pass");
  }
  const unexpected = receipt(false); unexpected.browser.result = "success";
  expect(proofProblems(unexpected)).toContain("browser: unselected job must be intentionally skipped (success)");
});

test("emitted aggregate executable fails a cancelled or skipped selected job and accepts its corrected receipt", async () => {
  for (const result of ["cancelled", "skipped", "success"]) {
    const needs = receipt(); needs.layout.result = result;
    // The metadata job's published partition sets reach the merge path through the receipt (#4108, #4117, #4163).
    Object.assign(needs.changeset.outputs, { unit_shards: "[1,2,3]", determinism_shards: "[1,2]", browser_determinism_shards: "[1,2,3,4]" });
    const child = Bun.spawn([process.execPath, "scripts/ci-proof.ts", "aggregate"], { cwd: ROOT,
      env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_EVENT_PATH: "", PROOF_NEEDS: JSON.stringify(needs) }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(result === "success" ? 0 : 1);
    if (result !== "success") expect(err).toContain(`layout: selected proof did not pass (${result})`);
    else {
      expect(out).toContain("All selected hosted proof passed");
      const line = out.split("\n").find(line => line.startsWith("BRAIN_SELECTED_PROOF_RECEIPT "));
      expect(line, "MERGE_CONSUMER_RECEIVES_VALIDATED_SELECTED_INVENTORY").toBeDefined();
      expect(JSON.parse(line!.slice("BRAIN_SELECTED_PROOF_RECEIPT ".length))).toEqual({
        selections: Object.fromEntries(PROOF_JOBS.map(name => [name, "true"])),
        results: Object.fromEntries(PROOF_JOBS.map(name => [name, "success"])), retained: [], unitShards: "[1,2,3]", determinismShards: "[1,2]", browserDeterminismShards: "[1,2,3,4]",
      });
    }
  }
});

test("hosted aggregate requires live draft readiness before selection planning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "candidate-event-")); directories.push(directory);
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, JSON.stringify({ action: "synchronize",
    pull_request: { number: 7, draft: true, head: { sha: "a".repeat(40) } } }));
  // Missing selections deliberately stop a bypass at the cheap cadence check.
  // No repository plan or matching selection fixture is needed to reach readiness.
  const child = Bun.spawn([process.execPath, "scripts/ci-proof.ts", "aggregate"], { cwd: ROOT,
    env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "odysseus/brain-kit", GH_TOKEN: "", GITHUB_TOKEN: "", PROOF_NEEDS: "{}" },
    stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err).toBe(1);
  expect(err, "AGGREGATE_MUST_REQUIRE_LIVE_DRAFT_READINESS").toContain("Draft proof requires live read-only GitHub readiness verification");
  expect(out).not.toContain("All selected hosted proof passed");
});

test("affected complete discovery admits new files and reverse dependencies without unrelated packages", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-proof-")); directories.push(dir);
  const packages: Workspace[] = [
    { dir: "core", name: "@fixture/core", dependencies: [], files: ["src"] },
    { dir: "ui-server", name: "@fixture/ui-server", dependencies: ["@fixture/core"], files: ["src"] },
    { dir: "module-video", name: "@fixture/video", dependencies: [], files: ["src"] },
  ];
  for (const file of ["tests/gate.test.ts", "packages/core/tests/new.test.ts", "packages/core/tests/old.test.ts", "packages/ui-server/tests/runtime.test.ts", "packages/module-video/tests/unrelated.test.ts", "experiments/harness.test.ts"]) {
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
  // The experiment tier runs before a release, not in hosted unit proof (#1386).
  expect(unitFiles(global, dir)).not.toContain("experiments/harness.test.ts");
  expect(() => unitFiles(plan, dir, "3/2")).toThrow("Invalid proof shard");
});

test("eight confirmation partitions run the files four main partitions run, each exactly once (#4108)", () => {
  const complete = planChecks(["package.json"], workspaces(ROOT));
  // Each hosted partition calls unitFiles with its own number over the matrix size.
  const partitions = (cadence: ProofCadence, plan = complete) => {
    const shards = unitShards({ ...plan, cadence });
    return shards.map(shard => unitFiles({ ...plan, cadence }, ROOT, `${shard}/${shards.length}`));
  };
  const discovered = discoverTests(ROOT, ["packages", "tests"]);
  expect(discovered.length).toBeGreaterThan(100);
  for (const [cadence, count] of [["confirmation", 8], ["feedback-heavy", 8], ["integrated", 4], ["exhaustive", 4]] as const) {
    const sets = partitions(cadence);
    expect(sets, `PARTITION_COUNT: ${cadence}`).toHaveLength(count);
    expect(sets.every(files => files.length > 0), `NONEMPTY: ${cadence}`).toBe(true);
    // Sorted equality with the duplicate-free discovery refuses an omitted, repeated or foreign file.
    expect(sets.flat().sort(), `EXACTLY_ONCE: ${cadence}`).toEqual([...discovered].sort());
  }
  // A selected inventory smaller than the cap gets one nonempty partition per file.
  const narrow = { ...planChecks(["packages/core/src/index.ts"], workspaces(ROOT)), unitTests: discovered.slice(0, 5) };
  expect(narrow.global).toBe(false);
  const few = partitions("confirmation", narrow);
  expect(few.map(files => files.length), "ONE_FILE_PER_PARTITION").toEqual([1, 1, 1, 1, 1]);
  expect(few.flat().sort()).toEqual(discovered.slice(0, 5).sort());
});

test("hosted global commands retain the full local inventory and real offline namespaces", () => {
  const plan = planChecks(["package.json"], workspaces(ROOT));
  // A global change touches no Bun test file and no browser spec, so nothing is repeated under load (#4109, #4163).
  const { determinism, browser_determinism, ...selections } = proofSelections(plan);
  expect(determinism, "NO_CHANGED_TEST_NO_REPETITION").toBe(false);
  expect(browser_determinism, "NO_CHANGED_SPEC_NO_REPETITION").toBe(false);
  expect(Object.values(selections).every(Boolean)).toBe(true);
  expect(Object.values(proofSelections(plan, true)).every(value => !value)).toBe(true);
  const cmds = ["unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"].flatMap(category => categoryCommands(category as "unit", plan, ROOT));
  const argv = cmds.map(command => command.argv.join(" ")).join("\n");
  for (const phase of ["test:browser", "test:layout", "test:endurance", "capture:verify", "measure-claude-runtime.ts", "measure-claude-enforcement.ts", "measure-claude-delegation.ts", "measure-claude-capability.ts", "measure-claude-haiku.ts", "tests/measurement-isolation.test.ts", "experiments/turn-surface-runtime-placement.test.ts", "--map-current-user --keep-caps --net", "chat-focus-runtime.test.ts", "external-speech-runtime.test.ts", "scripts/prove-native-host.ts", "scripts/prove-worker-identity.ts"]) expect(argv).toContain(phase);
  const unit = cmds.find(command => command.name === "complete affected unit and integration suite")!;
  expect(unit.env?.BRAIN_REQUIRE_CHROME).toBe("1");
  expect(unit.argv).toContain(join(ROOT, "scripts/unit-workers.ts"));
  expect(categoryCommands("unit", plan, ROOT, "1/4", 1)[0]!.argv).not.toContain(join(ROOT, "scripts/unit-workers.ts"));
  expect(() => categoryCommands("unit", plan, ROOT, "1/4", 4)).toThrow("supports 1 or 2 workers");
  expect(unit.argv.filter(arg => arg.endsWith(".test.ts")).length).toBeGreaterThan(100);
  expect(categoryCommands("layout", plan, ROOT, "1/2").at(-1)!.argv.at(-1)).toBe("--shard=1/2");
});


test("the emitted hosted aggregate cannot accept an omitted required endurance selection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "candidate-event-")); directories.push(directory);
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, "{}");
  const needs = receipt();
  needs.changeset.outputs.cadence = "exhaustive";
  needs.changeset.outputs.endurance = "false";
  needs.endurance = { result: "skipped" };
  const child = Bun.spawn([process.execPath, "scripts/ci-proof.ts", "aggregate"], { cwd: ROOT,
    env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
      PROOF_NEEDS: JSON.stringify(needs) }, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(err).toContain("endurance: required candidate selection differs from actual inputs");
});


test("required endurance proof cannot be absent even when every other job passes", () => {
  const needs = receipt();
  delete needs.endurance;
  expect(proofProblems(needs)).toContain("endurance: selected proof did not pass (missing)");
});


test("root consumer unit proof executes exactly selected consumers and tooling once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "consumer-unit-proof-")); directories.push(dir);
  const files = ["tests/owned.test.ts", "tests/tooling.test.ts", "packages/core/tests/consumer.test.ts"];
  for (const file of [...files, "tests/unrelated.test.ts"]) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), `import { test, expect } from "bun:test"; test(${JSON.stringify(file)}, () => expect(1).toBe(1));`);
  }
  const plan = { ...planChecks(["README.md"], []), unitTests: files, local: {
    fullTests: true, browser: false, layout: false, captures: false, runtime: false, endurance: false } };
  expect(unitFiles(plan, dir), "SELECTED_UNIT_EXACT_EXECUTION").toEqual([...files].sort());
  const command = categoryCommands("unit", plan, dir)[0]!;
  // Drive Bun itself, preserving explicit paths, rather than inspecting argv alone.
  const child = Bun.spawn([process.execPath, "test", ...unitFiles(plan, dir).map(file => join(dir, file))], {
    cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, err).toBe(0); expect(err).toContain("3 pass"); expect(err).not.toContain("unrelated.test.ts");
  expect(command.argv.filter(arg => arg.endsWith(".test.ts"))).toHaveLength(3);
  expect(() => unitFiles({ ...plan, unitTests: [...files, files[0]!] }, dir)).toThrow("Invalid selected unit inventory");
  expect(() => unitFiles({ ...plan, unitTests: ["tests/missing.test.ts"] }, dir)).toThrow("Invalid selected unit inventory");
});

test("explicit leaf inventory is exact, validated and preserves aggregate obligations", () => {
  const plan = planChecks(["packages/ui-sdk/tests/leaf.test.ts"], workspaces(ROOT));
  plan.unitTests = ["tests/ci-plan.test.ts", "tests/hosted-proof.test.ts"];
  expect(unitFiles(plan, ROOT)).toEqual(plan.unitTests);
  const parts = ["1/2", "2/2"].flatMap(shard => unitFiles(plan, ROOT, shard)).sort();
  expect(parts, "EXACT_LEAF_INVENTORY_ONCE").toEqual([...plan.unitTests].sort());
  expect(new Set(parts).size).toBe(2);
  const command = categoryCommands("unit", plan, ROOT)[0]!;
  expect(command.argv.filter(file => file.endsWith(".test.ts"))).toEqual(plan.unitTests.map(file => join(ROOT, file)));
  plan.unitTests = ["tests/does-not-exist.test.ts"];
  expect(() => unitFiles(plan, ROOT), "UNKNOWN_LEAF_REJECTED").toThrow("Invalid selected unit inventory");
  plan.unitTests = ["tests/ci-plan.test.ts", "tests/ci-plan.test.ts"];
  expect(() => unitFiles(plan, ROOT)).toThrow("Invalid selected unit inventory");
});


test("the aggregate requires repeated-run proof when selected and an intentional skip otherwise (#4109)", () => {
  const selected = receipt(false); selected.changeset.outputs.determinism = "true";
  for (const state of ["skipped", "failure", "cancelled", undefined]) {
    if (state === undefined) delete selected.determinism; else selected.determinism = { result: state };
    expect(proofProblems(selected), "SELECTED_REPETITION_MUST_PASS").toEqual([`determinism: selected proof did not pass (${state ?? "missing"})`]);
  }
  selected.determinism = { result: "success" };
  expect(proofProblems(selected), "SELECTED_AND_PASSED").toEqual([]);
  const unselected = receipt(false);
  expect(proofProblems(unselected), "UNSELECTED_NOT_REQUIRED").toEqual([]);
  unselected.determinism = { result: "success" };
  expect(proofProblems(unselected)).toEqual(["determinism: unselected job must be intentionally skipped (success)"]);
  const absent = receipt(false); delete absent.changeset.outputs.determinism;
  expect(proofProblems(absent), "MISSING_SELECTION_IS_NOT_A_SKIP").toEqual(["determinism: selection output is missing or invalid"]);
});

test("the hosted repetition command runs the planner's files through the command with real Chrome required (#4109)", () => {
  // The planner publishes the selection sorted (`determinismTests`), and the runner sorts what it is given.
  const plan = { ...planChecks(["docs/voyage.md"], workspaces(ROOT)), determinism: ["packages/core/tests/briefing.test.ts", "tests/ci-plan.test.ts"] };
  expect(determinismFiles(plan)).toEqual(["packages/core/tests/briefing.test.ts", "tests/ci-plan.test.ts"]);
  const [command, ...rest] = categoryCommands("determinism", plan, ROOT);
  expect(rest).toEqual([]);
  expect(command!.argv.slice(1)).toEqual([join(ROOT, "scripts/test-determinism.ts"), `--report=${DETERMINISM_REPORT}`, "packages/core/tests/briefing.test.ts", "tests/ci-plan.test.ts"]);
  // One partition is the unsplit job: the workflow's `--shard=1/1` runs the same command (#4117).
  expect(categoryCommands("determinism", plan, ROOT, "1/1"), "ONE_PARTITION_KEEPS_THE_COMMAND").toEqual([command!]);
  expect(() => categoryCommands("determinism", plan, ROOT, "1/2"), "DIVISOR_MUST_BE_THE_PLANNED_COUNT").toThrow("Repeated-run partition 1/2 is not in the planned set of 1");
  expect(command!.env, "CHANGED_FILES_MAY_DRIVE_REAL_CHROME").toEqual({ BRAIN_REQUIRE_CHROME: "1" });
  for (const unselected of [{ ...plan, determinism: [] }, { ...plan, determinism: undefined }]) {
    expect(() => categoryCommands("determinism", unselected, ROOT), "EMPTY_SELECTION_IS_NEVER_A_JOB").toThrow("Repeated-run proof was not selected");
  }
});

test("native runtime split requires both selected jobs and preserves all six phases exactly once", () => {
  const plan = planChecks(["package.json"], workspaces(ROOT));
  const selections = proofSelections(plan);
  expect(selections.runtime_host, "NATIVE_HOST_PROOF_SELECTED_WITH_RUNTIME").toBe(true);
  for (const state of ["skipped", "failure", "cancelled", undefined]) {
    const needs = receipt();
    if (state === undefined) delete needs.runtime_host;
    else needs.runtime_host = { result: state };
    expect(proofProblems(needs), "NATIVE_HOST_MISSING_OR_SKIPPED_REFUSED").toContain(`runtime_host: selected proof did not pass (${state ?? "missing"})`);
  }
  const allLocal = localChecks(plan, true);
  expect(allLocal.filter(c => ["measure-claude-runtime", "measure-claude-enforcement", "native delegation, capabilities and measurement isolation", "native managed hosted admission", "native separate-UID worker identity", "native reference pool allocation", "shared-process Chrome then child cleanup"].includes(c.name))).toHaveLength(7);
  const ordinary = categoryCommands("runtime", plan, ROOT);
  const native = categoryCommands("runtime_host", plan, ROOT);
  expect(native.map(c => c.name)).toEqual(["native managed hosted admission", "native separate-UID worker identity", "native reference pool allocation"]);
  expect(ordinary.map(c => c.name)).toEqual(["measure-claude-runtime", "measure-claude-enforcement", "native delegation, capabilities and measurement isolation", "shared-process Chrome then child cleanup"]);
  const shared = ordinary.at(-1)!;
  expect(shared.argv).toContain("--shard=1/1");
  expect(shared.argv.filter(arg => arg.endsWith("runtime.test.ts"))).toEqual(["packages/ui-react/tests/chat-focus-runtime.test.ts", "packages/ui-react/tests/external-speech-runtime.test.ts"]);
  expect(shared.env?.BRAIN_REQUIRE_CHROME).toBe("1");
});


test("emitted aggregate refuses skipped or missing selected native host job", async () => {
  for (const state of ["skipped", "missing", "success"]) {
    const needs = receipt();
    if (state === "missing") delete needs.runtime_host;
    else needs.runtime_host = { result: state };
    const child = Bun.spawn([process.execPath, "scripts/ci-proof.ts", "aggregate"], { cwd: ROOT,
      env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_EVENT_PATH: "", PROOF_NEEDS: JSON.stringify(needs) }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, "EMITTED_NATIVE_HOST_REQUIRED").toBe(state === "success" ? 0 : 1);
    if (state !== "success") expect(err).toContain(`runtime_host: selected proof did not pass (${state})`);
    else {
      expect(out).toContain("All selected hosted proof passed");
      const line = out.split("\n").find(line => line.startsWith("BRAIN_SELECTED_PROOF_RECEIPT "));
      expect(line, "MERGE_CONSUMER_RECEIVES_VALIDATED_SELECTED_INVENTORY").toBeDefined();
      expect(JSON.parse(line!.slice("BRAIN_SELECTED_PROOF_RECEIPT ".length))).toEqual({
        selections: Object.fromEntries(PROOF_JOBS.map(name => [name, "true"])),
        results: Object.fromEntries(PROOF_JOBS.map(name => [name, "success"])), retained: [], unitShards: null, determinismShards: null, browserDeterminismShards: null,
      });
    }
  }
});

test("an oversized selection runs as planned partitions: every file in exactly one, at the selection's count (#4117)", () => {
  const { capacitySeconds, max } = DETERMINISM_PARTITIONS;
  // Unweighted names, so the reviewed table cannot move this: 0.1 s each, 160 s per pass, 320 at the floor of two.
  const fleet = Array.from({ length: 1600 }, (_, index) => `tests/fleet/ship-${String(index).padStart(4, "0")}.test.ts`);
  const selected = { ...planChecks(["docs/voyage.md"], workspaces(ROOT)), determinism: fleet };
  for (const cadence of ["draft", "confirmation", "feedback-heavy"] as const) {
    const plan = { ...selected, cadence };
    expect(determinismShards(plan), `PUBLISHED_SET:${cadence}`).toEqual([1, 2]);
    const partitions = determinismShards(plan).map(shard => categoryCommands("determinism", plan, ROOT, `${shard}/2`));
    const files = partitions.map(([command]) => command!.argv.slice(command!.argv.indexOf("--repetitions=2") + 1));
    for (const [index, [command, ...rest]] of partitions.entries()) {
      expect(rest).toEqual([]);
      // A draft asks for five; the count for the whole selection is the floor, and each partition is told so.
      expect(command!.argv.slice(1, 4), `COUNT_DECIDED_OVER_THE_SELECTION:${cadence}`).toEqual([join(ROOT, "scripts/test-determinism.ts"), `--report=${DETERMINISM_REPORT}`, "--repetitions=2"]);
      expect(files[index]!.length * 0.1 * 2, "WITHIN_CAPACITY").toBeLessThanOrEqual(capacitySeconds);
      expect(determinismFiles(plan, `${index + 1}/2`), "RECEIPT_NAMES_THE_PARTITION_FILES").toEqual(files[index]!);
    }
    expect(files.flat().sort(), `EVERY_FILE_EXACTLY_ONCE:${cadence}`).toEqual(fleet);
    for (const shard of [undefined, "1/1", "1/3", "3/3"]) expect(() => categoryCommands("determinism", plan, ROOT, shard), `NOT_THE_PLANNED_SPLIT:${shard}`).toThrow("is not in the planned set of 2");
  }
  // Past the maximum nothing is planned, published or run: the metadata job and every partition refuse.
  const armada = { ...selected, cadence: "confirmation" as const, determinism: Array.from({ length: (max * capacitySeconds / 2 + 1) * 10 }, (_, index) => `tests/armada/ship-${index}.test.ts`) };
  const refusal = `weigh ${(armada.determinism.length * 0.1).toFixed(1)} weighted s per pass, ${(armada.determinism.length * 0.2).toFixed(1)} s at the floor of 2 repetitions. That needs more than the limit of ${max} partitions of ${capacitySeconds} weighted s each`;
  expect(() => determinismShards(armada), "PLANNER_REFUSES").toThrow(refusal);
  expect(() => categoryCommands("determinism", armada, ROOT, "1/10"), "PARTITION_REFUSES").toThrow(refusal);
  // Unselected, and on main where repetition never runs, the matrix expression still has one value.
  expect(determinismShards({ ...selected, determinism: undefined, cadence: "confirmation" })).toEqual([1]);
  expect(determinismShards({ ...armada, cadence: "integrated" }), "MAIN_NEVER_REPEATS").toEqual([1]);
});

test("ready confirmation repeats changed tests at the floor; every other cadence keeps the full count (#4137)", () => {
  const selected = { ...planChecks(["docs/voyage.md"], workspaces(ROOT)), determinism: ["tests/ci-plan.test.ts"] };
  const argv = (cadence: ProofCadence) => categoryCommands("determinism", { ...selected, cadence }, ROOT)[0]!.argv;
  // The lease is held while confirmation runs, and the draft head already ran the full count.
  expect(argv("confirmation"), "CONFIRMATION_RUNS_THE_FLOOR").toContain("--repetitions=2");
  for (const cadence of ["draft", "feedback", "feedback-heavy"] as const) {
    expect(argv(cadence).filter(arg => arg.startsWith("--repetitions")), `FULL_COUNT:${cadence}`).toEqual([]);
  }
  // The floor the command enforces and the count confirmation asks for are one number.
  expect(planRepetitions(["tests/ci-plan.test.ts"], { repetitions: 2 }).repetitions).toBe(2);
  expect(() => planRepetitions(["tests/ci-plan.test.ts"], { repetitions: 1 })).toThrow("at least 2");
});

// Names the reviewed table does not hold, so a weight refresh cannot move these: each pair costs the stated default.
const story = (name: string) => [{ project: "storybook", file: `packages/ui-kit/stories/${name}.stories.tsx` }, { project: "storybook-light", file: `packages/ui-kit/stories/${name}.stories.tsx` }];
const keys = (pairs: readonly { project: string; file: string }[]) => pairs.map(pair => `${pair.project}::${pair.file}`).sort();

test("a plan with changed browser specs repeats exactly its project/file pairs in the pinned container (#4163)", () => {
  const pairs = story("Argo"), plan = { ...planChecks(["docs/voyage.md"], workspaces(ROOT)), browserDeterminism: pairs };
  expect(browserDeterminismPairs(plan)).toEqual(["storybook-light::packages/ui-kit/stories/Argo.stories.tsx", "storybook::packages/ui-kit/stories/Argo.stories.tsx"]);
  const [build, repeat, ...rest] = categoryCommands("browser_determinism", plan, ROOT);
  expect(rest).toEqual([]);
  // The container resolves the packages' built output, as the browser and layout jobs do.
  expect([build!.name, build!.argv.slice(1)]).toEqual(["workspace build for real browser checks", ["run", "build", "--jobs=2"]]);
  expect(repeat!.argv.slice(1), "EXACT_PAIRS_NO_FILTER").toEqual([join(ROOT, "scripts/browser-determinism.ts"), `--report=${BROWSER_DETERMINISM_REPORT}`, ...keys(pairs)]);
  expect(categoryCommands("browser_determinism", plan, ROOT, "1/1"), "ONE_PARTITION_KEEPS_THE_COMMAND").toEqual([build!, repeat!]);
  expect(() => categoryCommands("browser_determinism", plan, ROOT, "1/2"), "DIVISOR_MUST_BE_THE_PLANNED_COUNT").toThrow("Repeated-run partition 1/2 is not in the planned set of 1");
  for (const unselected of [{ ...plan, browserDeterminism: [] }, { ...plan, browserDeterminism: undefined }]) {
    expect(() => categoryCommands("browser_determinism", unselected, ROOT), "EMPTY_SELECTION_IS_NEVER_A_JOB").toThrow("Repeated browser proof was not selected");
  }
  // The aggregate requires the job exactly when the plan selects it.
  const selected = receipt(false); selected.changeset.outputs.browser_determinism = "true";
  for (const state of ["skipped", "failure", "cancelled", undefined]) {
    if (state === undefined) delete selected.browser_determinism; else selected.browser_determinism = { result: state };
    expect(proofProblems(selected), "SELECTED_REPETITION_MUST_PASS").toEqual([`browser_determinism: selected proof did not pass (${state ?? "missing"})`]);
  }
  selected.browser_determinism = { result: "success" };
  expect(proofProblems(selected)).toEqual([]);
  const unselected = receipt(false); unselected.browser_determinism = { result: "success" };
  expect(proofProblems(unselected)).toEqual(["browser_determinism: unselected job must be intentionally skipped (success)"]);
});

test("ready confirmation repeats changed browser specs twice; every other pull-request cadence asks for five (#4163)", () => {
  const selected = { ...planChecks(["docs/voyage.md"], workspaces(ROOT)), browserDeterminism: story("Argo") };
  const argv = (cadence: ProofCadence) => categoryCommands("browser_determinism", { ...selected, cadence }, ROOT)[1]!.argv;
  expect(argv("confirmation"), "CONFIRMATION_RUNS_THE_FLOOR").toContain("--repetitions=2");
  for (const cadence of ["draft", "feedback", "feedback-heavy"] as const) {
    // No count on the command is the command's default of five.
    expect(argv(cadence).filter(arg => arg.startsWith("--repetitions")), `FULL_COUNT:${cadence}`).toEqual([]);
    expect(proofSelections({ ...selected, cadence }).browser_determinism, `SELECTED:${cadence}`).toBe(true);
  }
  for (const cadence of ["integrated", "exhaustive"] as const) expect(proofSelections({ ...selected, cadence }).browser_determinism, `NEVER_ON_MAIN:${cadence}`).toBe(false);
  // A fast category under the hybrid split: confirmation selects it, where it leaves the complete browser suites to main.
  expect(POST_MERGE_CATEGORIES, "NOT_A_POST_MERGE_CATEGORY").toEqual(["runtime", "runtime_host", "browser", "layout", "captures", "endurance"]);
  expect([proofSelections({ ...selected, cadence: "confirmation" }).browser_determinism, proofSelections({ ...selected, cadence: "confirmation", local: { ...selected.local, browser: true } }).browser])
    .toEqual([true, false]);
});

test("an oversized browser selection runs as planned partitions: every pair in exactly one, at the selection's count (#4163)", () => {
  const { capacitySeconds, max, unweightedSeconds } = BROWSER_DETERMINISM_PARTITIONS;
  // Sixteen unweighted pairs: 160 weighted s per pass, 320 at the floor of two, one more than one job holds.
  const fleet = Array.from({ length: 8 }, (_, index) => story(`Fleet${index}`)).flat();
  const selected = { ...planChecks(["docs/voyage.md"], workspaces(ROOT)), browserDeterminism: fleet };
  for (const cadence of ["draft", "confirmation", "feedback-heavy"] as const) {
    const plan = { ...selected, cadence };
    expect(browserDeterminismShards(plan), `PUBLISHED_SET:${cadence}`).toEqual([1, 2]);
    const partitions = browserDeterminismShards(plan).map(shard => categoryCommands("browser_determinism", plan, ROOT, `${shard}/2`)[1]!);
    const ran = partitions.map(command => command.argv.slice(command.argv.indexOf("--repetitions=2") + 1));
    for (const [index, command] of partitions.entries()) {
      // A draft asks for five; the count for the whole selection is the floor, and each partition is told so.
      expect(command.argv.slice(1, 4), `COUNT_DECIDED_OVER_THE_SELECTION:${cadence}`).toEqual([join(ROOT, "scripts/browser-determinism.ts"), `--report=${BROWSER_DETERMINISM_REPORT}`, "--repetitions=2"]);
      expect(ran[index]!.length * unweightedSeconds * 2, "WITHIN_CAPACITY").toBeLessThanOrEqual(capacitySeconds);
      expect(browserDeterminismPairs(plan, `${index + 1}/2`), "RECEIPT_NAMES_THE_PARTITION_PAIRS").toEqual(ran[index]!);
    }
    expect(ran.flat().sort(), `EVERY_PAIR_EXACTLY_ONCE:${cadence}`).toEqual(keys(fleet));
    for (const shard of [undefined, "1/1", "1/3", "3/3"]) expect(() => categoryCommands("browser_determinism", plan, ROOT, shard), `NOT_THE_PLANNED_SPLIT:${shard}`).toThrow("is not in the planned set of 2");
  }
  // Past the maximum nothing is planned, published or run: the metadata job and every partition refuse.
  const count = max * capacitySeconds / (2 * unweightedSeconds) + 1;
  const armada = { ...selected, cadence: "confirmation" as const, browserDeterminism: Array.from({ length: count }, (_, index) => ({ project: "visual", file: `packages/ui-kit/tests/visual/armada-${index}.visual.tsx` })) };
  const refusal = `Repeated browser proof refused before it ran: ${count} changed project/file pair(s) weigh ${(count * unweightedSeconds).toFixed(1)} weighted s per pass, ` +
    `${(count * unweightedSeconds * 2).toFixed(1)} s at the floor of 2 repetitions. That needs more than the limit of ${max} partitions of ${capacitySeconds} weighted s each (BROWSER_DETERMINISM_PARTITIONS, scripts/proof-shards.ts)`;
  expect(() => browserDeterminismShards(armada), "PLANNER_REFUSES").toThrow(refusal);
  expect(() => categoryCommands("browser_determinism", armada, ROOT, `1/${max}`), "PARTITION_REFUSES").toThrow(refusal);
  expect(browserDeterminismShards({ ...armada, browserDeterminism: armada.browserDeterminism.slice(1) }), "ONE_PAIR_FEWER_IS_THE_MAXIMUM").toHaveLength(max);
  // Unselected, and on main where repetition never runs, the matrix expression still has one value.
  expect(browserDeterminismShards({ ...selected, browserDeterminism: undefined, cadence: "confirmation" })).toEqual([1]);
  expect(browserDeterminismShards({ ...armada, cadence: "integrated" }), "MAIN_NEVER_REPEATS").toEqual([1]);
});
