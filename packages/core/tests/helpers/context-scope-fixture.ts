/**
 * The scoped-context fixture (#3644): a temp copy of fixtures/corpus where
 * `context/current-focus.md` (the canonical current focus) and a new
 * `projects/_index.md` (the projects registry) are both relevant to
 * {@link SCOPE_QUERY} and linked from its hits, so each would reach an
 * unscoped briefing as a canonical document, a search hit or a related
 * neighbour. Each carries a marker no other file holds, so a test can tell
 * whether its content came back.
 */

import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const CORE_ROOT = resolve(import.meta.dir, "../..");

export const FOCUS = "context/current-focus.md";
export const REGISTRY = "projects/_index.md";
export const FOCUS_MARKER = "bronze-oarlock-focus";
export const REGISTRY_MARKER = "bronze-oarlock-registry";
/** Matches the focus, the registry and the sail-repairs project. */
export const SCOPE_QUERY = "sail repairs cedar spars";

const REGISTRY_DOC = `---
type: index
title: "Projects — Registry"
created: 2026-01-08
updated: 2026-07-12
tags: [index, projects]
status: active
relevance: primary
summary: "Every shipbuilding project on Ogygia: the raft and the sail repairs"
---

## Projects

- Raft build: the pine deck frame, see [[projects/active/raft/plan]].
- Sail repairs: cedar spars spliced and sealed, see [[projects/active/sail-repairs/status]].
- The week's priorities live in [[current-focus]].

Registry marker: ${REGISTRY_MARKER}.
`;

/** A fresh copy of the corpus with the registry and both markers, not yet indexed. */
export function makeScopeBrain(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "brain-context-scope-"));
  cpSync(join(CORE_ROOT, "fixtures/corpus"), root, { recursive: true });
  // The fixture's brain.config.ts imports @schlessera/brain.
  symlinkSync(resolve(CORE_ROOT, "../../node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, REGISTRY), REGISTRY_DOC);
  appendFileSync(join(root, FOCUS), `\nFocus marker: ${FOCUS_MARKER}. Sail repairs come first this week.\n`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Replace an indexed file with a named pipe that serves its old text to every
 * reader and counts each open, so a test can prove that a subprocess never
 * opened it, by whatever call. A writer loop feeds the pipe, so an open never
 * blocks. Index before calling it: the indexer would read the pipe too.
 */
export function openCounter(root: string, rel: string): { opens: () => Promise<number>; stop: () => void } {
  const file = join(root, rel);
  const counter = join(mkdtempSync(join(tmpdir(), "brain-open-count-")), "opens");
  const text = readFileSync(file, "utf8");
  rmSync(file);
  const made = Bun.spawnSync(["mkfifo", file]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  writeFileSync(counter, "0");
  // Each pass blocks until a reader opens the pipe, then serves the text
  // whole and closes it. The pause before the next pass lets the reader see
  // end of file: a writer that reopened at once would keep its read going.
  const writer = Bun.spawn(
    ["sh", "-c", 'n=0; while :; do printf "%s" "$1" > "$2" || exit 1; n=$((n+1)); echo "$n" > "$3"; sleep 0.2; done', "sh", text, file, counter],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" }
  );
  return {
    // A reader that has finished has had its text, so the count has moved on;
    // the pause lets the writer record it.
    opens: async () => {
      await Bun.sleep(50);
      return Number(readFileSync(counter, "utf8").trim() || "0");
    },
    stop: () => {
      writer.kill();
      rmSync(dirname(counter), { recursive: true, force: true });
    },
  };
}
