/**
 * Files that tools leave beside a brain's content: OS metadata, editor swap
 * and backup files, LaTeX byproducts. `brain sync assess` classifies them as
 * ARTIFACT, `brain doctor` reports any that are committed, and the brain
 * template's `.gitignore` ignores every one. One list, so the three cannot
 * disagree; `tests/template-leftovers.test.ts` holds the template to it.
 */

export const TOOL_LEFTOVER_PATTERNS = [
  // OS metadata (a Windows download marks a file with a :Zone.Identifier stream,
  // which WSL shows as its own file).
  ".DS_Store",
  "Thumbs.db",
  "Desktop.ini",
  "*:Zone.Identifier",
  // Editor swap and backup files.
  "*.swp",
  "*.swo",
  "*~",
  // LaTeX byproducts.
  "*.aux",
  "*.out",
  "*.toc",
  "*.synctex.gz",
  "*.fls",
  "*.fdb_latexmk",
] as const;

function globToRegex(pattern: string): RegExp {
  const body = pattern
    .split(/(\*)/)
    .map((p) => (p === "*" ? ".*" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/** Whether `path`, or its last segment, matches one of `patterns` (`*` is any run of characters). */
export function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  const base = path.split("/").pop() ?? path;
  return patterns.some((p) => {
    const re = globToRegex(p);
    return re.test(path) || re.test(base);
  });
}

export function isToolLeftover(path: string): boolean {
  return matchesAnyPattern(path, TOOL_LEFTOVER_PATTERNS);
}
