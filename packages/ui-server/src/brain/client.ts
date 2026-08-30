import { existsSync } from "fs";
import { join } from "path";
import { subprocessEnv } from "../config/env.js";
import type {
  BrainSearchResult,
  BrainSearchResponse,
  BrainDocument,
  BrainStats,
  BrainSyncResult,
} from "./types.js";

/**
 * Wrapper around the brain CLI, bound to one brain repo. Constructed by
 * `createApp()` (or an embedder) with the resolved brain path — no ambient
 * environment, so two clients against different repos can coexist.
 */
export interface BrainClient {
  /** argv prefix for invoking the brain CLI inside the repo. */
  cliCommand(): string[];
  search(
    query: string,
    opts?: { type?: string; tag?: string; limit?: number; mode?: string }
  ): Promise<BrainSearchResponse>;
  briefing(): Promise<string>;
  stats(): Promise<BrainStats>;
  list(opts?: {
    type?: string;
    tag?: string;
    status?: string;
    relevance?: string;
    limit?: number;
  }): Promise<BrainDocument[]>;
  read(path: string): Promise<string>;
  sync(): Promise<BrainSyncResult>;
  add(
    content: string,
    opts?: { type?: string; title?: string; tags?: string[] }
  ): Promise<void>;
  index(opts?: { force?: boolean }): Promise<void>;
  validate(): Promise<string>;
  /** Run `brain skills sync` — re-materialize every agent's skill links. */
  skillsSync(): Promise<string>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * argv prefix for invoking the brain CLI inside `brainPath`.
 *
 * Two brain-repo layouts exist and both must work: a repo that depends on
 * `@schlessera/brain` gets a real bin at `node_modules/.bin/brain`, while the
 * legacy layout vendors `scripts/brain-cli.ts`. Prefer the packaged bin.
 *
 * Resolved per call (a bare `existsSync` stat) rather than at construction: in
 * the container the brain repo is cloned and `bun install`ed by entrypoint.sh,
 * and a repo can gain the dependency without restarting this server. The same
 * preference order is mirrored in `scripts/entrypoint.sh`, which links whichever
 * it finds onto PATH for cron.
 */
export function brainCliCommand(brainPath: string): string[] {
  const packaged = join(brainPath, "node_modules", ".bin", "brain");
  if (existsSync(packaged)) return [packaged];
  return ["bun", "scripts/brain-cli.ts"];
}

export function createBrainClient(opts: { brainPath: string }): BrainClient {
  const { brainPath } = opts;

  async function execBrain(args: string[]): Promise<ExecResult> {
    const proc = Bun.spawn([...brainCliCommand(brainPath), ...args], {
      cwd: brainPath,
      stdout: "pipe",
      stderr: "pipe",
      // Force JSON output when not a TTY
      env: subprocessEnv({ NO_COLOR: "1" }),
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

  return {
    cliCommand() {
      return brainCliCommand(brainPath);
    },

    async search(query, opts) {
      const args = ["search", query];
      if (opts?.type) args.push("--type", opts.type);
      if (opts?.tag) args.push("--tag", opts.tag);
      if (opts?.limit) args.push("--limit", String(opts.limit));
      if (opts?.mode) args.push("--mode", opts.mode);

      const result = await execBrain(args);
      const parsed = parseJsonOutput<BrainSearchResponse | BrainSearchResult[]>(result);
      // brain returns {results, warnings} since 22e82e1; tolerate the old bare array
      return Array.isArray(parsed) ? { results: parsed, warnings: [] } : parsed;
    },

    async briefing() {
      const result = await execBrain(["briefing"]);
      if (result.exitCode !== 0) {
        throw new Error(`brain briefing failed: ${result.stderr}`);
      }
      return result.stdout;
    },

    async stats() {
      const result = await execBrain(["stats"]);
      return parseJsonOutput(result);
    },

    async list(opts) {
      const args = ["list"];
      if (opts?.type) args.push("--type", opts.type);
      if (opts?.tag) args.push("--tag", opts.tag);
      if (opts?.status) args.push("--status", opts.status);
      if (opts?.relevance) args.push("--relevance", opts.relevance);
      if (opts?.limit) args.push("--limit", String(opts.limit));

      const result = await execBrain(args);
      return parseJsonOutput(result);
    },

    async read(path) {
      const result = await execBrain(["read", path]);
      if (result.exitCode !== 0) {
        throw new Error(`brain read failed: ${result.stderr}`);
      }
      return result.stdout;
    },

    async sync() {
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
    },

    async add(content, opts) {
      const args = ["add", content];
      if (opts?.type) args.push("--type", opts.type);
      if (opts?.title) args.push("--title", opts.title);
      if (opts?.tags) args.push("--tags", opts.tags.join(","));

      const result = await execBrain(args);
      if (result.exitCode !== 0) {
        throw new Error(`brain add failed: ${result.stderr}`);
      }
    },

    async index(opts) {
      const args = ["index"];
      // Full rebuild; indexing is incremental by default since brain 22e82e1.
      if (opts?.force) args.push("--force");

      const result = await execBrain(args);
      if (result.exitCode !== 0) {
        throw new Error(`brain index failed: ${result.stderr}`);
      }
    },

    async skillsSync() {
      const result = await execBrain(["skills", "sync"]);
      if (result.exitCode !== 0) {
        throw new Error(
          `brain skills sync failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
        );
      }
      return result.stdout;
    },

    async validate() {
      const result = await execBrain(["validate"]);
      if (result.exitCode !== 0) {
        throw new Error(`brain validate failed: ${result.stderr}`);
      }
      return result.stdout;
    },
  };
}
