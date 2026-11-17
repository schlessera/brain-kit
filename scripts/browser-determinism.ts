/**
 * Repeats a change's added or modified Vitest browser, layout and story specs
 * under CPU load in the pinned container (#4163).
 *
 * The Bun gate (scripts/test-determinism.ts, #4109) repeats changed Bun test
 * files. These specs run in the pinned Playwright image instead, once, after
 * merge; a racy wait in one passes there and fails later on someone else's
 * merge. This command runs each changed spec several times before it merges,
 * in every project that includes it, while busy loops occupy the container's
 * CPUs.
 *
 *   bun scripts/browser-determinism.ts --base origin/main [--json]
 *   bun scripts/browser-determinism.ts rail-fine::packages/ui-react/tests/browser/a.pointer.tsx ...   # explicit pairs (hosted job)
 *
 * It enters the container through `scripts/visual.mjs`, so the image, mounts
 * and network are the browser suite's, and hands it a plan that
 * `scripts/browser-determinism-inside.mjs` runs: further passes of exactly the
 * selected project/file pairs in one Vitest process, with one burner per CPU
 * started inside the container. That file says what a further pass reruns and
 * what carries over, and why the burners run inside.
 *
 * Bounded: five repetitions by default, reduced uniformly to a floor of two
 * when the reviewed weights (scripts/browser-shard-costs.json) exceed the
 * budget. No selected pair is dropped; a pair without a weight is costed at a
 * stated default and the report says so. The count and the hosted partitions
 * are planned in scripts/browser-determinism-plan.ts: hosted CI splits a
 * selection too heavy for one job across partitions, and each partition runs
 * this command with its own pairs. A local `--base` run repeats the whole
 * selection in one invocation; `--cpu-list` confines the container's work and
 * its burners to a few CPUs of a shared host.
 * Policy: docs/decisions/ci-utility.md, "Changed browser specs repeat under load before merge".
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listBrowserSpecs } from "./browser-input-closure";
import { expandSpecs, pairKey, parsePairKey, planBrowserRepetitions, type BrowserRepetitionPlan, type PlanOptions, type SpecPair } from "./browser-determinism-plan";
import { RESULT_KIND as PASSES_KIND } from "./browser-determinism-inside.mjs";
import { browserDeterminismSpecs, changedFiles } from "./ci-plan";

export const REPORT_KIND = "brain-browser-determinism";
/** The gate's own Vitest configuration; `--config-root` names another only for the gate's fixtures. */
export const CONFIG_ROOT = "packages/ui-kit";
const PLAN_PATH = "tmp/browser-determinism/plan.json", PASSES_PATH = "tmp/browser-determinism/passes.json";

export interface Failure { file: string | null; project: string | null; repetition: number | null; test: string | null; reason: string; }
export interface Pass { repetition: number; elapsedSeconds: number; ok: boolean; }
export interface Report extends BrowserRepetitionPlan {
  kind: typeof REPORT_KIND; version: 1; base: string | null; configRoot: string;
  outcome: "passed" | "failed" | "none-selected";
  failure: Failure | null; alsoFailed: SpecPair[]; passes: Pass[];
  load: { burners: number; cpus: number | null; inside: "pinned container" }; elapsedSeconds: number; exitCode: number;
}

/** What the container side runs: exactly these pairs, this many passes, this load. */
export function passPlan(plan: BrowserRepetitionPlan, options: { configRoot?: string; burners?: number; cpuList?: string } = {}) {
  return { kind: PASSES_KIND, version: 1, root: options.configRoot ?? CONFIG_ROOT, result: PASSES_PATH,
    pairs: plan.pairs.map(({ project, file }) => ({ project, file })), repetitions: plan.repetitions,
    burners: options.burners ?? null, cpuList: options.cpuList ?? null };
}

/** The launcher's argv: the selected projects decide the container's network and native preparation, as for any browser run. */
export function launcherArgv(pairs: readonly SpecPair[]): string[] {
  return ["node", "scripts/visual.mjs", ...[...new Set(pairs.map(pair => pair.project))].sort().map(project => `--project=${project}`), `--repeat-plan=${PLAN_PATH}`];
}

interface PassesResult { kind?: unknown; version?: unknown; pairs?: unknown; repetitions?: unknown; passes?: unknown; failure?: unknown; alsoFailed?: unknown; load?: { burners?: unknown; cpus?: unknown } }

