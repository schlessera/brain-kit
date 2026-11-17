/**
 * Streaming markdown parses block by block (#2588): the split must never
 * change what renders. Each fixture below renders identically split and
 * whole; the whole render comes from the same component with the splitter
 * swapped for one that never splits.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { REMARK_PLUGINS } from "../src/components/chat/use-markdown-highlight.js";
import * as blocks from "../src/components/chat/markdown-blocks.js";
import { MAX_TAIL_LAG_MS, tailText } from "../src/components/chat/markdown-blocks.js";
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
  test("splits paragraphs and headings at blank lines, keeping the blank lines with the block before", () => {
    expect(realSplit("# Ithaca\n\nThe raft is ready.\n\n\nPenelope weaves.")).toEqual(["# Ithaca\n", "The raft is ready.\n\n", "Penelope weaves."]);
  });
  test("never splits inside a fence, backtick or tilde, any length, nor after an unclosed one", () => {
    expect(realSplit("Before.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.")).toEqual(["Before.\n", "```js\nconst a = 1;\n\nconst b = 2;\n```\n", "After."]);
    expect(realSplit("~~~~\nsail\n\n~~~\nstill inside\n~~~~\n\nAfter.")).toEqual(["~~~~\nsail\n\n~~~\nstill inside\n~~~~\n", "After."]);
    expect(realSplit("Before.\n\n```\nopen fence\n\nstill streaming")).toEqual(["Before.\n", "```\nopen fence\n\nstill streaming"]);
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
  test("finds definitions inside blockquotes and list items, and with escaped brackets", () => {
    for (const text of ["See [the log][l].\n\n> [l]: https://ithaca.example/log", "A claim.[^1]\n\nMore.\n\n> [^1]: The source.", "See [x].\n\n>> [x]: /u", "See [the log][l].\n\n- [l]: https://ithaca.example/log", "See [a\\]b].\n\n[a\\]b]: https://ithaca.example/"])
      expect(realSplit(text), text).toHaveLength(1);
  });
  test("leading blank lines start no empty block", () => {
    expect(realSplit("\n\nFirst.\n\nSecond.")).toEqual(["\n\nFirst.\n", "Second."]);
  });
});

/** The issue's corpus. Each entry must split, except those that must not. */
const CORPUS: Record<string, { text: string; splits: boolean; props?: { fileLinks?: boolean; entityTags?: boolean } }> = {
  "reference links and footnotes": { text: "Odysseus kept [a log][log] of the voyage.[^1]\n\nThe crew read it.\n\n[log]: https://ithaca.example/log\n[^1]: Written at Ogygia.", splits: false },
  "loose and tight lists, an ordered list from 3": { text: "Supplies:\n\n- water\n- bread\n\nTasks:\n\n3. caulk the raft\n\n4. raise the mast\n\nDone.\n\n* oars\n\n* rope", splits: true },
  "fences with blank lines, backtick and tilde": { text: "Code:\n\n```ts\nconst raft = 1;\n\nconst mast = 2;\n```\n\nAnd:\n\n~~~~sh\nsail\n\nhome\n~~~~\n\nEnd.", splits: true },
  "an unclosed fence mid-stream": { text: "Plan:\n\nFirst step.\n\n```js\nconst wind = 'west';\n\nif (wind)", splits: true },
  "blockquotes, tables, setext headings": { text: "Athena\n======\n\n> Go home.\n>\n> Now.\n\nVoyage\n------\n\n| Day | Port |\n| --- | --- |\n| 1 | Troy |\n\nAfter the table.", splits: true },
  "an HTML block": { text: "Before.\n\n<div>\n<b>raw</b>\n</div>\n\nAfter the div.", splits: false },
  "entity tags": { text: "Met <p>Penelope</p> at the loom.\n\nThen <co>Ithaca Shipwrights</co> and <proj>The Raft</proj>.\n\nOn <d>2026-07-12</d>.", splits: true, props: { fileLinks: true, entityTags: true } },
  "share blocks": { text: "Here it is:\n\n```share md \"Voyage log\"\n# Day one\n\nCalm seas.\n```\n\nThat is the log.\n\nAnd more.", splits: true },
  "definitions inside a blockquote and a list item": { text: "Odysseus kept [a log][log].[^1]\n\nThe crew read it.\n\n> [log]: https://ithaca.example/log\n\n- [^1]: Written at Ogygia.", splits: false },
  "a definition whose label wraps across lines": { text: "See [the raft][long\nlabel].\n\nIt floats.\n\n[long\nlabel]: https://ithaca.example/raft", splits: false },
  "a definition with an escaped bracket": { text: "See [the raft\\]][r].\n\nIt floats.\n\n[the raft\\]]: https://ithaca.example/raft", splits: false },
  "a line of Unicode space continues a paragraph": { text: "Para one\n\u00a0\nstill para one.\n\nPara two\n\u3000\nstill two.\n\nThree\n\ufeff\nstill three.\n\nFour\n\u000b\nstill four.\n\nFive.", splits: true },
  "a closing fence followed by a Unicode space does not close": { text: "Before.\n\n```\ncode\n```\u00a0\n\nstill code\n\n```\n\nAfter.", splits: true },
  "a definition label wrapped after a backslash": { text: "See [a\\\nb].\n\nMore.\n\n[a\\\nb]: /u", splits: false },
  "a list-item fence closed at column 0": { text: "1. Install:\n\n   ```bash\n   npm i\n```\n\n2. Run it\n\nDone.", splits: false },
  "a fence indented at the top level": { text: "Before.\n\n  ```\ncode at column 0\n\nstill code\n  ```\n\nAfter.", splits: false },
  "a pre or comment block inside a list item": { text: "- <pre>\n\n  x\n\ny\n\n- <!--\n\n  z\n\nw", splits: false },
  "a fence marker inside an HTML block": { text: "<details>\n```js\na\n\nb\n```\n</details>\n\nAfter.", splits: false },
  "an HTML block before a separate fence": { text: "<div>\nraw\n</div>\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.", splits: false },
  "an HTML line continuing a list item": { text: " \n* item\n</pre>\n\n```\n\n```js\n\n", splits: false },
  "a fence opened after a bare carriage return": { text: "Para\r```\ncode\n\nmore code\n```\n\nAfter.", splits: false },
  "an autolink at the start of a line": { text: "Sources:\n\n<https://ithaca.example/log>\n\nAnd more.", splits: true },
  "links, inline code and emphasis": { text: "Read **the [log](https://ithaca.example/log)** and `notes/raft.md`.\n\n_Then_ sail.", splits: true },
};

