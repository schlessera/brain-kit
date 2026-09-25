/**
 * `brain briefing` opens with a warning line for each `brain audit` finding
 * about the focus document: an overdue review, a blown budget, past-dated
 * lines. Briefing reads the wall clock, so it runs in process with the clock
 * pinned to NOW.
 */

import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

import { generateBriefing } from "../src/cli/commands/briefing";
import { estimateTokens } from "../src/lib/context-assembler";
import { initContext } from "../src/lib/context";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-01T12:00:00Z");
const FOCUS = "context/current-focus.md";
const MTIME = new Date("2026-06-01T00:00:00Z");

const brains: string[] = [];
afterAll(() => { for (const dir of brains) cleanup(dir); });

function focusDoc(frontmatter: string, body: string): string {
  return `---\ntype: context\ntitle: "Current Focus"\ncreated: 2026-01-01\nupdated: 2026-06-28\nstatus: active\n${frontmatter}---\n\n${body}\n`;
}

interface BriefingOptions {
  config?: string;
  extra?: Record<string, string>;
  /** Where the focus document lives, relative to the root. */
  at?: string;
  /** Runs after indexing, before the briefing. */
  afterIndex?: (root: string) => void;
}

/** Index a brain holding `focus` (and any `extra` files) and return its briefing at NOW. */
async function briefing(focus: string, opts: BriefingOptions = {}): Promise<string> {
  const { config = "export default {};\n", extra = {}, at = FOCUS, afterIndex } = opts;
  const root = makeTempBrain({ empty: true });
  brains.push(root);
  writeFileSync(join(root, "brain.config.ts"), config);
  mkdirSync(join(root, at, ".."), { recursive: true });
  writeFileSync(join(root, at), focus);
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  // File times no later than any frontmatter `updated`, so no document reads
  // as silently modified and the whole output is deterministic.
  for (const rel of [at, ...Object.keys(extra)]) utimesSync(join(root, rel), MTIME, MTIME);
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  afterIndex?.(root);
  const brain = await initContext({ root });
  setSystemTime(NOW);
  try {
    return generateBriefing(brain);
  } finally {
    setSystemTime();
  }
}

const current = "## Now\n\n- Sand the face frame.\n- 2026-07-10 glue-up.";

test("a focus document past its next_review opens the briefing with an overdue warning", async () => {
  const out = await briefing(focusDoc("next_review: 2026-06-19\n", current));
  expect(out.split("\n")[0]).toBe(
    `> **Warning:** \`${FOCUS}\` is 12 day(s) overdue for review (due 2026-06-19); the priorities below may be stale.`
  );
  expect(out.split("\n")[1]).toBe("");
  expect(out.split("\n")[2]).toBe("## Current Focus");
});

test("a focus document over its configured budget names both numbers", async () => {
  const body = `${current}\n\n${"More context on the build. ".repeat(40)}`;
  const out = await briefing(focusDoc("", body), {
    config: `export default { taxonomy: { canonicalPolicy: { currentFocus: { maxTokens: 100 } } } };\n`,
  });
  const tokens = estimateTokens(`${body}\n`);
  expect(tokens).toBeGreaterThan(100);
  expect(out.split("\n")[0]).toBe(`> **Warning:** \`${FOCUS}\` is ~${tokens} tokens, over its 100-token budget.`);
});

test("past-dated lines are counted in one warning", async () => {
  const out = await briefing(focusDoc("", `${current}\n- 2026-05-01 send the quote.\n- 2026-06-30 book the kiln.`));
  expect(out.split("\n")[0]).toBe(`> **Warning:** \`${FOCUS}\` has 2 line(s) naming a past date; \`brain audit\` lists them.`);
});

test("a current, in-budget focus document with no past dates gives exactly the briefing it gave before", async () => {
  // Another document's overdue review stays in its own section below.
  const other = `---\ntype: note\ntitle: "Old"\ncreated: 2026-01-01\nupdated: 2026-06-01\nstatus: active\nnext_review: 2026-06-01\n---\n\nOld note.\n`;
  const out = await briefing(focusDoc("next_review: 2026-07-20\n", current), { extra: { "notes/old.md": other } });
  // The approved baseline: the output of the tree before this change for the
  // same brain and clock.
  expect(out).toBe(
    [
      "## Current Focus",
      "",
      "## Now",
      "",
      "- Sand the face frame.",
      "- 2026-07-10 glue-up.",
      "",
      "## Overdue Reviews",
      "",
      "- 2026-06-01 | notes/old.md | Old",
      "",
      "## Recently Active",
      "",
      "- 2026-06-28 | context | context/current-focus.md | Current Focus | ",
      "- 2026-06-01 | note | notes/old.md | Old | ",
    ].join("\n")
  );
});

// Review round 1: warnings render every value as one literal line.
test("a multi-line next_review gives one warning line with no day count", async () => {
  const out = await briefing(focusDoc("next_review: |\n  2026-06-19\n\n  # Injected heading\n", current));
  const [first, second] = out.split("\n");
  expect(first).toBe(
    `> **Warning:** \`${FOCUS}\` is overdue for review (its due date \`2026-06-19 # Injected heading\` is not a YYYY-MM-DD day); the priorities below may be stale.`
  );
  expect(first).not.toContain("NaN");
  expect(second).toBe("");
});

test("a focus path holding markup is shown as a literal", async () => {
  const at = "context/<img src=x>.md";
  const out = await briefing(focusDoc("next_review: 2026-06-19\n", current), {
    config: `export default { taxonomy: { canonical: { currentFocus: ${JSON.stringify(at)} } } };\n`,
    at,
  });
  expect(out.split("\n")[0]).toBe(
    `> **Warning:** \`${at}\` is 12 day(s) overdue for review (due 2026-06-19); the priorities below may be stale.`
  );
});

test("a focus path configured as ./context/… is the indexed document", async () => {
  const out = await briefing(focusDoc("next_review: 2026-06-19\n", "Links to [[notes/old]].\n"), {
    config: `export default { taxonomy: { canonical: { currentFocus: "./${FOCUS}" } } };\n`,
    extra: { "notes/old.md": `---\ntype: note\ntitle: "Old"\ncreated: 2026-01-01\nupdated: 2026-06-30\nstatus: active\n---\n\nOld.\n` },
  });
  expect(out.split("\n")[0]).toContain(`\`${FOCUS}\` is 12 day(s) overdue`);
  expect(out).toContain("## Focus-Linked Documents");
});

test("a focus document deleted after indexing gets no warning and no section", async () => {
  const out = await briefing(focusDoc("next_review: 2026-06-19\n", current), {
    afterIndex: (root) => rmSync(join(root, FOCUS)),
  });
  expect(out).not.toContain("Warning");
  expect(out).not.toContain("## Current Focus");
});
