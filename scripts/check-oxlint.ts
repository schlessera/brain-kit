// Runs oxlint (check-only) with the curated config in .oxlintrc.json.
//
// Thin wrapper so the standard linter joins `bun run lint` like the bespoke
// AST gates: scripts/lint.ts stays a plain list, and the ruleset lives in one
// reviewable config file rather than in CLI flags. `bun x` resolves the oxlint
// pinned in the root package.json, so CI and local runs lint identically.
//
// It is spelled `bun x` and not `bunx` on purpose: `bunx` is a separate PATH
// entry that bun's installer creates — a symlink back to `bun` dispatched on
// argv[0] — so an environment can have bun and no bunx, and this gate would be
// the only one that cannot run there.
//
// The files come from the tree every other gate reads (`listTree`, #5064),
// never from oxlint's own directory walk, so a local run and CI lint the same
// set. They are passed as arguments, in batches when the list outgrows one
// command line; oxlint's rules are per file, so a batch's findings do not depend
// on the rest.

import { join, resolve } from "path";
import { listTree } from "./lib/source";

/** The directories the gate lints. */
const ROOTS = ["packages/", "scripts/", "tests/", "experiments/", "evals/", "template/", "website/scripts/"];
/** The extensions oxlint lints: JavaScript and TypeScript, and the script blocks of component files. */
export const LINTED = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
/** Argument bytes per oxlint process: a quarter of macOS's 1 MiB limit and an eighth of Linux's 2 MiB. */
const BATCH_BYTES = 256 * 1024;

/** The files the gate hands to oxlint, in listing order. */
export function oxlintFiles(root: string): string[] {
  return listTree(root).filter(file => ROOTS.some(dir => file.startsWith(dir)) && LINTED.test(file));
}

/** `files` split into consecutive batches of at most `limit` argument bytes each. */
export function batches(files: readonly string[], limit = BATCH_BYTES): string[][] {
  const out: string[][] = [];
  let size = Infinity;
  for (const file of files) {
    const bytes = Buffer.byteLength(file) + 1;
    if (size + bytes > limit) { out.push([]); size = 0; }
    out.at(-1)!.push(file);
    size += bytes;
  }
  return out;
}

export function lintGate(root: string): number {
  let exitCode = 0;
  for (const batch of batches(oxlintFiles(root))) {
    const run = Bun.spawnSync(["bun", "x", "oxlint", "-c", join(root, ".oxlintrc.json"), ...batch],
      { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (run.exitCode !== 0) exitCode = run.exitCode ?? 1;
  }
  return exitCode;
}

if (import.meta.main) process.exit(lintGate(resolve(process.argv[2] ?? join(import.meta.dir, ".."))));