/**
 * The container's verdict, judged again on the host. A green run is evidence
 * only if the result names this plan's pairs and shows every repetition
 * passing; a missing, foreign or short result is a failure whatever the exit code.
 */
export function judge(plan: BrowserRepetitionPlan, result: PassesResult | undefined, exitCode: number): { failure: Failure | null; alsoFailed: SpecPair[]; passes: Pass[]; load: { burners: number; cpus: number | null } } {
  const none = { alsoFailed: [], passes: [], load: { burners: 0, cpus: null } };
  const anonymous = (reason: string): Failure => ({ file: null, project: null, repetition: null, test: null, reason });
  if (!result || result.kind !== PASSES_KIND || result.version !== 1 || !Array.isArray(result.passes) || !Array.isArray(result.pairs)) {
    return { ...none, failure: anonymous(`the pinned container exited ${exitCode} without a readable repetition result`) };
  }
  const passes = (result.passes as Pass[]).map(pass => ({ repetition: Number(pass.repetition), elapsedSeconds: Number(pass.elapsedSeconds), ok: pass.ok === true }));
  const load = { burners: Number(result.load?.burners ?? 0), cpus: Number.isSafeInteger(result.load?.cpus) ? Number(result.load!.cpus) : null };
  const alsoFailed = Array.isArray(result.alsoFailed) ? (result.alsoFailed as SpecPair[]).filter(pair => pair?.project && pair?.file).map(({ project, file }) => ({ project, file })) : [];
  const ran = JSON.stringify((result.pairs as SpecPair[]).map(pairKey).sort()), planned = JSON.stringify(plan.pairs.map(pairKey).sort());
  if (ran !== planned || result.repetitions !== plan.repetitions) return { passes, load, alsoFailed, failure: anonymous("the container's result names another selection or repetition count than this plan") };
  const reported = result.failure as Partial<Failure> | null | undefined;
  if (reported) {
    return { passes, load, alsoFailed, failure: { file: reported.file ?? null, project: reported.project ?? null,
      repetition: Number.isSafeInteger(reported.repetition) ? reported.repetition! : null, test: reported.test ?? null, reason: String(reported.reason ?? "a repetition failed") } };
  }
  const green = passes.filter(pass => pass.ok).length;
  if (passes.length !== plan.repetitions || green !== plan.repetitions || passes.some((pass, index) => pass.repetition !== index + 1)) {
    return { passes, load, alsoFailed, failure: anonymous(`ran ${green} of ${plan.repetitions} repetitions according to the container's result; a passing run must show every repetition`) };
  }
  if (exitCode !== 0) return { passes, load, alsoFailed, failure: anonymous(`the pinned container exited ${exitCode} after reporting every repetition green`) };
  return { passes, load, alsoFailed, failure: null };
}

export interface RunOptions extends PlanOptions {
  root: string; pairs: readonly SpecPair[]; base?: string | null; configRoot?: string; burners?: number; cpuList?: string;
  env?: Record<string, string | undefined>; log?: (line: string) => void;
  /** Starts the launcher and resolves with its exit code; the default inherits this process's output. */
  launch?: (argv: string[], cwd: string, env: Record<string, string | undefined>) => Promise<number>;
}

function describePlan(plan: BrowserRepetitionPlan, burners: number | undefined): string[] {
  const lines = [`Repeating ${plan.pairs.length} changed project/file pair(s) ${plan.repetitions} time(s) each in the pinned container under ` +
    `${burners === undefined ? "one CPU burner per CPU" : `${burners} CPU burner(s)`}: ${plan.weightSeconds.toFixed(1)} weighted s per pass, ` +
    `${plan.estimatedSeconds.toFixed(1)} s estimated, budget ${plan.budgetSeconds} s.`];
  if (plan.reduced) lines.push(`Reduced from ${plan.requested} to ${plan.repetitions} repetitions: ${plan.requested} would cost ` +
    `${(plan.weightSeconds * plan.requested).toFixed(1)} weighted s against the ${plan.budgetSeconds} s budget.`);
  if (plan.overBudget) lines.push(`Over budget at the floor of ${plan.floor}: every pair still runs ${plan.repetitions} times.`);
  for (const entry of plan.pairs) lines.push(`  ${entry.repetitions}x  ${entry.project}  ${entry.file} (${entry.weighted ? `weight ${entry.weightSeconds}s` : `no reviewed weight: costed at the ${plan.unweightedSeconds}s default`})`);
  return lines;
}

