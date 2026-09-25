import { describe, expect, test } from "bun:test";
import { markdownAnchors, markdownLinks, splitLink } from "./markdown-anchors";

const anchors = (body: string) => [...markdownAnchors(body)];

describe("markdownLinks", () => {
  test("reads every title form and an angle-bracket destination", () => {
    const body = [
      "[a](#double \"title\")",
      "[b](#single 'title')",
      "[c](#paren (title))",
      "[d](<docs/a b.md#setup>)",
    ].join("\n\n");
    expect(markdownLinks(body)).toEqual(["#double", "#single", "#paren", "docs/a b.md#setup"]);
  });

  test("returns a reference-style link through its definition", () => {
    expect(markdownLinks("[x][ref]\n\n[ref]: #by-reference\n")).toEqual(["#by-reference"]);
  });

  test("returns nothing from inside code", () => {
    const body = [
      "~~~",
      "[tilde](#in-tilde-fence)",
      "~~~",
      "",
      "````md",
      "```",
      "[nested](#in-four-backtick-fence)",
      "```",
      "````",
      "",
      "A `multiline",
      "[span](#in-code-span)` here.",
      "",
      "    [indented](#in-indented-code)",
    ].join("\n");
    expect(markdownLinks(body)).toEqual([]);
  });

  test("an unclosed fence runs to the end of the file", () => {
    expect(markdownLinks("```\n[x](#in-unclosed-fence)\n")).toEqual([]);
  });

  test("a link outside code is still found", () => {
    expect(markdownLinks("See `code` and [real](#real).\n")).toEqual(["#real"]);
  });
});

describe("splitLink", () => {
  test("splits at the first # and percent-decodes both parts", () => {
    expect(splitLink("docs/a%20b.md#caf%C3%A9")).toEqual({ path: "docs/a b.md", fragment: "café" });
    expect(splitLink("#same-file")).toEqual({ path: "", fragment: "same-file" });
    expect(splitLink("README.md")).toEqual({ path: "README.md", fragment: null });
  });

  test("a malformed escape is a diagnostic, not a throw", () => {
    expect(() => splitLink("#100%")).not.toThrow();
    expect(splitLink("#100%")).toEqual({ error: "malformed percent-escape in #100%" });
  });
});

describe("markdownAnchors: heading slugs", () => {
  test("drops punctuation and keeps letters, digits, spaces, - and _", () => {
    expect(anchors("# What's new? (v2.0) — notes_and-more!")).toEqual(["whats-new-v20--notes_and-more"]);
  });

  test("removes inline code backticks but keeps their text", () => {
    expect(anchors("# `taxonomy.types`\n\n# The `brain index` command")).toEqual([
      "taxonomytypes",
      "the-brain-index-command",
    ]);
  });

  test("keeps a link's text and drops its target", () => {
    expect(anchors("# See [the guide](docs/guide.md) first")).toEqual(["see-the-guide-first"]);
  });

  test("turns each space into a hyphen without collapsing runs", () => {
    expect(anchors("# A & B")).toEqual(["a--b"]);
  });

  test("slugs the rendered text: no inline HTML tags, emphasis markers or entities", () => {
    expect(anchors("# Hello <em>world</em>\n\n# _Hello_ again\n\n# Fish &amp; chips")).toEqual([
      "hello-world",
      "hello-again",
      "fish--chips",
    ]);
  });

  test("keeps combining marks and non-Latin scripts", () => {
    expect(anchors("# Cafe\u0301\n\n# \u0939\u093F\u0928\u094D\u0926\u0940")).toEqual([
      "cafe\u0301",
      "\u0939\u093F\u0928\u094D\u0926\u0940",
    ]);
  });

  test("strips a closing run of #", () => {
    expect(anchors("## Closed ##\n")).toEqual(["closed"]);
  });

  test("a hash with no space after it is not a heading", () => {
    expect(anchors("#hashtag\n")).toEqual([]);
  });
});

describe("markdownAnchors: which headings count", () => {
  test("numbers a repeated heading -1, -2", () => {
    expect(anchors("# Setup\n\n## Setup\n\n### Setup\n")).toEqual(["setup", "setup-1", "setup-2"]);
  });

  test("a later heading that collides with a numbered slug is numbered in turn", () => {
    expect(anchors("# Setup\n\n# Setup\n\n# Setup-1\n")).toEqual(["setup", "setup-1", "setup-1-1"]);
  });

  test("numbering skips a slug an earlier heading already took", () => {
    expect(anchors("# Setup-1\n\n# Setup\n\n# Setup\n")).toEqual(["setup-1", "setup", "setup-2"]);
  });

  test("ignores a heading inside a fenced code block", () => {
    const body = [
      "# Real",
      "```sh",
      "# not a heading",
      "```",
      "~~~~",
      "## also not",
      "```",
      "## still inside the tilde fence",
      "~~~~",
      "## After",
    ].join("\n");
    expect(anchors(body)).toEqual(["real", "after"]);
  });

  test("a fenced heading does not take a duplicate number", () => {
    expect(anchors("```\n# Setup\n```\n# Setup\n")).toEqual(["setup"]);
  });

  test("ignores a heading inside an HTML comment", () => {
    expect(anchors("<!--\n# Hidden\n-->\n\n# Shown\n")).toEqual(["shown"]);
  });

  test("counts setext headings and headings nested in a quote or a list", () => {
    expect(anchors("Setup\n=====\n\nUsage\n-----\n\n> # Quoted\n\n- ## Listed\n")).toEqual([
      "setup",
      "usage",
      "quoted",
      "listed",
    ]);
  });

  test("front matter does not become a heading", () => {
    expect(anchors("---\ntitle: Front\n---\n\n# Body\n")).toEqual(["body"]);
  });
});

describe("markdownAnchors: explicit anchors", () => {
  test("counts id and name on an <a> tag", () => {
    expect(anchors('<a id="by-id"></a>\n\nText <a name="by-name"></a>\n')).toEqual(["by-id", "by-name"]);
  });

  test("an anchor in code or a comment, or a data-id, is not a target", () => {
    const body = [
      'Code: `<a id="in-code"></a>`',
      "",
      '<!-- <a id="in-comment"></a> -->',
      "",
      '<a data-id="data-attribute"></a>',
    ].join("\n");
    expect(anchors(body)).toEqual([]);
  });
});
