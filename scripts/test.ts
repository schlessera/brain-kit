/**
 * The root `bun run test` entry point.
 *
 * `bun test` ORs every positional path it is given, so a script of
 * `bun test packages tests --timeout 30000` could never be narrowed:
 * `bun run test packages/scrape` appended a third path and still ran the whole
 * suite. This wrapper adds the default roots only when the caller named no path
 * of their own, and passes Bun's flags through untouched. CI's
 * `--balanced-shard=N/3` selects files by measured costs before that run.
 *
 *   bun run test                       # ./packages + ./tests (never experiments/)
 *   bun run test packages/scrape       # just that package
 *   bun run test --shard=1/3           # the whole suite, one shard
 *
 * The `--timeout 30000` lives in package.json, not here, so the manifest guard
 * in tests/release-manifest.test.ts still sees it on the root script.
 */

import { isDockerTest } from "./docker-test-files";
import { cleanTestEnvironment, offlineCommand } from "./offline-command";
export { offlineCommand } from "./offline-command";
import { constants } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync, rmSync, statSync } from "node:fs";
import { invocationChild } from "./test-invocation-child";
import { createInvokingTestHome } from "./test-home";
import { runtimeBrowserSelection, runtimeBuildSelection } from "./runtime-test-builds";
import { acceptsSpeechDelegation, clearInvocation, prepareCopiedInvocation, prepareInvocation, takePreparedTree } from "./test-invocation";
import { ensureWorkspaceLease, workspaceTestAccess } from "./workspace-lease.mjs";
import { ensureHostAdmission } from "./host-admission.mjs";
import { FILE_COST_SECONDS } from "./test-shards";

/** What runs when the caller names no path. */
export const DEFAULT_ROOTS: readonly string[] = ["packages", "tests"];

/**
 * The default roots as `bun test` receives them. A bare positional is a path
 * SUBSTRING filter to Bun 1.4.2, so `bun test packages tests` also runs any
 * file whose path merely contains "tests" (`experiment-tests/a.test.ts`); a
 * `./` prefix makes each one a directory root. The experiment tier
 * (`experiments/`, scripts/test-experiments.ts, #1386) therefore stays out of
 * default discovery by construction, whatever its files are named, and this
 * matches `discoverTests(cwd, DEFAULT_ROOTS)`'s directory walk.
 */
export const DEFAULT_PATH_ARGS: readonly string[] = DEFAULT_ROOTS.map((root) => `./${root}`);

/**
 * Long flags whose value may follow as the NEXT argument (`--timeout 30000`),
 * so that argument is the flag's, not a path. Exactly the required-value
 * params of `TEST_PARAMS` in Bun 1.4.2's `src/runtime/cli/Arguments.rs` (test-only,
 * runtime, transpiler and base params), aliases included. Only `bun test`'s
 * own: Bun skips a long flag it does not know, so the argument after one is a
 * path to it, and must be one here too.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--conditions", "--console-depth", "--coverage-dir", "--coverage-reporter",
  "--cpu-prof-dir", "--cpu-prof-interval", "--cpu-prof-name", "--cron-period",
  "--cron-title", "--cwd", "--define", "--disable-warning",
  "--dns-result-order", "--drop", "--env-file", "--eval",
  "--extension-order", "--feature", "--fetch-preconnect", "--grep",
  "--heap-prof-dir", "--heap-prof-interval", "--heap-prof-name", "--import",
  "--install", "--jsx-factory", "--jsx-fragment", "--jsx-import-source",
  "--jsx-runtime", "--loader", "--main-fields", "--max-concurrency",
  "--max-http-header-size", "--origin", "--parallel-delay", "--path-ignore-patterns",
  "--port", "--preload", "--print", "--redirect-warnings",
  "--reporter", "--reporter-outfile", "--require", "--rerun-each",
  "--retry", "--seed", "--shard", "--stack-trace-limit",
  "--test-name-pattern", "--timeout", "--timings", "--title",
  "--trace-event-categories", "--trace-event-file-pattern", "--tsconfig-override", "--unhandled-rejections",
  "--user-agent", "--watch-kill-signal",
]);

/**
 * Short flags that take a required value under `bun test`: `-t` (name
 * pattern), `-r` (preload), `-d` (define), `-l` (loader), `-e`/`-p`
 * (eval/print). Not `-u`: `bun test` resolves it to `--update-snapshots`,
 * which takes nothing, before the runtime's `-u, --origin`.
 */
