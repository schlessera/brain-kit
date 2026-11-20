/** Host-owned native selection, fixed before a session's first provider request. */
import { sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { envSnapshot } from "./config/env.js";
import { regular } from "./worker-state.js";

export const HOST_UNUSED_BUILTINS = Object.freeze([
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger",
  "SendMessage", "ListAgents", "NotebookEdit",
]);

/** Shared with native history removal; selection storage belongs to its session. */
export function sessionRequestShapeLocation(root: string, brain: string, session: string) {
  const { dir, name } = sessionPromptContextLocation(root, brain, session);
  return { dir, name: `${name}.claude-tools` };
}

/**
 * Called after retainAppend has established the private host context directory.
 * A legacy native session has no selection snapshot: keep its pre-upgrade list
 * unchanged. The runtime itself retains old stdio MCP definitions.
 */
export function retainSessionRequestShape(brain: string, session: string, resumed: boolean, candidate: string[], legacy: string[]): string[] {
  const env = envSnapshot();
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const { dir, name } = sessionRequestShapeLocation(root, brain, session);
  if (realpathSync(dir) !== dir) throw new Error("Session request storage must not contain directory aliases");
  const path = join(dir, name);
  let bytes: Buffer | undefined;
  try { bytes = regular(path, 64 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (bytes !== undefined) {
    const saved = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(saved) || !saved.every((name: unknown) => typeof name === "string")) {
      throw new Error("Invalid saved Claude session request shape");
    }
    return saved;
  }
  const selected = resumed ? legacy : candidate;
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(selected), { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return selected;
}
