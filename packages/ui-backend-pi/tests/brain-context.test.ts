/**
 * pi's brain_context assembles hits with core's assembler (#459): the pool
 * is sized from the budget, a hit that does not fit is skipped rather than
 * ending the block, headers are one line, and snippets carry no FTS5
 * highlight markers. Identity and focus stay out, since the pi session
 * already loads them.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { estimateTokens } from "@schlessera/brain";

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
    "notes/huge.md": doc("Lantern Huge", "lantern lantern lantern lantern", "a very long summary ".repeat(80).trim()),
    "notes/small.md": doc("Small", `a lantern ${"among other unrelated words ".repeat(6)}`),
    "me/identity.md": `---\ntype: identity\ntitle: "Identity"\ncreated: 2020-01-01\nupdated: 2020-01-02\ntags: [me]\n---\n\nThe keeper of the trail light.\n`,
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
  // The premise: the huge hit ranks first.
  const { results } = await createBrainAccess(brain.root).search({ query: "lantern", limit: 2 });
  expect(results.map((r) => r.path)).toEqual(["notes/huge.md", "notes/small.md"]);
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

test("warnings never push the block over its budget", async () => {
  // The block alone fills most budgets; the warning line must then give way.
  const over: number[] = [];
  let dropped = 0;
  for (let budget = 50; budget <= 2000; budget += 37) {
    const out = await context("beacon", budget);
    if (!out.startsWith("> ")) dropped++;
    if (estimateTokens(out) > budget) over.push(budget);
  }
  expect(dropped).toBeGreaterThan(0);
  expect(over).toEqual([]);
});
