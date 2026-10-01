/**
 * Properties of the merge library over generated documents (M4/M5).
 *
 * Each property runs over PROPERTY_CASES documents drawn from a seeded
 * mulberry32 stream, so a failure names a seed that reproduces it:
 *
 * (a) every block of OURS and of THEIRS is in the result, unless a decision
 *     dropped it or it is a base block the other side removed or rewrote;
 *     and every frontmatter field only one side changed has that side's value;
 * (b) merging a document with itself three times gives it back;
 * (c) when only one side changed, the result is that side, byte for byte;
 *     and when OURS changed only the body and THEIRS only the frontmatter,
 *     the result is THEIRS' frontmatter over OURS' body;
 * (d) the result always parses: frontmatter a YAML map, body split into
 *     blocks cleanly;
 * (e) planning and rendering never throw, whatever a side holds: a YAML alias
 *     that contains itself, frontmatter or a body nested deep, `.nan`, broken
 *     YAML, CRLF, a missing side, link cells and duplicate row keys. What
 *     cannot be merged comes back `unresolved`.
 *
 * Each checker is also run against a deliberately broken merge, which it must
 * catch, so none of them can pass by having nothing to observe.
 */

import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/lib/frontmatter-parse";

import { stringifyDocument } from "../src/lib/frontmatter";
import { parseDoc, type Unit } from "../src/lib/sync/resolve/markdown";
import { planMerge, type MergeInput, type MergeOutcome } from "../src/lib/sync/resolve/plan";
import { PAIR_DECISIONS, type JudgmentPair, type MergeStrategy, type PairDecision } from "../src/lib/sync/types";

const PROPERTY_CASES = 500;

/** mulberry32: a 32-bit generator whose low bits are as good as its high ones. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private readonly next: () => number;
  private counter = 0;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** A fresh token, so two generated blocks never collide by accident. */
  token(): string {
    return `n${++this.counter}`;
  }
  words(): string {
    const vocabulary = ["oak", "route", "glue", "Saturn", "knee", "bench", "ridge", "eagle", "plane", "shift", "rota", "sleep"];
    const count = 2 + this.int(5);
    return Array.from({ length: count }, () => this.pick(vocabulary)).join(" ");
  }
  date(): string {
    return `2026-0${4 + this.int(3)}-${String(1 + this.int(28)).padStart(2, "0")}`;
  }
}

// ---------------------------------------------------------------------------
// A document model, rendered to markdown, and edits on it.

type Block =
  | { kind: "para"; text: string }
  | { kind: "item"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: [string, string][] };

interface Model {
  title: string;
  created: string;
  updated: string;
  tags: string[];
  status: string;
  /** A number: a value `editFrontmatter` cannot write, so the serializer path runs too. */
  rating: number;
  sections: { heading: string | null; level?: number; blocks: Block[] }[];
}

function newBlock(g: Gen, timeline: boolean): Block {
  if (timeline) return { kind: "item", text: `${g.date()}: ${g.words()} ${g.token()}` };
  switch (g.int(5)) {
    case 0:
    case 1:
      return { kind: "para", text: `${g.words()} ${g.token()}.` };
    case 2:
      return { kind: "item", text: `${g.words()} ${g.token()}` };
    case 3:
      // A `#` line inside a fence is code, never a heading.
      return { kind: "code", text: `# ${g.words()} ${g.token()}\nrun --flag ${g.int(9)}` };
    default:
      return { kind: "table", rows: Array.from({ length: 1 + g.int(3) }, () => newRow(g)) };
  }
}

function newRow(g: Gen): [string, string] {
  const key = g.chance(0.3) ? `[[k${g.token()}]]` : `k${g.token()}`;
  return [key, `${g.words()} ${g.token()}`];
}

function newModel(g: Gen, strategy: MergeStrategy): Model {
  const sections: Model["sections"] = [{ heading: null, blocks: g.chance(0.5) ? [newBlock(g, false)] : [] }];
  const count = 1 + g.int(4);
  for (let i = 0; i < count; i++) {
    sections.push({ heading: `Topic ${g.token()}`, blocks: Array.from({ length: 1 + g.int(4) }, () => newBlock(g, false)) });
  }
  if (strategy === "timeline-append") {
    const dates = Array.from({ length: 1 + g.int(4) }, () => g.date()).sort();
    sections.push({ heading: "Timeline", blocks: dates.map((date) => ({ kind: "item", text: `${date}: ${g.words()} ${g.token()}` })) });
  }
  return {
    title: `Field notes ${g.token()}`,
    created: "2026-01-08",
    updated: g.date(),
    tags: ["sailor", g.pick(["wood", "sky", "health"])],
    status: "active",
    rating: 1 + g.int(5),
    sections,
  };
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "para":
      return block.text;
    case "item":
      return `- ${block.text}`;
    case "code":
      return "```\n" + block.text + "\n```";
    case "table":
      return ["| Key | Note |", "|-----|------|", ...block.rows.map(([k, v]) => `| ${k.replace(/\|/g, "\\|")} | ${v} |`)].join("\n");
  }
}

