import {logWorkerAuditDiagnostic} from "./browser-worker-audit";
/** Complete affected hosted proof. Reuses the opt-in local command inventory. */
import { requireCandidate, validateSelections } from "./candidate-proof";
import { cpus, freemem, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { localChecks, requireRuntimeTools } from "./check-pr";
import { runCommands, type Command } from "./ci-runner";
import type { CheckPlan } from "./ci-plan";
import { balanceTests, discoverTests } from "./test-shards";
import { resolveBrowserPin } from "./captures/provenance";
import { diagramInstallationIdentity } from "./diagram-export-installation.mjs";
import { diagramProducerRuntime } from "./diagram-export-producer.mjs";
import { browserInventory, checkout, git, proofInputs, runnerIdentity, type Reusable, type Inputs } from "./proof-inputs";
import { contextFromEvent, GitHubProofAPI, RECEIPT_MARKER, retainedCategories } from "./proof-reuse";

export const PROOF_JOBS = ["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"] as const;
export type ProofCategory = "unit" | "browser" | "layout" | "captures" | "runtime" | "runtime_host" | "endurance";

/** Aggregate requires passed selected jobs; missing/false-looking output is not proof. */
export function proofProblems(needs: Record<string, { result?: string; outputs?: Record<string, string> }>, retained: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  if (needs.changeset?.result !== "success") problems.push("metadata did not pass");
  for (const name of PROOF_JOBS) {
    const selected = needs.changeset?.outputs?.[name];
    const result = needs[name]?.result;
    if (selected !== "true" && selected !== "false") problems.push(`${name}: selection output is missing or invalid`);
    else if (selected === "true" && retained.has(name) && result !== "skipped") problems.push(`${name}: retained proof must skip fresh execution (${result ?? "missing"})`);
    else if (selected === "true" && result !== "success" && !(result === "skipped" && retained.has(name))) problems.push(`${name}: selected proof did not pass (${result ?? "missing"})`);
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

export function categoryCommands(category: ProofCategory, plan: CheckPlan, root: string, shard?: string, unitWorkers = 2): Command[] {
  if (![1, 2].includes(unitWorkers)) throw new Error("Unit worker measurement supports 1 or 2 workers");
  const inventory = localChecks(plan, true);
  if (category === "unit") return [{ name: "complete affected unit and integration suite", argv: unitWorkers === 2
    ? [process.execPath, join(root, "scripts/unit-workers.ts"), ...unitFiles(plan, root, shard).map(file => join(root, file))]
    : [process.execPath, "run", "test", ...unitFiles(plan, root, shard).map(file => join(root, file)),
      "--reporter=junit", "--reporter-outfile=tmp/unit-report.xml", "--timings=tmp/unit-timings.json", "--update-timings"],
    env: { BRAIN_REQUIRE_CHROME: "1" } }];
  const names: Record<Exclude<ProofCategory, "unit">, string[]> = {
    browser: ["workspace build for real browser checks", "complete pinned visual/accessibility/pointer suite"],
    layout: ["workspace build for real browser checks", "complete pinned layout/offline suite"],
    endurance: ["workspace build for real browser checks", "complete pinned endurance suite"],
    captures: ["editorial provenance and reproducibility"],
    runtime: ["measure-claude-runtime", "measure-claude-enforcement", "native delegation, capabilities and measurement isolation", "shared-process Chrome then child cleanup"],
    runtime_host: ["native managed hosted admission", "native separate-UID worker identity"],
  };
  const selected = inventory.filter(command => names[category].includes(command.name));
  if (selected.length !== names[category].length) throw new Error(`${category}: incomplete command inventory`);
  if (category === "captures") selected.unshift({ name: "pinned capture fonts and original notices", argv: [process.execPath, "run", "capture:fonts"] });
  if (category === "browser" || category === "layout" || category === "endurance") {
    selected.find(command => command.name === "workspace build for real browser checks")!.argv.push("--jobs=2");
    selected.at(-1)!.argv.push("--proof-report");
  }
  if (shard && (category === "browser" || category === "layout")) selected.at(-1)!.argv.push(`--shard=${shard}`);
  return selected;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "aggregate") {
      const needs = JSON.parse(process.env.PROOF_NEEDS ?? "null");
      const root = resolve(import.meta.dir, "..");
      const event = process.env.GITHUB_EVENT_PATH ? await Bun.file(process.env.GITHUB_EVENT_PATH).json() : {};
      if (process.env.GITHUB_ACTIONS === "true") validateSelections(root, event, process.env, needs?.changeset?.outputs);
      await requireCandidate(root, event, process.env);
      const context = contextFromEvent(event, process.env);
      const value = needs?.changeset?.outputs?.reuse;
      const retained = value ? await retainedCategories(root, JSON.parse(value), context,
        context && process.env.GH_TOKEN ? new GitHubProofAPI(context.repository, process.env.GH_TOKEN) : undefined) : new Set<string>();
      if (process.env.GITHUB_ACTIONS === "true" && !value) throw new Error("Missing current-head proof ledger");
      for (const category of retained) if (needs?.changeset?.outputs?.[category] !== "true") throw new Error("Retained proof was not selected");
      const problems = proofProblems(needs, retained);
      if (problems.length) throw new Error(problems.join("\n"));
      for (const category of retained) console.log(`Validated equivalent ${category} proof; original run/job/checkout identity remains in the ledger.`);
      console.log("All selected hosted proof passed; remaining skips are planner-intended.");
    } else {
      const root = resolve(import.meta.dir, "..");
      const category = process.argv[2] as ProofCategory;
      if (!["unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"].includes(category)) throw new Error("Unknown proof category");
      const args = process.argv.slice(3);
      const shardArg = args.find(arg => arg.startsWith("--shard="));
      const workersArg = args.find(arg => arg.startsWith("--workers="));
      if (args.length !== Number(Boolean(shardArg)) + Number(Boolean(workersArg)) ||
          (workersArg && (category !== "unit" || !/^--workers=[12]$/.test(workersArg)))) throw new Error("Unexpected proof argument");
      const shard = shardArg?.slice("--shard=".length);
      const unitWorkers = workersArg ? Number(workersArg.slice("--workers=".length)) : 2;
      const plan = await Bun.file(process.env.CI_PLAN_PATH ?? join(root, "tmp/ci-plan.json")).json() as CheckPlan;
      let inputs:Inputs|undefined;
      if (category === "browser" || category === "layout") {
        try {
          if (git(root, "diff", "HEAD", "--").trim()) throw new Error("Dirty tracked inputs");
          inputs = proofInputs(root, category as Reusable, await browserInventory(root), runnerIdentity());
        } catch (error) { logWorkerAuditDiagnostic(error); console.log(`Fresh execution remains required: reusable input inventory is unavailable: ${String(error)}`); }
      }
      const identity = Bun.spawnSync(["git", "show", "-s", "--format=%H %T %P", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (identity.exitCode !== 0) throw new Error("Cannot record actual proof checkout");
      const [sha, tree, ...parents] = new TextDecoder().decode(identity.stdout).trim().split(" ");
      await Bun.write(join(root, "tmp/proof-checkout.json"), JSON.stringify({ category, shard,
        checkout: { sha, tree, parents }, plan, inputs, files: category === "unit" ? unitFiles(plan, root, shard) : undefined }, null, 2));
      const native = category === "unit" || category === "runtime" || category === "runtime_host";
      const chrome = requireRuntimeTools({ ...plan, local: { ...plan.local, fullTests: native,
        browser: !native, layout: !native, captures: !native } });
      if (chrome && category === "unit") await runCommands([{ name: "first real Chrome launch and render",
        argv: [process.execPath, "packages/ui-render-puppeteer/tests/cold-start.ts", chrome] }], root);
      const commands = categoryCommands(category, plan, root, shard, unitWorkers).map(command => ({ ...command,
        env: { ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}), ...command.env, ...(inputs?.nativeDiagram?{BRAIN_PROOF_NATIVE_DIAGRAM_INPUTS:JSON.stringify(inputs.nativeDiagram)}:{}) } }));
      // The host/container lease regression deliberately uses --pull=never
      // under the offline test harness. Prepare its actual pinned image once,
      // only on the partition that discovers that test, before entering tests.
      if (category === "unit" && unitFiles(plan, root, shard).includes("tests/workspace-lease.test.ts")) {
        if (!Bun.which("docker")) throw new Error("The native workspace lease test requires Docker");
        const { image } = await resolveBrowserPin(root);
        commands.unshift({ name: "pinned offline workspace lease container prerequisite", argv: ["docker", "pull", image], env: {} });
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
      sample(); const sampler = setInterval(sample, 1000);
      const phases: { name: string; elapsedSeconds: number; success: boolean }[] = [];
      try {
        for (const command of commands) {
          const start = performance.now(); let success = false;
          try { await runCommands([command], root, 1); success = true; }
          finally { phases.push({ name: command.name, elapsedSeconds: (performance.now() - start) / 1000, success }); }
        }
      } finally {
        clearInterval(sampler); sample();
        const resources = { category, shard, checkout: { sha, tree, parents },
          elapsedSeconds: (performance.now() - started) / 1000, phases,
          machine: { logicalCpus: cpus().length, totalBytes: totalmem(), sampledPeakUsedBytes: peakUsedBytes,
            activeCpuSeconds: cpu() - cpuStart, samples, samplingSeconds: 1 },
          scope: "VM-wide during proof commands, including container work; setup/install and queue are measured separately by job steps. Sampling is not an exact process peak." };
        await Bun.write(join(root, "tmp/proof-resources.json"), JSON.stringify(resources, null, 2));
        console.log(`BRAIN_RESOURCE_RECEIPT ${JSON.stringify(resources)}`);
      }
      if (category === "unit") {
        const { validateUnitReports } = await import("./unit-proof-report");
        const report = validateUnitReports(unitFiles(plan, root, shard),
          await Bun.file(join(root, "tmp/unit-report.xml")).text(), await Bun.file(join(root, "tmp/unit-timings.json")).json());
        await Bun.write(join(root, "tmp/unit-report-summary.json"), JSON.stringify({ checkout: { sha, tree, parents }, shard, unitWorkers, ...report }, null, 2));
      }
      if (inputs) {
        if(inputs.nativeDiagram&&(diagramInstallationIdentity(root).sha256!==inputs.nativeDiagram.installation||diagramProducerRuntime().sha256!==inputs.nativeDiagram.runtime))throw Error("Native diagram installed or runtime inputs changed during reusable execution");
        if (git(root, "diff", "HEAD", "--").trim()) throw new Error("Reusable execution changed tracked inputs");
        console.log(RECEIPT_MARKER + JSON.stringify({ version: 1, category, shard, checkout: checkout(root), inputs }));
      }
    }
  } catch (error) { console.error(error); process.exit(1); }
}
