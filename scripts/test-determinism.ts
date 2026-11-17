/**
 * Repeats a change's added or modified Bun test files under CPU load (#4109).
 *
 * Most red-main incidents were cleared by changing only a test: a racy wait, an
 * unpinned clock, a deadline a loaded shard missed. Such a test passes once and
 * fails later on someone else's merge. This command runs each changed file
 * several times before it merges, while busy loops occupy the CPUs.
 *
 *   bun scripts/test-determinism.ts --base origin/main [--json]
 *   bun scripts/test-determinism.ts tests/a.test.ts ...   # an explicit selection (hosted job)
 *
 * The files run in one invocation of the offline wrapper (`bun run test`,
 * scripts/test.ts), so its preload, lease and single preparation build apply,
 * with Bun's `--rerun-each=<n> --bail=1`. Verified against Bun 1.4.2: each file
 * runs n times in a row in one process, its module is evaluated again for each
 * run, `globalThis` and process state persist between runs, and a run with
 * output is headed `<file>: (run #k)` on stderr. Under GitHub Actions the same
 * header opens a log group, `::group::<file>: (run #k)`. A file that leaks
 * state into its next run therefore fails here too.
 *
 * Bounded: five repetitions by default, reduced uniformly to a floor of two
 * when the reviewed weights (scripts/test-shard-costs.json) exceed the budget.
 * No selected file is dropped; the report lists each with its repetitions.
 * Policy: docs/decisions/ci-utility.md, "Changed tests repeat under load before merge".
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { changedFiles, determinismTests } from "./ci-plan";
import { ensureHostAdmission } from "./host-admission.mjs";
import { discoverTests, FILE_COST_SECONDS } from "./test-shards";

export const DEFAULT_REPETITIONS = 5;
export const FLOOR_REPETITIONS = 2;
/** Total reviewed-weight seconds the repetitions may cost before they are reduced. */
export const BUDGET_SECONDS = 600;
/** A file without a reviewed weight costs the small-file default (scripts/test-shards.ts). */
const UNWEIGHTED_SECONDS = 0.1;
/** A burner outlives its parent by one slice at most, and never this long. */
const BURNER_LIFETIME_MS = 2 * 60 * 60_000, BURNER_SLICE_MS = 200;
export const REPORT_KIND = "brain-test-determinism";
const JUNIT_PATH = "tmp/determinism-junit.xml";

export interface FileRepetitions { file: string; weightSeconds: number; weighted: boolean; repetitions: number; observed?: number; }
export interface RepetitionPlan {
  requested: number; floor: number; repetitions: number; reduced: boolean;
  budgetSeconds: number; weightSeconds: number; estimatedSeconds: number; overBudget: boolean;
  files: FileRepetitions[];
}
export interface Failure { file: string | null; repetition: number | null; test: string | null; reason: string; }
export interface Report extends RepetitionPlan {
  kind: typeof REPORT_KIND; version: 1; base: string | null;
  outcome: "passed" | "failed" | "none-selected";
  failure: Failure | null; load: { burners: number; cpus: number }; elapsedSeconds: number; exitCode: number;
}

/**
 * The same count for every file: the most repetitions that fit the budget,
 * never more than requested and never fewer than the floor. A selection too
 * heavy for the floor still runs at the floor and is reported over budget.
 */
export function planRepetitions(files: readonly string[], options: { repetitions?: number; floor?: number; budgetSeconds?: number;
  costs?: Readonly<Record<string, number>> } = {}): RepetitionPlan {
  const requested = options.repetitions ?? DEFAULT_REPETITIONS, floor = options.floor ?? FLOOR_REPETITIONS;
  const budgetSeconds = options.budgetSeconds ?? BUDGET_SECONDS, costs = options.costs ?? FILE_COST_SECONDS;
  if (!Number.isSafeInteger(floor) || floor < 2) throw new Error("The repetition floor is at least two: one run proves nothing about the next");
  if (!Number.isSafeInteger(requested) || requested < floor) throw new Error(`Repetitions must be an integer of at least ${floor}`);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error("The time budget must be positive seconds");
  if (new Set(files).size !== files.length) throw new Error("A test file was selected twice");
  const weights = files.map(file => {
    const weighted = Object.hasOwn(costs, file), weightSeconds = weighted ? costs[file]! : UNWEIGHTED_SECONDS;
    if (!Number.isFinite(weightSeconds) || weightSeconds <= 0) throw new Error(`Test file costs must be positive finite seconds: ${file}`);
    return { file, weightSeconds, weighted };
  });
  const weightSeconds = weights.reduce((sum, entry) => sum + entry.weightSeconds, 0);
  const fit = weightSeconds > 0 ? Math.floor(budgetSeconds / weightSeconds) : requested;
  const repetitions = Math.max(floor, Math.min(requested, fit));
  const estimatedSeconds = weightSeconds * repetitions;
  return { requested, floor, repetitions, reduced: repetitions < requested, budgetSeconds, weightSeconds, estimatedSeconds,
    overBudget: estimatedSeconds > budgetSeconds, files: weights.map(entry => ({ ...entry, repetitions })) };
}

