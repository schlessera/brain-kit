/**
 * rtk integration — https://github.com/rtk-ai/rtk
 *
 * rtk is a token-optimizing CLI proxy: `rtk git status` prints a compact form
 * of `git status`, cutting most of the bash output an agent reads (60-90% on
 * supported commands) with no semantic loss. Both backends route their bash
 * commands through `rtk hook claude` — rtk's own rewrite oracle, which reads
 * a PreToolUse-shaped JSON on stdin and answers with an updatedInput when it
 * knows how to proxy the command, and stays silent when it does not.
 *
 * The integration is OPPORTUNISTIC: when the `rtk` binary is not on PATH (or
 * misbehaves) every command runs exactly as written. Nothing here may ever
 * fail a tool call — the fallback is always the original command.
 */

import { execFile } from "node:child_process";

/**
 * The host already performs rewriting; a fresh worker HOME must not invite
 * the model to install global hooks. RTK v0.50.0 reads this missing-hook-only
 * override (src/core/config.rs::hook_warning_suppressed and
 * src/hooks/hook_check.rs::warning_text):
 * https://github.com/rtk-ai/rtk/blob/v0.50.0/src/core/config.rs#L283-L291
 * Keep the original command output and exit code, rather than filtering it.
 */
export const RTK_WORKER_ENV = { RTK_SUPPRESS_HOOK_WARNING: "1" } as const;

/** How long to give the rewrite oracle. rtk answers in <10ms; this is slack. */
const RTK_TIMEOUT_MS = 2000;

/** Probe this environment now; no successful host answer crosses workers. */
export function rtkAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  return available("rtk", env);
}
function available(binary: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<boolean> {
  return new Promise(resolve => {
    try { execFile(binary, ["--version"], { timeout: RTK_TIMEOUT_MS, env, ...(cwd ? { cwd } : {}) }, err => resolve(!err)); }
    catch { resolve(false); }
  });
}
/** @internal Compatibility for existing test callers; probes are no longer cached. */
export function resetRtkProbe(): void {}

/** Internal server-only oracle for a verified installed, worker-visible binary. */
export function rewriteInstalledRtk(command: string, binary: string): Promise<string> {
  return rewrite(command, { PATH: "/usr/bin:/bin", HOME: "/nonexistent", ...RTK_WORKER_ENV }, binary, "/");
}

/**
 * Rewrite one bash command through rtk, or return it unchanged when rtk is
 * absent, declines, or errors. The result is what should actually execute.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export async function rtkRewriteCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return rewrite(command, env, "rtk");
}
async function rewrite(command: string, env: NodeJS.ProcessEnv, binary: string, cwd?: string): Promise<string> {
  if (!(await available(binary, env, cwd))) return command;
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const stdout = await new Promise<string | null>((resolve) => {
    try {
      const child = execFile(
        binary,
        ["hook", "claude"],
        { timeout: RTK_TIMEOUT_MS, maxBuffer: 1024 * 1024, env, ...(cwd ? { cwd } : {}) },
        (err, out) => resolve(err ? null : out)
      );
      // An oracle can exit before consuming its input. Stream errors arrive
      // asynchronously, outside this try/catch; a broken optional oracle must
      // fall back even if its exit callback later supplies a valid reply.
      child.stdin?.on("error", () => resolve(null));
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
  if (!stdout || !stdout.trim()) return command;
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: unknown } };
    };
    const rewritten = parsed.hookSpecificOutput?.updatedInput?.command;
    return typeof rewritten === "string" && rewritten.trim() ? rewritten : command;
  } catch {
    return command;
  }
}
