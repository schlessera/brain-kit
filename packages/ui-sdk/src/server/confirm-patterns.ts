/**
 * The shared confirm-before-run policy for agent Bash commands.
 *
 * Both backends auto-allow their Bash tool (an approval card per command is
 * unusable), but a small set of destructive command shapes still raises a
 * confirmation card before running. The POLICY is backend-independent — what
 * counts as "worth stopping on" does not change with the model runtime — so
 * the patterns live here and each backend consults them from its own
 * permission path (Claude: PreToolUse hook; pi: the tool_call gate).
 *
 * WHAT THIS IS NOT. It is not containment. An agent with Bash can always
 * reach the same effect another way — `sh -c`, a heredoc, a script it just
 * wrote — and nothing here tries to stop that. The threat this addresses is
 * an agent doing something destructive you did not intend, not an adversary
 * evading a control. Read it as a seatbelt, not a lock; the real boundary is
 * auth.
 *
 * Matched case-insensitively against the whole command string, so a pattern
 * fires wherever it appears in a pipeline.
 */
export const DEFAULT_CONFIRM_BASH_PATTERNS: readonly string[] = [
  // Archiving is a VISIBILITY change, and that is the reason to confirm it —
  // not that it is hard to undo (it is a move inside a git repo). An archived
  // document drops out of search, briefings and context assembly, so a silent
  // archive shows up later as holes in output you cannot account for: results
  // that should have been there simply are not, with nothing pointing at why.
  String.raw`\bbrain\s+archive\b`,
  // Recursive delete, in any of its spellings.
  String.raw`\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]`,
  // History rewrites and discards — recoverable only if you notice in time.
  String.raw`\bgit\s+push\b.*--force`,
  String.raw`\bgit\s+reset\b.*--hard`,
  String.raw`\bgit\s+clean\b.*-[a-zA-Z]*f`,
  // Truncation via redirect into a tracked path is easy to do by accident.
  String.raw`\bgit\s+checkout\b.*\s--\s`,
];

/** Compile pattern sources, skipping (and reporting) any that will not parse. */
export function compileConfirmPatterns(
  sources: readonly string[],
  onInvalid: (source: string, message: string) => void
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, "i"));
    } catch (e) {
      // A bad pattern must not take the backend down: the safe direction to
      // fail is "this one never matches", reported loudly.
      onInvalid(source, e instanceof Error ? e.message : String(e));
    }
  }
  return compiled;
}

/**
 * Why an archiving document update stops for approval. Shown on the card, so
 * it says what the change does rather than which rule it tripped.
 */
export const ARCHIVING_UPDATE_REASON =
  'Setting status to "archived" removes this document from search, briefings and context assembly.';

/**
 * True when a document-update tool call is an archive in disguise.
 *
 * Both backends auto-allow their brain document update tool, on the argument
 * that it is strictly narrower than the raw file tools they already allow.
 * That argument holds for the frontmatter and body it writes; it does not
 * hold for `status`, which the archive path sets too. `status: "archived"`
 * makes precisely the visibility change `brain archive` confirms above and
 * `brain_archive` keeps a card for, so it confirms as well.
 *
 * Only that one value. "active" and "draft" change nothing about what search
 * can see, and an update with no `status` is an ordinary edit — a card on
 * every document edit is the noise that gets the whole mechanism switched
 * off, which protects nothing.
 *
 * Matched exactly, not case-insensitively: the tool's own schema is an enum
 * of the three lowercase spellings, so any other casing is refused by the
 * tool before it writes anything. Accepting near-misses here would only add
 * cards for calls that never archive.
 */
export function archivesDocument(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  return (input as { status?: unknown }).status === "archived";
}

/** The command string a Bash tool call is about to run, if it has one. */
export function bashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command : null;
}