describe("split and whole render the same HTML", () => {
  for (const [name, { text, splits, props = { fileLinks: true } }] of Object.entries(CORPUS)) {
    test(name, () => {
      expect(realSplit(text).length > 1, splits ? "this fixture exercises a split" : "this fixture must stay whole").toBe(splits);
      expect(html(text, props, false)).toBe(html(text, props, true));
      if (props.entityTags) expect(html(text, props, false), "entity tags really render as entities").not.toBe(html(text, { fileLinks: true }, false));
    });
  }
});

/**
 * Generated documents (fixed seeds): lines drawn from every construct the
 * split has to respect, joined by single and blank lines. Each one the
 * splitter splits must parse to the same HTML split and whole. React's
 * static renderer hoists an image's preload link to the start of its
 * segment; a DOM render has none, so it is not compared.
 */
const LINES = [
  "Para text", "Another line", "# Head", "Setext\n===", "Setext2\n---", "---", "***", "- item", "* item", "+ item", "1. one", "3) three",
  "  continued", "    indented code", "> quote", "> > nested", "| a | b |\n| - | - |\n| 1 | 2 |", "```", "```js", "~~~", "````", "  ```", "   ~~~",
  "- ```", "> ```", "<div>", "</div>", "<details>", "<span>x</span>", "<pre>", "</pre>", "<!--", "-->", "[r]: /u", "> [q]: /q", "[^1]: note", "see [x][r] and [^1]",
  "\u00a0", " ", "\t", "<br>", "Term\n: def", "1. a\n2. b", "- a\n  - b", "text with `code`", "***bold***", "\\", "- [ ] task", "|x|", "a | b", "-- | --",
  "hard break  ", "back\\", "<https://ithaca.example>", "*emph", "**", "[link](/u)", "![img](/i.png)", "&amp;", "1.", "-", ">", "#", "======", "| --- |", "\t- tab item", "10. ten", "~~~~ ~", "```` js", "  > quote", "\u3000", "a\u00a0b",
];
function seeded(seed: number) { return () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 0x100000000; }; }
const parse = (text: string) => renderToStaticMarkup(<Markdown remarkPlugins={REMARK_PLUGINS}>{text}</Markdown>).replace(/<link rel="preload"[^>]*\/>/g, "");

test("generated documents parse the same split and whole", () => {
  const differing: string[] = [];
  let split = 0;
  for (const seed of [2588, 7, 4242]) {
    const random = seeded(seed);
    for (let n = 0; n < 5000 && differing.length < 5; n++) {
      const parts: string[] = [];
      for (let i = 0, length = 2 + Math.floor(random() * 10); i < length; i++) {
        parts.push(LINES[Math.floor(random() * LINES.length)]!, random() < 0.55 ? "\n\n" : "\n");
      }
      const text = parts.join("");
      const pieces = realSplit(text);
      if (pieces.length < 2) continue;
      split++;
      if (parse(text) !== pieces.map(parse).join("\n")) differing.push(JSON.stringify(text));
    }
  }
  expect(split, "the generator produces documents that split").toBeGreaterThan(1000);
  expect(differing).toEqual([]);
}, 60_000);

describe("tailText", () => {
  test("shows the deferred tail while it is what the text extends and the last catch-up is recent", () => {
    expect(tailText("abc", "ab", 1000, 1000 + MAX_TAIL_LAG_MS)).toBe("ab");
  });
  test("renders the current tail once the last catch-up is older than the bound", () => {
    expect(tailText("abcde", "ab", 1000, 1001 + MAX_TAIL_LAG_MS)).toBe("abcde");
  });
  test("caught up, replaced or with no deferred text, shows the current text", () => {
    expect(tailText("abc", "abc", 0, 5000)).toBe("abc");
    expect(tailText("xyz", "ab", 1000, 1001)).toBe("xyz");
    expect(tailText("abc", null, 1000, 1001)).toBe("abc");
  });
});
