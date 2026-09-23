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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { BackendRuntimeReport } from "@schlessera/brain-ui-sdk/server";
import {
  execWrapperSpawnOptions,
  killWrapped,
  wrapCommand,
  type ExecWrapperConfig,
} from "@schlessera/brain-ui-sdk/server";

import { MEASURED_RUNTIME } from "./measured-runtime.js";

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

let sdkVersion: string | undefined;

/**
 * The version of the SDK copy this package loads. Read once; it cannot change
 * under a running process. `sdkEntry` is where the SDK resolved to, for tests.
 */
export function installedAgentSdkVersion(sdkEntry?: string): string {
  if (sdkEntry !== undefined) return readSdkVersion(sdkEntry);
  sdkVersion ??= readSdkVersion(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  return sdkVersion;
}

function readSdkVersion(entry: string): string {
  return (JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version: string }).version;
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
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe the binary a turn would spawn. Throws `ClaudeRuntimeUnavailableError`
 * when it is missing or will not report a version; returns what it found.
 */
export function probeClaudeRuntime(options: ClaudeRuntimeProbeOptions): BackendRuntimeReport {
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
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(wrapCommand(argv, options.exec.wrapper), {
      cwd,
      env: spawn.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: PROBE_TIMEOUT_MS,
      // A process that ignores SIGTERM would hold boot past the deadline.
      killSignal: "SIGKILL",
      ...execWrapperSpawnOptions(options.exec.wrapper),
    });
    // As for the brain CLI probe: a timed-out wrapper leaves its child behind,
    // so the group is swept whatever happened.
    if (options.exec.wrapper) killWrapped({ pid: result.pid, kill: () => {} }, options.exec, "SIGKILL");
  } catch (error) {
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code at ${spawn.command} cannot be started: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (result.exitedDueToTimeout) {
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code at ${spawn.command} did not answer --version within ${PROBE_TIMEOUT_MS / 1000} s`
    );
  }
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new ClaudeRuntimeUnavailableError(
      `Claude Code at ${spawn.command} exited ${result.exitCode} on --version: ${stderr || stdout || "(no output)"}`
    );
  }
  // Claude Code names itself; an interpreter answering for a script it could
  // not load prints a version too, and must not pass for Claude's.
  const version = stdout.match(/(\d+\.\d+\.\d+\S*) \(Claude Code\)/)?.[1];
  if (!version) {
    throw new ClaudeRuntimeUnavailableError(
      `${spawn.command} did not report a Claude Code version: ${stdout || "(no output)"}`
    );
  }
  const agentSdk = installedAgentSdkVersion();
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
