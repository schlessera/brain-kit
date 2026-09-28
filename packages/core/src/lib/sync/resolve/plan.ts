/**
 * Plan the merge of one conflicted file, then render it once its judgments
 * are in.
 *
 * `planMerge` runs the strategy once to find the passages it cannot combine
 * without a judgment (`pairs`); `render` runs it again with whatever
 * decisions came back, and a pair nobody decided gets the conservative
 * default, `distinct`: keep both, the newer side first. Strings in, strings
 * out: no git, no filesystem.
 *
 * Nothing is written that no side wrote. Every block of the result is a block
 * of an input, verbatim; what is dropped is dropped by a three-way rule (one
 * side changed or removed it and the other left it alone), by the strategy's
 * rule for a passage both sides changed, or by a decision, and each such
 * choice leaves a line in `notes`.
 */

import { createHash } from "crypto";

import { nameKey } from "../../name-key.js";
import type { JudgmentPair, MergeStrategy, PairDecision } from "../types.js";
import { mergeUnits, type Mergeable } from "./diff3.js";
import { dateValue, mergeFrontmatter } from "./frontmatter.js";
import {
  assembleBody,
  emitSection,
  isTimelineHeading,
  normalizeText,
  parseDoc,
  UnparseableError,
  type Doc,
  type ParseOptions,
  type Section,
  type TableRow,
  type Unit,
} from "./markdown.js";

/** A side larger than this is left for a human, like a binary file. */
export const MAX_MERGE_BYTES = 100 * 1024;

export interface MergeInput {
  path: string;
  /** Each side's text; null when the file does not exist on that side. */
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /**
   * Whether a path is already taken, so `keep-both` names THEIRS' copy after
   * a free one. Without it, no path is taken.
   */
  exists?: (path: string) => boolean;
}

export type MergeOutcome =
  | {
      status: "resolved";
      /** null: the file is deleted. */
      content: string | null;
      /** Files to write beside it: `keep-both`'s `<name>-remote.md`. */
      extraFiles: { path: string; content: string }[];
      /** One line per non-trivial choice, for the report. */
      notes: string[];
    }
  | { status: "unresolved"; reason: string };

export interface MergePlan {
  /** The judgments the strategy wants, possibly none. */
  pairs: JudgmentPair[];
  render(decisions: ReadonlyMap<string, PairDecision>): MergeOutcome;
}

/** Stable across runs: the same passage pair in the same place of the same file. */
export function pairId(path: string, context: string, ours: string, theirs: string): string {
  return createHash("sha256").update([path, context, ours, theirs].join("\u0000")).digest("hex").slice(0, 16);
}

const fixed = (outcome: MergeOutcome): MergePlan => ({ pairs: [], render: () => outcome });
const resolved = (content: string | null, notes: string[] = [], extraFiles: { path: string; content: string }[] = []): MergeOutcome => ({
  status: "resolved",
  content,
  extraFiles,
  notes,
});

/** `notes/idea.md` → `notes/idea-remote.md`, or `-remote-2.md`, … when that is taken. */
export function remotePath(path: string, exists: (path: string) => boolean = () => false): string {
  const dot = path.toLowerCase().endsWith(".md") ? path.length - 3 : path.length;
  const stem = path.slice(0, dot);
  const ext = path.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem}-remote${n === 1 ? "" : `-${n}`}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * Merge with line endings taken out of the comparison: a side checked out
 * with CRLF differs from an LF side on every line, which would turn one edit
 * into a whole-file conflict. Every side is compared as LF, and the result is
 * written back in OURS' line ending, so the file keeps the ending it has here.
 */
