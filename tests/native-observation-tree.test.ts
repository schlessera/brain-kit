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

test("large tree seed is deterministic and records its generated entries", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-timing-"));
  try {
    const sizes = { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 };
    mkdirSync(join(root, "brain", "node_modules"), { recursive: true });
    const before = readdirSync(root, { recursive: true }).length;
    const receipt = seedObservationTree(join(root, "brain"), join(root, "objects"), sizes);
    expect(receipt.generatedEntries, "ENTRY_RECEIPT_MATCHES_FILESYSTEM_DELTA").toBe(readdirSync(root, { recursive: true }).length - before);
    expect(receipt).toMatchObject({ ...sizes, generatedFiles: 17, generatedDirectories: 11, generatedEntries: 28 });
    expect(receipt, "COLD_EVIDENCE_IS_THE_RUN_S_NOT_THE_SEED_S").not.toHaveProperty("coldCache");
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
  // #4284: a cold admission that ran is one more fixture-model attempt in the final count.
  expect(source, "COLD_ADMISSION_COUNTED_IN_PROVIDER_ATTEMPTS").toContain("+ BACKLOG + 1 + (coldCache?.available ? 1 : 0);");
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
    if (!sizes && factor === 1) expect(outerMs).toBe(5400000);
  }
});

test("runner conditions are opt-in: --cpus and --cold-cache add Docker arguments only when selected (#4284, #4286)", async () => {
  const { nativeRunnerOptions } = await import("../scripts/native-proof/observation-tree");
  const large = ["--observation-timing", "--tree=large"];
  expect(nativeRunnerOptions(large, {}), "DEFAULT_RUNNER_HAS_NO_CONDITION").toEqual({});
  expect(nativeRunnerOptions(["--backend=pi", "--cpus=0.5"], {})).toEqual({ cpus: "0.5" });
  expect(nativeRunnerOptions(["--cpus=2"], {})).toEqual({ cpus: "2" });
  for (const bad of ["--cpus=0", "--cpus=-1", "--cpus=.5", "--cpus=1e3", "--cpus=0.5=1", "--cpus=", "--cpus=5000", "--cpus=0.0001"])
    expect(() => nativeRunnerOptions([bad], {}), `INVALID_CPU_QUOTA_REFUSED ${bad}`).toThrow();
  expect(() => nativeRunnerOptions(["--cpus=1", "--cpus=2"], {}), "DUPLICATE_CPU_QUOTA_AMBIGUOUS").toThrow();
  expect(() => nativeRunnerOptions(["--observation-timing", "--cold-cache"], {}), "COLD_CACHE_NEEDS_THE_LARGE_TREE").toThrow();
  expect(nativeRunnerOptions([...large, "--cold-cache"], {}), "UNDECLARED_RUNNER_IS_NOT_ISOLATED").toEqual({ coldCache: "undeclared" });
  expect(nativeRunnerOptions([...large, "--cold-cache"], { BRAIN_NATIVE_PROOF_ISOLATED_RUNNER: "true" })).toEqual({ coldCache: "undeclared" });
  expect(nativeRunnerOptions(large, { BRAIN_NATIVE_PROOF_ISOLATED_RUNNER: "1" }), "ISOLATION_ALONE_SELECTS_NOTHING").toEqual({});
  expect(nativeRunnerOptions([...large, "--cold-cache"], { BRAIN_NATIVE_PROOF_ISOLATED_RUNNER: "1" })).toEqual({ coldCache: "isolated" });
  const base = nativeHostDockerArgs("/repo", "/proof/run", "1000", "pi", false, false, "/bun", false, true);
  expect(nativeHostDockerArgs("/repo", "/proof/run", "1000", "pi", false, false, "/bun", false, true, undefined, {}), "DEFAULT_DOCKER_ARGUMENTS_UNCHANGED").toEqual(base);
  expect(base.some(arg => arg.startsWith("--cpus") || arg.includes("COLD_CACHE"))).toBe(false);
  expect(nativeHostDockerArgs("/repo", "/proof/run", "1000", "pi", false, false, "/bun", false, true, undefined, { cpus: "0.5" }))
    .toEqual([...base.slice(0, 5), "--cpus=0.5", ...base.slice(5)]);
  expect(nativeHostDockerArgs("/repo", "/proof/run", "1000", "pi", false, false, "/bun", false, true, undefined, { coldCache: "isolated" }))
    .toEqual([...base.slice(0, 6), "--env=BRAIN_NATIVE_PROOF_COLD_CACHE=isolated", ...base.slice(6)]);
});

test("the cold-cache row drops the page cache only when an isolated runner opted in, and says why otherwise (#4284)", async () => {
  const { coldCacheRow } = await import("../scripts/native-proof/observation-tree");
  let drops = 0, admissions = 0;
  const drop = () => { drops++; };
  const admit = async () => { admissions++; return { governedAdmissionMs: 1200 }; };
  for (const request of [undefined, "undeclared"] as const) {
    const row = await coldCacheRow(request, drop, admit);
    expect(row.available, "NO_COLD_ROW_WITHOUT_ISOLATED_OPT_IN").toBe(false);
    expect(row.available ? "" : row.reason).toMatch(request ? /did not declare itself isolated/ : /Not requested/);
  }
  expect([drops, admissions], "DEFAULT_NEVER_TOUCHES_THE_CACHE").toEqual([0, 0]);
  let now = 0;
  expect(await coldCacheRow("isolated", () => { drops++; now += 40; }, admit, () => now)).toEqual({ available: true, dropMs: 40, sample: { governedAdmissionMs: 1200 } });
  expect([drops, admissions], "ONE_DROP_THEN_ONE_ADMISSION").toEqual([1, 1]);
  const failed = await coldCacheRow("isolated", () => { throw Object.assign(Error("EACCES: permission denied, open '/proc/sys/vm/drop_caches'"), { code: "EACCES" }); }, admit);
  expect(failed, "FAILED_DROP_RUNS_NO_COLD_ADMISSION").toEqual({ available: false, reason: "Page cache drop failed (EACCES: permission denied, open '/proc/sys/vm/drop_caches'); no cold admission ran" });
  expect(admissions).toBe(1);
});

test("the host answers the container's one cache-drop request, and only that one (#4284)", async () => {
  const { requestHostCacheDrop, serveHostCacheDrop, COLD_CACHE_RESPONSE } = await import("../scripts/native-proof/observation-tree");
  const dir = mkdtempSync(join(tmpdir(), "ithaca-cold-"));
  try {
    let drops = 0;
    const host = serveHostCacheDrop(dir, () => { drops++; }, 5);
    try {
      await Bun.sleep(30);
      expect(drops, "NO_REQUEST_NO_DROP").toBe(0);
      await requestHostCacheDrop(dir, 5000, 5);
      expect(drops, "ONE_REQUEST_ONE_DROP").toBe(1);
      rmSync(join(dir, COLD_CACHE_RESPONSE));
      await expect(requestHostCacheDrop(dir, 100, 5), "A_SECOND_REQUEST_IS_NEVER_ANSWERED").rejects.toThrow("did not answer");
      expect(drops).toBe(1);
    } finally { host.stop(); }
    const refused = mkdtempSync(join(dir, "refused-"));
    const failing = serveHostCacheDrop(refused, () => { throw Error("sudo -n drop exited 1: a password is required"); }, 5);
    try { await expect(requestHostCacheDrop(refused, 5000, 5), "HOST_REFUSAL_REACHES_THE_ROW").rejects.toThrow("a password is required"); }
    finally { failing.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