const SHORT_VALUE_LETTERS: ReadonlySet<string> = new Set(["t", "r", "d", "l", "e", "p"]);

/** Short flags with an optional value (`-c`, `--config`): they end a cluster and take nothing after it. */
const SHORT_OPTIONAL_LETTERS: ReadonlySet<string> = new Set(["c"]);

/**
 * Optional-valued long flags (`--bail`, `--parallel`, `--changed`,
 * `--config`, `--inspect*`) are deliberately absent: Bun's parser gives them a
 * value only through `=`, so a separate argument after one is a positional
 * path to Bun too.
 */

/**
 * Whether a short-flag token (`-t`, `-ut`, `-tname`, `-t=name`) leaves its
 * value to the next argument. Bun walks the cluster left to right: the first
 * required-value letter takes the REST of the token as its value, and only
 * when it ends the token does the value come from the next argument; an
 * optional-value letter ends the cluster and never reaches the next argument.
 */
function shortTakesNext(token: string): boolean {
  for (let i = 1; i < token.length; i++) {
    const letter = token[i]!;
    if (SHORT_OPTIONAL_LETTERS.has(letter)) return false;
    if (SHORT_VALUE_LETTERS.has(letter)) return i === token.length - 1;
  }
  return false;
}

/** The `bun test` argv for the arguments `bun run test` received. */
function testPathIndexes(args: readonly string[]): number[] {
  const paths: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      paths.push(...args.slice(i + 1).map((_, offset) => i + 1 + offset));
      break;
    }
    // A bare `-` is a positional to Bun, like any other path.
    if (arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--")) {
        if (!arg.includes("=") && VALUE_FLAGS.has(arg)) i++;
      } else if (shortTakesNext(arg)) {
        i++;
      }
      continue;
    }
    paths.push(i);
  }
  return paths;
}

export function testPaths(args: readonly string[]): string[] {
  return testPathIndexes(args).map(index => args[index]!);
}

/** Separate ordinary, browser-runtime and host Docker commands before isolation. */
export async function testCommandBatches(argv: string[], cwd: string): Promise<{ argv: string[]; docker: boolean; browser?: boolean }[]> {
  const paths = testPaths(argv);
  const { discoverTests } = await import("./test-shards");
  const files = paths.flatMap(path => {
    const absolute = resolve(cwd, path);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return discoverTests(absolute, ["."]).map(file => resolve(absolute, file));
    if (stat) return [absolute];
    // Bun path substrings are OR selections, not filenames. Discover their
    // matches before splitting, without forwarding a filter to another batch.
    return discoverTests(cwd, ["."]).filter(file => file.includes(path)).map(file => resolve(cwd, file));
  });
  const browser = (file: string) => runtimeBrowserSelection(resolve(import.meta.dir, ".."), cwd, [file]).length > 0;
  const kind = (file: string) => isDockerTest(file, resolve(import.meta.dir, "..")) ? "docker" : browser(file) ? "browser" : "ordinary";
  if (new Set(files.map(kind)).size < 2) return [{ argv, docker: files.some(file => isDockerTest(file)), browser: files.some(browser) }];
  const positions = new Set(testPathIndexes(argv));
  const flags = argv.filter((_, index) => !positions.has(index));
  const batches = ["ordinary", "browser", "docker"].flatMap(group => {
    const selected = [...new Set(files.filter(file => kind(file) === group))];
    return selected.length ? [{ argv: [...flags, ...selected.map(file => resolve(cwd, file))], docker: group === "docker", browser: group === "browser" }] : [];
  });
  if (batches.length > 1) for (const batch of batches) {
    batch.argv = batch.argv.map((arg, index, args) => {
      const suffix = batch.docker ? ".docker" : batch.browser ? ".browser" : ".ordinary";
      if (arg.startsWith("--reporter-outfile=")) return arg + suffix + ".xml";
      if (args[index - 1] === "--reporter-outfile") return arg + suffix + ".xml";
      if (arg.startsWith("--timings=")) return arg + suffix + ".json";
      return args[index - 1] === "--timings" ? arg + suffix + ".json" : arg;
    });
  }
  return batches;
}

