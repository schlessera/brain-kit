import { isAbsolute, join, normalize } from "node:path";
import { BRAIN_LOCK_KEY, bashLockKey } from "@schlessera/brain-ui-sdk/internal";
import { bashCommand } from "@schlessera/brain-ui-sdk/internal";

import { QUERY_ACTIVITY_TOOL_NAME } from "./activity-tool.js";
import { ASK_USER_TOOL_NAME } from "./ask-user-tool.js";
import { GET_LOCATION_TOOL_NAME } from "./location-tool.js";
import { SHOW_BLOCK_TOOL_NAME } from "./show-block-tool.js";

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
export const BRAIN_UPDATE_TOOL = "mcp__brain-ui__brain_update";

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
  "mcp__brain-ui__brain_add",
  BRAIN_UPDATE_TOOL,
  // Direct backend consumers without a hosted application bridge retain
  // the original project MCP auto-allow posture. Hosted options shadow it.
  `${BRAIN_MCP_PREFIX}brain_add`,
  `${BRAIN_MCP_PREFIX}brain_update`,
  // Read-only jobs queue; chat already allows its CLI spelling through Bash.
  `${BRAIN_MCP_PREFIX}jobs_review`,
];

/**
 * The voice posture: the tool set a spoken turn runs under.
 *
 * The membership, and every reason below, comes from
 * `docs/decisions/voice-permission.md` ("The voice posture"). A change to this
 * list is a change to that record first. It is selected like any other
 * allowlist (a profile's `allowedTools`, or the backend's), and it is only a
 * boundary when the turn also declares `enforceAllowedTools`. Without that,
 * the runtime's own shortcuts can still admit a tool this list leaves out.
 * A spoken turn also has nobody to answer an approval card, so it declares
 * `noGrantSurface` as well; the two declarations are separate, and #173
 * refuses the second without the first. Under both, a tool left out is
 * denied where it is raised rather than parked on a card.
 *
 * Left out, each on purpose:
 * - `Bash`: 192 of 192 measured approvals came from it, and its payload cannot
 *   be read aloud (median 118 spoken seconds). Removing it removes the problem
 *   instead of narrating it.
 * - `Write`, `Edit`, `NotebookEdit`: raw writes to arbitrary paths. The brain
 *   document tools cover the legitimate eyes-free write and keep frontmatter
 *   and the index correct.
 * - `Agent`: a subagent's own `Bash`/`Edit`/`Write` calls would each be
 *   denied, one at a time, inside work nobody can see.
 * - `Skill`: a skill without `Bash` fails partway, with side effects written.
 * - `LSP`: no eyes-free use.
 * - `brain_archive`: the one visibility change, and one whose damage is
 *   invisible later. An archiving `brain_update` is denied as well, because it
 *   raises a per-use confirmation this turn cannot grant.
 * - `request_image_mask`: it needs someone to paint a region. The backend
 *   appends it outside any allowlist when the host offers an editor, so it is
 *   withheld by `noGrantSurface`, not by its absence here.
 *
 * @experimental
 */
export const VOICE_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  // Read-only queries over the user's own documents: the reason to talk to a
  // brain at all.
  `${BRAIN_MCP_PREFIX}brain_search`,
  // Read-only context assembly; how a question gets an answer with sources.
  `${BRAIN_MCP_PREFIX}brain_context`,
  // Read-only, one document.
  `${BRAIN_MCP_PREFIX}brain_read`,
  // Read-only enumeration.
  `${BRAIN_MCP_PREFIX}brain_list`,
  // Read-only link traversal.
  `${BRAIN_MCP_PREFIX}brain_graph`,
  // Read-only local module queue, capped at 50 summaries; no egress.
  `${BRAIN_MCP_PREFIX}jobs_review`,
  // Capture, the most valuable eyes-free action. A create destroys nothing:
  // the worst case is an unwanted document, visible in Files and removable.
  "mcp__brain-ui__brain_add",
  // "Add this to my note about X". It never rewrites the body, only appends to
  // it, so no prose is lost. It can overwrite the six frontmatter fields, and
  // those are recoverable only if the document was committed.
  BRAIN_UPDATE_TOOL,
  // Read-only over the brain repo, for questions the brain tools do not cover.
  // No mutation, no egress.
  "Read",
  "Glob",
  "Grep",
  // Read-only egress, kept with the exposure the decision record states.
  "WebSearch",
  "WebFetch",
  // The bridge tools, minus the mask editor. None of them is a permission
  // decision, and each is appended per turn only when the host offers it; they
  // are named here so the posture states its whole membership.
  ASK_USER_TOOL_NAME,
  GET_LOCATION_TOOL_NAME,
  QUERY_ACTIVITY_TOOL_NAME,
  SHOW_BLOCK_TOOL_NAME,
]);

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
  "mcp__brain-ui__brain_add",
  BRAIN_UPDATE_TOOL,
  "mcp__brain-ui__brain_archive",
  `${BRAIN_MCP_PREFIX}brain_add`,
  `${BRAIN_MCP_PREFIX}brain_update`,
  `${BRAIN_MCP_PREFIX}brain_archive`,
]);

// Module tool names are open-ended. Dispatch all brain MCP candidates through
// lockKeyForTool; named reads below return null and acquire no lock.
export const MUTATING_TOOL_MATCHER = `^(${[...MUTATING_TOOLS].join("|")}|${BRAIN_MCP_PREFIX}.*)$`;

// module-mcp-tools.md §6 requires unknown brain tools to serialize. Exempt
// only these named reads, never a module's own readOnlyHint or an allowlist.
const BRAIN_READ_TOOLS = new Set([
  `${BRAIN_MCP_PREFIX}brain_search`,
  `${BRAIN_MCP_PREFIX}brain_context`,
  `${BRAIN_MCP_PREFIX}brain_read`,
  `${BRAIN_MCP_PREFIX}brain_list`,
  `${BRAIN_MCP_PREFIX}brain_graph`,
  `${BRAIN_MCP_PREFIX}jobs_review`,
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
 * - **The brain lock** for every brain MCP tool except the named reads above,
 *   plus the core document CLI spellings. A module may write a file AND
 *   reindex `brain.db`, so unknown names share the document writers' key.
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
  if ((toolName.startsWith(BRAIN_MCP_PREFIX) && !BRAIN_READ_TOOLS.has(toolName)) ||
      (toolName.startsWith("mcp__brain-ui__") && MUTATING_TOOLS.has(toolName))) {
    return BRAIN_LOCK_KEY;
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const path = declaredPath(toolName, input);
    // A call without a usable path fails the tool's own validation anyway;
    // locking nothing beats locking a bogus key.
    if (!path) return null;
    return `path:${normalize(isAbsolute(path) ? path : join(brainPath, path))}`;
  }
  return null;
}