export function planMerge(input: MergeInput, strategy: MergeStrategy): MergePlan {
  const lf = (side: string | null) => (side === null ? null : side.replace(/\r\n/g, "\n"));
  const crlf = input.ours !== null ? input.ours.includes("\r\n") : (input.theirs ?? "").includes("\r\n");
  const plan = planMergeLF({ ...input, base: lf(input.base), ours: lf(input.ours), theirs: lf(input.theirs) }, strategy);
  if (!crlf) return plan;
  const back = (text: string) => text.replace(/\n/g, "\r\n");
  return {
    pairs: plan.pairs,
    render(decisions) {
      const outcome = plan.render(decisions);
      if (outcome.status !== "resolved") return outcome;
      return {
        ...outcome,
        content: outcome.content === null ? null : back(outcome.content),
        extraFiles: outcome.extraFiles.map((file) => ({ ...file, content: back(file.content) })),
      };
    },
  };
}

function planMergeLF(input: MergeInput, strategy: MergeStrategy): MergePlan {
  const { base, ours, theirs } = input;
  if (strategy === "code-merge") return fixed({ status: "unresolved", reason: "code-merge: needs an agent to combine the edits" });
  if (strategy === "cache-union") return fixed({ status: "unresolved", reason: "cache-union: handled by pull" });
  const present = [base, ours, theirs].filter((side): side is string => side !== null);
  if (present.some((side) => side.includes("\u0000"))) return fixed({ status: "unresolved", reason: "binary: a side contains a NUL byte" });
  if (present.some((side) => Buffer.byteLength(side, "utf8") > MAX_MERGE_BYTES)) {
    return fixed({ status: "unresolved", reason: `too large: a side is over ${MAX_MERGE_BYTES / 1024} KB` });
  }

  // One side changed (a deletion included): that side.
  if (ours === theirs) return fixed(resolved(ours));
  if (ours === base) return fixed(resolved(theirs, theirs === null ? ["deleted on their side, unchanged on ours"] : []));
  if (theirs === base) return fixed(resolved(ours, ours === null ? ["deleted on our side, unchanged on theirs"] : []));
  // Deleted on one side, changed on the other: content wins.
  if (ours === null) return fixed(resolved(theirs, ["deleted on our side but changed on theirs; kept theirs"]));
  if (theirs === null) return fixed(resolved(ours, ["deleted on their side but changed on ours; kept ours"]));

  if (strategy === "keep-both") {
    const remote = remotePath(input.path, input.exists);
    return fixed(resolved(ours, [`both sides changed it; kept ours in place and theirs as ${remote}`], [{ path: remote, content: theirs }]));
  }
  return planMarkdown(input.path, base, ours, theirs, strategy);
}

function planMarkdown(path: string, baseText: string | null, oursText: string, theirsText: string, strategy: MergeStrategy): MergePlan {
  const opts: ParseOptions = { tables: strategy === "table-union" ? "whole" : "rows", timeline: strategy === "timeline-append" };
  let docs: [Doc, Doc, Doc];
  try {
    docs = [parseDoc(baseText ?? "", "base", opts), parseDoc(oursText, "ours", opts), parseDoc(theirsText, "theirs", opts)];
  } catch (e) {
    if (e instanceof UnparseableError) return fixed({ status: "unresolved", reason: `unparseable: ${e.message}` });
    throw e;
  }
  const [base, ours, theirs] = docs;
  const oursUpdated = dateValue(ours.data.updated);
  const theirsUpdated = dateValue(theirs.data.updated);
  const theirsNewer = oursUpdated !== null && theirsUpdated !== null && theirsUpdated > oursUpdated;

  const run = (decide: (id: string) => PairDecision | undefined) => {
    const merge = new Merge(path, strategy, decide, theirsNewer);
    const content = merge.documents(base, ours, theirs);
    return { merge, content };
  };
  const planned = run(() => undefined);
  return {
    pairs: [...planned.merge.pairs.values()],
    render(decisions) {
      const { merge, content } = run((id) => decisions.get(id));
      try {
        parseDoc(content, "ours", opts);
      } catch (e) {
        if (e instanceof UnparseableError) return { status: "unresolved", reason: `the merged text does not parse: ${e.message}` };
        throw e;
      }
      return resolved(content, merge.notes);
    },
  };
}

/** A section as the body merge aligns it. `next` is set while it is a source section taken whole. */
interface SectionUnit extends Mergeable {
  text: string;
  section: Section;
  next?: string | null;
}

