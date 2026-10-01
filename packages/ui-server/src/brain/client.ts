import { existsSync } from "fs";
import { join } from "path";
import type { Logger } from "@opentelemetry/api-logs";
import { execConfig, subprocessEnv } from "../config/env.js";
import {
  execWrapperSpawnOptions,
  killWrapped,
  wrapCommand,
  probeVersionCommand,
  assertVersionRequirements,
  validateVersionMinimum,
  type VersionProbeResult,
} from "@schlessera/brain-ui-sdk/server";
import type {
  BrainSearchResult,
  BrainSearchResponse,
  BrainDocument,
  BrainStats,
  BrainStatsHistory,
  BrainSyncResult,
  BrainAddResult,
} from "./types.js";
import { parseSyncResult, syncMessage, type BrainSyncOutput } from "./sync-result.js";

/**
 * A `brain sync` that exited non-zero, with its result when stdout held one:
 * an agent that failed after its runtime reported itself keeps that report.
 */
export class BrainSyncError extends Error {
  constructor(message: string, readonly result?: BrainSyncOutput) {
    super(message);
    this.name = "BrainSyncError";
  }
}

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
  /** `brain stats --history`: the recorded snapshots as one series per field (#581). */
  statsHistory(): Promise<BrainStatsHistory>;
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
  ): Promise<BrainAddResult>;
  index(opts?: { force?: boolean }): Promise<void>;
  validate(): Promise<string>;
  /** Run `brain skills sync` — re-materialize every agent's skill links. */
  skillsSync(): Promise<string>;
  /** Run `brain scratch prune` — the periodic pass over the scratch area (#310). An aborted signal kills the child. */
  scratchPrune(opts?: { signal?: AbortSignal }): Promise<string>;
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
 * Resolved per call (a bare `existsSync` stat) rather than at construction: a
 * container deployment may clone and `bun install` the brain repo at startup,
 * and a repo can gain the dependency without restarting this server. A
 * deployment that links the CLI onto PATH for cron should use the same
 * preference order.
 */
export function brainCliCommand(brainPath: string): string[] {
  const packaged = join(brainPath, "node_modules", ".bin", "brain");
  if (existsSync(packaged)) return [packaged];
  return ["bun", "scripts/brain-cli.ts"];
}