async function launchInherited(argv: string[], cwd: string, env: Record<string, string | undefined>): Promise<number> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  // The launcher forwards a signal to its container run; this process then reports the interruption.
  const listeners = signals.map(signal => () => { child.kill(signal); });
  signals.forEach((signal, index) => process.on(signal, listeners[index]!));
  try {
    const code = await child.exited;
    return child.signalCode ? 128 + (constants.signals[child.signalCode] ?? 0) : code;
  } finally { signals.forEach((signal, index) => process.off(signal, listeners[index]!)); }
}

/** Plans the selection, runs it in the pinned container and returns its report. */
export async function runBrowserDeterminism(options: RunOptions): Promise<Report> {
  const { root } = options, log = options.log ?? (line => console.error(line));
  const configRoot = options.configRoot ?? CONFIG_ROOT;
  const plan = planBrowserRepetitions(options.pairs, options);
  const base = { kind: REPORT_KIND as typeof REPORT_KIND, version: 1 as const, base: options.base ?? null, configRoot, ...plan };
  if (!plan.pairs.length) {
    log("No added or modified browser, layout or story spec: nothing to repeat.");
    return { ...base, outcome: "none-selected", failure: null, alsoFailed: [], passes: [], load: { burners: 0, cpus: null, inside: "pinned container" }, elapsedSeconds: 0, exitCode: 0 };
  }
  for (const line of describePlan(plan, options.burners)) log(line);
  mkdirSync(dirname(join(root, PLAN_PATH)), { recursive: true });
  rmSync(join(root, PASSES_PATH), { force: true });
  writeFileSync(join(root, PLAN_PATH), JSON.stringify(passPlan(plan, options), null, 2) + "\n");
  const started = performance.now();
  const exitCode = await (options.launch ?? launchInherited)(launcherArgv(plan.pairs), root, { ...process.env, ...options.env });
  const elapsedSeconds = (performance.now() - started) / 1000;
  let result: PassesResult | undefined;
  try { result = JSON.parse(readFileSync(join(root, PASSES_PATH), "utf8")); } catch {}
  const verdict = judge(plan, result, exitCode);
  const report: Report = { ...base, outcome: verdict.failure ? "failed" : "passed", failure: verdict.failure, alsoFailed: verdict.alsoFailed, passes: verdict.passes,
    load: { ...verdict.load, inside: "pinned container" }, elapsedSeconds, exitCode: verdict.failure ? (exitCode || 1) : 0 };
  const { failure } = report;
  if (failure) {
    log(`FAILED: ${failure.file ?? "unknown spec"} in project ${failure.project ?? "unknown"}, repetition ${failure.repetition ?? "unknown"} of ${plan.repetitions}` +
      `${failure.test ? `: ${JSON.stringify(failure.test)}` : ""} (${failure.reason}).`);
    log("A changed spec must pass every repetition. Fix the spec or what it exposes; a rerun is not a fix.");
  } else log(`Passed: ${plan.pairs.length} project/file pair(s), ${plan.repetitions} repetition(s) each, ${elapsedSeconds.toFixed(1)} s including the container start.`);
  return report;
}

