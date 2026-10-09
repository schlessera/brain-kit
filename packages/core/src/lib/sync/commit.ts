/**
 * The commits a sync makes of the files `assess` classes TRACK, grouped by
 * domain the way `brain sync group` lists them. A plan is plain data, so an
 * agent can rewrite its messages before it is applied. Applying one checks
 * every path against the set the caller assessed and commits each group with
 * `--only`, so anything else already staged stays staged and out of it.
 */

import { parseFrontmatter } from "../frontmatter-parse.js";
import { lstatSync, readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

import { frontmatterLength } from "../document-parts.js";
import { editFrontmatter } from "../frontmatter-edit.js";
import { git } from "./git.js";
import { inCanonicalDir, writeFileSafely } from "../safe-path.js";

/** One `brain sync group` entry. */
export interface GroupedFile {
  domain: string;
  status: string;
  path: string;
}

export interface PlannedFile {
  path: string;
  status: string;
}

export interface PlannedCommit {
  domains: string[];
  files: PlannedFile[];
  subject: string;
  body: string;
}

export interface CommitPlan {
  commits: PlannedCommit[];
}

export type CommitResult = { subject: string; sha: string } | { subject: string; error: string };

const SUBJECT_MAX = 72;
const DEFAULT_MAX_FILES = 10;
/** A subject keeps at least this much room for titles; longer domain lists are counted instead of named. */
const MIN_TITLE_ROOM = 24;

/** Decoded strictly, a leading U+FEFF kept: a file is rewritten only when its text round-trips to the same bytes. */
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A regular file's text, or null when it is missing, not a regular file, or not UTF-8. */
function readText(root: string, path: string): string | null {
  const file = resolve(root, path);
  try {
    // A symlink is written through to its target, which may be outside the brain.
    if (!lstatSync(file).isFile()) return null;
    return strict.decode(readFileSync(file));
  } catch {
    return null;
  }
}

/** The file as HEAD has it, or null when HEAD has no such file. */
function headText(root: string, path: string): string | null {
  const shown = git(root, ["cat-file", "blob", `HEAD:${path}`], true);
  return shown.code === 0 ? shown.stdout : null;
}

function frontmatterData(text: string): Record<string, unknown> | null {
  try {
    return parseFrontmatter(text).data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whitespace runs, line breaks and control characters as one space: text fit for a one-line subject. */
function oneLine(text: string): string {
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A path with its control characters spelled as `\xNN`, so it stays one line of the body. */
function printable(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Frontmatter `title`, else the file name without its extension. A deletion is read as HEAD had it. */
function titleOf(root: string, file: PlannedFile): string {
  if (file.path.endsWith(".md")) {
    const text = file.status === "D" ? headText(root, file.path) : readText(root, file.path);
    const title = text === null ? undefined : frontmatterData(text)?.title;
    if (typeof title === "string" && oneLine(title)) return oneLine(title);
  }
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return oneLine(dot > 0 ? name.slice(0, dot) : name);
}

function verbFor(files: PlannedFile[]): "Add" | "Remove" | "Update" {
  if (files.every((file) => file.status === "A" || file.status === "?")) return "Add";
  if (files.every((file) => file.status === "D")) return "Remove";
  return "Update";
}

/** Length in code points, as a reader counts characters. */
const width = (text: string) => [...text].length;

/**
 * `<Verb> <domains>: <title>, <title> (+N more)`, at most 72 characters.
 * Titles drop into the `+N more` count until it fits; a first title that is
 * too long alone is shortened with an ellipsis. Domains too many to name in
 * the room left are counted instead.
 */
export function composeSubject(verb: string, domains: string[], titles: string[]): string {
  let head = `${verb} ${domains.join(", ")}: `;
  if (width(head) > SUBJECT_MAX - MIN_TITLE_ROOM) {
    head = `${verb} ${domains.length} domain${domains.length === 1 ? "" : "s"}: `;
  }
  const room = SUBJECT_MAX - width(head);
  for (let shown = titles.length; shown >= 1; shown--) {
    const more = titles.length - shown;
    const text = titles.slice(0, shown).join(", ") + (more > 0 ? ` (+${more} more)` : "");
    if (width(text) <= room) return head + text;
  }
  const more = titles.length - 1;
  const suffix = more > 0 ? ` (+${more} more)` : "";
  const first = [...(titles[0] ?? "")].slice(0, room - width(suffix) - 1).join("").trimEnd();
  return `${head}${first}…${suffix}`;
}

function plannedCommit(root: string, domains: string[], files: PlannedFile[]): PlannedCommit {
  const subject = composeSubject(verbFor(files), domains, files.map((file) => titleOf(root, file)));
  // An untracked file is an addition once committed.
  const body = files.map((file) => `- ${file.status === "?" ? "A" : file.status} ${printable(file.path)}`).join("\n");
  return { domains, files, subject, body };
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Code-point order: the same on every machine, whatever its locale. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group assessed TRACK files into commits: one domain is one commit, split
 * into chunks of at most `maxFiles` (10); the domains with a single file are
 * gathered into one commit (chunked the same way), after the others. Domains
 * and paths are taken in code-point order, and a path listed twice counts once.
 * Reads each markdown file's `title` for the subject; changes nothing.
 */
export function planCommits(root: string, groups: GroupedFile[], opts: { maxFiles?: number } = {}): CommitPlan {
  const maxFiles = Number.isInteger(opts.maxFiles) && opts.maxFiles! >= 1 ? opts.maxFiles! : DEFAULT_MAX_FILES;
  const byDomain = new Map<string, PlannedFile[]>();
  const seen = new Set<string>();
  for (const { domain, status, path } of groups) {
    if (seen.has(path)) continue;
    seen.add(path);
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), { path, status }]);
  }
  const commits: PlannedCommit[] = [];
  const singles: { domain: string; file: PlannedFile }[] = [];
  for (const domain of [...byDomain.keys()].sort(byCodePoint)) {
    const files = byDomain.get(domain)!.sort((a, b) => byCodePoint(a.path, b.path));
    if (files.length === 1) singles.push({ domain, file: files[0]! });
    else for (const chunk of chunked(files, maxFiles)) commits.push(plannedCommit(root, [domain], chunk));
  }
  for (const chunk of chunked(singles, maxFiles)) {
    commits.push(plannedCommit(root, chunk.map((single) => single.domain), chunk.map((single) => single.file)));
  }
  return { commits };
}

/** Frontmatter `updated` as `YYYY-MM-DD` text, however YAML typed it. */
function updatedOf(text: string): string | null {
  const updated = frontmatterData(text)?.updated;
  if (updated instanceof Date) return updated.toISOString().slice(0, 10);
  return typeof updated === "string" ? updated.trim() : null;
}

/** Equal once every run of whitespace, line breaks included, counts as one space. */
function sameBeyondWhitespace(a: string, b: string): boolean {
  const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();
  return squeeze(a) === squeeze(b);
}

/**
 * Set frontmatter `updated` to `today` on each modified (`M`) markdown file
 * whose body, frontmatter excluded, differs from HEAD by more than
 * whitespace. The edit goes through `editFrontmatter`, so every other byte of
 * the file stays as it was; a file it cannot edit that way is left untouched
 * and listed as refused. A file without frontmatter, not valid UTF-8, or not a
 * regular file is skipped, as is one already dated today.
 */
export function bumpUpdated(root: string, files: PlannedFile[], today: string): { bumped: string[]; refused: string[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new RangeError(`today must be YYYY-MM-DD, not "${today}"`);
  const bumped: string[] = [];
  const refused: string[] = [];
  for (const { path, status } of files) {
    if (status !== "M" || !path.endsWith(".md")) continue;
    const text = readText(root, path);
    const head = headText(root, path);
    if (text === null || head === null) continue;
    const length = frontmatterLength(text);
    if (length === 0) continue;
    if (sameBeyondWhitespace(text.slice(length), head.slice(frontmatterLength(head)))) continue;
    if (updatedOf(text) === today) continue;
    const edited = editFrontmatter(text, { updated: today });
    if (edited === null) {
      refused.push(path);
      continue;
    }
    writeFileSafely(inCanonicalDir(resolve(root, path)), edited);
    bumped.push(path);
  }
  return { bumped, refused };
}

/** Why each commit cannot be applied, or null. Every path must be allowed and belong to one commit only. */
function refusals(plan: CommitPlan, allowed: ReadonlySet<string>): (string | null)[] {
  const claimed = new Set<string>();
  return plan.commits.map((commit) => {
    if (!commit.subject.trim()) return "refused: empty subject";
    if (commit.files.length === 0) return "refused: no files";
    const outside = commit.files.filter((file) => !allowed.has(file.path)).map((file) => file.path);
    if (outside.length > 0) return `refused: not in the assessed set: ${outside.map(printable).join(", ")}`;
    const twice = commit.files.filter((file) => claimed.has(file.path)).map((file) => file.path);
    for (const file of commit.files) claimed.add(file.path);
    if (twice.length > 0) return `refused: already in an earlier commit: ${twice.map(printable).join(", ")}`;
    return null;
  });
}

/** One commit of exactly its files, with the message as given. */
function applyCommit(root: string, commit: PlannedCommit): CommitResult {
  const subject = commit.subject;
  // `--literal-pathspecs`: a path is a name, never a pattern. Without it a
  // file called `a*.md` also commits `ab.md`, which nobody allowed.
  const literal = (args: string[], raw = false) => git(root, ["--literal-pathspecs", ...args], raw);
  const paths = commit.files.map((file) => file.path);
  // `--only` takes a path the index or HEAD knows from the working tree as it
  // is, deletion included (a `git rm`ed file is in HEAD alone); one neither
  // knows is added first. Which is which is asked of git rather than read off
  // the plan's status.
  const known = new Set([
    ...literal(["ls-files", "-z", "--", ...paths], true).stdout.split("\0"),
    ...literal(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...paths], true).stdout.split("\0"),
  ]);
  const fresh = paths.filter((path) => !known.has(path));
  if (fresh.length > 0) {
    const added = literal(["add", "--", ...fresh]);
    if (added.code !== 0) return { subject, error: added.stderr || added.stdout };
  }
  const message = ["-m", subject, ...(commit.body.trim() ? ["-m", commit.body] : [])];
  const committed = literal(["commit", "--only", ...message, "--", ...paths]);
  if (committed.code !== 0) {
    // The files it added go back to untracked, as they were.
    if (fresh.length > 0) literal(["rm", "--cached", "-q", "--", ...fresh]);
    return { subject, error: committed.stderr || committed.stdout };
  }
  return { subject, sha: git(root, ["rev-parse", "HEAD"]).stdout };
}

/**
 * Commit each planned group, in order, with `git commit --only -m <subject>
 * -m <body> -- <files>`. Nothing is committed unless every file of every
 * commit is in `allowed` (the TRACK set the caller assessed) and no file is in
 * two commits; otherwise each commit reports why it was not applied. A commit
 * git rejects is reported and the rest still run.
 */
export function applyCommitPlan(root: string, plan: CommitPlan, allowed: ReadonlySet<string>): CommitResult[] {
  const refused = refusals(plan, allowed);
  if (refused.some((reason) => reason !== null)) {
    return plan.commits.map((commit, i) => ({
      subject: commit.subject,
      error: refused[i] ?? "not applied: another commit in the plan was refused",
    }));
  }
  return plan.commits.map((commit) => applyCommit(root, commit));
}

const planSchema = z.object({
  commits: z.array(
    z.object({
      domains: z.array(z.string()),
      files: z.array(z.object({ path: z.string().min(1), status: z.string() })),
      subject: z.string(),
      body: z.string(),
    })
  ),
});

/** The plan as the JSON `commit --plan` prints and `commit --plan-file` reads. */
export function serializePlan(plan: CommitPlan): string {
  return JSON.stringify(plan, null, 2) + "\n";
}

/** A plan from JSON text. Its files are checked against the assessed set only when it is applied. */
export function parsePlan(text: string): { plan: CommitPlan } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON: ${(e as Error).message}` };
  }
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    return { error: `not a commit plan: ${first.path.join(".") || "(root)"}: ${first.message}` };
  }
  return { plan: parsed.data };
}

/** A plan read from `file`, as `parsePlan` reads it. */
export function planFromFile(file: string): { plan: CommitPlan } | { error: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    return { error: `cannot read ${file}: ${(e as Error).message}` };
  }
  return parsePlan(text);
}