/** Probe the selected content CLI, keeping unknown versions warning-only by default. */
export async function probeBrainCliVersion(brainPath: string, log: Logger, options: { minimumVersion?: string; phase?: string; command?: readonly string[]; signal?: AbortSignal } = {}): Promise<void> {
  const phase = options.phase ?? "startup";
  const requirements = [{ owner: "@schlessera/brain-ui-server", kind: "minimum" as const, declaration: MIN_BRAIN_CLI_VERSION }];
  if (options.minimumVersion !== undefined) {
    validateVersionMinimum(options.minimumVersion, "host versionRequirements.brainCli", `brain CLI during ${phase}`);
    requirements.push({ owner: "host versionRequirements.brainCli", kind: "minimum", declaration: options.minimumVersion });
  }
  const command = options.command ?? brainCliCommand(brainPath);
  const action = "bump the brain repo's @schlessera/brain pin to a compatible version before deploying.";
  function unknown(reason: string, body: string, attributes?: Record<string, string | number>) {
    if (options.minimumVersion !== undefined) {
      assertVersionRequirements({ identity: "brain CLI", version: null, requirements, phase, action, unknownReason: reason });
    }
    log.emit({ severityText: "WARN", body, attributes: { reason, ...attributes } });
  }
  let result: VersionProbeResult;
  try {
    result = await probeVersionCommand([...command, "--version"], {
      cwd: brainPath,
      env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
      exec: execConfig(),
      signal: options.signal,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    unknown(error instanceof Error ? error.message : String(error), "brain CLI version probe failed; continuing");
    return;
  }
  for (const warning of result.cleanupWarnings) log.emit({ severityText: "WARN", body: warning });
  if (result.timedOut) {
    unknown("did not answer --version within 5 s", "brain CLI did not answer --version within 5 s; continuing");
    return;
  }
  if (result.exitCode !== 0) {
    unknown(`version probe exited ${result.exitCode}: ${result.stderr.trim()}`, "brain CLI version probe failed; continuing", { "exit.code": String(result.exitCode) });
    return;
  }
  const foundText = result.stdout.trim();
  // Retain the CLI's historical optional v-prefix, but never accept it in a
  // host declaration. Identity comes from this executable, not a manifest
  // belonging to the server's unrelated installation of core.
  const version = foundText.replace(/^v/, "");
  try {
    validateVersionMinimum(version, "detected version", "brain CLI");
  } catch {
    unknown(`unparseable version ${JSON.stringify(foundText)}`, "brain CLI returned an unparseable version; continuing", { version: foundText });
    return;
  }
  try {
    assertVersionRequirements({ identity: "brain CLI", version, requirements, phase, action });
  } catch (error) {
    throw new Error(`brain CLI version ${foundText} is incompatible: version ${MIN_BRAIN_CLI_VERSION} or newer is required; ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Interactive search must finish or fail within a bounded time. */
const SEARCH_TIMEOUT_MS = 15_000;

export function createBrainClient(opts: { brainPath: string; searchTimeoutMs?: number; minimumVersion?: string; log?: Logger }): BrainClient {
  const { brainPath } = opts;
  const minimumVersion = opts.minimumVersion;
  if (minimumVersion !== undefined) validateVersionMinimum(minimumVersion, "host versionRequirements.brainCli", "brain CLI during client construction");
  const log = opts.log ?? { emit() {}, enabled: () => false };
  const searchTimeoutMs = opts.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  if (!Number.isFinite(searchTimeoutMs) || searchTimeoutMs <= 0) {
    throw new Error("searchTimeoutMs must be a positive finite number");
  }

  async function execBrain(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    signal?.throwIfAborted();
    const command = brainCliCommand(brainPath);
    if (minimumVersion !== undefined) {
      await probeBrainCliVersion(brainPath, log, { minimumVersion, phase: "invocation", command, signal });
      signal?.throwIfAborted();
    }
    // Every brain CLI launch goes through the host's wrapper, not only the
    // agent's tools. The CLI imports the repository's `brain.config.ts` and
    // its repo-resolved modules — agent-writable executable inputs — so a
    // search or a stats call executes repository code just as a tool call
    // does. Leaving these two spawns unwrapped would have left the privilege
    // boundary with a hole the size of the whole read path.
    const exec = execConfig();
    const proc = Bun.spawn(wrapCommand([...command, ...args], exec.wrapper), {
      cwd: brainPath,
      stdout: "pipe",
      stderr: "pipe",
      // Force JSON output when not a TTY
      env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
      // Only read-only search passes a signal. Kill even a CLI that ignores
      // SIGTERM; abandoning a request must not leave the local process alive.
      // Bun's own signal handling kills the pid it spawned, which with a
      // wrapper is the wrapper alone — so with one configured we take the
      // abort ourselves and signal the group.
      ...(signal && !exec.wrapper ? { signal, killSignal: "SIGKILL" } : {}),
      ...execWrapperSpawnOptions(exec.wrapper),
    });
    const onAbort = () => killWrapped(proc, exec, "SIGKILL");
    if (signal && exec.wrapper) signal.addEventListener("abort", onAbort, { once: true });

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
        killWrapped(proc, exec, "SIGKILL");
        await proc.exited;
      }
      throw error;
    } finally {
      if (signal && exec.wrapper) signal.removeEventListener("abort", onAbort);
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

    async statsHistory() {
      // A CLI older than 0.40.0 rejects the flag and exits 1, which throws
      // here: the route answers 500 and the PWA draws no trends.
      const result = await execBrain(["stats", "--history"]);
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
      // The whole sync, asked for as one result (#290): the run's report,
      // and whether an agent ran and which runtime it reported. Any non-zero
      // exit is a failure here, including 3: a conflict blocked the push and
      // no agent took it. The exit code decides that, never the document: a
      // result that cannot be read only means nothing is known about the
      // agent, and a CLI older than the result prints its text instead.
      const exec = await execBrain(["sync", "--json"]);
      const result = parseSyncResult(exec.stdout) ?? undefined;
      const message = result ? syncMessage(result) : exec.stdout.trim();
      if (exec.exitCode !== 0) {
        throw new BrainSyncError(
          `brain sync failed (exit ${exec.exitCode}): ${exec.stderr.trim() || message}`,
          result
        );
      }
      return { message, ...(result ? { result } : {}) };
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
      const parsed = parseJsonOutput<BrainAddResult>(result);
      if (!parsed || typeof parsed !== "object" || typeof parsed.path !== "string" ||
          typeof parsed.indexed !== "boolean" || typeof parsed.title !== "string" ||
          typeof parsed.type !== "string" || (parsed.indexError !== undefined && typeof parsed.indexError !== "string") ||
          !["created", "appended"].includes(parsed.action)) {
        throw new Error("Capture completed but its outcome could not be read. Check your files before adding it again.");
      }
      return parsed;
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

    async scratchPrune(opts) {
      const result = await execBrain(["scratch", "prune"], opts?.signal);
      if (result.exitCode !== 0) {
        throw new Error(
          `brain scratch prune failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
        );
      }
      return result.stdout;
    },
  };
}
