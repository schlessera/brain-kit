/**
 * One confirm pattern and the effect it has, in words.
 *
 * @experimental
 */
export interface ConfirmPattern {
  /** Regex source, matched case-insensitively against the whole command. */
  pattern: string;
  /**
   * What running a matching command does, in words: a sentence fragment that
   * completes "I want to …". It becomes the `reason` of the approval the
   * pattern raises, so the card says what will happen rather than that a rule
   * tripped, and it is what an announcement can say when the command itself
   * is too long to read out (docs/decisions/voice-permission.md).
   */
  effect: string;
}

/**
 * A confirm pattern as a deployment may give it: the object form, or a bare
 * regex source, which is the older shape and still works — it simply has no
 * effect to name, and its approval falls back to a generic sentence.
 */
export type ConfirmPatternSource = string | ConfirmPattern;

/** A compiled confirm pattern: a RegExp, carrying its effect when it has one. */
export type CompiledConfirmPattern = RegExp & { readonly effect?: string };

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
export const DEFAULT_CONFIRM_BASH_PATTERNS: readonly ConfirmPattern[] = [
  // Archiving is a VISIBILITY change, and that is the reason to confirm it —
  // not that it is hard to undo (it is a move inside a git repo). An archived
  // document drops out of search, briefings and context assembly, so a silent
  // archive shows up later as holes in output you cannot account for: results
  // that should have been there simply are not, with nothing pointing at why.
  {
    pattern: String.raw`\bbrain\s+archive\b`,
    effect: "archive a document, which takes it out of search and briefings",
  },
  // Recursive delete, in any of its spellings.
  {
    pattern: String.raw`\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]`,
    effect: "delete a directory and everything inside it",
  },
  // History rewrites and discards — recoverable only if you notice in time.
  {
    pattern: String.raw`\bgit\s+push\b.*--force`,
    effect: "force-push, overwriting history on the remote",
  },
  {
    pattern: String.raw`\bgit\s+reset\b.*--hard`,
    effect: "discard every uncommitted change in the working tree",
  },
  {
    pattern: String.raw`\bgit\s+clean\b.*-[a-zA-Z]*f`,
    effect: "delete untracked files from the working tree",
  },
  // Truncation via redirect into a tracked path is easy to do by accident.
  {
    pattern: String.raw`\bgit\s+checkout\b.*\s--\s`,
    effect: "discard changes to specific files",
  },
];

/**
 * Compile pattern sources, skipping (and reporting) any that will not parse.
 * A nonempty list with no valid patterns throws; only an explicit empty list
 * disables confirmation. Mixed lists keep their valid patterns and effects.
 * Both forms are accepted; an entry whose pattern is not a string is reported
 * too, because `new RegExp(undefined)` would match every command.
 */
export function compileConfirmPatterns(
  sources: readonly ConfirmPatternSource[],
  onInvalid: (source: string, message: string) => void
): CompiledConfirmPattern[] {
  const compiled: CompiledConfirmPattern[] = [];
  const invalid: string[] = [];
  const reportInvalid = (source: string, message: string) => {
    invalid.push(`${JSON.stringify(source)}: ${message}`);
    onInvalid(source, message);
  };
  for (const entry of sources) {
    const source = typeof entry === "string" ? entry : entry?.pattern;
    if (typeof source !== "string") {
      reportInvalid(String(source), "a confirm pattern must be a regex source string");
      continue;
    }
    const effect =
      typeof entry === "object" && typeof entry.effect === "string" && entry.effect.trim()
        ? entry.effect
        : undefined;
    try {
      const re = new RegExp(source, "i");
      compiled.push(effect === undefined ? re : Object.assign(re, { effect }));
    } catch (e) {
      // A mixed list can still use its valid entries. Reject an entirely
      // invalid list below instead of silently disabling confirmation.
      reportInvalid(source, e instanceof Error ? e.message : String(e));
    }
  }
  if (sources.length > 0 && compiled.length === 0) {
    throw new Error(
      "confirmBashPatterns / BRAIN_UI_CONFIRM_BASH contains no valid confirmation patterns; " +
      "repair the invalid entries or explicitly set [] to disable confirmation. " +
      invalid.join("; ")
    );
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
 * Matched exactly, not case-insensitively, because both callers refuse any
 * other spelling before writing: the MCP tool's schema is a zod enum of the
 * three lowercase values, and pi's takes a free string but throws on anything
 * outside them. Accepting near-misses here would only add cards for calls
 * that cannot archive anyway.
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
