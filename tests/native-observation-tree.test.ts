import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeHostDockerArgs } from "../scripts/prove-native-host";
import { observationTreeOptions, seedObservationTree, traceObserverBootstrap } from "../scripts/native-proof/observation-tree";

test("large observation fixture validates parameter sizes and leaves default Docker arguments unchanged", () => {
  expect(observationTreeOptions(["--observation-timing"])).toBeUndefined();
  expect(observationTreeOptions(["--observation-timing", "--tree=large"])).toEqual({ workspaceEntries: 80000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 });
  expect(observationTreeOptions(["--observation-timing", "--tree=large", "--workspace-entries=40000"])).toMatchObject({ workspaceEntries: 40000 });
  for (const bad of [["--tree=large"], ["--observation-timing", "--tree=small"], ["--observation-timing", "--tree=large", "--checkouts=0"],
    ["--observation-timing", "--tree=large", "--journal-objects=-1"]]) expect(() => observationTreeOptions(bad)).toThrow();
  const base = nativeHostDockerArgs("/repo", "/proof/run", "1000", "claude", false, false, "/bun", false, true);
  expect(base.filter(arg => arg.startsWith("--env=BRAIN_NATIVE_PROOF_TREE="))).toEqual([]);
  const sizes = { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 };
  expect(nativeHostDockerArgs("/repo", "/proof/run", "1000", "claude", false, false, "/bun", false, true, sizes))
    .toEqual([...base.slice(0, 6), `--env=BRAIN_NATIVE_PROOF_TREE=${JSON.stringify(sizes)}`, ...base.slice(6)]);
});

