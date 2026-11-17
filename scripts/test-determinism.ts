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
 * The count and the hosted partitions are planned in scripts/determinism-plan.ts:
 * hosted CI splits a selection too heavy for one job across partitions (#4117),
 * and each partition runs this command with its own files. A local `--base`
 * run repeats the whole selection in one invocation.
 *
 * Watchdogs scale with the load (#4191). The burners slow every test, and a
 * timeout that exists to stop a hang is a catch-all for the worst case, so the
 * run multiplies test deadlines by one factor
 * (`DETERMINISM_PARTITIONS.deadlineFactor`, scripts/proof-shards.ts): Bun's
 * per-test cap through a later `--timeout`, explicit test and hook timeouts
 * through a second preload (scripts/test-deadline-preload.ts), and in-test
 * watchdogs that read `watchdogMs` (scripts/test-deadlines.ts) through the
 * environment. Verified against Bun 1.4.2: the last `--timeout` on the command
 * line wins, and neither it nor `setDefaultTimeout` changes a timeout a test
 * names itself. A wait a test bounds any other way is not scaled.
 * Policy: docs/decisions/ci-utility.md, "Changed tests repeat under load before merge"
 * and "Test watchdogs are a worst-case catch-all".
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { changedFiles, determinismTests } from "./ci-plan";
import { ensureHostAdmission } from "./host-admission.mjs";
import { planRepetitions, type RepetitionPlan } from "./determinism-plan";
import { DETERMINISM_PARTITIONS } from "./proof-shards";
import { DEADLINE_FACTOR_ENV, parseDeadlineFactor } from "./test-deadlines";
import { discoverTests } from "./test-shards";

export { BUDGET_SECONDS, DEFAULT_REPETITIONS, FLOOR_REPETITIONS, planRepetitions, repetitionsFor, type FileRepetitions, type RepetitionPlan } from "./determinism-plan";

/** A burner outlives its parent by one slice at most, and never this long. */
const BURNER_LIFETIME_MS = 2 * 60 * 60_000, BURNER_SLICE_MS = 200;
export const REPORT_KIND = "brain-test-determinism";
const JUNIT_PATH = "tmp/determinism-junit.xml";
const DEADLINE_PRELOAD = "scripts/test-deadline-preload.ts";

export interface Failure { file: string | null; repetition: number | null; test: string | null; reason: string; }
export interface Report extends RepetitionPlan {
  kind: typeof REPORT_KIND; version: 1; base: string | null;
  outcome: "passed" | "failed" | "none-selected";
  failure: Failure | null; load: { burners: number; cpus: number };
  /** The factor test deadlines were multiplied by, and Bun's per-test cap after it. */
  deadlines: { factor: number; testCapMs: number };
  elapsedSeconds: number; exitCode: number;
}

/**
 * Bun's per-test cap for `bun run test`, read from the root script that owns
 * it. A script that names none is refused: an unknown cap cannot be scaled.
 */
export function testCapMs(root: string): number {
  const script: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.scripts?.test;
  const cap = typeof script === "string" ? /(?:^|\s)--timeout[=\s](\d+)(?=\s|$)/.exec(script)?.[1] : undefined;
  if (!cap || Number(cap) <= 0) throw new Error("The root test script names no --timeout, so the per-test cap cannot be scaled under load");
  return Number(cap);
}

/**
 * The wrapper's argv: one invocation, so preparation builds once for every
 * repetition. `deadlines` adds the scaled per-test cap after the script's own
 * `--timeout`, and the preload that scales explicit timeouts.
 */
export function repetitionArgv(files: readonly string[], repetitions: number, deadlines?: { capMs: number; preload: string }): string[] {
  return [process.execPath, "run", "test", `--rerun-each=${repetitions}`, "--bail=1",
    "--reporter=junit", `--reporter-outfile=${JUNIT_PATH}`,
    ...(deadlines ? [`--timeout=${deadlines.capMs}`, `--preload=${deadlines.preload}`] : []), ...files.map(file => `./${file}`)];
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
  /** Multiplies test deadlines for the run; the gate's own factor unless named. One leaves every deadline as written. */
  deadlineFactor?: number;
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
  const factor = parseDeadlineFactor(options.deadlineFactor ?? DETERMINISM_PARTITIONS.deadlineFactor);
  const deadlines = { factor, testCapMs: testCapMs(root) * factor };
  const base = { kind: REPORT_KIND as typeof REPORT_KIND, version: 1 as const, base: options.base ?? null, ...plan, load: { burners: burnerCount, cpus }, deadlines };
  if (!plan.files.length) {
    log("No added or modified Bun test file: nothing to repeat.");
    return { ...base, load: { burners: 0, cpus }, outcome: "none-selected", failure: null, elapsedSeconds: 0, exitCode: 0 };
  }
  for (const line of describePlan(plan, burnerCount)) log(line);
  if (factor > 1) log(`Test deadlines scaled by ${factor} under load: Bun's per-test cap is ${deadlines.testCapMs} ms, and explicit test and hook timeouts and watchdogMs() watchdogs are multiplied the same way.`);
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
      // The factor is always named, so a run asked for one never inherits another run's.
      child = Bun.spawn(repetitionArgv(files, plan.repetitions, factor > 1 ? { capMs: deadlines.testCapMs, preload: join(root, DEADLINE_PRELOAD) } : undefined),
        { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env, [DEADLINE_FACTOR_ENV]: String(factor) } });
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
  if (report.deadlines.factor > 1) lines.push(`Test deadlines scaled by ${report.deadlines.factor} (per-test cap ${report.deadlines.testCapMs / 1000} s).`, "");
  if (report.failure) lines.push(`**Failed:** \`${report.failure.file ?? "unknown file"}\`, repetition ${report.failure.repetition ?? "unknown"}` +
    `${report.failure.test ? `, case \`${report.failure.test.replaceAll("`", "'")}\`` : ""} (${report.failure.reason}).`, "");
  lines.push("| File | Reviewed weight (s) | Repetitions |", "| --- | --- | --- |");
  for (const entry of report.files) lines.push(`| \`${entry.file}\` | ${entry.weighted ? entry.weightSeconds : "none"} | ${entry.repetitions} |`);
  return lines.concat("").join("\n");
}

const USAGE = "usage: bun scripts/test-determinism.ts (--base <ref> | <test file>...) [--json] [--report <path>] [--repetitions <n>] [--budget-seconds <n>] [--burners <n>] [--deadline-factor <n>]";

export interface Arguments { base?: string; files: string[]; json: boolean; report?: string; repetitions?: number; budgetSeconds?: number; burners?: number; deadlineFactor?: number; }

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
    else if (flag === "--deadline-factor") parsed.deadlineFactor = parseDeadlineFactor(positive(flag, value()));
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
      budgetSeconds: args.budgetSeconds, burners: args.burners, deadlineFactor: args.deadlineFactor,
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
