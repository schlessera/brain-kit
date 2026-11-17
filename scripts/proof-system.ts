/** Classifies a diff as a proof-system change: one that touches a path in the
 * ruled path set (`scripts/proof-system-paths.json`) or changes a test timeout or
 * deadline constant. The serialized lane, the proof-policy epochs and off-main
 * qualification all read this classification (docs/decisions/ci-utility.md,
 * "Proof-system lane", answer 5).
 *
 *   bun scripts/proof-system.ts classify --base <sha> --head <sha> [--json]
 *
 * A diff that cannot be computed throws; the command then exits nonzero and
 * never reports `false`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PathSet { paths: string[]; timeoutCheckScope: string[] }

export type Reason =
  | { kind: "path"; path: string; pattern: string }
  | { kind: "timeout-change"; path: string; line: number; side: "head" | "base";
      signal: SignalKind; name: string; from: string | null; to: string | null };

export interface Classification {
  schemaVersion: 1;
  base: string;
  head: string;
  proofSystem: boolean;
  reasons: Reason[];
}

export type SignalKind = "constant" | "option" | "call" | "test-argument";
interface Signal { kind: SignalKind; name: string; value: string }

const ROOT = join(import.meta.dir, "..");
export const PATH_SET_FILE = join(ROOT, "scripts", "proof-system-paths.json");

export function loadPathSet(file = PATH_SET_FILE): PathSet {
  return parsePathSet(readFileSync(file, "utf8"), file);
}

/** Validates the text of a path-set file; `file` only labels errors. */
export function parsePathSet(text: string, file: string): PathSet {
  const raw = JSON.parse(text);
  const list = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.length === 0 || !value.every(x => typeof x === "string" && x.length > 0)) {
      throw new Error(`${file}: \`${field}\` must be a non-empty list of globs`);
    }
    return value;
  };
  return { paths: list(raw?.paths, "paths"), timeoutCheckScope: list(raw?.timeoutCheckScope, "timeoutCheckScope") };
}

const firstMatch = (path: string, globs: string[]): string | undefined => globs.find(glob => new Bun.Glob(glob).match(path));

/** The ruled pattern a repository-relative path matches, if any. */
export function matchProofSystemPath(path: string, set: PathSet = loadPathSet()): string | undefined {
  return firstMatch(path, set.paths);
}

// Numeric expressions such as `5000`, `30_000`, `2.5` or `5 * 60 * 1000`.
const NUM = String.raw`\d[\d_]*(?:\.\d+)?(?:\s*[*+]\s*\d[\d_]*(?:\.\d+)?)*`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const TIMING = /timeout|deadline/i;
const norm = (value: string) => value.replace(/[\s_]/g, "");

/** The timeout and deadline values one source line declares, read syntactically. */
export function timeoutSignals(line: string): Signal[] {
  const signals: Signal[] = [];
  // `const RESTART_DEADLINE_MS = 30_000`, `let fooTimeout: number = A ? 1 : 2`.
  for (const m of line.matchAll(new RegExp(String.raw`\b(${IDENT})\s*(?::\s*[^=;,]+?)?\s*=(?![=>])\s*([^;,]*\d[^;,]*)`, "g"))) {
    if (TIMING.test(m[1]!)) signals.push({ kind: "constant", name: m[1]!, value: norm(m[2]!) });
  }
  // `{ timeout: 5000 }`, `deadlineMs: 2_000`.
  for (const m of line.matchAll(new RegExp(String.raw`\b(${IDENT})\s*:\s*(${NUM})(?![\w.])`, "g"))) {
    if (TIMING.test(m[1]!)) signals.push({ kind: "option", name: m[1]!, value: norm(m[2]!) });
  }
  // `setDefaultTimeout(5000)`, `jest.setTimeout(5000)`, `this.timeout(5000)`.
  for (const m of line.matchAll(new RegExp(String.raw`\b((?:${IDENT}\.)*(?:setDefaultTimeout|setTimeout|timeout))\s*\(\s*(${NUM})\s*\)`, "g"))) {
    signals.push({ kind: "call", name: m[1]!, value: norm(m[2]!) });
  }
  // Bun test third-argument timeouts: `test("x", fn, 5000);` or the closing `}, 5000);`.
  const single = line.match(new RegExp(String.raw`(?:^|[^\w$.])((?:test|it|describe)(?:\.${IDENT})*)\s*\(.*,\s*(${NUM})\s*\)\s*;?\s*$`));
  const closing = single ? null : line.match(new RegExp(String.raw`^\s*\}\s*\)?\s*,\s*(${NUM})\s*\)\s*;?\s*$`));
  if (single) signals.push({ kind: "test-argument", name: "test", value: norm(single[2]!) });
  else if (closing) signals.push({ kind: "test-argument", name: "test", value: norm(closing[1]!) });
  return signals;
}

