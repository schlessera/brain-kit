/**
 * Streaming markdown parses block by block (#2588): the split must never
 * change what renders. Each fixture below renders identically split and
 * whole; the whole render comes from the same component with the splitter
 * swapped for one that never splits.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as blocks from "../src/components/chat/markdown-blocks.js";
import { BrainMarkdown } from "../src/components/chat/brain-markdown.js";
import { BrainUiProvider } from "../src/root-context.js";
import { createBrainUiRoot } from "../src/root.js";

const realSplit = blocks.splitMarkdownBlocks;
let whole = false;
mock.module("../src/components/chat/markdown-blocks.js", () => ({
  splitMarkdownBlocks: (text: string) => (whole ? [text] : realSplit(text)),
}));
afterAll(() => mock.restore());

const root = createBrainUiRoot({ storage: null });
function html(content: string, props: { fileLinks?: boolean; entityTags?: boolean }, asWhole: boolean): string {
  whole = asWhole;
  try {
    return renderToStaticMarkup(<BrainUiProvider root={root}><BrainMarkdown content={content} {...props} /></BrainUiProvider>);
  } finally { whole = false; }
}

describe("splitMarkdownBlocks", () => {
  test("splits paragraphs and headings at blank lines, dropping the blank lines between", () => {
    expect(realSplit("# Ithaca\n\nThe raft is ready.\n\n\nPenelope weaves.")).toEqual(["# Ithaca", "The raft is ready.", "Penelope weaves."]);
  });
  test("never splits inside a fence, backtick or tilde, any length, nor after an unclosed one", () => {
    expect(realSplit("Before.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.")).toEqual(["Before.", "```js\nconst a = 1;\n\nconst b = 2;\n```", "After."]);
    expect(realSplit("~~~~\nsail\n\n~~~\nstill inside\n~~~~\n\nAfter.")).toEqual(["~~~~\nsail\n\n~~~\nstill inside\n~~~~", "After."]);
    expect(realSplit("Before.\n\n```\nopen fence\n\nstill streaming")).toEqual(["Before.", "```\nopen fence\n\nstill streaming"]);
  });
  test("keeps lists, blockquotes, tables and indented continuations whole", () => {
    expect(realSplit("- one\n\n- two\n\n  more of two\n\n3. three\n\n4) four\n\n> quote\n\n> more\n\n| a |\n\n    code")).toHaveLength(1);
  });
  test("does not split a text with a link reference or footnote definition, nor a long HTML block", () => {
    expect(realSplit("See [the log][l].\n\n[l]: https://ithaca.example/log")).toHaveLength(1);
    expect(realSplit("A claim.[^1]\n\nMore.\n\n[^1]: The source.")).toHaveLength(1);
    expect(realSplit("<pre>\na\n\nb\n</pre>\n\nAfter.")).toHaveLength(1);
    expect(realSplit("<!-- note\n\nstill note -->\n\nAfter.")).toHaveLength(1);
  });
  test("leading blank lines start no empty block", () => {
    expect(realSplit("\n\nFirst.\n\nSecond.")).toEqual(["\n\nFirst.", "Second."]);
  });
});

/** The issue's corpus. Each entry must split, except those that must not. */
const CORPUS: Record<string, { text: string; splits: boolean; props?: { fileLinks?: boolean; entityTags?: boolean } }> = {
  "reference links and footnotes": { text: "Odysseus kept [a log][log] of the voyage.[^1]\n\nThe crew read it.\n\n[log]: https://ithaca.example/log\n[^1]: Written at Ogygia.", splits: false },
  "loose and tight lists, an ordered list from 3": { text: "Supplies:\n\n- water\n- bread\n\nTasks:\n\n3. caulk the raft\n\n4. raise the mast\n\nDone.\n\n* oars\n\n* rope", splits: true },
  "fences with blank lines, backtick and tilde": { text: "Code:\n\n```ts\nconst raft = 1;\n\nconst mast = 2;\n```\n\nAnd:\n\n~~~~sh\nsail\n\nhome\n~~~~\n\nEnd.", splits: true },
  "an unclosed fence mid-stream": { text: "Plan:\n\nFirst step.\n\n```js\nconst wind = 'west';\n\nif (wind)", splits: true },
  "blockquotes, tables, setext headings, HTML blocks": { text: "Athena\n======\n\n> Go home.\n>\n> Now.\n\nVoyage\n------\n\n| Day | Port |\n| --- | --- |\n| 1 | Troy |\n\n<div>\n<b>raw</b>\n</div>\n\nAfter the div.", splits: true },
  "entity tags": { text: "Met <person>Penelope</person> at the loom.\n\nThen <place>Ithaca</place>.", splits: true, props: { fileLinks: true, entityTags: true } },
  "share blocks": { text: "Here it is:\n\n```share md \"Voyage log\"\n# Day one\n\nCalm seas.\n```\n\nThat is the log.\n\nAnd more.", splits: true },
  "links, inline code and emphasis": { text: "Read **the [log](https://ithaca.example/log)** and `notes/raft.md`.\n\n_Then_ sail.", splits: true },
};

describe("split and whole render the same HTML", () => {
  for (const [name, { text, splits, props = { fileLinks: true } }] of Object.entries(CORPUS)) {
    test(name, () => {
      expect(realSplit(text).length > 1, splits ? "this fixture exercises a split" : "this fixture must stay whole").toBe(splits);
      expect(html(text, props, false)).toBe(html(text, props, true));
    });
  }
});
