import { describe, expect, test } from "bun:test";
import { headingSlug, markdownAnchors } from "./markdown-anchors";

describe("headingSlug", () => {
  test("drops punctuation and keeps letters, digits, spaces, - and _", () => {
    expect(headingSlug("What's new? (v2.0) — notes_and-more!")).toBe("whats-new-v20--notes_and-more");
  });

  test("removes inline code backticks but keeps their text", () => {
    expect(headingSlug("`taxonomy.types`")).toBe("taxonomytypes");
    expect(headingSlug("The `brain index` command")).toBe("the-brain-index-command");
  });

  test("keeps a link's text and drops its target", () => {
    expect(headingSlug("See [the guide](docs/guide.md) first")).toBe("see-the-guide-first");
  });

  test("turns each space into a hyphen without collapsing runs", () => {
    expect(headingSlug("A & B")).toBe("a--b");
  });
});

describe("markdownAnchors", () => {
  test("numbers a repeated heading -1, -2", () => {
    const anchors = markdownAnchors("# Setup\n\n## Setup\n\n### Setup\n");
    expect([...anchors]).toEqual(["setup", "setup-1", "setup-2"]);
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
    expect([...markdownAnchors(body)]).toEqual(["real", "after"]);
  });

  test("a fenced heading does not take a duplicate number", () => {
    const anchors = markdownAnchors("```\n# Setup\n```\n# Setup\n");
    expect([...anchors]).toEqual(["setup"]);
  });

  test("strips a closing run of #", () => {
    expect([...markdownAnchors("## Closed ##\n")]).toEqual(["closed"]);
  });

  test("counts explicit id and name anchors", () => {
    const anchors = markdownAnchors('<a id="by-id"></a>\n\nText <a name="by-name"></a>\n');
    expect([...anchors]).toEqual(["by-id", "by-name"]);
  });

  test("a hash with no space after it is not a heading", () => {
    expect([...markdownAnchors("#hashtag\n")]).toEqual([]);
  });
});