function render(model: Model): string {
  let text = `---\ntitle: "${model.title}"\ncreated: ${model.created}\nupdated: ${model.updated}\ntags: [${model.tags.join(", ")}]\nstatus: ${model.status}\nrating: ${model.rating}\n---\n`;
  for (const section of model.sections) {
    if (section.heading !== null) text += `\n${"#".repeat(section.level ?? 2)} ${section.heading}\n`;
    for (const block of section.blocks) text += `\n${renderBlock(block)}\n`;
  }
  return text;
}

const clone = (model: Model): Model => JSON.parse(JSON.stringify(model)) as Model;

function editBody(g: Gen, model: Model): void {
  const timeline = model.sections.find((s) => s.heading === "Timeline");
  const sections = model.sections.filter((s) => s !== timeline);
  const section = g.pick(sections);
  switch (g.int(7)) {
    case 0:
      if (timeline) timeline.blocks.push(newBlock(g, true));
      else section.blocks.push(newBlock(g, false));
      break;
    case 1:
      section.blocks.splice(g.int(section.blocks.length + 1), 0, newBlock(g, false));
      break;
    case 2:
      if (section.blocks.length > 0) section.blocks.splice(g.int(section.blocks.length), 1);
      break;
    case 3: {
      if (section.blocks.length === 0) break;
      const i = g.int(section.blocks.length);
      const block = section.blocks[i]!;
      if (block.kind === "table") {
        const r = g.int(block.rows.length);
        if (g.chance(0.5)) block.rows[r] = [block.rows[r]![0], `${g.words()} ${g.token()}`];
        else block.rows.push(newRow(g));
      } else {
        section.blocks[i] = newBlock(g, false);
      }
      break;
    }
    case 4:
      // Sometimes a heading the other side may add too, sometimes nested.
      model.sections.splice(1 + g.int(model.sections.length), 0, {
        heading: g.chance(0.4) ? g.pick(["Ideas", "Next steps"]) : `Topic ${g.token()}`,
        level: g.chance(0.3) ? 3 : 2,
        blocks: [newBlock(g, false)],
      });
      break;
    case 5:
      if (sections.length > 1 && section.heading !== null) model.sections.splice(model.sections.indexOf(section), 1);
      break;
    default:
      if (timeline && timeline.blocks.length > 0 && g.chance(0.5)) timeline.blocks.splice(g.int(timeline.blocks.length), 1);
      else section.blocks.push(newBlock(g, false));
  }
}

function editFrontmatter(g: Gen, model: Model): void {
  switch (g.int(4)) {
    case 3:
      model.rating = 1 + g.int(5);
      break;
    case 0:
      model.updated = g.date();
      break;
    case 1:
      model.tags = g.chance(0.5) ? [...model.tags, `t${g.token()}`] : model.tags.slice(1);
      break;
    default:
      model.status = g.pick(["paused", "done", "active"]);
  }
}

function edited(g: Gen, base: Model, body: boolean, frontmatter: boolean): Model {
  const model = clone(base);
  if (body) for (let n = 1 + g.int(3); n > 0; n--) editBody(g, model);
  if (frontmatter) editFrontmatter(g, model);
  return model;
}

// ---------------------------------------------------------------------------
// The checkers. Each takes the merge under test and returns its failures.

type Merge = (input: MergeInput, strategy: MergeStrategy, decide: (pair: JudgmentPair) => PairDecision | undefined) => {
  pairs: JudgmentPair[];
  outcome: MergeOutcome;
  decisions: Map<string, PairDecision>;
};

const realMerge: Merge = (input, strategy, decide) => {
  const plan = planMerge(input, strategy);
  const decisions = new Map<string, PairDecision>();
  for (const pair of plan.pairs) {
    const decision = decide(pair);
    if (decision) decisions.set(pair.id, decision);
  }
  return { pairs: plan.pairs, outcome: plan.render(decisions), decisions };
};

