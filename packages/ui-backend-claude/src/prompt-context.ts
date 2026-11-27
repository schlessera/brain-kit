import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { textOfParts } from "@schlessera/brain-ui-sdk/server";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { directory, regular } from "./worker-state.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionPromptContext, sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { envSnapshot } from "./config/env.js";
/** Content-free provenance survives loss of the append file or its directory. */
export function claudePromptContextProvenanceLocation(brainPath: string, sessionId: string, env = envSnapshot()) {
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const { dir, name } = sessionPromptContextLocation(root, brainPath, sessionId);
  const provenance = `${dir}.required`, brain = realpathSync(brainPath);
  if (isWithin(brain, provenance) || isWithin(provenance, brain))
    throw new Error("Claude prompt provenance must be outside the authoritative brain");
  return { dir: provenance, name };
}
const REQUIRED = "snapshot-required";
/** Uses host native storage; profile overrides cannot change replay ownership. */
export function claudePromptContext(brainPath: string, sessionId: string, env = envSnapshot(), existing = false) {
  const context = sessionPromptContext(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), brainPath, sessionId);
  const provenance = claudePromptContextProvenanceLocation(brainPath, sessionId, env);
  const marker = join(provenance.dir, provenance.name);
  let required = false;
  try {
    if (regular(marker, 64).toString() !== REQUIRED) throw new Error("Invalid Claude prompt-context provenance");
    required = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    const append = context.append();
    if (typeof append !== "string" && (required || append !== undefined))
      throw new Error("Saved Claude session prompt context is missing or invalid; resume refused.");
    // No context and no provenance means an older session with unknown origin.
    // Retain the first observed append, as before host snapshots existed.
  }
  return { ...context, retainAppend(candidate: string, initialFacts: Record<string, string> = {}) {
    const retained = context.retainAppend(candidate, initialFacts);
    // Record provenance before returning any append to SDK assembly. A failed
    // marker write releases no prompt; retry retains the already-saved append.
    directory(provenance.dir);
    try { writeFileSync(marker, REQUIRED, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || regular(marker, 64).toString() !== REQUIRED) throw error;
    }
    return retained;
  } };
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
  // The owned entry was appended by this turn: walk back from the end and parse
  // only lines naming its id. An unparsable candidate is skipped, not thrown:
  // leaving the turn unacknowledged only repeats facts on the next prompt.
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes(owned.id)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "user" || entry.uuid !== owned.id) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? textOfParts(content, "") : undefined;
    if (text === owned.text) { claudePromptContext(brainPath, sessionId).acknowledge(owned.id); return; }
  }
}
