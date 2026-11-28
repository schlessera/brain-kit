/** Complete affected hosted proof. Reuses the opt-in local command inventory. */
import { mergeBatchReports } from "./test";
import { validateUnitReports } from "./unit-proof-report";
import { offlineCommand } from "./offline-command";
import { DOCKER_TEST_FILES, isDockerTest } from "./docker-test-files";
import { requireCandidate, validateSelections } from "./candidate-proof";
import { cpus, freemem, totalmem } from "node:os";
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { localChecks, requireRuntimeTools } from "./check-pr";
import { runCommands, type Command } from "./ci-runner";
import type { CheckPlan } from "./ci-plan";
import { balanceTests, discoverTests } from "./test-shards";
import { planPartitions, repetitionsFor, selectPartition, type DeterminismPartition, type PartitionPlan } from "./determinism-plan";
import { browserRepetitionsFor, pairKey, planBrowserPartitions, selectBrowserPartition, type BrowserPartition, type BrowserPartitionPlan } from "./browser-determinism-plan";
import { resolveBrowserPin } from "./captures/provenance";
import { startUnitMemorySampler } from "./unit-memory";
import { diskSampler, floorProblem } from "./ci-disk";

export const PROOF_JOBS = ["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance", "determinism", "browser_determinism"] as const;
export const PROOF_CATEGORIES = ["unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance", "determinism", "browser_determinism"] as const;
export type ProofCategory = typeof PROOF_CATEGORIES[number];
export const DETERMINISM_REPORT = "tmp/determinism-report.json";
export const BROWSER_DETERMINISM_REPORT = "tmp/browser-determinism-report.json";
/** Bun tests that start the pinned image with `--pull=never`: a partition holding one pulls the image first. */
export const PINNED_IMAGE_TESTS = DOCKER_TEST_FILES;

/** One partition of the planner's added or modified Bun test files, at the count decided over the
 * whole selection (#4117). An empty selection is never a job (#4109), and a shard divisor that is
 * not the planned partition count is refused: a partition of some other split proves nothing. */
export function determinismPartition(plan: CheckPlan, shard = "1/1"): { selection: PartitionPlan; partition: DeterminismPartition } {
  if (!plan.determinism?.length) throw new Error("Repeated-run proof was not selected");
  const selection = planPartitions(plan.determinism, { cadence: plan.cadence });
  return { selection, partition: selectPartition(selection, shard) };
}

/** The files partition `shard` repeats: every selected file is in exactly one planned partition. */
export function determinismFiles(plan: CheckPlan, shard?: string): string[] {
  return [...determinismPartition(plan, shard).partition.files];
}

/** One partition of the planner's changed browser, layout and story spec pairs, at the count decided
 * over the whole selection (#4163). The Bun gate's rules: an empty selection is never a job, and a
 * shard divisor that is not the planned partition count is refused. */
export function browserDeterminismPartition(plan: CheckPlan, shard = "1/1"): { selection: BrowserPartitionPlan; partition: BrowserPartition } {
  if (!plan.browserDeterminism?.length) throw new Error("Repeated browser proof was not selected");
  const selection = planBrowserPartitions(plan.browserDeterminism, { cadence: plan.cadence });
  return { selection, partition: selectBrowserPartition(selection, shard) };
}

/** The `project::file` pairs partition `shard` repeats: every selected pair is in exactly one planned partition. */
export function browserDeterminismPairs(plan: CheckPlan, shard?: string): string[] {
  return browserDeterminismPartition(plan, shard).partition.pairs.map(pairKey);
}

/** Aggregate requires passed selected jobs; missing/false-looking output is not proof.
 * Every selected category runs fresh: a skipped selected job never passes (#4107). */
export function proofProblems(needs: Record<string, { result?: string; outputs?: Record<string, string> }>): string[] {
  const problems: string[] = [];
  if (needs.changeset?.result !== "success") problems.push("metadata did not pass");
  for (const name of PROOF_JOBS) {
    const selected = needs.changeset?.outputs?.[name];
    const result = needs[name]?.result;
    if (selected !== "true" && selected !== "false") problems.push(`${name}: selection output is missing or invalid`);
    else if (selected === "true" && result !== "success") problems.push(`${name}: selected proof did not pass (${result ?? "missing"})`);
    else if (selected === "false" && result !== "skipped") problems.push(`${name}: unselected job must be intentionally skipped (${result ?? "missing"})`);
  }
  return problems;
}

