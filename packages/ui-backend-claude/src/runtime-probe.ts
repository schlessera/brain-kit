/**
 * Boot-time probe of the Claude Code binary a turn would spawn (#211,
 * docs/decisions/claude-code-runtime.md, "The server knows the version").
 *
 * The SDK's binary resolver is not exported, so this does not re-implement it.
 * The SDK resolves the binary while `query()` is being BUILT, synchronously, and
 * then hands `{ command, args }` to `spawnClaudeCodeProcess` instead of
 * spawning. The probe supplies a callback that records what it was handed and
 * throws a sentinel, so no session ever starts. For a native binary `command`
 * is the binary itself; for a JavaScript `CLAUDE_CODE_PATH` it is the
 * interpreter and the script leads `args`, so everything before the session's
 * own flags is kept and those are replaced with `--version`. That runs through
 * the same exec wrapper, environment and working directory a turn uses, so a
 * binary the agent's uid cannot execute fails here and not on the first turn.
 */
import { existsSync } from "node:fs";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { loadedSdkIdentity } from "@schlessera/brain-ui-sdk/internal";
import type { BackendRuntimeReport, BackendVersionRequirements } from "@schlessera/brain-ui-sdk/server";
import {
  probeVersionCommand,
  type VersionProbeResult,
  type BackendLogFn,
  type ExecWrapperConfig,
} from "@schlessera/brain-ui-sdk/server";
import { VERSION_PROBE_TIMEOUT_MS } from "@schlessera/brain-ui-sdk/internal";

import { MEASURED_RUNTIME } from "./measured-runtime.js";
import { assertClaudeSdk, assertClaudeRuntime, claudeRuntimeRequirements } from "./version-requirements.js";

/** Thrown when the binary a turn would spawn is missing or will not start. */
export class ClaudeRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRuntimeUnavailableError";
  }
}

/** What the SDK would hand to a spawn. */
interface SelectedSpawn {
  command: string;
  args: string[];
  /** The environment the SDK itself would give the CLI, not the one it was given. */
  env: Record<string, string | undefined>;
  cwd: string | undefined;
}

class Captured extends Error {
  constructor(readonly spawn: SelectedSpawn) {
    super("captured");
  }
}

/** The SDK identity at this backend's import site, including its owning range. */
export function installedAgentSdkVersion(sdkEntry?: string): string {
  if (sdkEntry !== undefined) {
    const identity = loadedSdkIdentity(sdkEntry, "@anthropic-ai/claude-agent-sdk");
    return identity.version;
  }
  return assertClaudeSdk(undefined, "SDK observation").version;
}

/** Whether a pair is the one the backend's behaviour was measured against. Both halves count. */
export function isMeasuredRuntime(claudeCode: string | undefined, agentSdk: string): boolean {
  return claudeCode === MEASURED_RUNTIME.claudeCode && agentSdk === MEASURED_RUNTIME.agentSdk;
}