/** A Markdown table for the hosted job summary: each pair with the repetitions it got. */
export function summaryMarkdown(report: Report): string {
  const lines = [`### Changed browser specs under CPU load: ${report.outcome}`, ""];
  if (report.outcome === "none-selected") return lines.concat("No added or modified browser, layout or story spec.", "").join("\n");
  lines.push(`${report.repetitions} of ${report.requested} requested repetitions per project/file pair, ${report.load.burners} burner(s) on ${report.load.cpus ?? "unknown"} CPU(s) inside the pinned container; ` +
    `${report.estimatedSeconds.toFixed(1)} weighted s estimated against a ${report.budgetSeconds} s budget${report.overBudget ? " (over budget at the floor)" : ""}; ` +
    `${report.elapsedSeconds.toFixed(1)} s elapsed.`, "");
  const { failure } = report;
  if (failure) lines.push(`**Failed:** \`${failure.file ?? "unknown spec"}\` in project \`${failure.project ?? "unknown"}\`, repetition ${failure.repetition ?? "unknown"}` +
    `${failure.test ? `, case \`${failure.test.replaceAll("`", "'")}\`` : ""} (${failure.reason.replaceAll("`", "'")}).`, "");
  lines.push("| Project | Spec | Reviewed weight (s) | Repetitions |", "| --- | --- | --- | --- |");
  for (const entry of report.pairs) lines.push(`| \`${entry.project}\` | \`${entry.file}\` | ${entry.weighted ? entry.weightSeconds : `none (${report.unweightedSeconds} default)`} | ${entry.repetitions} |`);
  if (report.passes.length) lines.push("", `Pass seconds: ${report.passes.map(pass => `${pass.elapsedSeconds.toFixed(1)}${pass.ok ? "" : " (failed)"}`).join(", ")}.`);
  return lines.concat("").join("\n");
}

const USAGE = "usage: bun scripts/browser-determinism.ts (--base <ref> | <project>::<spec file>...) [--json] [--report <path>] [--repetitions <n>] [--budget-seconds <n>] [--burners <n>] [--cpu-list <cpus>] [--config-root <dir>]";

export interface Arguments { base?: string; pairs: SpecPair[]; json: boolean; report?: string; repetitions?: number; budgetSeconds?: number; burners?: number; cpuList?: string; configRoot?: string; }

export function parseArguments(args: readonly string[]): Arguments {
  const parsed: Arguments = { pairs: [], json: false };
  const integer = (name: string, value: string | undefined, least: number) => {
    if (!value || !/^(?:0|[1-9]\d{0,6})$/.test(value) || Number(value) < least) throw new Error(`${name} needs an integer of at least ${least}\n${USAGE}`);
    return Number(value);
  };
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index]!.startsWith("--") ? args[index]!.split(/=(.*)/s, 2) as [string, string | undefined] : [args[index]!, undefined];
    const value = () => inline ?? args[++index];
    if (flag === "--json" && inline === undefined) parsed.json = true;
    else if (flag === "--base") { parsed.base = value(); if (!parsed.base) throw new Error(`--base needs a ref\n${USAGE}`); }
    else if (flag === "--report") { parsed.report = value(); if (!parsed.report) throw new Error(`--report needs a path\n${USAGE}`); }
    else if (flag === "--repetitions") parsed.repetitions = integer(flag, value(), 2);
    else if (flag === "--budget-seconds") parsed.budgetSeconds = integer(flag, value(), 1);
    // Zero burners is a diagnosis: the same passes without load.
    else if (flag === "--burners") parsed.burners = integer(flag, value(), 0);
    else if (flag === "--cpu-list") { parsed.cpuList = value(); if (!parsed.cpuList || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(parsed.cpuList)) throw new Error(`--cpu-list needs CPUs such as 0-3\n${USAGE}`); }
    else if (flag === "--config-root") { parsed.configRoot = value(); if (!parsed.configRoot || !/^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(parsed.configRoot) || parsed.configRoot.split("/").includes("..")) throw new Error(`--config-root needs a repository directory\n${USAGE}`); }
    else if (flag.startsWith("-")) throw new Error(`Unknown option ${flag}\n${USAGE}`);
    else { try { parsed.pairs.push(parsePairKey(flag)); } catch (error) { throw new Error(`${(error as Error).message}\n${USAGE}`); } }
  }
  if ((parsed.base === undefined) === (parsed.pairs.length === 0)) throw new Error(`Name either --base <ref> or the project/file pairs to repeat\n${USAGE}`);
  return parsed;
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const args = parseArguments(process.argv.slice(2));
    let pairs = args.pairs;
    if (args.base !== undefined) {
      const specs = browserDeterminismSpecs(root, changedFiles(root, args.base, "HEAD", true, true));
      pairs = specs.length ? expandSpecs(specs, listBrowserSpecs(root)) : [];
    }
    // The launcher takes the host admission slot and the workspace lease, as every browser run does.
    const report = await runBrowserDeterminism({ root, pairs, base: args.base ?? null, repetitions: args.repetitions, budgetSeconds: args.budgetSeconds,
      burners: args.burners, cpuList: args.cpuList, configRoot: args.configRoot,
      ...(args.json ? { launch: async (argv, cwd, env) => { const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: 2, stderr: "inherit" }); return await child.exited; } } : {}) });
    if (args.report) {
      mkdirSync(dirname(resolve(root, args.report)), { recursive: true });
      writeFileSync(resolve(root, args.report), JSON.stringify(report, null, 2) + "\n");
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(report));
    if (args.json) console.log(JSON.stringify(report));
    process.exit(report.exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