/** Every block of a document, as the checks compare them: tables by row. */
function blocks(text: string): Unit[] {
  return parseDoc(text, "ours", { tables: "rows" }).sections.flatMap((section) => section.units.filter((unit) => unit.kind !== "head"));
}

const BODY_STRATEGIES: MergeStrategy[] = ["synthesize", "table-union", "timeline-append"];
const ALL_STRATEGIES: MergeStrategy[] = [...BODY_STRATEGIES, "latest-wins-additive", "keep-both"];

interface Failure {
  seed: number;
  why: string;
}

function propertyA(merge: Merge): Failure[] {
  const failures: Failure[] = [];
  for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
    const g = new Gen(seed);
    const strategy = BODY_STRATEGIES[seed % BODY_STRATEGIES.length]!;
    const base = newModel(g, strategy);
    const ours = render(edited(g, base, true, g.chance(0.5)));
    const theirs = render(edited(g, base, true, g.chance(0.5)));
    const baseText = render(base);
    const judged = g.chance(0.5);
    const { outcome, pairs, decisions } = merge({ path: "notes/field.md", base: baseText, ours, theirs }, strategy, () =>
      judged ? g.pick([...PAIR_DECISIONS, undefined]) : undefined
    );
    if (outcome.status !== "resolved" || outcome.content === null) {
      failures.push({ seed, why: `not resolved: ${JSON.stringify(outcome)}` });
      continue;
    }
    const out = new Set(blocks(outcome.content).map((unit) => unit.norm));
    const inBase = new Set(blocks(baseText).map((unit) => unit.norm));
    const check = (side: "ours" | "theirs", text: string, other: string) => {
      const inOther = new Set(blocks(other).map((unit) => unit.norm));
      for (const unit of blocks(text)) {
        if (out.has(unit.norm)) continue;
        // A one-sided three-way change: the other side removed or rewrote a base block.
        if (inBase.has(unit.norm) && !inOther.has(unit.norm)) continue;
        // A decision kept the other version of a pair this block was in.
        const dropped = pairs.some((pair) => {
          const decision = decisions.get(pair.id);
          return side === "ours"
            ? decision === "theirs-supersedes" && pair.ours.includes(unit.norm)
            : (decision === "same-fact" || decision === "ours-supersedes") && pair.theirs.includes(unit.norm);
        });
        if (dropped) continue;
        failures.push({ seed, why: `${strategy}: ${side} block missing: ${JSON.stringify(unit.norm)}` });
        return;
      }
    };
    check("ours", ours, theirs);
    check("theirs", theirs, ours);

    // A field only one side changed keeps that side's value.
    const [b, o, t, m] = [baseText, ours, theirs, outcome.content].map(fields);
    for (const key of new Set([...Object.keys(o!), ...Object.keys(t!)])) {
      const changedOurs = o![key] !== b![key];
      const changedTheirs = t![key] !== b![key];
      if (changedOurs !== changedTheirs && m![key] !== (changedOurs ? o! : t!)[key]) {
        failures.push({ seed, why: `${strategy}: frontmatter \`${key}\` changed only on ${changedOurs ? "ours" : "theirs"} was lost` });
      }
    }
  }
  return failures;
}

/** Frontmatter fields as comparable strings, dates as their day. */
function fields(text: string): Record<string, string> {
  const data = parseFrontmatter(text).data as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, JSON.stringify(v instanceof Date ? v.toISOString().slice(0, 10) : v)])
  );
}

function propertyB(merge: Merge): Failure[] {
  const failures: Failure[] = [];
  for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
    const g = new Gen(seed);
    const strategy = ALL_STRATEGIES[seed % ALL_STRATEGIES.length]!;
    const x = render(edited(g, newModel(g, strategy), g.chance(0.5), g.chance(0.5)));
    const { outcome } = merge({ path: "notes/field.md", base: x, ours: x, theirs: x }, strategy, () => undefined);
    if (outcome.status !== "resolved" || outcome.content !== x) failures.push({ seed, why: `${strategy}: merge(x, x, x) is not x` });
  }
  return failures;
}