interface DiffLine { side: "head" | "base"; line: number; text: string; edit: boolean }

/** Added and removed lines of a `git diff --unified=0` patch for one file.
 * `edit` marks a line whose hunk both removes and adds lines, i.e. rewrites
 * existing lines rather than only inserting or deleting them. */
export function changedLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let base = 0, head = 0, hunk: DiffLine[] | null = null;
  const flush = () => {
    if (!hunk) return;
    const edit = hunk.some(l => l.side === "base") && hunk.some(l => l.side === "head");
    for (const line of hunk) lines.push({ ...line, edit });
  };
  for (const text of patch.split("\n")) {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { flush(); base = Number(header[1]); head = Number(header[2]); hunk = []; continue; }
    if (!hunk) continue;
    if (text.startsWith("-")) hunk.push({ side: "base", line: base++, text: text.slice(1), edit: false });
    else if (text.startsWith("+")) hunk.push({ side: "head", line: head++, text: text.slice(1), edit: false });
  }
  flush();
  return lines;
}

type Located = Signal & { line: number; edit: boolean };

/** Timeout or deadline signals that differ between the removed and added lines
 * of one file. A signal moved unchanged within the file is not a change; a
 * changed value is reported once, at its head line, with both values.
 *
 * Only existing budgets count: an unmatched signal is a change when its hunk
 * rewrites existing lines, or when it is a file-wide default call
 * (`setDefaultTimeout(N)`) inserted into or deleted from a file present on both
 * sides. A new test or file that sets its own timeout, or a deleted one, does
 * not change any existing test's timeout. */
export function timeoutChanges(patch: string, path: { base: string; head: string }, existing = true): Reason[] {
  const removed: Located[] = [], added: Located[] = [];
  for (const line of changedLines(patch)) {
    for (const signal of timeoutSignals(line.text)) {
      (line.side === "base" ? removed : added).push({ ...signal, line: line.line, edit: line.edit });
    }
  }
  const key = (s: Signal) => `${s.kind}\0${s.name}\0${s.value}`;
  const unmatchedAdded = added.filter(signal => {
    const index = removed.findIndex(other => key(other) === key(signal));
    if (index < 0) return true;
    removed.splice(index, 1);
    return false;
  });
  const counts = (signal: Located) => signal.edit || (existing && signal.kind === "call");
  const reasons: Reason[] = unmatchedAdded.filter(counts).map(signal => {
    const index = removed.findIndex(other => counts(other) && other.kind === signal.kind && other.name === signal.name);
    const previous = index < 0 ? null : removed.splice(index, 1)[0]!.value;
    return { kind: "timeout-change", path: path.head, line: signal.line, side: "head",
      signal: signal.kind, name: signal.name, from: previous, to: signal.value };
  });
  for (const signal of removed.filter(counts)) {
    reasons.push({ kind: "timeout-change", path: path.base, line: signal.line, side: "base",
      signal: signal.kind, name: signal.name, from: signal.value, to: null });
  }
  return reasons;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function resolveCommit(cwd: string, rev: string): string {
  if (!rev || rev.startsWith("-")) throw new Error(`Invalid revision: ${JSON.stringify(rev)}`);
  return git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]).trim();
}