test("large tree seed is deterministic and records its generated entries and unavailable cold evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-timing-"));
  try {
    const sizes = { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 };
    mkdirSync(join(root, "brain", "node_modules"), { recursive: true });
    const before = readdirSync(root, { recursive: true }).length;
    const receipt = seedObservationTree(join(root, "brain"), join(root, "objects"), sizes);
    expect(receipt.generatedEntries, "ENTRY_RECEIPT_MATCHES_FILESYSTEM_DELTA").toBe(readdirSync(root, { recursive: true }).length - before);
    expect(receipt).toMatchObject({ ...sizes, generatedFiles: 17, generatedDirectories: 11, generatedEntries: 28,
      coldCache: { available: false, reason: "No isolated cache-drop proof; shared runner cache is never mutated" } });
    const first = readdirSync(join(root, "objects"));
    seedObservationTree(join(root, "second"), join(root, "second-objects"), sizes);
    expect(readdirSync(join(root, "second-objects"))).toEqual(first);
    expect(readFileSync(join(root, "brain/workspaces/ithaca-000/.gitignore"), "utf8")).toBe("node_modules/\n");
    expect(readFileSync(join(root, "brain/workspaces/ithaca-000/node_modules/ship-0/entry-0")).length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("observer bootstrap measures the first actual initialize and preserves failures", async () => {
  let now = 1000;
  const spans: { elapsedMs: number; outcome: string }[] = [];
  const initialize = traceObserverBootstrap(async (fail: boolean) => { now += 300; if (fail) throw Error("unavailable"); return "Ithaca"; }, span => spans.push(span), () => now);
  expect(await initialize(false)).toBe("Ithaca"); expect(await initialize(false)).toBe("Ithaca");
  expect(spans).toEqual([{ elapsedMs: 300, outcome: "completed" }]);
  const failed = traceObserverBootstrap(async () => { now += 200; throw Error("unavailable"); }, span => spans.push(span), () => now);
  await expect(failed()).rejects.toThrow("unavailable");
  expect(spans).toEqual([{ elapsedMs: 300, outcome: "completed" }, { elapsedMs: 200, outcome: "failed" }]);
});


test("directory counts also include implicitly created fixture parents", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-parent-count-"));
  try {
    const receipt = seedObservationTree(join(root, "brain"), join(root, "objects"), { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 });
    expect(receipt.generatedEntries).toBe(readdirSync(root, { recursive: true }).length);
    expect(receipt.generatedDirectories).toBe(13);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large timing watchdogs scale with tree size while small qualification keeps its limits", async () => {
  const { observationTreeWatchdog } = await import("../scripts/native-proof/observation-tree");
  const small = observationTreeWatchdog();
  const half = observationTreeWatchdog({ workspaceEntries: 40000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 })!;
  const full = observationTreeWatchdog({ workspaceEntries: 80000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 })!;
  expect(small).toBeUndefined();
  expect(half, "LARGE_TREE_USES_MEASUREMENT_WATCHDOGS").toBeGreaterThan(10000);
  expect(full).toBeGreaterThan(half);
  const source = await Bun.file(new URL("../scripts/native-proof/hosted-app.test.ts", import.meta.url)).text();
  expect(source).toContain("Math.max(deadlineMs, LARGE_TREE_WATCHDOG ?? 0)");
  expect(source).toContain("AbortSignal.timeout(healthLimitMs)");
  expect(source).toContain("toBeLessThan(LARGE_TREE_WATCHDOG ?? 15000)");
  expect(source).toContain("toBeLessThan(LARGE_TREE_WATCHDOG ?? 2000)");
});


test("malformed complete parameter values never select an unintended tree size", () => {
  for (const option of ["--workspace-entries=40000=80000", "--dependency-entries=3=4", "--journal-objects=4=5", "--checkouts=2=3"]) {
    expect(() => observationTreeOptions(["--observation-timing", "--tree=large", option]), "COMPLETE_TREE_PARAMETER_MUST_VALIDATE").toThrow();
  }
  for (const options of [["--workspace-entries=40000", "--workspace-entries=80000"], ["--tree=large"]])
    expect(() => observationTreeOptions(["--observation-timing", "--tree=large", ...options]), "DUPLICATE_TREE_PARAMETERS_ARE_AMBIGUOUS").toThrow();
});

test("the fixture outer watchdog exceeds the effective inner timeout for every sized scenario", async () => {
  const { observationRunTimeout } = await import("../scripts/native-proof/observation-tree");
  const python = Bun.which("python3")!;
  for (const sizes of [undefined, { workspaceEntries: 80000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 },
    { workspaceEntries: 1000000, dependencyEntries: 1000000, journalObjects: 1000000, checkouts: 1000 }]) for (const factor of [1, 3]) {
    const env = { BRAIN_NATIVE_PROOF_OBSERVATION_TIMING: "1", BRAIN_TEST_DEADLINE_FACTOR: String(factor), ...(sizes ? { BRAIN_NATIVE_PROOF_TREE: JSON.stringify(sizes) } : {}) };
    // Execute only the fixture's actual configuration prefix, before ROOT and
    // all filesystem setup. This cannot open a loop device or run native proof.
    const code = `import ast,json,os,pathlib,sys
path=pathlib.Path(sys.argv[1]); os.environ.update(json.loads(sys.argv[2])); sys.argv=[str(path),"claude","1000"]
nodes=[]
for node in ast.parse(path.read_text()).body:
    if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=="ROOT" for target in node.targets): break
    nodes.append(node)
else: raise RuntimeError("fixture configuration boundary missing")
namespace={"__file__":str(path),"__name__":"fixture_configuration_test"}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),"exec"),namespace)
print(namespace["HOSTED_TIMEOUT"])`;
    const child = Bun.spawnSync([python, "-I", "-S", "-B", "-c", code, new URL("../scripts/native-proof/fixture.py", import.meta.url).pathname, JSON.stringify(env)], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const outerMs = Number(child.stdout.toString()) * 1000;
    expect(outerMs, "OUTER_NATIVE_WATCHDOG_CANNOT_PREEMPT_INNER").toBeGreaterThanOrEqual(observationRunTimeout(sizes) * factor + 120000);
    if (!sizes && factor === 1) expect(outerMs).toBe(1800000);
  }
});
