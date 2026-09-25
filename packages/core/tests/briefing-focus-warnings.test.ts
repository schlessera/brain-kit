/**
 * `brain briefing` opens with a warning line for each `brain audit` finding
 * about the focus document: an overdue review, a blown budget, past-dated
 * lines. Briefing reads the wall clock, so it runs in process with the clock
 * pinned to NOW.
 */

import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { generateBriefing } from "../src/cli/commands/briefing";
import { estimateTokens } from "../src/lib/context-assembler";
import { initContext } from "../src/lib/context";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-01T12:00:00Z");
const FOCUS = "context/current-focus.md";

const brains: string[] = [];
afterAll(() => { for (const dir of brains) cleanup(dir); });

function focusDoc(frontmatter: string, body: string): string {
  return `---\ntype: context\ntitle: "Current Focus"\ncreated: 2026-01-01\nupdated: 2026-06-28\nstatus: active\n${frontmatter}---\n\n${body}\n`;
}

/** Index a brain holding `focus` (and any `extra` files) and return its briefing at NOW. */
async function briefing(focus: string, config = "export default {};\n", extra: Record<string, string> = {}): Promise<string> {
  const root = makeTempBrain({ empty: true });
  brains.push(root);
  writeFileSync(join(root, "brain.config.ts"), config);
  mkdirSync(join(root, "context"), { recursive: true });
  writeFileSync(join(root, FOCUS), focus);
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
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
    `> **Warning:** ${FOCUS} is 12 day(s) overdue for review (due 2026-06-19); the priorities below may be stale.`
  );
  expect(out.split("\n")[1]).toBe("");
  expect(out.split("\n")[2]).toBe("## Current Focus");
});

test("a focus document over its configured budget names both numbers", async () => {
  const body = `${current}\n\n${"More context on the build. ".repeat(40)}`;
  const out = await briefing(
    focusDoc("", body),
    `export default { taxonomy: { canonicalPolicy: { currentFocus: { maxTokens: 100 } } } };\n`
  );
  const tokens = estimateTokens(`${body}\n`);
  expect(tokens).toBeGreaterThan(100);
  expect(out.split("\n")[0]).toBe(`> **Warning:** ${FOCUS} is ~${tokens} tokens, over its 100-token budget.`);
});

test("past-dated lines are counted in one warning", async () => {
  const out = await briefing(focusDoc("", `${current}\n- 2026-05-01 send the quote.\n- 2026-06-30 book the kiln.`));
  expect(out.split("\n")[0]).toBe(`> **Warning:** ${FOCUS} has 2 line(s) naming a past date; \`brain audit\` lists them.`);
});

test("a current, in-budget focus document with no past dates opens with Current Focus, as before", async () => {
  // Another document's overdue review stays in its own section below.
  const other = `---\ntype: note\ntitle: "Old"\ncreated: 2026-01-01\nupdated: 2026-06-01\nstatus: active\nnext_review: 2026-06-01\n---\n\nOld note.\n`;
  const out = await briefing(focusDoc("next_review: 2026-07-20\n", current), undefined, { "notes/old.md": other });
  expect(out).toContain("## Overdue Reviews");
  expect(out.split("\n").slice(0, 3)).toEqual(["## Current Focus", "", "## Now"]);
});
