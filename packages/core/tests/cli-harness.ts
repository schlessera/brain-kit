/**
 * Shared harness for the CLI/MCP contract tests. Not a test file itself (no
 * `.test.ts`), so `bun test` does not execute it directly.
 *
 * Each temp brain is a copy of fixtures/corpus with node_modules symlinked from
 * the monorepo root, so the fixture's `brain.config.ts` (which imports
 * @schlessera/brain) resolves. API keys are stripped from the spawned env so the
 * keyless (FTS-only, deterministic) paths are exercised.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

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
}

let binHome: string | null = null;
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
    const dir = mkdtempSync(join(tmpdir(), "brain-test-home-"));
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
    const dir = mkdtempSync(join(tmpdir(), "brain-test-path-"));
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
    const dir = mkdtempSync(join(tmpdir(), "brain-test-bin-"));
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
