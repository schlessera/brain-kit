/** Host-owned native selection, fixed before a session's first provider request. */
import { sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { envSnapshot } from "./config/env.js";
import { regular } from "./worker-state.js";

export const HOST_UNUSED_BUILTINS = Object.freeze([
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger",
  "SendMessage", "ListAgents",
]);
export interface ClaudeSessionRequestShape {
  version: 1;
  disallowedTools: string[];
  /** null retains the pre-upgrade SDK input: no host tool-search pin. */
  toolSearch: "true" | "false" | null;
}
const invalid = () => new Error("Invalid saved Claude session request shape");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The selection and its presence marker live atomically beside the retained
 * append, not in an independently losable sidecar. Prompt-context writes retain
 * these internal fields; neither field is sent to the provider.
 */
export function retainSessionRequestShape(brain: string, session: string, resumed: boolean, candidate: string[], legacy: string[],
  env: Readonly<Record<string, string | undefined>> = envSnapshot(), toolSearch: "true" | "false" | null = null): ClaudeSessionRequestShape {
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const { dir, name } = sessionPromptContextLocation(root, brain, session);
  if (realpathSync(dir) !== dir) throw new Error("Session request storage must not contain directory aliases");
  const path = join(dir, name);
  const state = JSON.parse(regular(path, 64 * 1024 * 1024).toString("utf8"));
  if (!state || Array.isArray(state) || typeof state.append !== "string") throw invalid();
  const known = [legacy, [...legacy, ...HOST_UNUSED_BUILTINS], candidate];
  const validate = (value: unknown): ClaudeSessionRequestShape => {
    const shape = value as ClaudeSessionRequestShape | undefined;
    if (!shape || typeof shape !== "object" || Array.isArray(shape) || shape.version !== 1
      || Object.keys(shape).sort().join(",") !== "disallowedTools,toolSearch,version"
      || !Array.isArray(shape.disallowedTools) || shape.disallowedTools.length === 0
      || !shape.disallowedTools.every(name => typeof name === "string" && name.length > 0)
      || new Set(shape.disallowedTools).size !== shape.disallowedTools.length
      || !legacy.includes("AskUserQuestion") || !legacy.every(name => shape.disallowedTools.includes(name))
      || !known.some(roster => same(roster, shape.disallowedTools))
      || ![null, "true", "false"].includes(shape.toolSearch)) throw invalid();
    return shape;
  };
  if (state.claudeRequestShapeInitialized !== undefined) {
    if (state.claudeRequestShapeInitialized !== true) throw invalid();
    return validate(state.claudeRequestShape);
  }
  if (state.claudeRequestShape !== undefined) throw invalid();
  const selected = validate({ version: 1, disallowedTools: resumed ? legacy : candidate, toolSearch: resumed ? null : toolSearch });
  state.claudeRequestShapeInitialized = true;
  state.claudeRequestShape = selected;
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return selected;
}