/** The wrapper's argv: one invocation, so preparation builds once for every repetition. */
export function repetitionArgv(files: readonly string[], repetitions: number): string[] {
  return [process.execPath, "run", "test", `--rerun-each=${repetitions}`, "--bail=1",
    "--reporter=junit", `--reporter-outfile=${JUNIT_PATH}`, ...files.map(file => `./${file}`)];
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The first failure in the wrapper's stderr: Bun heads a run's output with
 * `<file>: (run #k)`, as a `::group::` annotation under GitHub Actions, and
 * reports the case as `(fail) <name> [<time>]`. A failure with no case line
 * (a load error, a crash, a killed process) still names the last file and run
 * that produced output.
 */
export function firstFailure(stderr: string, files: readonly string[], root: string): Omit<Failure, "reason"> {
  const selected = new Map(files.map(file => [resolve(root, file), file]));
  let file: string | null = null, repetition: number | null = null;
  for (const line of plain(stderr).split("\n")) {
    const header = /^(?:::group::)?(.+?):(?: \(run #(\d+)\))?\s*$/.exec(line);
    const named = header && selected.get(resolve(root, header[1]!));
    if (named) { file = named; repetition = Number(header![2] ?? 1); continue; }
    const failed = /^\(fail\) (.*?)(?: \[[^\]]*\])?\s*$/.exec(line);
    if (failed) return { file, repetition, test: failed[1]! };
  }
  return { file, repetition, test: null };
}

/**
 * Repetitions each file really ran, from Bun's JUnit report: a case that
 * appears once per run appears that many times in its file's suite. A file
 * that reported no case at all counts zero.
 */
export function observedRepetitions(junit: string, files: readonly string[]): Map<string, number> {
  const counts = new Map<string, Map<string, number>>(files.map(file => [file, new Map()]));
  for (const match of junit.matchAll(/<testcase\b([^>]*)>/g)) {
    const attribute = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(match[1]!)?.[1] ?? "";
    const cases = counts.get(attribute("file"));
    if (!cases) continue;
    const key = `${attribute("classname")}\n${attribute("name")}\n${attribute("line")}`;
    cases.set(key, (cases.get(key) ?? 0) + 1);
  }
  return new Map([...counts].map(([file, cases]) => [file, cases.size ? Math.min(...cases.values()) : 0]));
}

/** A busy loop that exits by itself once its parent is gone or its lifetime ends. */
export function burnerSource(parent: number, lifetimeMs = BURNER_LIFETIME_MS): string {
  return `const parent=${parent},end=Date.now()+${lifetimeMs};for(;;){const slice=Date.now()+${BURNER_SLICE_MS};while(Date.now()<slice);if(process.ppid!==parent||Date.now()>end)process.exit(0);}`;
}

export interface Burners { pids: number[]; stop(): void; }

/** One busy loop per requested CPU. `stop` kills exactly the PIDs started here that are still running. */
export function startBurners(count: number, lifetimeMs = BURNER_LIFETIME_MS): Burners {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1024) throw new Error("Burners must be a positive integer");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const stop = () => {
    for (const child of children.splice(0)) {
      // An exited child's PID may already belong to another process.
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { process.kill(child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  };
  try {
    for (let index = 0; index < count; index++) children.push(Bun.spawn([process.execPath, "-e", burnerSource(process.pid, lifetimeMs)],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
  } catch (error) { stop(); throw error; }
  return { pids: children.map(child => child.pid), stop };
}

export interface RunOptions {
  root: string; files: readonly string[]; base?: string | null; repetitions?: number; budgetSeconds?: number; burners?: number;
  costs?: Readonly<Record<string, number>>; env?: Record<string, string | undefined>; log?: (line: string) => void;
  /** Receives the wrapper's output as it arrives. */
  relay?: (chunk: Uint8Array, channel: "stdout" | "stderr") => void;
}

function describePlan(plan: RepetitionPlan, burners: number): string[] {
  const lines = [`Repeating ${plan.files.length} changed Bun test file(s) ${plan.repetitions} time(s) each under ${burners} CPU burner(s): ` +
    `${plan.weightSeconds.toFixed(1)} weighted s per pass, ${plan.estimatedSeconds.toFixed(1)} s estimated, budget ${plan.budgetSeconds} s.`];
  if (plan.reduced) lines.push(`Reduced from ${plan.requested} to ${plan.repetitions} repetitions: ${plan.requested} would cost ` +
    `${(plan.weightSeconds * plan.requested).toFixed(1)} weighted s against the ${plan.budgetSeconds} s budget.`);
  if (plan.overBudget) lines.push(`Over budget at the floor of ${plan.floor}: every file still runs ${plan.repetitions} times.`);
  for (const entry of plan.files) lines.push(`  ${entry.repetitions}x  ${entry.file} (${entry.weighted ? `weight ${entry.weightSeconds}s` : "no reviewed weight"})`);
  return lines;
}

/**
 * Runs the selection and returns its report. Burners and the wrapper are
 * stopped by PID on every path out: completion, a thrown error, a signal and
 * the process's own exit.
 */
export async function runDeterminism(options: RunOptions): Promise<Report> {
  const { root } = options, log = options.log ?? (line => console.error(line));
  const cpus = availableParallelism(), burnerCount = options.burners ?? cpus;
  const discovered = new Set(discoverTests(root, ["packages", "tests"]));
  const unknown = options.files.filter(file => !discovered.has(file));
  if (unknown.length) throw new Error(`Not a Bun test file under packages/ or tests/: ${unknown.join(", ")}`);
  const plan = planRepetitions([...options.files].sort(), options);
  const base = { kind: REPORT_KIND as typeof REPORT_KIND, version: 1 as const, base: options.base ?? null, ...plan, load: { burners: burnerCount, cpus } };
  if (!plan.files.length) {
    log("No added or modified Bun test file: nothing to repeat.");
    return { ...base, load: { burners: 0, cpus }, outcome: "none-selected", failure: null, elapsedSeconds: 0, exitCode: 0 };
  }
  for (const line of describePlan(plan, burnerCount)) log(line);
  const files = plan.files.map(entry => entry.file), started = performance.now();
  mkdirSync(dirname(join(root, JUNIT_PATH)), { recursive: true });
  rmSync(join(root, JUNIT_PATH), { force: true });
  let burners: Burners | undefined, child: ReturnType<typeof Bun.spawn> | undefined, cancelled: NodeJS.Signals | undefined;
  const cleanup = () => { burners?.stop(); if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, "SIGKILL"); } catch {} } };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  // The wrapper stops its own test process on a forwarded signal; burners go at once.
  const listeners = signals.map(signal => () => { cancelled = signal; burners?.stop(); child?.kill(signal); });
  signals.forEach((signal, index) => process.on(signal, listeners[index]!));
  process.on("exit", cleanup);
  let stderr = "", exitCode = 1;
  try {
    burners = startBurners(burnerCount);
    log(`CPU burners started (PIDs ${burners.pids.join(", ")}).`);
    if (!cancelled) {
      child = Bun.spawn(repetitionArgv(files, plan.repetitions), { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, ...options.env } });
      const decoder = new TextDecoder();
      const read = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => {
        for await (const chunk of stream) {
          if (channel === "stderr") stderr += decoder.decode(chunk, { stream: true });
          options.relay?.(chunk, channel);
        }
      };
      const [code] = await Promise.all([child.exited, read(child.stdout as ReadableStream<Uint8Array>, "stdout"), read(child.stderr as ReadableStream<Uint8Array>, "stderr")]);
      exitCode = child.signalCode ? 128 + (constants.signals[child.signalCode] ?? 0) : code;
    }
  } finally {
    cleanup();
    process.off("exit", cleanup);
    signals.forEach((signal, index) => process.off(signal, listeners[index]!));
  }
  if (cancelled) exitCode = 128 + (constants.signals[cancelled] ?? 0);
  const elapsedSeconds = (performance.now() - started) / 1000;
  let failure: Failure | null = null;
  if (exitCode !== 0) {
    const first = firstFailure(stderr, files, root);
    failure = { ...first, reason: cancelled ? `interrupted by ${cancelled}` : first.test ? "a test case failed" : `the offline test wrapper exited ${exitCode} without naming a failing case` };
  } else {
    // A green run is evidence only if every file really ran every repetition.
    let junit = "";
    try { junit = readFileSync(join(root, JUNIT_PATH), "utf8"); } catch {}
    const observed = observedRepetitions(junit, files);
    for (const entry of plan.files) entry.observed = observed.get(entry.file) ?? 0;
    const short = plan.files.find(entry => entry.observed !== entry.repetitions);
    if (short) {
      exitCode = 1;
      failure = { file: short.file, repetition: null, test: null,
        reason: `ran ${short.observed} of ${short.repetitions} repetitions according to the test report; a passing run must show every repetition` };
    }
  }
  const report: Report = { ...base, files: plan.files, outcome: failure ? "failed" : "passed", failure, elapsedSeconds, exitCode };
  if (failure) {
    log(`FAILED: ${failure.file ?? "unknown file"}, repetition ${failure.repetition ?? "unknown"} of ${plan.repetitions}` +
      `${failure.test ? `: ${JSON.stringify(failure.test)}` : ""} (${failure.reason}).`);
    log("A changed test must pass every repetition. Fix the test or what it exposes; a rerun is not a fix.");
  } else log(`Passed: ${files.length} file(s), ${plan.repetitions} repetition(s) each, ${elapsedSeconds.toFixed(1)} s under load.`);
  return report;
}

/** A Markdown table for the hosted job summary: each file with the repetitions it got. */
export function summaryMarkdown(report: Report): string {
  const lines = [`### Changed Bun tests under CPU load: ${report.outcome}`, ""];
  if (report.outcome === "none-selected") return lines.concat("No added or modified Bun test file.", "").join("\n");
  lines.push(`${report.repetitions} of ${report.requested} requested repetitions per file, ${report.load.burners} burner(s) on ${report.load.cpus} CPU(s); ` +
    `${report.estimatedSeconds.toFixed(1)} weighted s estimated against a ${report.budgetSeconds} s budget${report.overBudget ? " (over budget at the floor)" : ""}; ` +
    `${report.elapsedSeconds.toFixed(1)} s elapsed.`, "");
  if (report.failure) lines.push(`**Failed:** \`${report.failure.file ?? "unknown file"}\`, repetition ${report.failure.repetition ?? "unknown"}` +
    `${report.failure.test ? `, case \`${report.failure.test.replaceAll("`", "'")}\`` : ""} (${report.failure.reason}).`, "");
  lines.push("| File | Reviewed weight (s) | Repetitions |", "| --- | --- | --- |");
  for (const entry of report.files) lines.push(`| \`${entry.file}\` | ${entry.weighted ? entry.weightSeconds : "none"} | ${entry.repetitions} |`);
  return lines.concat("").join("\n");
}

const USAGE = "usage: bun scripts/test-determinism.ts (--base <ref> | <test file>...) [--json] [--report <path>] [--repetitions <n>] [--budget-seconds <n>] [--burners <n>]";

export interface Arguments { base?: string; files: string[]; json: boolean; report?: string; repetitions?: number; budgetSeconds?: number; burners?: number; }

export function parseArguments(args: readonly string[]): Arguments {
  const parsed: Arguments = { files: [], json: false };
  const positive = (name: string, value: string | undefined) => {
    if (!value || !/^[1-9]\d{0,6}$/.test(value)) throw new Error(`${name} needs a positive integer\n${USAGE}`);
    return Number(value);
  };
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index]!.startsWith("--") ? args[index]!.split(/=(.*)/s, 2) as [string, string | undefined] : [args[index]!, undefined];
    const value = () => inline ?? args[++index];
    if (flag === "--json" && inline === undefined) parsed.json = true;
    else if (flag === "--base") { parsed.base = value(); if (!parsed.base) throw new Error(`--base needs a ref\n${USAGE}`); }
    else if (flag === "--report") { parsed.report = value(); if (!parsed.report) throw new Error(`--report needs a path\n${USAGE}`); }
    else if (flag === "--repetitions") parsed.repetitions = positive(flag, value());
    else if (flag === "--budget-seconds") parsed.budgetSeconds = positive(flag, value());
    else if (flag === "--burners") parsed.burners = positive(flag, value());
    else if (flag.startsWith("-")) throw new Error(`Unknown option ${flag}\n${USAGE}`);
    else parsed.files.push(flag.replace(/^\.\//, ""));
  }
  if ((parsed.base === undefined) === (parsed.files.length === 0)) throw new Error(`Name either --base <ref> or the test files to repeat\n${USAGE}`);
  return parsed;
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const args = parseArguments(process.argv.slice(2));
    const files = args.base === undefined ? args.files : determinismTests(root, changedFiles(root, args.base, "HEAD", true, true));
    // Every CPU is occupied on purpose, so a local run takes a host slot like any heavy command (#2943).
    if (files.length) {
      const admitted = await ensureHostAdmission("test-determinism");
      if (admitted !== undefined) process.exit(admitted);
    }
    const report = await runDeterminism({ root, files, base: args.base ?? null, repetitions: args.repetitions,
      budgetSeconds: args.budgetSeconds, burners: args.burners,
      relay: (chunk, channel) => { process[args.json ? "stderr" : channel].write(chunk); } });
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
