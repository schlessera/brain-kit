import { existsSync, realpathSync } from "node:fs";
import { regular } from "./worker-state.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionPromptContext } from "@schlessera/brain-ui-sdk/internal";
import { envSnapshot } from "./config/env.js";
/** Uses host native storage; profile overrides cannot change replay ownership. */
export function claudePromptContext(brainPath: string, sessionId: string, env = envSnapshot()) {
  return sessionPromptContext(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), brainPath, sessionId);
}

/** A successful send becomes delivered only after its exact UUID/bytes survive native copy-out. */
export function acknowledgeClaudeContext(brainPath: string, sessionId: string, owned: { id: string; text: string },
  env: Record<string, string | undefined>) {
  if (!existsSync(brainPath)) return;
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const project = `projects/${realpathSync(brainPath).replace(/[^a-zA-Z0-9]/g, "-")}`;
  const path = join(root, project, `${sessionId}.jsonl`);
  if (!existsSync(path)) return;
  const lines = regular(path, 64 * 1024 * 1024).toString("utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.type !== "user" || entry.uuid !== owned.id) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : undefined;
    if (text === owned.text) claudePromptContext(brainPath, sessionId).acknowledge(owned.id);
  }
}
