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

/** Env with API keys stripped → deterministic keyless (FTS-only) behaviour. */
export function keylessEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.BRAIN_ROOT = root;
  delete env.GEMINI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.GOOGLE_API_KEY;
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