/** What the SDK would spawn for a turn with these options. */
export function selectedSpawn(
  options: Pick<Options, "pathToClaudeCodeExecutable" | "env" | "cwd">
): SelectedSpawn {
  try {
    query({
      prompt: "",
      options: {
        ...options,
        spawnClaudeCodeProcess: (spawn) => {
          throw new Captured({
            command: spawn.command,
            args: [...spawn.args],
            env: { ...spawn.env },
            cwd: spawn.cwd,
          });
        },
      },
    });
  } catch (error) {
    if (error instanceof Captured) return error.spawn;
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code cannot be started: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  throw new ClaudeRuntimeUnavailableError(
    "Claude Code cannot be probed: the Agent SDK built a query without asking to spawn one"
  );
}

/**
 * The spawn's argv with its session arguments replaced by `--version`. For a
 * JavaScript `CLAUDE_CODE_PATH` the SDK runs an interpreter with the script
 * among its arguments; everything up to and including the script is kept.
 * Found by the path, not by the first dash — a script path may start with one.
 */
export function versionArgv(spawn: { command: string; args: string[] }, claudeCodePath?: string): string[] {
  const script = claudeCodePath !== undefined && spawn.command !== claudeCodePath ? spawn.args.indexOf(claudeCodePath) : -1;
  const prefix = script === -1 ? [] : spawn.args.slice(0, script + 1);
  return [spawn.command, ...prefix, "--version"];
}

export interface ClaudeRuntimeProbeOptions {
  /** `CLAUDE_CODE_PATH`; undefined takes the SDK's own binary. */
  claudeCodePath?: string;
  brainPath: string;
  /** The environment a turn's CLI gets. */
  env: Record<string, string | undefined>;
  exec: ExecWrapperConfig;
  log?: BackendLogFn;
  versionRequirements?: BackendVersionRequirements;
  phase?: string;
  signal?: AbortSignal;
}

/**
 * Probe the binary a turn would spawn. Throws `ClaudeRuntimeUnavailableError`
 * when it is missing or will not report a version; returns what it found.
 */
export async function probeClaudeRuntime(options: ClaudeRuntimeProbeOptions): Promise<BackendRuntimeReport & { runtime: NonNullable<BackendRuntimeReport["runtime"]> }> {
  const phase = options.phase ?? "startup probe";
  const sdk = assertClaudeSdk(options.versionRequirements, phase);
  const requirements = claudeRuntimeRequirements(options.versionRequirements, phase);
  let report: BackendRuntimeReport & { runtime: NonNullable<BackendRuntimeReport["runtime"]> };
  try {
    report = await runProbe(options, sdk.version);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (requirements.length) {
      try { assertClaudeRuntime(null, requirements, phase, reason); } catch (failure) {
        throw new ClaudeRuntimeUnavailableError(failure instanceof Error ? failure.message : String(failure));
      }
    }
    throw new ClaudeRuntimeUnavailableError(`@schlessera/brain-backend-claude runtime (claude-code) during ${phase}; required valid Claude Code version; detected unknown. ${reason}. Install/select an executable that answers --version successfully.`);
  }
  try { assertClaudeRuntime(report.runtime.version, requirements, phase); } catch (error) {
    throw new ClaudeRuntimeUnavailableError(error instanceof Error ? error.message : String(error));
  }
  return report;
}

async function runProbe(options: ClaudeRuntimeProbeOptions, agentSdk: string): Promise<BackendRuntimeReport & { runtime: NonNullable<BackendRuntimeReport["runtime"]> }> {
  const spawn = selectedSpawn({
    ...(options.claudeCodePath ? { pathToClaudeCodeExecutable: options.claudeCodePath } : {}),
    env: options.env,
    cwd: options.brainPath,
  });
  const argv = versionArgv(spawn, options.claudeCodePath);
  const cwd = spawn.cwd ?? options.brainPath;
  // A missing working directory fails the spawn with the same ENOENT a
  // missing binary does; say which it is.
  if (!existsSync(cwd)) {
    throw new ClaudeRuntimeUnavailableError(`Claude Code cannot be probed: the brain path ${cwd} does not exist`);
  }
  let result: VersionProbeResult;
  try {
    result = await probeVersionCommand(argv, { cwd, env: spawn.env, exec: options.exec, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code at ${spawn.command} cannot be started: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (result.timedOut) {
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code at ${spawn.command} did not answer --version within ${VERSION_PROBE_TIMEOUT_MS / 1000} s${result.cleanupWarnings.length ? `; ${result.cleanupWarnings.join("; ")}` : ""}`
    );
  }
  for (const warning of result.cleanupWarnings) {
    if (options.log) options.log("warn", warning); else console.error(warning);
  }
  const stdout = result.stdout.replace(/\r?\n$/, "");
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code at ${spawn.command} exited ${result.exitCode} on --version: ${stderr || stdout || "(no output)"}`
    );
  }
  // Claude Code names itself; an interpreter answering for a script it could
  // not load prints a version too, and must not pass for Claude's.
  const version = stdout.match(/^v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) \(Claude Code\)$/)?.[1];
  if (!version) {
    throw new ClaudeRuntimeUnavailableError(
      `${spawn.command} did not report a Claude Code version: ${stdout || "(no output)"}`
    );
  }
  return {
    runtime: {
      name: "claude-code",
      version,
      command: spawn.command,
      hostProvided: options.claudeCodePath !== undefined,
    },
    sdk: { name: "@anthropic-ai/claude-agent-sdk", version: agentSdk },
    measured: {
      runtime: MEASURED_RUNTIME.claudeCode,
      sdk: MEASURED_RUNTIME.agentSdk,
      matches: isMeasuredRuntime(version, agentSdk),
    },
  };
}
