import { existsSync } from "fs";
import { join } from "path";
import type { Logger } from "@opentelemetry/api-logs";
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
    opts?: { type?: string; tag?: string; limit?: number; mode?: string; signal?: AbortSignal }
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
 * First core release whose parser understands `--`. The ui-server inserts the
 * separator before user input, so an older brain repo pin would lose every
 * positional silently.
 */
export const MIN_BRAIN_CLI_VERSION = "0.33.0";

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

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(
    // Full SemVer 2.0.0 grammar: prerelease and build metadata are
    // dot-separated NON-EMPTY identifiers. A loose `[0-9A-Za-z.-]+` would
    // accept "0.32.9-.." and treat garbage as a real prerelease, which the
    // comparison below would then refuse to boot on instead of warning.
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  };
}

function isBelowMinimum(found: ParsedVersion, minimum: ParsedVersion): boolean {
  for (const key of ["major", "minor", "patch"] as const) {
    if (found[key] !== minimum[key]) return found[key] < minimum[key];
  }
  return found.prerelease && !minimum.prerelease;
}

/** Probe the brain repo's own CLI pin, refusing only known-incompatible versions. */
export function probeBrainCliVersion(brainPath: string, log: Logger): void {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([...brainCliCommand(brainPath), "--version"], {
      cwd: brainPath,
      stdout: "pipe",
      stderr: "pipe",
      env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
      timeout: 5_000,
    });
  } catch (error) {
    log.emit({
      severityText: "WARN",
      body: "brain CLI version probe failed; continuing",
      attributes: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  if (result.exitCode !== 0) {
    log.emit({
      severityText: "WARN",
      body: "brain CLI version probe failed; continuing",
      attributes: { "exit.code": result.exitCode },
    });
    return;
  }

  const foundText = new TextDecoder().decode(result.stdout).trim();
  const found = parseVersion(foundText);
  const minimum = parseVersion(MIN_BRAIN_CLI_VERSION)!;
  if (!found) {
    log.emit({
      severityText: "WARN",
      body: "brain CLI returned an unparseable version; continuing",
      attributes: { version: foundText },
    });
    return;
  }

  if (isBelowMinimum(found, minimum)) {
    throw new Error(
      `brain CLI version ${foundText} is incompatible: version ${MIN_BRAIN_CLI_VERSION} ` +
        `or newer is required; bump the brain repo's @schlessera/brain pin before deploying.`
    );
  }
}

/** Interactive search must finish or fail within a bounded time. */
const SEARCH_TIMEOUT_MS = 15_000;

export function createBrainClient(opts: { brainPath: string; searchTimeoutMs?: number }): BrainClient {
  const { brainPath } = opts;
  const searchTimeoutMs = opts.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  if (!Number.isFinite(searchTimeoutMs) || searchTimeoutMs <= 0) {
    throw new Error("searchTimeoutMs must be a positive finite number");
  }

  async function execBrain(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    signal?.throwIfAborted();
    const proc = Bun.spawn([...brainCliCommand(brainPath), ...args], {
      cwd: brainPath,
      stdout: "pipe",
      stderr: "pipe",
      // Force JSON output when not a TTY
      env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
      // Only read-only search passes a signal. Kill even a CLI that ignores
      // SIGTERM; abandoning a request must not leave the local process alive.
      ...(signal ? { signal, killSignal: "SIGKILL" } : {}),
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      signal?.throwIfAborted();
      return { stdout, stderr, exitCode };
    } catch (error) {
      // A pipe-read failure also abandons search. Reap before its caller
      // clears the deadline; otherwise that failure could orphan the child.
      if (signal) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
      throw error;
    }
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

    async search(query, searchOpts) {
      const args = ["search"];
      if (searchOpts?.type) args.push("--type", searchOpts.type);
      if (searchOpts?.tag) args.push("--tag", searchOpts.tag);
      if (searchOpts?.limit) args.push("--limit", String(searchOpts.limit));
      if (searchOpts?.mode) args.push("--mode", searchOpts.mode);
      args.push("--", query);

      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(
        new DOMException("Search timed out. Please try again.", "TimeoutError")
      ), searchTimeoutMs);
      const signal = searchOpts?.signal
        ? AbortSignal.any([searchOpts.signal, deadline.signal])
        : deadline.signal;
      try {
        const result = await execBrain(args, signal);
        const parsed = parseJsonOutput<BrainSearchResponse | BrainSearchResult[]>(result);
        // brain returns {results, warnings} since 22e82e1; tolerate the old bare array
        return Array.isArray(parsed) ? { results: parsed, warnings: [] } : parsed;
      } finally {
        clearTimeout(timer);
      }
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
      const result = await execBrain(["read", "--", path]);
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
      const args = ["add"];
      if (opts?.type) args.push("--type", opts.type);
      if (opts?.title) args.push("--title", opts.title);
      if (opts?.tags) args.push("--tags", opts.tags.join(","));
      args.push("--", content);

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
