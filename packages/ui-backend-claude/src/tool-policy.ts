import { isAbsolute, join, normalize } from "node:path";
import {
  BRAIN_LOCK_KEY,
  bashCommand,
  bashLockKey,
} from "@schlessera/brain-ui-sdk/server";

/**
 * The brain repo registers the brain CLI's MCP server project-scoped in its
 * `.mcp.json` under the key `brain`, so the SDK exposes those tools as
 * `mcp__brain__<tool>`. A different key in `.mcp.json` yields a different
 * prefix and these entries stop matching — the tools then prompt, which is the
 * safe direction to fail.
 */
const BRAIN_MCP_PREFIX = "mcp__brain__";

/**
 * The document update tool, named once: it is auto-allowed below, serialized
 * as a mutating tool, AND gated on one input shape by the PreToolUse hook.
 * Three places that must agree.
 */
export const BRAIN_UPDATE_TOOL = `${BRAIN_MCP_PREFIX}brain_update`;

export const DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "LSP",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Skill",
  "NotebookEdit",
  // The brain's own document tools. Auto-allowed because the CONTENT they
  // write is content the raw file tools above could already write: an agent
  // that wanted to change the repo never needed brain_add to do it, and
  // routing the change through these keeps frontmatter and the search index
  // correct. Deliberately absent: `brain_archive`, which changes what search,
  // briefings and context assembly can SEE — that one keeps its approval card.
  //
  // The content argument does not extend to visibility, and two paths used to
  // get there anyway:
  //
  // - `brain archive x.md` through the auto-allowed Bash tool, which is the
  //   form the brain repo's own CLAUDE.md documents;
  // - `brain_update` with `status: "archived"`, which is the identical
  //   visibility change through the auto-allowed tool listed below.
  //
  // Both are closed from the PreToolUse hook, which is the only place an
  // auto-allowed call is seen before it runs: DEFAULT_CONFIRM_BASH_PATTERNS
  // matches the command, `archivesDocument` matches that one input shape. No
  // other brain_update asks — a card on every document edit would be worse
  // than the hole.
  //
  // A THIRD path is deliberately NOT closed: `Write` and `Edit`, listed
  // above, can put `status: archived` straight into a document's frontmatter
  // and nothing here fires. That is not an oversight and not a boundary this
  // list claims to hold. The raw file tools are a different trust class —
  // they can write anything anywhere in the repo, so a confirmation keyed on
  // one frontmatter value would be theatre — and DEFAULT_CONFIRM_BASH_PATTERNS
  // says what this whole mechanism is: a seatbelt against an agent doing
  // something you did not intend, not containment of one trying to evade it.
  // What the gate above buys is that the tools whose PURPOSE is document
  // management cannot make a document invisible quietly.
  `${BRAIN_MCP_PREFIX}brain_search`,
  `${BRAIN_MCP_PREFIX}brain_context`,
  `${BRAIN_MCP_PREFIX}brain_read`,
  `${BRAIN_MCP_PREFIX}brain_list`,
  `${BRAIN_MCP_PREFIX}brain_graph`,
  `${BRAIN_MCP_PREFIX}brain_add`,
  BRAIN_UPDATE_TOOL,
];

/**
 * Tools whose execution MAY mutate the shared working tree, and therefore may
 * take a lock. Which lock — if any — is decided per call by
 * {@link lockKeyForTool} from the tool's actual input. A subagent's own
 * Bash/Edit/Write calls surface here under their own names and are gated
 * individually.
 *
 * The lock is acquired in a PreToolUse hook, NOT in canUseTool: the SDK
 * auto-allows tools listed in `allowedTools` without ever consulting
 * canUseTool, while PreToolUse fires (and is awaited) before every tool
 * execution regardless of how it was permitted.
 */
export const MUTATING_TOOLS = new Set([
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  `${BRAIN_MCP_PREFIX}brain_add`,
  BRAIN_UPDATE_TOOL,
  `${BRAIN_MCP_PREFIX}brain_archive`,
]);

export const MUTATING_TOOL_MATCHER = `^(${[...MUTATING_TOOLS].join("|")})$`;

const BRAIN_DOC_TOOLS = new Set([
  `${BRAIN_MCP_PREFIX}brain_add`,
  BRAIN_UPDATE_TOOL,
  `${BRAIN_MCP_PREFIX}brain_archive`,
]);

/**
 * Lock keys partition contention instead of the old single global mutex,
 * which serialized every mutating tool across every session — under agent
 * fan-outs that collapsed a multi-session host into a single-session one
 * (waiters stalled in the PreToolUse hook past the CLI's hook timeout, which
 * then REFUSED their tool calls with a message the model reads as a denial).
 *
 * Three domains:
 *
 * - **Per-path** for tools that declare their target file. Two agents writing
 *   different files never contend; two writing the same file serialize, which
 *   is exactly when they should.
 * - **The git lock** for Bash commands that touch git's staging area or
 *   history. This is the one genuine repo-wide hazard: `git add` from one
 *   session landing inside another session's `git add && git commit` commits
 *   the wrong files — silently. Single git commands failing on index.lock are
 *   retryable errors; interleaved staging is corruption.
 * - **The brain lock** for the brain document tools (and their CLI spellings),
 *   which write a file AND reindex `brain.db`. Their bursts are short, so one
 *   shared key is cheap and spares SQLite the busy-retries.
 *
 * Everything else — curl, builds, tests, greps, plain file reads — takes NO
 * lock. That is the load-bearing change: a two-minute `bun run build` in one
 * session no longer freezes every writer in every other session.
 *
 * A Bash command the classifier misses (a script that runs git internally)
 * falls back to git's own index.lock, which fails cleanly and visibly — the
 * same residual exposure this backend always accepted for cross-process
 * writers in the same repo. A false positive merely over-serializes one
 * command.
 */

/** The declared target path of a path-scoped tool call, if it has one. */
function declaredPath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const raw =
    toolName === "NotebookEdit" ? record.notebook_path : record.file_path;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/**
 * The lock key one tool call must hold while it executes, or null for no
 * lock. Exported for tests: this classification IS the serialization policy.
 */
export function lockKeyForTool(
  toolName: string,
  input: unknown,
  brainPath: string
): string | null {
  if (toolName === "Bash") {
    const command = bashCommand(input);
    if (!command) return null;
    return bashLockKey(command);
  }
  if (BRAIN_DOC_TOOLS.has(toolName)) return BRAIN_LOCK_KEY;
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const path = declaredPath(toolName, input);
    // A call without a usable path fails the tool's own validation anyway;
    // locking nothing beats locking a bogus key.
    if (!path) return null;
    return `path:${normalize(isAbsolute(path) ? path : join(brainPath, path))}`;
  }
  return null;
}
