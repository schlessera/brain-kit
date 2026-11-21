/** Host-owned native selection, fixed before a session's first provider request. */
import { SESSION_PROMPT_CONTEXT_MAX_BYTES, sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { createHash } from "node:crypto";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { envSnapshot } from "./config/env.js";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { FIRST_PARTY_FAILURE_CLASSES } from "@schlessera/brain-ui-sdk/protocol";
import { regular } from "./worker-state.js";

export class SessionRosterIncompatibleError extends BackendRequestError {
  readonly errorClass = FIRST_PARTY_FAILURE_CLASSES.session_roster_incompatible;
  constructor() { super("session_roster_incompatible: this session's retained tools conflict with current mandatory exclusions. Resume under its compatible authority or start a new conversation."); }
}

export const HOST_UNUSED_BUILTINS = Object.freeze([
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger",
  "SendMessage", "ListAgents",
]);
export interface ClaudeSessionRequestShape {
  version: 4;
  selectionDigest: string;
  disallowedTools: string[];
  /** null means the original setting is unknown: retain legacy unpinned behavior. */
  toolSearch: "true" | "false" | null;
}
const invalid = () => new Error("Invalid saved Claude session request shape");
const digest = (roster: string[], toolSearch: ClaudeSessionRequestShape["toolSearch"]) =>
  createHash("sha256").update(JSON.stringify({ version: 4, disallowedTools: roster, toolSearch })).digest("hex");

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
  const state = JSON.parse(regular(path, SESSION_PROMPT_CONTEXT_MAX_BYTES).toString("utf8"));
  if (!state || Array.isArray(state) || typeof state.append !== "string") throw invalid();
  const validate = (value: unknown): ClaudeSessionRequestShape => {
    const shape = value as ClaudeSessionRequestShape | undefined;
    if (!shape || typeof shape !== "object" || Array.isArray(shape) || shape.version !== 4
      || Object.keys(shape).sort().join(",") !== "disallowedTools,selectionDigest,toolSearch,version"
      || !Array.isArray(shape.disallowedTools) || shape.disallowedTools.length === 0
      || !shape.disallowedTools.every(name => typeof name === "string" && name.length > 0)
      || new Set(shape.disallowedTools).size !== shape.disallowedTools.length
      || !shape.disallowedTools.includes("AskUserQuestion")
      || shape.selectionDigest !== digest(shape.disallowedTools, shape.toolSearch)
      || ![null, "true", "false"].includes(shape.toolSearch)) throw invalid();
    return shape;
  };
  if (state.claudeRequestShapeInitialized !== undefined) {
    if (state.claudeRequestShapeInitialized !== true) throw invalid();
    const saved = validate(state.claudeRequestShape);
    if (!legacy.every(name => saved.disallowedTools.includes(name))) throw new SessionRosterIncompatibleError();
    return saved;
  }
  if (state.claudeRequestShape !== undefined) throw invalid();
  const selectedRoster = resumed ? legacy : candidate;
  if (!legacy.every(name => selectedRoster.includes(name))) throw invalid();
  const selectedPin = resumed ? null : toolSearch;
  const selected = validate({ version: 4, selectionDigest: digest(selectedRoster, selectedPin), disallowedTools: selectedRoster, toolSearch: selectedPin });
  state.claudeRequestShapeInitialized = true;
  state.claudeRequestShape = selected;
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded) > SESSION_PROMPT_CONTEXT_MAX_BYTES)
    throw new Error("Session request shape exceeds its 64 MiB storage limit; migration refused without writing.");
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temp, encoded, { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return selected;
}