function propertyC(merge: Merge): Failure[] {
  const failures: Failure[] = [];
  for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
    const g = new Gen(seed);
    const strategy = ALL_STRATEGIES[seed % ALL_STRATEGIES.length]!;
    const baseModel = newModel(g, strategy);
    const base = render(baseModel);
    const changed = render(edited(g, baseModel, true, g.chance(0.5)));
    const oursChanged = g.chance(0.5);
    const input = oursChanged ? { base, ours: changed, theirs: base } : { base, ours: base, theirs: changed };
    const one = merge({ path: "notes/field.md", ...input }, strategy, () => undefined).outcome;
    if (one.status !== "resolved" || one.content !== changed) {
      failures.push({ seed, why: `${strategy}: only ${oursChanged ? "ours" : "theirs"} changed, the result is not that side` });
      continue;
    }
    // OURS changed only the body and THEIRS only the frontmatter.
    if (strategy === "keep-both") continue;
    const bodyOnly = edited(g, baseModel, true, false);
    const fmOnly = clone(baseModel);
    editFrontmatter(g, fmOnly);
    const ours = render(bodyOnly);
    const theirs = render(fmOnly);
    if (ours === base || theirs === base) continue;
    const split = merge({ path: "notes/field.md", base, ours, theirs }, strategy, () => undefined).outcome;
    const oursDoc = parseDoc(ours, "ours", { tables: "rows" });
    const theirsDoc = parseDoc(theirs, "theirs", { tables: "rows" });
    if (split.status !== "resolved" || split.content !== theirsDoc.frontmatter + oursDoc.body) {
      failures.push({ seed, why: `${strategy}: body from ours and frontmatter from theirs were not combined as they are` });
    }
  }
  return failures;
}

function propertyD(merge: Merge): Failure[] {
  const failures: Failure[] = [];
  for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
    const g = new Gen(seed);
    const strategy = ALL_STRATEGIES[seed % ALL_STRATEGIES.length]!;
    const baseModel = newModel(g, strategy);
    const ours = render(edited(g, baseModel, g.chance(0.8), g.chance(0.7)));
    const theirs = render(edited(g, baseModel, g.chance(0.8), g.chance(0.7)));
    const { outcome } = merge({ path: "notes/field.md", base: render(baseModel), ours, theirs }, strategy, () =>
      g.pick([...PAIR_DECISIONS, undefined])
    );
    if (outcome.status !== "resolved" || outcome.content === null) {
      failures.push({ seed, why: `${strategy}: not resolved` });
      continue;
    }
    for (const text of [outcome.content, ...outcome.extraFiles.map((file) => file.content)]) {
      try {
        parseDoc(text, "ours", { tables: "rows" });
        const data = parseFrontmatter(text).data as unknown;
        if (!data || typeof data !== "object" || Array.isArray(data) || !("title" in data)) throw new Error("frontmatter lost its fields");
      } catch (e) {
        failures.push({ seed, why: `${strategy}: result does not parse: ${(e as Error).message}` });
        break;
      }
    }
  }
  return failures;
}

/** A generated side with one thing a stranger's file may hold that the generator above never writes. */
function hostile(g: Gen, text: string): string {
  const intoFrontmatter = (line: string) => text.replace(/^---\n/, `---\n${line}\n`);
  switch (g.int(10)) {
    case 0:
      return intoFrontmatter(g.pick(["loop: &l [*l]", "loop: &l {self: *l}", "a: &a [x]\nb: [*a, *a]"]));
    case 1: {
      const n = 40 + g.int(120);
      return intoFrontmatter(`deep: ${"[".repeat(n)}${"]".repeat(n)}`);
    }
    case 2:
      return intoFrontmatter(`reading: ${g.pick([".nan", ".inf", "-.inf", "null", "~"])}`);
    case 3:
      return intoFrontmatter(g.pick(["broken: [", "a: b: c", "- a list"]));
    case 4: {
      const key = g.pick(["A", "a", "A#1", "a#2", "[[a]]"]);
      const link = g.pick(["old", "new", "other"]);
      return `${text}\n| Key | Note |\n|-----|------|\n| ${key} | [${g.words()}](${link}) |\n| A | ${g.token()} |\n`;
    }
    case 5:
      return `${text}\n${g.words()}${g.chance(0.5) ? "  " : " "}\n${g.words()}\n`;
    case 6:
      return `${text}\n${"> ".repeat(50 + g.int(3000))}${g.words()}\n`;
    case 7:
      return text.replace(/\n/g, "\r\n");
    case 8:
      return `${text}\n## ${g.pick(["[Ideas](a.md)", "[Ideas](b.md)", "IDEAS", "Ideas"])}\n\n${g.words()}\n`;
    default:
      return text;
  }
}

const EVERY_STRATEGY: MergeStrategy[] = [...ALL_STRATEGIES, "code-merge", "cache-union"];