const optionValue = (argv: readonly string[], flag: string) => {
  const index = argv.findIndex(arg => arg === flag || arg.startsWith(flag + "="));
  return index < 0 ? undefined : argv[index] === flag ? argv[index + 1] : argv[index]!.slice(flag.length + 1);
};

/** Keep the requested aggregate as well as each command's separate report. */
export async function mergeBatchReports(argv: readonly string[], batches: readonly { argv: string[]; empty?: boolean }[]) {
  for (const flag of ["--reporter-outfile", "--timings"]) {
    const destination = optionValue(argv, flag);
    if (!destination) continue;
    const reports = await Promise.all(batches.filter(batch => !batch.empty).map(batch => Bun.file(optionValue(batch.argv, flag)!).text()));
    if (flag === "--timings") {
      await Bun.write(destination, JSON.stringify({ version: 1, files: Object.assign({}, ...reports.map(text => JSON.parse(text).files)) }));
    } else {
      if (!reports.length) continue; // Bun emits no JUnit when every selection is empty.
      const totals = { tests: 0, failures: 0, skipped: 0, assertions: 0, time: 0 };
      for (const xml of reports) {
        const tag = /<testsuites\b[^>]*>/.exec(xml)?.[0];
        if (!tag || !/<\/testsuites>\s*$/.test(xml)) throw new Error("Incomplete batch JUnit report");
        for (const name of Object.keys(totals) as (keyof typeof totals)[]) {
          const raw = new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1];
          if (raw === undefined || !Number.isFinite(Number(raw)) || Number(raw) < 0) throw new Error("Invalid batch JUnit total");
          totals[name] += Number(raw);
        }
      }
      await Bun.write(destination, `<testsuites ${Object.entries(totals).map(([key, value]) => `${key}="${value}"`).join(" ")}>\n` +
        reports.map(xml => xml.replace(/^[\s\S]*?<testsuites\b[^>]*>/, "").replace(/<\/testsuites>\s*$/, "")).join("\n") + "\n</testsuites>\n");
    }
  }
}

export function testArgv(args: readonly string[]): string[] {
  return testPaths(args).length ? [...args] : [...DEFAULT_PATH_ARGS, ...args];
}

/** A measured file at or over this many seconds is a heavy local command on its own (#2943). */
export const HEAVY_TEST_FILE_SECONDS = 30;

/**
 * Why a selection needs host admission, or undefined for a focused run: the
 * integrated default suite, runtime-host and native suites, and any selected
 * file whose measured cost reaches HEAVY_TEST_FILE_SECONDS. Paths match the
 * way runtimeBuildSelection matches them.
 */
export function heavyTestReason(root: string, cwd: string, args: readonly string[],
  costs: Readonly<Record<string, number>> = FILE_COST_SECONDS): string | undefined {
  const paths = testPaths(args);
  if (!paths.length) return "integrated suite";
  if (runtimeBuildSelection(root, cwd, paths).length) return "runtime-host tests";
  if (paths.some(path => /(?:^|\/)native-proof(?:\/|$)|\.native\./.test(path))) return "native tests";
  const selects = (file: string) => paths.some(path => {
    const absolute = join(root, file);
    if (isAbsolute(path) || path.startsWith(".")) {
      const target = resolve(cwd, path);
      return absolute === target || absolute.startsWith(`${target}/`);
    }
    return absolute.includes(path);
  });
  const long = Object.entries(costs).find(([file, seconds]) => seconds >= HEAVY_TEST_FILE_SECONDS && selects(file));
  return long ? `long test file ${long[0]}` : undefined;
}