const sectionName = (section: Section) => section.path.join(" > ") || "(top of the document)";
const snippet = (text: string) => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
};
const sideName = (side: "ours" | "theirs") => (side === "ours" ? "our" : "their");
const otherSide = (side: "ours" | "theirs") => (side === "ours" ? "their" : "our");

/** The date a timeline entry leads with: `- 2026-05-01 …`, `### 2026-05-01`, `**2026-05-01**`. */
export function entryDate(text: string): string | null {
  const match = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?(?:#{1,6}[ \t]+)?[*_]{0,2}\[{0,2}(\d{4}-\d{2}-\d{2})(?!\d)/.exec(text);
  return match ? match[1]! : null;
}

/** One merge of one file under one set of decisions. */
class Merge {
  readonly pairs = new Map<string, JudgmentPair>();
  readonly notes: string[] = [];

  constructor(
    private readonly path: string,
    private readonly strategy: MergeStrategy,
    private readonly decide: (id: string) => PairDecision | undefined,
    private readonly theirsNewer: boolean
  ) {}

  documents(base: Doc, ours: Doc, theirs: Doc): string {
    const frontmatter = mergeFrontmatter(base, ours, theirs, this.notes);
    let body: string;
    if (ours.body === theirs.body || theirs.body === base.body) body = ours.body;
    else if (ours.body === base.body) body = theirs.body;
    else body = this.bodies(base, ours, theirs);
    return frontmatter + body;
  }

  private bodies(base: Doc, ours: Doc, theirs: Doc): string {
    const wrap = (doc: Doc): SectionUnit[] =>
      doc.sections.map((section, i) => ({
        key: section.key,
        norm: normalizeText(section.text),
        text: section.text,
        section,
        next: doc.sections[i + 1]?.key ?? null,
      }));
    const merged = mergeUnits(wrap(base), wrap(ours), wrap(theirs), {
      both: (b, a, t) => [this.section(b.section, a.section, t.section)],
      // Two sections added in one place: the same heading is one section
      // both sides wrote, merged against nothing; different headings are two.
      pair: (a, t) => (a.key === t.key ? [this.section(null, a.section, t.section)] : [a, t]),
      keptOverRemoval: (unit, by) =>
        this.notes.push(`section "${sectionName(unit.section)}": removed on ${otherSide(by)} side but changed on ${sideName(by)}s; kept`),
      removed: (unit, by) => this.notes.push(`section "${sectionName(unit.section)}": removed, as ${sideName(by)} side deleted it`),
    });
    return assembleBody(merged.map((unit) => ({ key: unit.key, text: unit.text, verbatim: unit.next === undefined ? undefined : { next: unit.next } })));
  }

  /** A section both sides changed (or both added under one heading). */
  private section(base: Section | null, ours: Section, theirs: Section): SectionUnit {
    const context = sectionName(ours);
    if (this.strategy === "latest-wins-additive") {
      const pick = this.theirsNewer ? theirs : ours;
      this.notes.push(
        `section "${context}": both sides changed it; kept ${this.theirsNewer ? "theirs (later `updated`)" : "ours (`updated` not later on theirs)"} and dropped the other version`
      );
      return { key: ours.key, norm: normalizeText(pick.text), text: pick.text, section: pick };
    }
    const timeline = this.strategy === "timeline-append" && isTimelineHeading(ours.path[ours.path.length - 1] ?? "");
    const units = timeline ? this.timeline(base, ours, theirs, context) : this.blocks(base, ours, theirs, context);
    const heading = this.written(`section "${context}"`, "heading", base?.heading ?? null, ours.heading, theirs.heading);
    const text = emitSection(heading, ours.lead, units);
    return { key: ours.key, norm: normalizeText(text), text, section: ours };
  }

  /**
   * One line of source both versions key the same way (a heading, a table's
   * header): the key reads it as a reader sees it, so a new link target or
   * markup leaves it aligned but is still a change. Three-way by the bytes;
   * both changed, or both wrote it differently with no base, keeps OURS.
   */
  private written(context: string, what: string, base: string | null, ours: string, theirs: string): string {
    if (ours === theirs || theirs === base) return ours;
    if (ours === base) return theirs;
    this.notes.push(`${context}: both sides wrote the ${what} differently; kept ours: "${snippet(ours)}" / "${snippet(theirs)}"`);
    return ours;
  }

  private blocks(base: Section | null, ours: Section, theirs: Section, context: string): Unit[] {
    const sameTable = (x: Unit, y: Unit) => x.kind === "table" && y.kind === "table" && x.key === y.key;
    return mergeUnits(base?.units ?? [], ours.units, theirs.units, {
      pair: (x, y) => (sameTable(x, y) ? [this.table(null, x, y, context)] : this.pair(x, y, context)),
      both: (b, x, y) => (sameTable(x, y) ? [this.table(b, x, y, context)] : this.pair(x, y, context)),
      keptOverRemoval: (unit, by) =>
        this.notes.push(`${context}: kept a block ${otherSide(by)} side removed, because ${sideName(by)} side changed it: "${snippet(unit.text)}"`),
      removed: (unit, by) => this.notes.push(`${context}: removed a block ${sideName(by)} side deleted: "${snippet(unit.text)}"`),
    });
  }

  /**
   * Two versions of one passage: which to keep, in order. A pair nobody
   * decided keeps both, the newer side first.
   */
  private judge(context: string, ours: string, theirs: string): ("ours" | "theirs")[] {
    const pair: JudgmentPair = { id: pairId(this.path, context, ours, theirs), path: this.path, context, ours, theirs };
    this.pairs.set(pair.id, pair);
    const decision = this.decide(pair.id);
    const what = `"${snippet(ours)}" / "${snippet(theirs)}"`;
    switch (decision) {
      case "same-fact":
        this.notes.push(`${context}: both sides changed a passage; judged the same fact, kept ours: ${what}`);
        return ["ours"];
      case "ours-supersedes":
        this.notes.push(`${context}: both sides changed a passage; ours supersedes theirs, kept ours: ${what}`);
        return ["ours"];
      case "theirs-supersedes":
        this.notes.push(`${context}: both sides changed a passage; theirs supersedes ours, kept theirs: ${what}`);
        return ["theirs"];
      default:
        this.notes.push(
          `${context}: both sides changed a passage; ${decision ? "judged distinct" : "not judged"}, kept both, ${this.theirsNewer ? "theirs" : "ours"} first: ${what}`
        );
        return this.theirsNewer ? ["theirs", "ours"] : ["ours", "theirs"];
    }
  }

  private pair(x: Unit, y: Unit, context: string): Unit[] {
    return this.judge(context, x.text, y.text).map((side) => (side === "ours" ? x : y));
  }

  /**
   * One table both sides changed, merged row by row, keyed by the first cell.
   * Header from OURS; OURS' rows in OURS' order, then the rows only THEIRS
   * has, in THEIRS' order. A row both sides changed goes to its later
   * `Updated` date, else to a judgment.
   */
  private table(base: Unit | null, ours: Unit, theirs: Unit, context: string): Unit {
    const header = ours.table!.header;
    const updatedColumn = header.findIndex((cell) => nameKey(cell) === "updated");
    // A row is its key and which of that key's rows it is, as a tuple: a
    // spelled-out `a#1` would be the second `a` and the first `a#1` at once.
    const keyed = (rows: TableRow[] = []) => {
      const byKey = new Map<string, TableRow>();
      const seen = new Map<string, number>();
      for (const row of rows) {
        const n = seen.get(row.key) ?? 0;
        seen.set(row.key, n + 1);
        byKey.set(JSON.stringify([row.key, n]), row);
      }
      return byKey;
    };
    const B = keyed(base?.rows);
    const O = keyed(ours.rows);
    const T = keyed(theirs.rows);
    // Cells as written: a new link target changes a row even where its text does not.
    const same = (a?: TableRow, b?: TableRow) => (a && b ? JSON.stringify(a.source) === JSON.stringify(b.source) : a === b);

    const resolveRow = (key: string): TableRow[] => {
      const b = B.get(key);
      const o = O.get(key);
      const t = T.get(key);
      const label = `${context} > ${header.join(" | ")} > ${(o ?? t)?.cells[0] ?? ""}`;
      if (o && t) {
        if (same(o, t) || same(t, b)) return [o];
        if (same(o, b)) return [t];
        const od = updatedColumn >= 0 ? dateValue(o.cells[updatedColumn]) : null;
        const td = updatedColumn >= 0 ? dateValue(t.cells[updatedColumn]) : null;
        if (od !== null && td !== null && od !== td) {
          this.notes.push(`${label}: both sides changed the row; kept ${td > od ? "theirs" : "ours"} (later Updated)`);
          return [td > od ? t : o];
        }
        return this.judge(label, o.text, t.text).map((side) => (side === "ours" ? o : t));
      }
      const only = o ?? t;
      if (!only) return [];
      const side = o ? "ours" : "theirs";
      if (!b) return [only];
      if (same(only, b)) {
        this.notes.push(`${label}: removed the row, as ${otherSide(side)} side deleted it`);
        return [];
      }
      this.notes.push(`${label}: kept the row ${otherSide(side)} side removed, because ${sideName(side)} side changed it`);
      return [only];
    };

    const rows = [...O.keys()].flatMap(resolveRow);
    for (const key of T.keys()) if (!O.has(key)) rows.push(...resolveRow(key));
    const head = this.written(`${context} > ${header.join(" | ")}`, "table header", base?.table?.head ?? null, ours.table!.head, theirs.table!.head);
    const text = [head, ...rows.map((row) => row.text)].join("\n");
    return { ...ours, text, norm: normalizeText(text), origin: null, rows };
  }

  /**
   * The Timeline section: three-way by entry, so an entry one side removed
   * or rewrote follows that side; then every entry in date order, in the
   * direction OURS keeps it, exact duplicates once. Two entries in one place
   * with different text both stay: a timeline only grows.
   */
  private timeline(base: Section | null, ours: Section, theirs: Section, context: string): Unit[] {
    const merged = mergeUnits(base?.units ?? [], ours.units, theirs.units, {
      pair: (x, y) => {
        if (entryDate(x.text) && entryDate(y.text)) {
          this.notes.push(`${context}: both sides added an entry in one place; kept both: "${snippet(x.text)}" / "${snippet(y.text)}"`);
          return [x, y];
        }
        return this.pair(x, y, context);
      },
      keptOverRemoval: (unit, by) =>
        this.notes.push(`${context}: kept an entry ${otherSide(by)} side removed, because ${sideName(by)} side changed it: "${snippet(unit.text)}"`),
      removed: (unit, by) => this.notes.push(`${context}: removed an entry ${sideName(by)} side deleted: "${snippet(unit.text)}"`),
    });

    const seen = new Set<string>();
    const unique = merged.filter((unit) => {
      if (entryDate(unit.text) === null) return true;
      if (seen.has(unit.norm)) return false;
      seen.add(unit.norm);
      return true;
    });

    const direction = (section: Section | null): boolean | null => {
      const dates = (section?.units ?? []).map((unit) => entryDate(unit.text)).filter((d): d is string => d !== null);
      if (new Set(dates).size < 2) return null;
      return dates[0]! > dates[dates.length - 1]!;
    };
    const descending = direction(ours) ?? direction(theirs) ?? direction(base) ?? false;

    // Undated units before the first entry stay first; any other undated
    // unit travels with the entry before it.
    const lead: Unit[] = [];
    const groups: { date: string; units: Unit[] }[] = [];
    for (const unit of unique) {
      const date = entryDate(unit.text);
      if (date !== null) groups.push({ date, units: [unit] });
      else if (groups.length > 0) groups[groups.length - 1]!.units.push(unit);
      else lead.push(unit);
    }
    groups.sort((a, b) => (a.date === b.date ? 0 : (a.date < b.date) !== descending ? -1 : 1));
    return [...lead, ...groups.flatMap((group) => group.units)];
  }
}