interface Change { base: string; head: string; existing: boolean }

function changedFiles(cwd: string, base: string, head: string): Change[] {
  const fields = git(cwd, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", base, head, "--"]).split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (/^[RC]/.test(status)) { changes.push({ base: fields[i]!, head: fields[i + 1]!, existing: status.startsWith("R") }); i += 2; }
    else if (/^[AMDT]$/.test(status)) { changes.push({ base: fields[i]!, head: fields[i]!, existing: status === "M" || status === "T" }); i += 1; }
    else throw new Error(`Unrecognised git diff status ${JSON.stringify(status)}`);
  }
  return changes;
}

export interface ClassifyOptions { cwd?: string; pathSet?: PathSet }

/** Whether `base..head` is a proof-system change, and why. Throws whenever the
 * diff cannot be computed, so a caller never mistakes a failure for `false`. */
export function classify(base: string, head: string, options: ClassifyOptions = {}): Classification {
  const cwd = options.cwd ?? process.cwd();
  const set = options.pathSet ?? loadPathSet();
  const baseSha = resolveCommit(cwd, base), headSha = resolveCommit(cwd, head);
  const reasons: Reason[] = [];
  const seen = new Set<string>();
  const changes = changedFiles(cwd, baseSha, headSha);
  for (const change of changes) {
    for (const path of new Set([change.base, change.head])) {
      const pattern = matchProofSystemPath(path, set);
      if (pattern && !seen.has(path)) { seen.add(path); reasons.push({ kind: "path", path, pattern }); }
    }
  }
  for (const change of changes) {
    if (!firstMatch(change.base, set.timeoutCheckScope) && !firstMatch(change.head, set.timeoutCheckScope)) continue;
    const patch = git(cwd, ["diff", "--unified=0", "-M", "--no-color", "--no-ext-diff", "--text", baseSha, headSha,
      "--", ...new Set([`:(literal)${change.base}`, `:(literal)${change.head}`])]);
    reasons.push(...timeoutChanges(patch, change, change.existing));
  }
  return { schemaVersion: 1, base: baseSha, head: headSha, proofSystem: reasons.length > 0, reasons };
}

export function formatClassification(result: Classification): string {
  const lines = [`${result.proofSystem ? "proof-system change" : "not a proof-system change"} (${result.base.slice(0, 12)}..${result.head.slice(0, 12)})`];
  for (const reason of result.reasons) {
    lines.push(reason.kind === "path"
      ? `  path ${reason.path} (matches ${reason.pattern})`
      : `  timeout-change ${reason.path}:${reason.line} (${reason.side}) ${reason.name} ${reason.from ?? "(none)"} -> ${reason.to ?? "(none)"}`);
  }
  return lines.join("\n");
}

const USAGE = "usage: bun scripts/proof-system.ts classify --base <sha> --head <sha> [--json]";

export function main(argv: string[], cwd = process.cwd()): { code: number; stdout: string; stderr: string } {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") json = true;
    else if ((arg === "--base" || arg === "--head") && rest[i + 1] !== undefined) options[arg.slice(2)] = rest[++i]!;
    else return { code: 2, stdout: "", stderr: `Unknown argument ${JSON.stringify(arg)}\n${USAGE}\n` };
  }
  if (command !== "classify" || !options.base || !options.head) return { code: 2, stdout: "", stderr: `${USAGE}\n` };
  try {
    const result = classify(options.base, options.head, { cwd });
    return { code: 0, stdout: `${json ? JSON.stringify(result, null, 2) : formatClassification(result)}\n`, stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: `proof-system: cannot classify ${options.base}..${options.head}: ${(error as Error).message}\n` };
  }
}

if (import.meta.main) {
  const { code, stdout, stderr } = main(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(code);
}
