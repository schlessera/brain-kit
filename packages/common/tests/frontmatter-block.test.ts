/**
 * `frontmatterBlock` finds the fences `parseFrontmatter` reads by (#2507).
 * Every row is checked against the parser itself, so a change to either side
 * that makes them disagree fails here.
 */

import { describe, expect, test } from "bun:test";

import { frontmatterBlock, frontmatterLength } from "../src/frontmatter-block";
import { parseFrontmatter } from "../src/frontmatter-parse";

const BOM = "\uFEFF";

const rows: Array<{ name: string; text: string; block: ReturnType<typeof frontmatterBlock>; data?: Record<string, unknown> }> = [
  { name: "plain LF", text: "---\ntitle: a\n---\nbody\n", block: { start: 0, innerStart: 4, innerEnd: 13, end: 17, closed: true }, data: { title: "a" } },
  { name: "byte order mark", text: `${BOM}---\ntitle: a\n---\nbody\n`, block: { start: 1, innerStart: 5, innerEnd: 14, end: 18, closed: true }, data: { title: "a" } },
  { name: "CRLF", text: "---\r\ntitle: a\r\n---\r\nbody\r\n", block: { start: 0, innerStart: 5, innerEnd: 15, end: 20, closed: true }, data: { title: "a" } },
  { name: "trailing whitespace after the opening fence", text: "--- \ntitle: a\n---\nbody\n", block: { start: 0, innerStart: 5, innerEnd: 14, end: 18, closed: true }, data: { title: "a" } },
  // gray-matter ends the block at the dashes; the whitespace starts the content.
  { name: "trailing whitespace after the closing fence", text: "---\ntitle: a\n--- \nbody\n", block: { start: 0, innerStart: 4, innerEnd: 13, end: 16, closed: true }, data: { title: "a" } },
  { name: "closing fence at the end of the file", text: "---\ntitle: a\n---", block: { start: 0, innerStart: 4, innerEnd: 13, end: 16, closed: true }, data: { title: "a" } },
  { name: "four dashes are not a fence", text: "----\ntitle: a\n----\nbody\n", block: null },
  { name: "a leading blank line means no frontmatter", text: "\n---\ntitle: a\n---\nbody\n", block: null },
  { name: "no frontmatter", text: "# Title\n", block: null },
  { name: "unclosed block runs to the end", text: "---\ntitle: a\n", block: { start: 0, innerStart: 4, innerEnd: 13, end: 13, closed: false }, data: { title: "a" } },
  { name: "empty block", text: "---\n---\nbody\n", block: { start: 0, innerStart: 4, innerEnd: 4, end: 8, closed: true }, data: {} },
  // The first `\n---` closes; the next `---` line is a rule in the body.
  { name: "a rule right after the closing fence", text: "---\ntitle: a\n---\n---\nbody\n", block: { start: 0, innerStart: 4, innerEnd: 13, end: 17, closed: true }, data: { title: "a" } },
  // A `...` line does not close a block: everything to the end is frontmatter.
  { name: "a ... line is not a closer", text: "---\ntitle: a\n...\n", block: { start: 0, innerStart: 4, innerEnd: 17, end: 17, closed: false }, data: { title: "a" } },
];

describe("frontmatterBlock agrees with parseFrontmatter", () => {
  for (const row of rows) {
    test(row.name, () => {
      const block = frontmatterBlock(row.text);
      expect(block).toEqual(row.block);
      expect(frontmatterLength(row.text)).toBe(block?.end ?? 0);
      const parsed = parseFrontmatter(row.text, { dataOnly: true });
      if (!block) {
        expect(parsed.matter).toBe("");
        expect(parsed.data).toEqual({});
        return;
      }
      // What the parser treats as body is exactly what follows the block.
      expect(parsed.content).toBe(row.text.slice(block.end));
      // What it treats as YAML is exactly the block's inner lines.
      expect(parsed.matter.trim()).toBe(row.text.slice(block.innerStart, block.innerEnd).trim());
      expect(parsed.data).toEqual(row.data!);
    });
  }
});
