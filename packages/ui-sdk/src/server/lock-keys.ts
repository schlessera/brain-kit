/**
 * The shared write-serialization POLICY for agent bash commands.
 *
 * Both backends run parallel sessions (and parallel sibling tool calls)
 * against one working tree, so writes need serializing — but only writes
 * that actually contend. The old posture of locking every bash command
 * repo-wide collapses a parallel agent into a sequential one: a two-minute
 * build in one call blocks every other tool. What genuinely needs a lock:
 *
 * - **{@link GIT_LOCK_KEY}** for commands that touch git's staging area or
 *   history. This is the one repo-wide hazard: `git add` from one session
 *   landing inside another session's `git add && git commit` commits the
 *   wrong files — silently. Reads (status/log/diff/…) never serialize.
 * - **{@link BRAIN_LOCK_KEY}** for brain CLI commands that write a document
 *   AND reindex `brain.db`. Their bursts are short, so one shared key is
 *   cheap and spares SQLite the busy-retries.
 * - Everything else — curl, builds, tests, greps — takes NO lock.
 *
 * A command the classifier misses (a script that runs git internally) falls
 * back to git's own index.lock, which fails cleanly and visibly. A false
 * positive merely over-serializes one command.
 */

/** Repo-wide key for git staging/history mutations. */
export const GIT_LOCK_KEY = "repo-git";
/**
 * Key for brain document writes + reindex (MCP tools and CLI spellings).
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export const BRAIN_LOCK_KEY = "brain-docs";

/**
 * Git verbs that mutate the staging area, the working tree, or history.
 * Deliberately absent: status/log/diff/show/blame/branch/fetch and every
 * other read, so ordinary inspection never serializes. `[^\n|;&]{0,120}?`
 * keeps the match inside one pipeline segment (a `git` before a pipe cannot
 * claim a verb after it) while tolerating `-C <dir>` / `--no-pager` style
 * options between the word `git` and its verb.
 */
const GIT_BASH_PATTERN =
  /\bgit\b[^\n|;&]{0,120}?\b(add|commit|rm|mv|restore|rebase|merge|cherry-pick|revert|reset|checkout|switch|stash|apply|am|pull|push|clean|worktree)\b/;

/** brain CLI commands that drive git under the hood (sync commits/pushes). */
const GIT_BRAIN_CLI_PATTERN = /\bbrain\s+(sync|import)\b/;

/** brain CLI commands that write a document and reindex, like the MCP tools. */
const BRAIN_CLI_PATTERN = /\bbrain\s+(add|update|archive)\b/;

/**
 * The lock key one bash command must hold while it executes, or null for no
 * lock. This classification IS the serialization policy — shared so both
 * backends stop on the same hazards and parallelize the same reads.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export function bashLockKey(command: string): string | null {
  if (GIT_BASH_PATTERN.test(command) || GIT_BRAIN_CLI_PATTERN.test(command)) {
    return GIT_LOCK_KEY;
  }
  if (BRAIN_CLI_PATTERN.test(command)) return BRAIN_LOCK_KEY;
  return null;
}
