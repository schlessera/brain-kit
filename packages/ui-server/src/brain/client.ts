import { existsSync } from "fs";
import { join } from "path";
import type { Logger } from "@opentelemetry/api-logs";
import { ambientExecConfig, subprocessEnv } from "../config/env.js";
import { VERSION_PROBE_TIMEOUT_MS } from "@schlessera/brain-ui-sdk/internal";
import {
  probeVersionCommand,
  assertVersionRequirements,
  validateVersionMinimum,
  type ExecWrapperConfig,
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
import type { ConfiguredModule } from "@schlessera/brain-ui-sdk";
import { brainCommandClass, createHostBoundary, type HostBoundary } from "./host-boundary.js";

/**
 * A `brain sync` that exited non-zero, with its result when stdout held one:
 * an agent that failed after its runtime reported itself keeps that report.
 */
export class BrainMaintenanceUnavailable extends Error {
  constructor(message: string, readonly reason: "core_upgrade_or_probe_required" | "owner_admission_refused" = "owner_admission_refused") { super(message); }
}
export class BrainMaintenanceError extends Error {
  constructor(message: string, readonly stdout: string, readonly exitCode: number) { super(message); }
}
export interface MaintenanceRequest { signal?: AbortSignal; assertAuthorized?: () => void; bounded?: boolean }
export const STORAGE_PACK_CLI_VERSION = "0.44.0";
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
  /** Deterministic hygiene CLI; business outcomes may accompany exit 1. */
  hygiene?(args: readonly string[]): Promise<unknown>;
  /** argv prefix for invoking the brain CLI inside the repo. */
  cliCommand(): string[];
  /** Additive settings support; older injected clients may omit it. */
  modules?(): Promise<{ enabled: ConfiguredModule[]; available: unknown[] }>;
  moduleSettings?(name: string, operation: "get" | "save" | "validate" | "preview" | "migrate" | "enable" | "disable" | "action", options?: { values?: Record<string, unknown>; revision?: string; action?: string }): Promise<unknown>;
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
  index(opts?: { force?: boolean; lock?: import("@schlessera/brain-ui-sdk/server").KeyedLock }): Promise<void>;
  validate(): Promise<string>;
  /** Run `brain skills sync` — re-materialize every agent's skill links. */
  skillsSync(): Promise<string>;
  /** Run `brain scratch prune` — the periodic pass over the scratch area (#310). An aborted signal kills the child. */
  scratchPrune(opts?: MaintenanceRequest & { pinsFile?: string }): Promise<string>;
  /** Optional narrow packing capability; requires its own CLI version floor. */
  storagePack?(opts?: MaintenanceRequest): Promise<unknown>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * First core release with every command/flag this server invokes: hygiene
 * next/resolve/check/undo require 0.41.0; scratch pin input requires 0.42.0.
 * tests/cli-inventory.test.ts guards this floor as invocations change.
 */
export const MIN_BRAIN_CLI_VERSION = "0.42.0";

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
export async function probeBrainCliVersion(brainPath: string, log: Logger, options: { exec: ExecWrapperConfig; minimumVersion?: string; phase?: string; command?: readonly string[]; signal?: AbortSignal;
  /** @internal Where the CLI runs: in a maintenance worker while the host execution boundary holds (#1648). */
  boundary?: HostBoundary; outputBytes?: number; assertAuthorized?: () => void }): Promise<void> {
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
  const boundary = options.boundary ?? createHostBoundary({ brainPath, exec: options.exec });
  try {
    if (boundary.isolated()) {
      // The CLI is the brain's own code: answered from a maintenance worker.
      const answer = await boundary.run({ argv: [...command, "--version"], env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
        credentials: false, gate: "shared", purpose: "brain CLI version", ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: VERSION_PROBE_TIMEOUT_MS, ...(options.outputBytes ? { outputBytes: options.outputBytes } : {}), ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}) });
      result = { stdout: answer.stdout, stderr: answer.stderr, exitCode: answer.timedOut ? null : answer.exitCode,
        timedOut: answer.timedOut === true, cleanupWarnings: [] };
    } else {
      result = await probeVersionCommand([...command, "--version"], {
        cwd: brainPath,
        env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
        exec: options.exec,
        signal: options.signal,
      });
    }
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

/** Options for {@link createBrainClient}. */
export interface BrainClientOptions {
  brainPath: string;
  searchTimeoutMs?: number;
  minimumVersion?: string;
  log?: Logger;
  /**
   * The exec wrapper every brain CLI launch goes through. `createApp()` passes
   * its configuration's. Omitted, it is resolved from the process environment
   * once, here, so a client built directly by an embedder is never unwrapped.
   */
  exec?: ExecWrapperConfig;
  /**
   * @internal The host execution boundary (#1648). `createApp()` passes the app's.
   * Omitted, the client builds its own, so a client built directly by an
   * embedder never runs the brain's code on a host that can run a governed
   * turn.
   */
  boundary?: HostBoundary;
}

export function createBrainClient(opts: BrainClientOptions): BrainClient {
  const { brainPath } = opts;
  const exec = opts.exec ?? ambientExecConfig();
  const boundary = opts.boundary ?? createHostBoundary({ brainPath, exec });
  const minimumVersion = opts.minimumVersion;
  if (minimumVersion !== undefined) validateVersionMinimum(minimumVersion, "host versionRequirements.brainCli", "brain CLI during client construction");
  const log = opts.log ?? { emit() {}, enabled: () => false };
  const searchTimeoutMs = opts.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  if (!Number.isFinite(searchTimeoutMs) || searchTimeoutMs <= 0) {
    throw new Error("searchTimeoutMs must be a positive finite number");
  }

  async function execBrain(args: string[], signal?: AbortSignal, input?: string, lock?: import("@schlessera/brain-ui-sdk/server").KeyedLock, maintenance?: MaintenanceRequest & { minimumVersion?: string }): Promise<ExecResult> {
    signal?.throwIfAborted();
    if (maintenance?.bounded && !boundary.isolated()) throw new BrainMaintenanceUnavailable("Storage maintenance requires a qualified worker before probing repository code.");
    const command = brainCliCommand(brainPath);
    const requiredVersion = maintenance?.minimumVersion ?? minimumVersion;
    if (requiredVersion !== undefined) {
      try { await probeBrainCliVersion(brainPath, log, { exec, minimumVersion: requiredVersion, phase: "invocation", command, signal, boundary, ...(maintenance?.bounded ? { outputBytes: 1024 * 1024 } : {}), ...(maintenance?.assertAuthorized ? { assertAuthorized: maintenance.assertAuthorized } : {}) }); }
      catch (error) { signal?.throwIfAborted(); if (maintenance?.minimumVersion) throw new BrainMaintenanceUnavailable("Storage packing requires a qualified core CLI at " + maintenance.minimumVersion + " or newer.", "core_upgrade_or_probe_required"); throw error; }
      signal?.throwIfAborted();
    }
    // Every brain CLI launch goes through the host boundary, not only the
    // agent's tools. The CLI imports the repository's `brain.config.ts` and
    // its repo-resolved modules — agent-writable executable inputs — so a
    // search or a stats call executes repository code just as a tool call
    // does. While the boundary holds, that happens in a maintenance worker,
    // with the operator's exec wrapper inside it; otherwise in a host process
    // through the wrapper, as before.
    const { credentials, gate } = brainCommandClass(args);
    let entered = false;
    try { return await boundary.run({
      argv: [...command, ...args],
      // Force JSON output when not a TTY
      env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
      credentials,
      gate,
      purpose: `brain ${args.slice(0, 2).join(" ")}`,
      ...(args[0] === "sync" ? { sync: true } : {}),
      ...(lock ? { lock: { keyed: lock, key: "brain-docs" } } : {}),
      ...(maintenance?.assertAuthorized ? { assertAuthorized: maintenance.assertAuthorized } : {}),
      ...(maintenance?.bounded ? { outputBytes: 1024 * 1024, timeoutMs: 5 * 60_000, onExecute: () => { entered = true; } } : {}),
      ...(input !== undefined ? { stdin: input } : {}),
      // Only read-only search passes a signal. Kill even a CLI that ignores
      // SIGTERM; abandoning a request must not leave the local process alive.
      ...(signal ? { signal, killSignal: "SIGKILL" as const } : {}),
    }); } catch (error) {
      if (maintenance?.bounded && !entered) throw new BrainMaintenanceUnavailable("The owner refused maintenance before its command started.");
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

    async modules() {
      return parseJsonOutput(await execBrain(["module", "list", "--json"]));
    },

    async moduleSettings(name, operation, options = {}) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error("Invalid module name");
      const args = ["module", operation === "enable" || operation === "disable" ? operation : "settings", name, "--json"];
      if (operation === "save" || operation === "validate") args.push("--stdin");
      if (operation === "validate") args.push("--preview");
      if (operation === "preview" || operation === "migrate") args.push("--migrate");
      if (operation === "preview") args.push("--preview");
      if (options.revision) args.push("--revision", options.revision);
      if (operation === "action") {
        if (!options.action || !/^[a-z][a-z0-9-]*$/.test(options.action)) throw new Error("Invalid module action");
        args.push("--action", options.action);
      }
      const result = await execBrain(args, undefined, (operation === "save" || operation === "validate") ? JSON.stringify(options.values) : undefined);
      if (![0, 1].includes(result.exitCode)) throw new Error(`brain hygiene failed (exit ${result.exitCode}): ${result.stderr}`);
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch { return parseJsonOutput(result); }
      if (result.exitCode !== 0 && !(parsed && typeof parsed === "object" && "status" in parsed)) return parseJsonOutput(result);
      return parsed;
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

    async hygiene(args) {
      const result = await execBrain(["hygiene", "--json", ...args]);
      if (![0, 1].includes(result.exitCode)) throw new Error(`brain hygiene failed (exit ${result.exitCode}): ${result.stderr}`);
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`brain hygiene returned unreadable output (exit ${result.exitCode}): ${result.stderr}`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`brain hygiene failed (exit ${result.exitCode}): ${result.stderr}`);
      return parsed;
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

      const result = await execBrain(args, undefined, undefined, opts?.lock);
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

    async storagePack(opts) {
      const result = await execBrain(["storage", "pack", "--json"], opts?.signal, undefined, undefined, { ...opts, bounded: true, minimumVersion: STORAGE_PACK_CLI_VERSION });
      if (result.exitCode !== 0 && result.exitCode !== 2) throw new BrainMaintenanceError("Git packing failed", result.stdout, result.exitCode);
      return JSON.parse(result.stdout);
    },
    async scratchPrune(opts) {
      const args = ["scratch", "prune", ...(opts?.pinsFile ? ["--pins-file", opts.pinsFile, "--json"] : opts?.bounded ? ["--json"] : [])];
      const result = await execBrain(args, opts?.signal, undefined, undefined, opts);
      if (result.exitCode !== 0) {
        throw new BrainMaintenanceError(
          `brain scratch prune failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`, result.stdout, result.exitCode
        );
      }
      return result.stdout;
    },
  };
}
