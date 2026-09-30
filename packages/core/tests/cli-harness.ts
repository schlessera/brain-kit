/**
 * Shared harness for the CLI/MCP contract tests. Not a test file itself (no
 * `.test.ts`), so `bun test` does not execute it directly.
 *
 * Each temp brain is a copy of fixtures/corpus with node_modules symlinked from
 * the monorepo root, so the fixture's `brain.config.ts` (which imports
 * @schlessera/brain) resolves. API keys are stripped from the spawned env so the
 * keyless (FTS-only, deterministic) paths are exercised.
 */

import { cpSync, mkdtempSync, rmSync, symlinkSync } from "fs";
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
    process.on("exit", () => cleanup(dir));
  }
  return binHome;
}

/**
 * Env with API keys stripped → deterministic keyless (FTS-only) behaviour, and
 * XDG_BIN_HOME pointed at `testBinHome()`. A caller can pass its own.
 */
export function keylessEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.BRAIN_ROOT = root;
  env.XDG_BIN_HOME = testBinHome();
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

/** Run the real bin keyless; `env` overrides individual variables (e.g. PATH). */
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
