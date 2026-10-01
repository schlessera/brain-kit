/**
 * Key-and-value runs the model TYPED, counted without the detector (#208).
 *
 * `scripts/measure-show-block.ts` reports the `kv_run` population as three
 * columns: runs written, runs carrying an address, and `kv_run` candidates
 * the classification pass detected. The first two come from here. They have
 * to be counted independently of the detector, or the first column is just
 * the third relabelled and a detector change moves both at once.
 *
 * So this counts SHAPE only. It parses each text part with the same mdast
 * parser the pass walks, takes the top-level paragraphs and bullet lists, and
 * counts the ones whose every line is a key-colon-value line, two or more of
 * them — the shape `kvRunCandidate` looks for
 * (`kvRunCandidate`, `packages/ui-sdk/src/classification/detect.ts:523-557`)
 * with none of its inline-content rejection. A link, an image or inline HTML
 * in a line does not stop it counting here. Lines are read from the source,
 * so `[odysseus@example.com](mailto:odysseus@example.com)` is still a line that
 * carries an address.
 *
 * `KV_LINE` is COPIED from the detector
 * (`KV_LINE`, `packages/ui-sdk/src/classification/detect.ts:419`), not
 * imported. That is deliberate: an import would let a change to the
 * detector's line rule move "written" and "detected" together, and the gap
 * between them is the number being read.
 *
 * The third column is the detector's by definition, so it is read from
 * `planClassification`, the entry point `ui-server` calls.
 *
 * What "carries an address" means is a corpus-authoring fact, not a finding
 * about traffic: the fixture corpus carries exactly the addresses someone put
 * in it. Report it as the population the detector was offered, never as how
 * often a real answer holds one.
 */

import { planClassification } from "@schlessera/brain-ui-sdk/server";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Copied from the detector on purpose; see the header. */
const KV_LINE = /^(?:\*\*([^*:]{1,40})(?::\*\*|\*\*:)|([A-Z][^:]{0,39}):)\s+(.+)$/;

/**
 * An address a reader could follow: an email, an `http(s)://` URL, or GFM's
 * `www.` form. Matched anywhere in a line's value, so a bare address, an
 * autolink and a labelled link's destination all count.
 */
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\bhttps?:\/\/\S|\bwww\.[\w-]+\.\S/i;

const MARKDOWN = unified().use(remarkParse).use(remarkGfm);

interface Node {
  type: string;
  ordered?: boolean | null;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export interface KvRunCounts {
  /** Top-level paragraphs and bullet lists shaped as two or more key-colon-value lines. */
  written: number;
  /** Of those, the runs with at least one line whose value carries an address. */
  withAddress: number;
}

function sourceOf(node: Node, text: string): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? text.slice(start, end) : null;
}

/** The lines of a run, or null when the block is not shaped as one. */
function runLines(node: Node, text: string): string[] | null {
  if (node.type === "paragraph") {
    const source = sourceOf(node, text);
    return source === null ? null : source.split("\n").map((line) => line.trim());
  }
  if (node.type !== "list" || node.ordered) return null;
  const lines: string[] = [];
  for (const item of node.children ?? []) {
    // One paragraph per item, as the detector reads a list: an item with a
    // nested list or a second paragraph is not one line.
    const [only, ...rest] = item.children ?? [];
    if (!only || rest.length > 0 || only.type !== "paragraph") return null;
    const source = sourceOf(only, text);
    if (source === null) return null;
    lines.push(source.trim());
  }
  return lines;
}

/**
 * Count the key-and-value runs in a turn's text parts. Per part, never over
 * the join, for the reason `countMarkdownTables` gives: a tool call between
 * two parts makes them two blocks the reader saw.
 */
export function countKvRuns(...parts: string[]): KvRunCounts {
  const counts: KvRunCounts = { written: 0, withAddress: 0 };
  for (const part of parts) {
    const root = MARKDOWN.parse(part) as unknown as Node;
    for (const node of root.children ?? []) {
      const lines = runLines(node, part);
      if (!lines || lines.length < 2) continue;
      const values: string[] = [];
      for (const line of lines) {
        const match = KV_LINE.exec(line);
        if (!match) break;
        values.push(match[3]!);
      }
      if (values.length !== lines.length) continue;
      counts.written++;
      if (values.some((value) => ADDRESS.test(value))) counts.withAddress++;
    }
  }
  return counts;
}

export interface KvRunColumns extends KvRunCounts {
  /** `kv_run` candidates the classification pass detected in the same parts. */
  detected: number;
}

/** The three columns for one turn's text parts. */
export function kvRunColumns(textParts: readonly string[]): KvRunColumns {
  const detected = (planClassification(textParts)?.candidates ?? []).filter(
    (planned) => planned.candidate.kind === "kv_run"
  ).length;
  return { ...countKvRuns(...textParts), detected };
}

/**
 * The report's rows: one per group of turns, each column summed. A table in
 * three columns, because the middle one is a corpus-authoring choice and has
 * to be read as one, not folded into a rate.
 */
export function kvRunRows(groups: readonly { label: string; turns: readonly KvRunColumns[] }[]): string[] {
  const rows = [
    "| arm | turns | kv-shaped runs written | of those, carrying an address | `kv_run` candidates detected |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const { label, turns } of groups) {
    const sum = (pick: (turn: KvRunColumns) => number): number =>
      turns.reduce((total, turn) => total + pick(turn), 0);
    rows.push(
      `| ${label} | ${turns.length} | ${sum((t) => t.written)} | ${sum((t) => t.withAddress)} | ${sum((t) => t.detected)} |`
    );
  }
  return rows;
}
