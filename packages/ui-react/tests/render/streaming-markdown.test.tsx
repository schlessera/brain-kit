/**
 * A streaming answer re-parses only its growing tail (#2588). react-markdown
 * is wrapped to record the text of every parse; appending to the last block
 * of a 24 KB answer must parse that block alone, never an earlier one, and
 * an earlier block's elements must keep their DOM identity (a rendered
 * Mermaid diagram keeps its SVG state).
 */
import { registerStreamingMarkdownDom, unregisterStreamingMarkdownDom } from "./streaming-markdown-dom.js";

registerStreamingMarkdownDom();

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import RealMarkdown from "react-markdown";

const parsed: string[] = [];
// The function itself, before the mock replaces the module's binding.
const realMarkdown = RealMarkdown;
mock.module("react-markdown", () => ({
  default: (props: Parameters<typeof RealMarkdown>[0]) => {
    parsed.push(String(props.children ?? ""));
    return realMarkdown(props);
  },
}));

const { BrainMarkdown } = await import("../../src/components/chat/brain-markdown.js");
const { BrainUiProvider } = await import("../../src/root-context.js");
const { createBrainUiRoot } = await import("../../src/root.js");

// File links ask the host for wikilinks once; nothing here is on the network.
const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ slugs: {}, entries: [] }) });
afterEach(async () => { await act(async () => cleanup()); parsed.length = 0; });
afterAll(async () => { mock.restore(); root.dispose(); await unregisterStreamingMarkdownDom(); });

const answer = (paragraphs: number) => Array.from({ length: paragraphs }, (_, i) =>
  i % 9 === 4 ? "```js\nconst day = " + i + ";\n\nconst port = 'Ithaca';\n```" : `Day ${i}: the raft drifts east past the headland, and Odysseus counts the stars to keep his course for Ithaca.`).join("\n\n");
/**
 * Waits until rendering is quiet: the highlighter loads asynchronously and,
 * once it has, every block parses one more time with it. That is the first
 * render's cost, not streaming's; the appends below are measured after it.
 */
async function settled() {
  for (let quiet = 0, seen = -1; quiet < 3;) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    if (parsed.length === seen) quiet++; else { quiet = 0; seen = parsed.length; }
  }
}
const view = (content: string) => <BrainUiProvider root={root}><BrainMarkdown content={content} fileLinks /></BrainUiProvider>;

test("appending to the last block of a 24 KB answer parses only that block", async () => {
  let text = answer(240);
  expect(text.length, "a 24 KB answer").toBeGreaterThan(24_000);
  const r = render(view(text));
  await settled();
  const blocks = parsed.length;
  expect(blocks, "the answer parses as many blocks").toBeGreaterThan(100);
  for (const word of [" and the wind", " turns west", " at dusk."]) {
    parsed.length = 0;
    text += word;
    r.rerender(view(text));
    await act(async () => {});
    expect(parsed.length, "one parse per append").toBeGreaterThan(0);
    // The growing tail may parse twice (deferred, then current), but nothing else parses.
    expect(parsed.length, "at most the tail's two parses").toBeLessThanOrEqual(2);
    expect(parsed.every((source) => source.endsWith(word) && source.length < 400), `only the grown tail block re-parses: ${parsed.map((s) => s.length).join(", ")}`).toBe(true);
  }
});

test("a new block below leaves the earlier ones parsed once and their elements in place", async () => {
  let text = "```mermaid\ngraph LR; Troy-->Ithaca\n```\n\nThe voyage begins.";
  const r = render(view(text));
  await settled();
  const first = r.container.querySelector(".brain-prose")!.firstElementChild!;
  expect(first, "the diagram block is drawn").toBeTruthy();
  for (const more of ["\n\nDay one: calm.", "\n\nDay two: a storm.", " The mast holds."]) {
    parsed.length = 0;
    text += more;
    r.rerender(view(text));
    await act(async () => {});
    expect(parsed.some((source) => source.includes("mermaid")), "the diagram's block is not parsed again").toBe(false);
    expect(r.container.querySelector(".brain-prose")!.firstElementChild, "its element is the same node: nothing remounted").toBe(first);
  }
});