function propertyE(merge: Merge): Failure[] {
  const failures: Failure[] = [];
  for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
    const g = new Gen(seed);
    const strategy = EVERY_STRATEGY[seed % EVERY_STRATEGY.length]!;
    const baseModel = newModel(g, strategy);
    const side = (model: Model) => (g.chance(0.05) ? null : g.chance(0.6) ? hostile(g, render(model)) : render(model));
    const base = side(baseModel);
    const ours = side(edited(g, baseModel, g.chance(0.8), g.chance(0.7)));
    const theirs = side(edited(g, baseModel, g.chance(0.8), g.chance(0.7)));
    try {
      merge({ path: "notes/field.md", base, ours, theirs }, strategy, () => g.pick([...PAIR_DECISIONS, undefined]));
    } catch (e) {
      failures.push({ seed, why: `${strategy}: threw ${(e as Error).message.split("\n")[0]}` });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Broken merges each checker must catch. Each models a real bug.

/** Both sides changed the body: OURS wins, THEIRS' additions are lost. */
const oursWins: Merge = (input, strategy, decide) => {
  const real = realMerge(input, strategy, decide);
  if (real.outcome.status !== "resolved" || input.ours === null || input.theirs === null || input.base === null) return real;
  const [b, o, t] = [input.base, input.ours, input.theirs].map((text) => parseDoc(text, "ours", { tables: "rows" }));
  if (o!.body === b!.body || t!.body === b!.body) return real;
  const content = o!.frontmatter + o!.body;
  return { ...real, outcome: { ...real.outcome, content } };
};

/** The frontmatter goes back through the serializer, so its quoting changes. */
const reserialized: Merge = (input, strategy, decide) => {
  const real = realMerge(input, strategy, decide);
  if (real.outcome.status !== "resolved" || real.outcome.content === null) return real;
  const parsed = parseFrontmatter(real.outcome.content);
  return { ...real, outcome: { ...real.outcome, content: stringifyDocument(parsed.content, parsed.data) } };
};

/** The frontmatter's closing fence is lost when both sides changed it. */
const unclosed: Merge = (input, strategy, decide) => {
  const real = realMerge(input, strategy, decide);
  if (real.outcome.status !== "resolved" || real.outcome.content === null) return real;
  if (input.ours === input.theirs || input.ours === input.base || input.theirs === input.base) return real;
  return { ...real, outcome: { ...real.outcome, content: real.outcome.content.replace(/\n---\n/, "\n") } };
};

/** Frontmatter compared by walking it, aliases and all: a value that contains itself never ends. */
const walksAliases: Merge = (input, strategy, decide) => {
  for (const text of [input.base, input.ours, input.theirs]) {
    if (text === null) continue;
    try {
      JSON.stringify(parseFrontmatter(text).data);
    } catch (e) {
      if (e instanceof TypeError) throw e;
    }
  }
  return realMerge(input, strategy, decide);
};

/** Failing cases (seeds), not failures: one case can fail more than one check. */
const failing = (failures: Failure[]) => new Set(failures.map((failure) => failure.seed)).size;
const report = (failures: Failure[]) =>
  failures.length === 0 ? "" : `${failing(failures)} failing cases; first: seed ${failures[0]!.seed}: ${failures[0]!.why}`;

describe("sync merge properties", () => {
  test("(a) no block or one-sided field change is dropped without a three-way rule or a decision", () => {
    expect(report(propertyA(realMerge))).toBe("");
  });
  test("(b) merge(x, x, x) = x", () => {
    expect(report(propertyB(realMerge))).toBe("");
  });
  test("(c) only one side changed: the result is that side", () => {
    expect(report(propertyC(realMerge))).toBe("");
  });
  test("(d) the result parses, frontmatter included", () => {
    expect(report(propertyD(realMerge))).toBe("");
  });
  test("(e) planning and rendering never throw, whatever a side holds", () => {
    expect(report(propertyE(realMerge))).toBe("");
  });

  test("each checker catches a broken merge", () => {
    const counts = {
      a: failing(propertyA(oursWins)),
      b: failing(propertyB(reserialized)),
      c: failing(propertyC(reserialized)),
      d: failing(propertyD(unclosed)),
      e: failing(propertyE(walksAliases)),
    };
    console.log(`broken-merge failure counts (of ${PROPERTY_CASES} each): ${JSON.stringify(counts)}`);
    expect(counts.a).toBeGreaterThan(0);
    expect(counts.b).toBeGreaterThan(0);
    expect(counts.c).toBeGreaterThan(0);
    expect(counts.d).toBeGreaterThan(0);
    expect(counts.e).toBeGreaterThan(0);
  });
});
