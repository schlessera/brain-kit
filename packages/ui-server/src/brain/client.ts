import { existsSync } from "fs";
import { join } from "path";
import type {
  BrainSearchResult,
  BrainSearchResponse,
  BrainDocument,
  BrainStats,
  BrainSyncResult,
} from "./types.js";

const BRAIN_PATH = process.env.BRAIN_PATH || join(process.env.HOME || "/root", "brain");

/**
 * argv prefix for invoking the brain CLI inside BRAIN_PATH.
 *
 * Two brain-repo layouts exist and both must work: a repo that depends on
 * `@schlessera/brain` gets a real bin at `node_modules/.bin/brain`, while the
 * legacy layout vendors `scripts/brain-cli.ts`. Prefer the packaged bin.
 *
 * Resolved per call (a bare `existsSync` stat) rather than at import time: in
 * the container the brain repo is cloned and `bun install`ed by entrypoint.sh,
 * and a repo can gain the dependency without restarting this server. The same
 * preference order is mirrored in `scripts/entrypoint.sh`, which links whichever
 * it finds onto PATH for cron.
 */
export function brainCliCommand(): string[] {
  const packaged = join(BRAIN_PATH, "node_modules", ".bin", "brain");
  if (existsSync(packaged)) return [packaged];
  return ["bun", "scripts/brain-cli.ts"];
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execBrain(args: string[]): Promise<ExecResult> {
  const proc = Bun.spawn([...brainCliCommand(), ...args], {
    cwd: BRAIN_PATH,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Force JSON output when not a TTY
      NO_COLOR: "1",
    },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

function parseJsonOutput<T>(result: ExecResult): T {
  if (result.exitCode !== 0) {
    throw new Error(
      `brain CLI failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    // Some commands output plain text, not JSON
    return result.stdout as unknown as T;
  }
}

export async function brainSearch(
  query: string,
  opts?: { type?: string; tag?: string; limit?: number; mode?: string }
): Promise<BrainSearchResponse> {
  const args = ["search", query];
  if (opts?.type) args.push("--type", opts.type);
  if (opts?.tag) args.push("--tag", opts.tag);
  if (opts?.limit) args.push("--limit", String(opts.limit));
  if (opts?.mode) args.push("--mode", opts.mode);

  const result = await execBrain(args);
  const parsed = parseJsonOutput<BrainSearchResponse | BrainSearchResult[]>(result);
  // brain returns {results, warnings} since 22e82e1; tolerate the old bare array
  return Array.isArray(parsed) ? { results: parsed, warnings: [] } : parsed;
}

export async function brainBriefing(): Promise<string> {
  const result = await execBrain(["briefing"]);
  if (result.exitCode !== 0) {
    throw new Error(`brain briefing failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function brainStats(): Promise<BrainStats> {
  const result = await execBrain(["stats"]);
  return parseJsonOutput(result);
}

export async function brainList(opts?: {
  type?: string;
  tag?: string;
  status?: string;
  relevance?: string;
  limit?: number;
}): Promise<BrainDocument[]> {
  const args = ["list"];
  if (opts?.type) args.push("--type", opts.type);
  if (opts?.tag) args.push("--tag", opts.tag);
  if (opts?.status) args.push("--status", opts.status);
  if (opts?.relevance) args.push("--relevance", opts.relevance);
  if (opts?.limit) args.push("--limit", String(opts.limit));

  const result = await execBrain(args);
  return parseJsonOutput(result);
}

export async function brainRead(path: string): Promise<string> {
  const result = await execBrain(["read", path]);
  if (result.exitCode !== 0) {
    throw new Error(`brain read failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function brainSync(): Promise<BrainSyncResult> {
  // Note: brain sync spawns Claude Code internally via the /sync skill.
  // For cron jobs, we use a simpler git-based sync instead.
  const result = await execBrain(["sync"]);
  if (result.exitCode !== 0) {
    return {
      success: false,
      commits: 0,
      conflicts: 0,
      message: result.stderr || result.stdout,
    };
  }
  try {
    return parseJsonOutput(result);
  } catch {
    return {
      success: true,
      commits: 0,
      conflicts: 0,
      message: result.stdout,
    };
  }
}

export async function brainAdd(
  content: string,
  opts?: { type?: string; title?: string; tags?: string[] }
): Promise<void> {
  const args = ["add", content];
  if (opts?.type) args.push("--type", opts.type);
  if (opts?.title) args.push("--title", opts.title);
  if (opts?.tags) args.push("--tags", opts.tags.join(","));

  const result = await execBrain(args);
  if (result.exitCode !== 0) {
    throw new Error(`brain add failed: ${result.stderr}`);
  }
}

export async function brainIndex(opts?: {
  /** Full rebuild; indexing is incremental by default since brain 22e82e1. */
  force?: boolean;
}): Promise<void> {
  const args = ["index"];
  if (opts?.force) args.push("--force");

  const result = await execBrain(args);
  if (result.exitCode !== 0) {
    throw new Error(`brain index failed: ${result.stderr}`);
  }
}

export async function brainValidate(): Promise<string> {
  const result = await execBrain(["validate"]);
  if (result.exitCode !== 0) {
    throw new Error(`brain validate failed: ${result.stderr}`);
  }
  return result.stdout;
}
