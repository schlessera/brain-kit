/**
 * Shared harness for the CLI/MCP contract tests. Not a test file itself (no
 * `.test.ts`), so `bun test` does not execute it directly.
 *
 * Each temp brain is a copy of fixtures/corpus with node_modules symlinked from
 * the monorepo root, so the fixture's `brain.config.ts` (which imports
 * @schlessera/brain) resolves. API keys are stripped from the spawned env so the
 * keyless (FTS-only, deterministic) paths are exercised.
 */

import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { format } from "util";

const CORE_ROOT = resolve(import.meta.dir, "..");
export const BRAIN_BIN = join(CORE_ROOT, "src/cli/brain.ts");
const FIXTURE_CORPUS = join(CORE_ROOT, "fixtures/corpus");
const REPO_NODE_MODULES = resolve(CORE_ROOT, "../../node_modules");

export function makeTempBrain(opts: { empty?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  if (!opts.empty) cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  symlinkSync(REPO_NODE_MODULES, join(dir, "node_modules"));
  return dir;
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  dropBinLinksInto(dir);
}

let binHome: string | null = null;
let utilityRoot: string | undefined;

/** The preload places process-lifetime utilities under launcher-owned storage. */
export function setCliUtilityRoot(root: string): void { utilityRoot = root; }

/**
 * `brain setup` and `brain doctor --fix` link `brain` into the shared test bin
 * home, pointing into the fixture that ran them. Once that fixture is deleted
 * the link dangles, and a later fixture's `brain doctor` reports it as a broken
 * symlink (#1680). Deleting a fixture therefore also drops the bin links into it.
 */
function dropBinLinksInto(dir: string): void {
  if (binHome === null || dir === binHome) return;
  const prefix = resolve(dir) + "/";
  for (const name of readdirSync(binHome)) {
    const link = join(binHome, name);
    try {
      if (lstatSync(link).isSymbolicLink() && resolve(binHome, readlinkSync(link)).startsWith(prefix)) rmSync(link, { force: true });
    } catch {
      /* best effort */
    }
  }
}
let home: string | null = null;
let commandPath: string | null = null;

/** Called after the whole test run by its preload, or on ordinary Bun exit. */
export function cleanupCliUtilities(): void {
  for (const dir of [home, commandPath, binHome]) {
    if (dir !== null) cleanup(dir);
  }
  home = null;
  commandPath = null;
  binHome = null;
}
process.on("exit", cleanupCliUtilities);

/** Host account/configuration discovery must never be part of a CLI fixture. */
function testHome(): string {
  if (home === null) {
    const dir = mkdtempSync(join(utilityRoot ?? tmpdir(), "brain-test-home-"));
    for (const name of ["claude", "pi", "config", "cache", "data"]) {
      mkdirSync(join(dir, name));
    }
    home = dir;
  }
  return home;
}

/** Local CLI/fixture tools only; no ambient Claude, gh or MCP commands. */
function testCommandPath(): string {
  if (commandPath === null) {
    const dir = mkdtempSync(join(utilityRoot ?? tmpdir(), "brain-test-path-"));
    symlinkSync(process.execPath, join(dir, "bun"));
    // The sync push-race fixture's git hook records its first invocation with touch.
    for (const name of ["git", "touch"]) {
      const executable = Bun.which(name);
      if (executable) symlinkSync(executable, join(dir, name));
    }
    commandPath = dir;
  }
  return commandPath;
}

/**
 * One throwaway bin directory per test process. `brain setup` and
 * `brain doctor --fix` link `brain` into XDG_BIN_HOME (else ~/.local/bin), and
 * a test must never replace the developer's own link with one into a temp
 * brain that is about to be deleted.
 */
export function testBinHome(): string {
  if (binHome === null) {
    const dir = mkdtempSync(join(utilityRoot ?? tmpdir(), "brain-test-bin-"));
    binHome = dir;
  }
  return binHome;
}

/**
 * Env with API keys stripped → deterministic keyless (FTS-only) behaviour, and
 * test-owned home/configuration and a PATH containing only bun, git and touch.
 * XDG_BIN_HOME points at `testBinHome()`. Children share the parent runtime's
 * calendar; callers can supply explicit fixture shims through `runCli`.
 */
export function keylessEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.BRAIN_ROOT = root;
  env.HOME = testHome();
  env.CLAUDE_CONFIG_DIR = join(env.HOME, "claude");
  env.PI_CODING_AGENT_DIR = join(env.HOME, "pi");
  env.XDG_CONFIG_HOME = join(env.HOME, "config");
  env.XDG_CACHE_HOME = join(env.HOME, "cache");
  env.XDG_DATA_HOME = join(env.HOME, "data");
  env.PATH = testCommandPath();
  env.XDG_BIN_HOME = testBinHome();
  // With TZ absent, Bun's test and ordinary runtimes can choose different
  // defaults. Pass the calendar actually used by the parent, including an
  // explicitly selected non-UTC calendar, rather than the machine's default.
  env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  delete env.GEMINI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.GOOGLE_API_KEY;
  // An enabled jev reranker uses its key, and the sync judge asks
  // Jev: a developer key would turn these runs into paid network calls.
  delete env.TYPESAFE_API_KEY;
  delete env.BRAIN_RERANK_MODE;
  return env;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the real bin keyless; overrides (e.g. PATH or HOME) must be test-owned. */
export async function runCli(root: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn(["bun", BRAIN_BIN, ...args], {
    env: { ...keylessEnv(root), ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** The console methods a command prints through, and which stream each one writes, as the bin's Console does. */
const CONSOLE_STREAMS = { log: "stdout", info: "stdout", debug: "stdout", warn: "stderr", error: "stderr" } as const;

let inProcessCall: string[] | null = null;

/**
 * Run one `brain` invocation inside this process, through the same
 * `runBrainCli` the bin calls, and return what `runCli` would. For the call,
 * the environment is the keyless one `runCli` gives a child (plus `env`), the
 * process-wide brain context is cleared, and everything printed through
 * `console` or written to `process.stdout`/`process.stderr` is captured. All of
 * it is put back afterwards, complete property descriptors included, also when
 * the command throws.
 *
 * Not a substitute for the process boundary: stdio completion, the exit code a
 * parent sees and a signal path that calls `process.exit` stay with `runCli`.
 * A command whose module keeps state across calls, or that reloads a
 * brain.config.ts changed since this process first imported it, stays spawned.
 * Calls must not overlap: one that starts while another runs is refused.
 */
export async function runCliInProcess(root: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  // Loaded on first use, so a file that only spawns the bin does not load the CLI.
  const { runBrainCli } = await import("../src/cli/main");
  const { setContext } = await import("../src/lib/context");
  if (inProcessCall !== null) {
    throw new Error(
      `runCliInProcess(${JSON.stringify(args)}) started while runCliInProcess(${JSON.stringify(inProcessCall)}) is still running; await each call before the next`
    );
  }
  inProcessCall = args;

  const out = { stdout: [] as string[], stderr: [] as string[] };
  const which = Bun.which;
  const write = (name: "stdout" | "stderr") => (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
    out[name].push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(() => (done as () => void)());
    return true;
  };
  // Every property the call replaces: the console methods, the direct stdio
  // writes, stdio that is not a terminal, as `runCli`'s pipes are not, and the
  // PATH lookup, so it reads the call's PATH as a child's would.
  const replaced: [object, string, unknown][] = [
    ...Object.entries(CONSOLE_STREAMS).map(([key, stream]): [object, string, unknown] => [
      console, key, (...values: unknown[]) => { out[stream].push(`${format(...values)}\n`); },
    ]),
    [process.stdout, "write", write("stdout")],
    [process.stderr, "write", write("stderr")],
    [process.stdout, "isTTY", false],
    [process.stderr, "isTTY", false],
    [process.stdin, "isTTY", false],
    // Bun.which answers from the PATH the process started with unless told one.
    [Bun, "which", (command: string, options?: { PATH?: string; cwd?: string }) => which(command, { PATH: process.env.PATH, ...options })],
  ];
  const saved = replaced.map(([owner, key]) => [owner, key, Object.getOwnPropertyDescriptor(owner, key)] as const);
  const savedEnv = { ...process.env };
  const previousContext = setContext(null);
  try {
    const target = { ...keylessEnv(root), ...env };
    for (const key of Object.keys(process.env)) if (!(key in target)) delete process.env[key];
    Object.assign(process.env, target);
    for (const [owner, key, value] of replaced) {
      // A property the runtime fixed in place (Bun.which) can only be reassigned.
      if (Object.getOwnPropertyDescriptor(owner, key)?.configurable === false) (owner as Record<string, unknown>)[key] = value;
      else Object.defineProperty(owner, key, { configurable: true, enumerable: true, writable: true, value });
    }
    const code = await runBrainCli(args);
    return { stdout: out.stdout.join(""), stderr: out.stderr.join(""), code };
  } finally {
    for (const [owner, key, descriptor] of saved) {
      if (descriptor?.configurable === false) (owner as Record<string, unknown>)[key] = descriptor.value;
      else if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete (owner as Record<string, unknown>)[key];
    }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    setContext(previousContext);
    inProcessCall = null;
  }
}
