/**
 * Core's raw frontmatter editors find the block through `frontmatterBlock`,
 * the rule `parseFrontmatter` reads by (#2507): the generated-region splitter,
 * the key editor and `brain tags --apply` (which share one `frontmatterBounds`
 * and one `readScalar`).
 */

import { describe, expect, test } from "bun:test";

import { editFrontmatter, frontmatterBounds, readScalar, type ScalarToken } from "../src/lib/frontmatter-edit";
import { splitFrontmatterBlock } from "../src/lib/generated-regions";
import { rewriteTags } from "../src/lib/tags-apply";

const BOM = "﻿";

describe("splitFrontmatterBlock", () => {
  test.each([
    ["LF", "---\ntitle: a\n---\nbody\n", "---\ntitle: a\n---", "\nbody\n"],
    ["a byte order mark", `${BOM}---\ntitle: a\n---\nbody\n`, `${BOM}---\ntitle: a\n---`, "\nbody\n"],
    ["CRLF", "---\r\ntitle: a\r\n---\r\nbody\r\n", "---\r\ntitle: a\r\n---", "\r\nbody\r\n"],
    ["a closing fence at the end of the file", "---\ntitle: a\n---", "---\ntitle: a\n---", ""],
    ["a rule right after the closing fence", "---\ntitle: a\n---\n---\nbody\n", "---\ntitle: a\n---", "\n---\nbody\n"],
    ["a leading blank line", "\n---\ntitle: a\n---\n", "", "\n---\ntitle: a\n---\n"],
    ["a four-dash first line", "----\ntitle: a\n", "", "----\ntitle: a\n"],
  ])("%s", (_, raw, frontmatter, body) => {
    expect(splitFrontmatterBlock(raw)).toEqual({ frontmatter, body });
  });

  test("a block that is never closed is refused", () => {
    expect(() => splitFrontmatterBlock("---\ntitle: a\nbody\n")).toThrow("no closing --- line");
    expect(() => splitFrontmatterBlock(`${BOM}---\ntitle: a\n`)).toThrow("no closing --- line");
  });
});

describe("frontmatterBounds, shared by the key editor and brain tags --apply", () => {
  test.each([
    ["LF", "---\ntitle: a\n---\nbody\n", "title: a\n"],
    ["a byte order mark", `${BOM}---\ntitle: a\n---\nbody\n`, "title: a\n"],
    ["CRLF", "---\r\ntitle: a\r\n---\r\nbody\r\n", "title: a\r\n"],
    ["a closing fence at the end of the file", "---\ntitle: a\n---", "title: a\n"],
    // The copy in tags-apply searched back from the block's end, so this one
    // took the closing fence into the block.
    ["a rule right after the closing fence", "---\ntitle: a\n---\n---\nbody\n", "title: a\n"],
    ["an empty block", "---\n---\nbody\n", ""],
  ])("%s", (_, text, inner) => {
    const bounds = frontmatterBounds(text);
    expect(bounds && text.slice(bounds.start, bounds.end)).toBe(inner);
  });

  test("no block, or one never closed, has no bounds", () => {
    for (const text of ["\n---\ntitle: a\n---\n", "----\ntitle: a\n----\n", "---\ntitle: a\n", "---\ntitle: a\n...\n"]) {
      expect(frontmatterBounds(text)).toBeNull();
    }
  });

  test("the key editor keeps a byte order mark and an end-of-file fence", () => {
    expect(editFrontmatter(`${BOM}---\ntitle: a\n---\nbody\n`, { title: "b" })).toBe(`${BOM}---\ntitle: b\n---\nbody\n`);
    expect(editFrontmatter("---\ntitle: a\n---", { title: "b" })).toBe("---\ntitle: b\n---");
  });

  test("brain tags --apply rewrites the tags after a byte order mark and before a rule", () => {
    expect(rewriteTags(`${BOM}---\ntitle: T\ntags: [old]\n---\nbody\n`, () => ["new"])).toEqual({
      text: `${BOM}---\ntitle: T\ntags: [new]\n---\nbody\n`, from: ["old"], to: ["new"],
    });
    expect(rewriteTags("---\ntitle: T\ntags:\n  - old\n---\n---\nbody\n", () => ["new"])).toEqual({
      text: "---\ntitle: T\ntags:\n  - new\n---\n---\nbody\n", from: ["old"], to: ["new"],
    });
  });
});

describe("readScalar, the one scalar reader both editors use", () => {
  test.each<[string, string, string, ScalarToken]>([
    ["a plain scalar up to a comment", "abc  # note", "", { start: 0, end: 3, quote: null, value: "abc" }],
    ["a plain scalar up to a stop", "abc, def", ",]", { start: 0, end: 3, quote: null, value: "abc" }],
    ["a double-quoted scalar with escapes", '"a\\"b\\n"', "", { start: 0, end: 8, quote: '"', value: 'a"b\n' }],
    ["a single-quoted scalar with a doubled quote", "'it''s'", "", { start: 0, end: 7, quote: "'", value: "it's" }],
  ])("%s", (_, text, stops, token) => {
    expect(readScalar(text, 0, stops)).toEqual(token);
  });

  test("a quote not closed on its line, or nothing to read, is null", () => {
    expect(readScalar('"open\n"', 0)).toBeNull();
    expect(readScalar("  # only a comment", 0)).toBeNull();
  });
});