/** Complete discovery expands unknown/global inputs; root tooling tests accompany package changes. */
export function unitFiles(plan: CheckPlan, root: string, shard = "1/1"): string[] {
  if (!plan.local.fullTests) throw new Error("Unit proof was not selected");
  const roots = plan.global ? ["packages", "tests"] : ["tests", ...plan.affected.map(dir => `packages/${dir}`)];
  const discovered = discoverTests(root, !plan.global && plan.unitTests ? ["packages", "tests"] : roots);
  const files = !plan.global && plan.unitTests ? plan.unitTests : discovered;
  if (files.some(file => !discovered.includes(file)) || new Set(files).size !== files.length) throw new Error("Invalid selected unit inventory");
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error("Expected proof --shard=M/N");
  const index = Number(match[1]), total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) throw new Error("Invalid proof shard");
  return balanceTests(files, total)[index - 1]!;
}

export function categoryCommands(category: ProofCategory, plan: CheckPlan, root: string, shard?: string, unitWorkers = 2, dockerDrivers = false): Command[] {
  if (![1, 2].includes(unitWorkers)) throw new Error("Unit worker measurement supports 1 or 2 workers");
  const inventory = localChecks(plan, true);
  const selected = (files: readonly string[]) => files.filter(file => isDockerTest(file, root) === dockerDrivers);
  if ((category === "unit" || category === "determinism") && !selected(category === "unit" ? unitFiles(plan, root, shard) : determinismFiles(plan, shard)).length) return [];
  if (category === "unit") return [{ name: "complete affected unit and integration suite", argv: unitWorkers === 2 && !dockerDrivers
    ? [process.execPath, join(root, "scripts/unit-workers.ts"), ...selected(unitFiles(plan, root, shard)).map(file => join(root, file))]
    : [process.execPath, "run", "test", ...selected(unitFiles(plan, root, shard)).map(file => join(root, file)),
      "--reporter=junit", "--reporter-outfile=tmp/unit-report.xml", "--timings=tmp/unit-timings.json", "--update-timings"],
    env: { BRAIN_REQUIRE_CHROME: "1" } }];
  // The unit job's serial form, repeated: changed files may drive real Chrome too.
  if (category === "determinism") {
    const { selection, partition } = determinismPartition(plan, shard);
    // An unsplit selection keeps its command. A partition of a split one names the selection's
    // count: the runner would otherwise plan its lighter subset for more repetitions (#4117).
    const repetitions = selection.partitions.length > 1 ? selection.repetitions : repetitionsFor(plan.cadence);
    return [{ name: "changed Bun test files repeated under CPU load",
      argv: [process.execPath, join(root, "scripts/test-determinism.ts"), `--report=${DETERMINISM_REPORT}`,
        ...(repetitions === undefined ? [] : [`--repetitions=${repetitions}`]), ...selected(partition.files)],
      env: { BRAIN_REQUIRE_CHROME: "1" } }];
  }
  // The pinned container, entered as `browser` and `layout` enter it. As for the Bun gate, an unsplit
  // selection keeps its command and a partition of a split one names the selection's count.
  if (category === "browser_determinism") {
    const { selection, partition } = browserDeterminismPartition(plan, shard);
    const repetitions = selection.partitions.length > 1 ? selection.repetitions : browserRepetitionsFor(plan.cadence);
    return [{ name: "workspace build for real browser checks", argv: [process.execPath, "run", "build", "--jobs=2"] },
      { name: "changed Vitest specs repeated under CPU load in the pinned container",
        argv: [process.execPath, join(root, "scripts/browser-determinism.ts"), `--report=${BROWSER_DETERMINISM_REPORT}`,
          ...(repetitions === undefined ? [] : [`--repetitions=${repetitions}`]), ...partition.pairs.map(pairKey)] }];
  }
  const names: Record<Exclude<ProofCategory, "unit" | "determinism" | "browser_determinism">, string[]> = {
    browser: ["workspace build for real browser checks", "complete pinned visual/accessibility/pointer suite"],
    layout: ["workspace build for real browser checks", "complete pinned layout/offline suite"],
    endurance: ["workspace build for real browser checks", "complete pinned endurance suite"],
    captures: ["editorial provenance and reproducibility"],
    runtime: ["measure-claude-runtime", "measure-claude-enforcement", "native delegation, capabilities and measurement isolation", "shared-process Chrome then child cleanup"],
    runtime_host: ["native managed hosted admission", "native separate-UID worker identity", "native reference pool allocation"],
  };
  const checks = inventory.filter(command => names[category].includes(command.name));
  if (checks.length !== names[category].length) throw new Error(`${category}: incomplete command inventory`);
  if (category === "captures") checks.unshift({ name: "pinned capture fonts and original notices", argv: [process.execPath, "run", "capture:fonts"] });
  if (category === "browser" || category === "layout" || category === "endurance") {
    checks.find(command => command.name === "workspace build for real browser checks")!.argv.push("--jobs=2");
    checks.at(-1)!.argv.push("--proof-report");
  }
  if (shard && (category === "browser" || category === "layout")) checks.at(-1)!.argv.push(`--shard=${shard}`);
  return checks;
}

