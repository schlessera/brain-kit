import { describe, test, expect } from "bun:test";
import { parseSnippet } from "../src/lib/search-snippet.js";

describe("parseSnippet", () => {
  test("returns a single plain segment when there are no markers", () => {
    expect(parseSnippet("plain text")).toEqual([
      { text: "plain text", hit: false },
    ]);
  });

  test("splits a marked term out of the surrounding text", () => {
    expect(parseSnippet("about >>>vector<<< search")).toEqual([
      { text: "about ", hit: false },
      { text: "vector", hit: true },
      { text: " search", hit: false },
    ]);
  });

  test("handles several hits", () => {
    expect(parseSnippet(">>>a<<< and >>>b<<<")).toEqual([
      { text: "a", hit: true },
      { text: " and ", hit: false },
      { text: "b", hit: true },
    ]);
  });

  test("keeps the ellipsis the CLI adds around a clipped snippet", () => {
    expect(parseSnippet("...the >>>brain<<< repo...")).toEqual([
      { text: "...the ", hit: false },
      { text: "brain", hit: true },
      { text: " repo...", hit: false },
    ]);
  });

  test("collapses the multi-line chunk text a vector hit returns", () => {
    expect(parseSnippet("\n## Abstract\n\nWorkshop on  >>>agents<<<\n")).toEqual([
      { text: "Abstract Workshop on ", hit: false },
      { text: "agents", hit: true },
    ]);
  });

  test("strips markdown syntax without eating the highlight", () => {
    expect(parseSnippet("**Health>>>Checker<<< Agent** is `live`")).toEqual([
      { text: "Health", hit: false },
      { text: "Checker", hit: true },
      { text: " Agent is live", hit: false },
    ]);
  });

  test("keeps a highlight that starts the snippet (not read as a blockquote)", () => {
    expect(parseSnippet(">>>agent<<< first")).toEqual([
      { text: "agent", hit: true },
      { text: " first", hit: false },
    ]);
  });

  test("keeps text after an unclosed marker, dropping the stray marker", () => {
    expect(parseSnippet("truncated >>>mid")).toEqual([
      { text: "truncated mid", hit: false },
    ]);
  });

  test("skips an empty highlight", () => {
    expect(parseSnippet("a>>><<<b")).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: false },
    ]);
  });

  test("returns nothing for an empty snippet", () => {
    expect(parseSnippet("")).toEqual([]);
  });

  test("does not treat a lone closing marker as a hit", () => {
    expect(parseSnippet("a <<< b")).toEqual([{ text: "a b", hit: false }]);
  });
});
