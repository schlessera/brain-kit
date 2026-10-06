/**
 * pi's brain_context assembles hits with core's assembler (#459): the pool
 * is sized from the budget, a hit that does not fit is skipped rather than
 * ending the block, headers are one line, and snippets carry no FTS5
 * highlight markers. Identity and focus stay out, since the pi session
 * already loads them.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { estimateTokens } from "@schlessera/brain/internal";

import { createBrainAccess } from "../src/brain-access";
import { makeIndexedBrain, type TempBrain } from "./helpers";

const doc = (title: string, body: string, summary?: string) =>
  `---\ntype: note\ntitle: "${title}"\ncreated: 2020-01-01\nupdated: 2020-01-02\ntags: [t]\nstatus: active\nrelevance: secondary\n` +
  (summary ? `summary: "${summary}"\n` : "") +
  `---\n\n${body}\n`;

let brain: TempBrain;

beforeAll(async () => {
  const docs: Record<string, string> = {
    // Ranked first for "lantern" and too large for a small budget on its own.
    // The size is in the title, which both the old loop and core's header
    // print, so the old loop stops on it too.
    "notes/huge.md": doc(`Lantern ${"lantern very long title ".repeat(80).trim()}`, "lantern lantern lantern lantern"),
    "notes/small.md": doc("Small", `a lantern ${"among other unrelated words ".repeat(6)}`),
    "me/identity.md": `---\ntype: identity\ntitle: "Identity"\ncreated: 2020-01-01\nupdated: 2020-01-02\ntags: [me]\n---\n\nThe keeper of the trail light.\n`,
    "context/current-focus.md": `---\ntype: context\ntitle: "Current Focus"\ncreated: 2020-01-01\nupdated: 2020-01-02\ntags: [focus]\n---\n\nFinishing the trail map this week.\n`,
  };
  // Enough matching material that 2000 tokens cannot hold it all.
  for (let i = 0; i < 40; i++) {
    docs[`notes/beacon-${String(i).padStart(2, "0")}.md`] = doc(`Beacon ${i}`, `beacon ${"signal words for the beacon note ".repeat(12)}`);
  }
  brain = await makeIndexedBrain(docs);
});

afterAll(() => brain.cleanup());

const context = (query: string, maxTokens: number) => createBrainAccess(brain.root).context(query, maxTokens);

test("carries no FTS5 highlight markers", async () => {
  const out = await context("lantern", 4000);
  // The premise: a hit is present, and FTS5 marked its snippet.
  expect(out).toContain("(notes/small.md)");
  expect(out).not.toContain(">>>");
  expect(out).not.toContain("<<<");
});

test("a hit too large for the budget is skipped and the next one that fits is included", async () => {
  // The premise: the huge hit ranks first, and its title alone is over budget.
  const { results } = await createBrainAccess(brain.root).search({ query: "lantern", limit: 2 });
  expect(results.map((r) => r.path)).toEqual(["notes/huge.md", "notes/small.md"]);
  expect(estimateTokens(results[0]!.title)).toBeGreaterThan(300);
  const out = await context("lantern", 300);
  expect(out).not.toContain("notes/huge.md");
  expect(out).toContain("(notes/small.md)");
});

test("each hit's header is core's one-line header", async () => {
  const out = await context("lantern", 4000);
  expect(out.split("\n")).toContain("### Small (notes/small.md) · updated 2020-01-02 · active");
});

test("a larger budget yields strictly more, and neither exceeds its budget", async () => {
  const small = await context("beacon", 2000);
  const large = await context("beacon", 8000);
  expect(large.length).toBeGreaterThan(small.length);
  expect(estimateTokens(small)).toBeLessThanOrEqual(2000);
  expect(estimateTokens(large)).toBeLessThanOrEqual(8000);
});

test("no identity or focus section is prepended", async () => {
  const out = await context("lantern", 4000);
  expect(out.split("\n")).not.toContain("## Identity");
  expect(out.split("\n")).not.toContain("## Current Focus");
});

test("the search's warnings lead the block when they fit", async () => {
  // Keyless: vector search is unavailable, and the block says so first.
  const out = await context("lantern", 4000);
  expect(out.startsWith("> vector search unavailable")).toBe(true);
  expect(estimateTokens(out)).toBeLessThanOrEqual(4000);
});

// The block alone fills most of these budgets: the warning line must give way.
const SWEEP = Array.from({ length: 53 }, (_, i) => 50 + i * 37);

test("the warning line is left out when the block leaves no room for it", async () => {
  let dropped = 0;
  for (const budget of SWEEP) if (!(await context("beacon", budget)).startsWith("> ")) dropped++;
  expect(dropped).toBeGreaterThan(0);
});

test("with the warning line, no budget is exceeded", async () => {
  const over: number[] = [];
  for (const budget of SWEEP) {
    if (estimateTokens(await context("beacon", budget)) > budget) over.push(budget);
  }
  expect(over).toEqual([]);
});
