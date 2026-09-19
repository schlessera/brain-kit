import { describe, test, expect } from "bun:test";
import { computeDiffRows, diffText } from "../src/lib/diff";

// ----------------------------------------------------------------------------
// computeDiffRows (line-level LCS) and diffText (the kit DiffBlock's input)
// ----------------------------------------------------------------------------

describe("computeDiffRows", () => {
  test("identical text is all neutral, appears once", () => {
    const rows = computeDiffRows("a\nb\nc", "a\nb\nc");
    expect(rows.map((r) => r.kind)).toEqual(["same", "same", "same"]);
  });

  test("a one-word edit in a 10-line block yields 9 neutral + 1 del + 1 ins", () => {
    const oldLines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[4] = "line four"; // change only "4" -> "four"
    const rows = computeDiffRows(oldLines.join("\n"), newLines.join("\n"));
    expect(rows.filter((r) => r.kind === "same").length).toBe(9);
    expect(rows.filter((r) => r.kind === "del").length).toBe(1);
    expect(rows.filter((r) => r.kind === "ins").length).toBe(1);
  });

  test("a change block lists its deletions before its insertions", () => {
    const rows = computeDiffRows("a\nb", "x\ny");
    expect(rows.map((r) => [r.kind, r.line])).toEqual([
      ["del", "a"],
      ["del", "b"],
      ["ins", "x"],
      ["ins", "y"],
    ]);
  });

  test("pure insert yields only same + ins rows", () => {
    const rows = computeDiffRows("a\nb", "a\nb\nc\nd");
    expect(rows.map((r) => r.kind)).toEqual(["same", "same", "ins", "ins"]);
    expect(rows.filter((r) => r.kind === "ins").map((r) => r.line)).toEqual(["c", "d"]);
  });

  test("pure delete yields only same + del rows", () => {
    const rows = computeDiffRows("a\nb\nc", "a\nc");
    expect(rows.map((r) => r.kind)).toEqual(["same", "del", "same"]);
    expect(rows.find((r) => r.kind === "del")!.line).toBe("b");
  });
});

describe("diffText", () => {
  test("signs every row the way the kit DiffBlock reads it", () => {
    expect(diffText(computeDiffRows("a\nb\nc", "a\nx\nc"))).toBe("  a\n- b\n+ x\n  c");
  });

  test("a context line starting with a sign keeps its two-space indent, so it stays context", () => {
    const text = diffText(computeDiffRows("- item\n+ plus", "- item\n+ plus\nnew"));
    expect(text.split("\n")).toEqual(["  - item", "  + plus", "+ new"]);
  });

  test("keeps the line's own leading whitespace after the sign", () => {
    expect(diffText([{ kind: "ins", line: "    indented" }])).toBe("+     indented");
  });
});
