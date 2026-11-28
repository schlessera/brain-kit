/**
 * The one TypeScript parse the lint gates make (#4673), and the one view of the
 * tree they scan (#4674). A compiler API change (#2311) is adapted here once
 * instead of in every gate.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** The script kind a gate parses `file` with when it does not force one. */
function scriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** A source file with parent pointers, its kind chosen by extension unless the caller passes one. */
export function parse(file: string, text: string, kind: ts.ScriptKind = scriptKind(file)): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, kind);
}

/**
 * The tree every lint gate but leakage scans (#4674): tracked files plus untracked
 * files that are not ignored, limited to paths that exist in the working tree,
 * sorted. Outside a Git work tree (a fixture directory) it is every file under `root`.
 */
export function listTree(root: string): string[] {
  if (Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    return [...new Bun.Glob("**").scanSync({ cwd: root, dot: true })].sort();
  }
  const run = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ls-files failed: ${run.stderr.toString()}`);
  return [...new Set(run.stdout.toString().split("\0").filter(file => file && existsSync(join(root, file))))].sort();
}

/** The listed files that match any of `patterns`. */
export function treeFiles(root: string, patterns: string | readonly string[]): string[] {
  const globs = [patterns].flat().map(pattern => new Bun.Glob(pattern));
  return listTree(root).filter(file => globs.some(glob => glob.match(file)));
}