if (import.meta.main) {
  let args = process.argv.slice(2);
  let argv: string[];
  let fullPreparation = false, delegatedSpeech = false, help = false, unsupported = realpathSync(process.cwd()) !== realpathSync(resolve(import.meta.dir, ".."));
  try {
    const balanced: string[] = [];
    const forwarded: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") {
        forwarded.push(...args.slice(i));
        break;
      }
      if (arg === "--internal-full-preparation") { fullPreparation = true; continue; }
      if (arg === "--internal-external-speech") { delegatedSpeech = true; continue; }
      // Bun prints usage and runs nothing, so help never builds or fails on a compiler error.
      if (arg === "--help" || arg === "-h") help = true;
      if (["--watch", "--hot", "--cwd"].some(flag => arg === flag || arg.startsWith(`${flag}=`))) unsupported = true;
      if (arg === "--balanced-shard") throw new Error("Expected --balanced-shard=M/N");
      if (arg.startsWith("--balanced-shard=")) {
        balanced.push(arg);
        continue;
      }
      forwarded.push(arg);
      // A Bun flag's value can itself look like our option (e.g. -t PATTERN).
      if (arg.startsWith("--") ? !arg.includes("=") && VALUE_FLAGS.has(arg) :
          arg.startsWith("-") && shortTakesNext(arg)) {
        if (i + 1 < args.length) forwarded.push(args[++i]!);
      }
    }
    args = forwarded;
    argv = testArgv(args);
    if (balanced.length) {
      if (balanced.length !== 1 || argv.length === args.length ||
          args.some((arg) => arg.startsWith("--shard") || arg.startsWith("--cwd"))) {
        throw new Error("--balanced-shard requires the default roots and cannot combine with --shard or --cwd");
      }
      const { selectShard } = await import("./test-shards");
      argv = [...selectShard(process.cwd(), DEFAULT_ROOTS, balanced[0]!.slice("--balanced-shard=".length)), ...args];
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const root = resolve(import.meta.dir, "..");
  const batches = await testCommandBatches(argv, process.cwd());
  const run = async (command: string[], observe?: (stderr: string) => void) => {
    const child = invocationChild(command, { stdin: "inherit" });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const listeners = signals.map(signal => () => { void child.stop(signal); });
    signals.forEach((signal, index) => process.on(signal, listeners[index]!));
    try {
      let stderr = "";
      const decoder = new TextDecoder();
      const relay = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => {
        for await (const chunk of stream) { process[channel].write(chunk); if (observe && channel === "stderr") stderr += decoder.decode(chunk, { stream: true }); }
        if (observe && channel === "stderr") stderr += decoder.decode();
      };
      const [code] = await Promise.all([child.exited, relay(child.stdout, "stdout"), relay(child.stderr, "stderr")]);
      await child.finish();
      observe?.(stripVTControlCharacters(stderr));
      return code;
    } finally { signals.forEach((signal, index) => process.off(signal, listeners[index]!)); }
  };
  // Enter before owning a lease or receipt: a new user namespace cannot read
  // its parent's descriptor through procfs. Nested commands reuse isolation.
  if (!help && batches.length > 1) {
    let code = 0;
    const completed: { argv: string[]; empty?: boolean }[] = [];
    for (const flag of ["--reporter-outfile", "--timings"]) {
      const path = optionValue(argv, flag); if (path) rmSync(path, { force: true });
    }
    for (const batch of batches) for (const flag of ["--reporter-outfile", "--timings"]) {
      const path = optionValue(batch.argv, flag); if (path) rmSync(path, { force: true });
    }
    for (const [index, batch] of batches.entries()) {
      console.error(JSON.stringify({ kind: "test-invocation", event: "batch-start", pid: process.pid, batch: index }));
      code = await run([process.execPath, "--no-env-file", import.meta.path,
        ...(fullPreparation && index === 0 ? ["--internal-full-preparation"] : []),
        ...(delegatedSpeech ? ["--internal-external-speech"] : []), ...batch.argv], output => {
        const changed = batch.argv.some(arg => /^--changed(?:=|$)/.test(arg)) ? /^--changed: .*$/m.exec(output)?.[0] ?? "" : "";
        const assignment = batch.argv.some(arg => /^--shard(?:=|$)/.test(arg)) ? /^--shard=\d+\/\d+: running (\d+)\/\d+ test files?$/m.exec(output) : null;
        const empty = assignment?.[1] === "0" || /^--changed: (?:no changed files, nothing to run|\d+ changed files?, but no test files are affected)\.?$/.test(changed);
        completed.push({ argv: batch.argv, empty });
      });
      if (code) break;
    }
    await mergeBatchReports(argv, completed);
    process.exit(code);
  }
  const batch = batches[0]!;
  if (!help && !batch.docker && Bun.spawnSync(offlineCommand(["--check"], batch.browser), { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    process.exit(await run(offlineCommand([process.execPath, "--no-env-file", import.meta.path, ...process.argv.slice(2)], batch.browser)));
  }
  const coordinated = await ensureWorkspaceLease(root, workspaceTestAccess());
  if (coordinated !== undefined) process.exit(coordinated);
  const heavy = help ? undefined : heavyTestReason(resolve(import.meta.dir, ".."), process.cwd(), args);
  // Inside the workspace lease: a queued command never holds a host slot
  // while it waits for its own checkout's output.
  if (heavy) {
    const admitted = await ensureHostAdmission(`bun run test (${heavy})`);
    if (admitted !== undefined) process.exit(admitted);
  }
  // Cancellation covers preparation as well as tests; an interrupted build is
  // never retried and cannot launch tests, even if it was just exiting zero.
  let cancelled: NodeJS.Signals | undefined;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let owned: ReturnType<typeof invocationChild> | undefined;
  const stopping: Promise<void>[] = [];
  const stop = (signal: NodeJS.Signals) => { const pending = owned?.stop(signal); if (pending) { stopping.push(pending); void pending.catch(() => {}); } };
  const started = (child: ReturnType<typeof invocationChild>) => { owned = child; if (cancelled) stop(cancelled); };
  const listeners = signals.map(signal => () => { cancelled = signal; stop(signal); });
  signals.forEach((signal, index) => process.on(signal, listeners[index]!));
  let dispose = () => {};
  let invokingHome: ReturnType<typeof createInvokingTestHome> | undefined;
  let result = 1;
  try {
    const paths = testPaths(argv);
    const borrowed = !unsupported && workspaceTestAccess() === "write" && delegatedSpeech && acceptsSpeechDelegation(root, paths);
    const preparedTree = takePreparedTree(root);
    if (!borrowed) clearInvocation();
    if (fullPreparation && workspaceTestAccess() !== "write") throw new Error("Read-only verification cannot prepare workspace output");
    const directories = runtimeBuildSelection(root, process.cwd(), paths);
    if (!help && !borrowed && !unsupported && workspaceTestAccess() === "write" && (fullPreparation || directories.length)) {
      const preparation = preparedTree ? prepareCopiedInvocation(root, preparedTree) :
        await prepareInvocation(root, fullPreparation ? undefined : directories, started);
      dispose = preparation.dispose;
      if (preparation.code !== 0) { result = preparation.code; throw new Error(`Test invocation preparation failed (${result})`); }
    }
    if (!cancelled) {
      const beforeTests = performance.now();
      console.error(JSON.stringify({ kind: "test-invocation", event: "tests-start", pid: process.pid, at: Date.now() }));
      for (const batch of batches) {
        invokingHome = createInvokingTestHome();
        const testCommand = [process.execPath, "test", "--no-env-file", "--preload", join(import.meta.dir, "test-network-preload.ts"), ...batch.argv];
        const tests = invocationChild(testCommand, { stdin: "inherit", env: { ...cleanTestEnvironment(process.env), HOME: invokingHome.home, CLAUDE_CONFIG_DIR: invokingHome.config, BRAIN_TEST_RESOURCE_ROOT: invokingHome.resources } });
        started(tests);
        await tests.ready;
        const relay = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => { for await (const chunk of stream) process[channel].write(chunk); };
        const joined = await Promise.allSettled([tests.exited, relay(tests.stdout, "stdout"), relay(tests.stderr, "stderr")]);
        await tests.finish();
        invokingHome.assertUnchanged();
        result = joined[0].status === "fulfilled" ? joined[0].value : 1;
        if (joined.some(item => item.status === "rejected")) result = result || 1;
        if (tests.signalCode) result = 128 + (constants.signals[tests.signalCode] ?? 0);
        invokingHome.dispose(); invokingHome = undefined;
        if (result || cancelled) break;
      }
      console.error(JSON.stringify({ kind: "test-invocation", event: "tests-complete", pid: process.pid, at: Date.now(), code: result,
        elapsedMs: performance.now() - beforeTests }));
    }
  } catch (error) { console.error(error); }
  finally {
    const stopped = await Promise.allSettled(stopping);
    if (stopped.some(item => item.status === "rejected")) { console.error("Invocation child cleanup failed", stopped); result = result || 1; }
    try { dispose(); } finally { invokingHome?.dispose(); }
    signals.forEach((signal, index) => process.off(signal, listeners[index]!));
  }
  process.exit(cancelled ? 128 + (constants.signals[cancelled] ?? 0) : result);
}