/** The dedicated driver step runs first; the ordinary step publishes the union. */
export async function completeUnitReport(root: string, files: string[], checkout: { sha: string; tree: string; parents: string[] }, shard: string | undefined, dockerDrivers: boolean) {
  const drivers = files.filter(file => isDockerTest(file, root));
  const reportArgv = (prefix = "") => ["--reporter-outfile", join(root, "tmp", prefix + "unit-report.xml"), "--timings", join(root, "tmp", prefix + "unit-timings.json")];
  if (dockerDrivers) {
    const report = validateUnitReports(drivers, await Bun.file(reportArgv()[1]!).text(), await Bun.file(reportArgv()[3]!).json());
    for (const name of ["unit-report.xml", "unit-timings.json"]) copyFileSync(join(root, "tmp", name), join(root, "tmp", `docker-driver-${name}`));
    copyFileSync(join(root, "tmp/proof-checkout.json"), join(root, "tmp/docker-driver-proof-checkout.json"));
    return report;
  }
  if (drivers.length) {
    const receipt = await Bun.file(join(root, "tmp/docker-driver-proof-checkout.json")).json();
    if (receipt.category !== "unit" || JSON.stringify(receipt.checkout) !== JSON.stringify(checkout) || receipt.shard !== shard ||
        JSON.stringify([...receipt.files].sort()) !== JSON.stringify([...files].sort())) throw new Error("Docker driver proof identity differs");
    await mergeBatchReports(reportArgv(), [
      ...(files.length > drivers.length ? [{ argv: reportArgv() }] : []), { argv: reportArgv("docker-driver-") },
    ]);
  }
  return validateUnitReports(files, await Bun.file(reportArgv()[1]!).text(), await Bun.file(reportArgv()[3]!).json());
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "aggregate") {
      const needs = JSON.parse(process.env.PROOF_NEEDS ?? "null");
      const root = resolve(import.meta.dir, "..");
      const event = process.env.GITHUB_EVENT_PATH ? await Bun.file(process.env.GITHUB_EVENT_PATH).json() : {};
      await requireCandidate(root, event, process.env);
      if (process.env.GITHUB_ACTIONS === "true") validateSelections(root, event, process.env, needs?.changeset?.outputs);
      const problems = proofProblems(needs);
      if (problems.length) throw new Error(problems.join("\n"));
      // `retained` is always empty since proof retention was retired (#4107). The field stays so
      // a checkout that predates the retirement, and the timing collector reading older runs,
      // still parse this receipt.
      console.log(`BRAIN_SELECTED_PROOF_RECEIPT ${JSON.stringify({ selections: Object.fromEntries(PROOF_JOBS.map(name => [name, needs.changeset.outputs[name]])), results: Object.fromEntries(PROOF_JOBS.map(name => [name, needs[name]?.result])), retained: [], unitShards: needs.changeset.outputs.unit_shards ?? null, determinismShards: needs.changeset.outputs.determinism_shards ?? null, browserDeterminismShards: needs.changeset.outputs.browser_determinism_shards ?? null })}`);
      console.log("All selected hosted proof passed; remaining skips are planner-intended.");
    } else {
      const root = resolve(import.meta.dir, "..");
      const category = process.argv[2] as ProofCategory;
      if (!PROOF_CATEGORIES.includes(category)) throw new Error("Unknown proof category");
      const args = process.argv.slice(3);
      const dockerDrivers = args.includes("--docker-drivers");
      if (dockerDrivers && category !== "unit" && category !== "determinism") throw new Error("Docker drivers require unit or determinism");
      const shardArg = args.find(arg => arg.startsWith("--shard="));
      const workersArg = args.find(arg => arg.startsWith("--workers="));
      if (args.length !== Number(Boolean(shardArg)) + Number(Boolean(workersArg)) + Number(dockerDrivers) ||
          (workersArg && (category !== "unit" || !/^--workers=[12]$/.test(workersArg)))) throw new Error("Unexpected proof argument");
      const shard = shardArg?.slice("--shard=".length);
      const unitWorkers = workersArg ? Number(workersArg.slice("--workers=".length)) : 2;
      const plan = await Bun.file(process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json")).json() as CheckPlan;
      const identity = Bun.spawnSync(["git", "show", "-s", "--format=%H %T %P", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (identity.exitCode !== 0) throw new Error("Cannot record actual proof checkout");
      const [sha, tree, ...parents] = new TextDecoder().decode(identity.stdout).trim().split(" ");
      await Bun.write(join(root, "tmp/proof-checkout.json"), JSON.stringify({ category, shard,
        checkout: { sha, tree, parents }, plan, files: category === "unit" ? unitFiles(plan, root, shard) : category === "determinism" ? determinismFiles(plan, shard) :
          category === "browser_determinism" ? browserDeterminismPairs(plan, shard) : undefined }, null, 2));
      const native = category === "unit" || category === "runtime" || category === "runtime_host" || category === "determinism";
      const chrome = requireRuntimeTools({ ...plan, local: { ...plan.local, fullTests: native,
        browser: !native, layout: !native, captures: !native } });
      if (chrome && (category === "unit" || category === "determinism")) await runCommands([{ name: "first real Chrome launch and render",
        argv: offlineCommand([process.execPath, "--no-env-file", "packages/ui-render-puppeteer/tests/cold-start.ts", chrome], true) }], root);
      const commands = categoryCommands(category, plan, root, shard, unitWorkers, dockerDrivers).map(command => ({ ...command,
        env: { ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}), ...command.env } }));
      // The host/container lease regression deliberately uses --pull=never
      // under the offline test harness. Prepare its actual pinned image once,
      // only on the partition that discovers that test, before entering tests.
      // The browser repetition gate's own container test starts the same image the same way (#4163).
      const selectedFiles = category === "unit" ? unitFiles(plan, root, shard) : category === "determinism" ? determinismFiles(plan, shard) : [];
      if (dockerDrivers && PINNED_IMAGE_TESTS.some(file => selectedFiles.includes(file))) {
        if (!Bun.which("docker")) throw new Error("The pinned-container tests require Docker");
        const { image } = await resolveBrowserPin(root);
        commands.unshift({ name: "pinned offline workspace lease container prerequisite", argv: ["docker", "pull", image], env: {} });
      }
      if (category === "determinism") {
        const { selection, partition } = determinismPartition(plan, shard);
        if (selection.partitions.length > 1) console.log(`Partition ${shard} of a selection split by reviewed weight: ${selection.files.length} file(s), ` +
          `${selection.weightSeconds.toFixed(1)} weighted s per pass, ${selection.repetitions} repetition(s) each (${selection.requested} requested); ` +
          `this partition repeats ${partition.files.length} file(s), ${partition.estimatedSeconds.toFixed(1)} s estimated against a capacity of ${selection.capacitySeconds} s` +
          `${partition.estimatedSeconds > selection.capacitySeconds ? " (one file that cannot be split)" : ""}.`);
      }
      if (category === "browser_determinism") {
        const { selection, partition } = browserDeterminismPartition(plan, shard);
        if (selection.partitions.length > 1) console.log(`Partition ${shard} of a selection split by reviewed weight: ${selection.pairs.length} project/file pair(s), ` +
          `${selection.weightSeconds.toFixed(1)} weighted s per pass, ${selection.repetitions} repetition(s) each (${selection.requested} requested); ` +
          `this partition repeats ${partition.pairs.length} pair(s), ${partition.estimatedSeconds.toFixed(1)} s estimated against a capacity of ${selection.capacitySeconds} s` +
          `${partition.estimatedSeconds > selection.capacitySeconds ? " (one pair that cannot be split)" : ""}.`);
      }
      const started = performance.now();
      const cpu = () => cpus().reduce((sum, core) => sum + core.times.user + core.times.nice + core.times.sys + core.times.irq, 0) / 1000;
      const cpuStart = cpu();
      let samples = 0, peakUsedBytes = 0;
      const sample = () => {
        const available = process.platform === "linux" ? Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) * 1024 : freemem();
        if (!Number.isFinite(available)) return;
        samples++; peakUsedBytes = Math.max(peakUsedBytes, totalmem() - available);
      };
      // Turn fixtures keep their brains under the proof's TMPDIR (#3256).
      const disk = diskSampler();
      sample(); const sampler = setInterval(() => { sample(); disk.sample(); }, 1000);
      const unitMemory = category === "unit" ? await startUnitMemorySampler(join(root, "tmp/unit-memory.jsonl"), 10_000, true) : undefined;
      const phases: { name: string; elapsedSeconds: number; success: boolean }[] = [];
      try {
        for (const command of commands) {
          const start = performance.now(); let success = false;
          try { await runCommands([command], root, 1); success = true; }
          finally { phases.push({ name: command.name, elapsedSeconds: (performance.now() - start) / 1000, success }); }
        }
      } finally {
        clearInterval(sampler); sample(); disk.sample();
        const resources = { category, shard, checkout: { sha, tree, parents },
          elapsedSeconds: (performance.now() - started) / 1000, phases,
          machine: { logicalCpus: cpus().length, totalBytes: totalmem(), sampledPeakUsedBytes: peakUsedBytes,
            activeCpuSeconds: cpu() - cpuStart, samples, samplingSeconds: 1 },
          disk: disk.summary(),
          scope: "VM-wide during proof commands, including container work; setup/install and queue are measured separately by job steps. Sampling is not an exact process peak." };
        await Bun.write(join(root, "tmp/proof-resources.json"), JSON.stringify(resources, null, 2));
        console.log(`BRAIN_RESOURCE_RECEIPT ${JSON.stringify(resources)}`);
        const lowDisk = floorProblem(resources.disk.path, resources.disk.minimumAvailableBytes, resources.disk.floorBytes);
        if (lowDisk) {
          console.error(`::error title=Runner disk below the turn-fixture floor::${lowDisk}`);
          if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Infrastructure: ${lowDisk}\n`);
        }
        await unitMemory?.stop();
      }
      if (dockerDrivers && commands.length && category === "determinism") {
        for (const name of ["determinism-report.json", "determinism-junit.xml"]) {
          copyFileSync(join(root, "tmp", name), join(root, "tmp", `docker-driver-${name}`));
        }
      }
      if (category === "unit" && (commands.length || (!dockerDrivers && unitFiles(plan, root, shard).length))) {
        const report = await completeUnitReport(root, unitFiles(plan, root, shard), { sha, tree, parents }, shard, dockerDrivers);
        await Bun.write(join(root, "tmp/unit-report-summary.json"), JSON.stringify({ checkout: { sha, tree, parents }, shard, unitWorkers, ...report }, null, 2));
      }
    }
  } catch (error) { console.error(error); process.exit(1); }
}
