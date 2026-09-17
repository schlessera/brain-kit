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

/** How long to give the rewrite oracle. rtk answers in <10ms; this is slack. */
const RTK_TIMEOUT_MS = 2000;

/** undefined = not probed yet. Cached for the process lifetime. */
let rtkProbe: Promise<boolean> | undefined;

/** Whether the `rtk` binary is available. Probed once, cached. */
export function rtkAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (rtkProbe) return rtkProbe;
  rtkProbe = new Promise<boolean>((resolve) => {
    try {
      execFile(
        "rtk",
        ["--version"],
        { timeout: RTK_TIMEOUT_MS, env },
        (err) => {
          resolve(!err);
        }
      );
    } catch {
      resolve(false);
    }
  });
  return rtkProbe;
}

/** @internal Test seam — reset the cached probe. */
export function resetRtkProbe(): void {
  rtkProbe = undefined;
}

/**
 * Rewrite one bash command through rtk, or return it unchanged when rtk is
 * absent, declines, or errors. The result is what should actually execute.
 */
export async function rtkRewriteCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  if (!(await rtkAvailable(env))) return command;
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const stdout = await new Promise<string | null>((resolve) => {
    try {
      const child = execFile(
        "rtk",
        ["hook", "claude"],
        { timeout: RTK_TIMEOUT_MS, maxBuffer: 1024 * 1024, env },
        (err, out) => resolve(err ? null : out)
      );
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
