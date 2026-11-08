/**
 * Caller path scope for context assembly (#3644): an optional include list
 * and an optional exclude list of repository-relative paths, applied to every
 * lane of `assembleContext` before any source file is opened.
 *
 * An entry is an exact path, or a directory prefix when it ends in `/`
 * (`projects/` covers everything under `projects`, at any depth). There are
 * no globs. An entry is refused unless it is a plain relative path: absolute,
 * `.` or `..` segments, empty segments, `\\`, `:` and control characters are
 * errors, so no spelling can name something outside the root.
 *
 * Precedence: an exclusion wins over an inclusion, everywhere. Without an
 * include list every path is in scope unless excluded; with one, only the
 * paths it covers are. Include entries match case-sensitively, exclude entries
 * under Unicode compatibility case folding, so an alias spelling of an
 * excluded path stays excluded and an include list never covers more than it
 * names. A file is also checked under its real path (symlinks followed): an
 * in-repo link to an excluded file is excluded, and a link that leaves the
 * root is unavailable.
 *
 * Scope only narrows. It never makes a document readable that the brain's
 * index, policy or provider masks leave out.
 */

import { relative, sep } from "path";

import { safeResolve } from "./safe-path.js";

/** The most entries an include or exclude list may hold. */
export const MAX_SCOPE_ENTRIES = 64;
/** The longest entry, in characters. */
export const MAX_SCOPE_ENTRY_LENGTH = 512;

/** What a caller passes: either list may be absent or empty. */
export interface ContextScopeInput {
  include?: readonly string[];
  exclude?: readonly string[];
}

interface Entry {
  /** The entry as given. */
  raw: string;
  /** True for a directory prefix (an entry ending in `/`). */
  prefix: boolean;
}

/** A validated scope. `include` is null when every path is in scope unless excluded. */
export interface ContextScope {
  include: readonly string[] | null;
  exclude: readonly string[];
  /** The include entries that name one file, in the order given, without repeats. */
  exactIncludes: readonly string[];
  /** Whether `path`, as spelled, is in scope. */
  allows(path: string): boolean;
  /** Whether `path`, as spelled, matches an exclusion. */
  excludes(path: string): boolean;
  /**
   * Whether the file at `path` may be opened: in scope as spelled and under
   * its real path, and inside the root. `"unavailable"` when it does not
   * resolve inside the root, `"excluded"` when it, or what it links to, is
   * out of scope.
   */
  admitFile(root: string, path: string): "ok" | "excluded" | "unavailable";
}

/** Why an entry is refused, or null when it is a valid scope entry. */
export function scopeEntryError(entry: unknown): string | null {
  if (typeof entry !== "string") return "a path scope entry must be a string";
  const shown = JSON.stringify(entry.length > 80 ? `${entry.slice(0, 80)}…` : entry);
  if (entry.length === 0) return "a path scope entry must not be empty";
  if (entry.length > MAX_SCOPE_ENTRY_LENGTH) return `path scope entry ${shown} is longer than ${MAX_SCOPE_ENTRY_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(entry)) return `path scope entry ${shown} holds a control character`;
  if (entry.startsWith("/")) return `path scope entry ${shown} must be relative to the brain root`;
  const body = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const segments = body.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes(":"))) {
    return `path scope entry ${shown} must be a plain relative path: no ".", "..", empty segments, "\\" or ":"`;
  }
  return null;
}

/** Unicode compatibility case folding, for exclusion matching. */
const fold = (text: string) => text.normalize("NFKC").toLowerCase();

const matches = (entry: Entry, path: string) => (entry.prefix ? path.startsWith(entry.raw) : path === entry.raw);

function parseList(name: "include" | "exclude", list: unknown): Entry[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${name} must be a list of paths`);
  if (list.length > MAX_SCOPE_ENTRIES) throw new Error(`${name} holds ${list.length} paths; the most it may hold is ${MAX_SCOPE_ENTRIES}`);
  const entries: Entry[] = [];
  for (const raw of list) {
    const error = scopeEntryError(raw);
    if (error) throw new Error(`${name}: ${error}`);
    entries.push({ raw: raw as string, prefix: (raw as string).endsWith("/") });
  }
  return entries;
}

/**
 * Validate a caller's scope. Null when neither list holds an entry, so an
 * unscoped call takes exactly the unscoped path. Throws on an invalid entry or
 * a list over {@link MAX_SCOPE_ENTRIES}.
 */
export function parseContextScope(input: ContextScopeInput | undefined): ContextScope | null {
  if (!input) return null;
  const include = parseList("include", input.include);
  const exclude = parseList("exclude", input.exclude);
  if (include.length === 0 && exclude.length === 0) return null;
  const folded = exclude.map((entry) => ({ ...entry, raw: fold(entry.raw) }));

  const excludes = (path: string) => {
    const key = fold(path);
    return folded.some((entry) => matches(entry, key));
  };
  const allows = (path: string) => !excludes(path) && (include.length === 0 || include.some((entry) => matches(entry, path)));

  return {
    include: include.length > 0 ? include.map((entry) => entry.raw) : null,
    exclude: exclude.map((entry) => entry.raw),
    exactIncludes: [...new Set(include.filter((entry) => !entry.prefix).map((entry) => entry.raw))],
    allows,
    excludes,
    admitFile(root, path) {
      if (!allows(path)) return "excluded";
      const real = safeResolve(root, path);
      const realRoot = safeResolve(root, ".");
      if (!real || !realRoot) return "unavailable";
      const canonical = relative(realRoot, real).split(sep).join("/");
      return canonical === path || allows(canonical) ? "ok" : "excluded";
    },
  };
}
