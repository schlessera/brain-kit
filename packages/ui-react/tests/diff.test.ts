import { describe, test, expect } from "bun:test";
import { computeDiffRows } from "../src/lib/diff";

// ----------------------------------------------------------------------------
// computeDiffRows (line-level LCS + word refinement)
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

  test("single-line change gets word-level tokens with only the word changed", () => {
    const rows = computeDiffRows("the quick brown fox", "the quick red fox");
    const del = rows.find((r) => r.kind === "del")!;
    const ins = rows.find((r) => r.kind === "ins")!;
    expect(del.tokens).not.toBeNull();
    expect(ins.tokens).not.toBeNull();
    // Only the differing token is flagged as changed on each side.
    expect(del.tokens!.filter((t) => t.changed).map((t) => t.text)).toEqual(["brown"]);
    expect(ins.tokens!.filter((t) => t.changed).map((t) => t.text)).toEqual(["red"]);
    // Tokens reassemble the original line exactly.
    expect(del.tokens!.map((t) => t.text).join("")).toBe("the quick brown fox");
    expect(ins.tokens!.map((t) => t.text).join("")).toBe("the quick red fox");
  });

  test("multi-line change blocks are not word-refined", () => {
    const rows = computeDiffRows("a\nb", "x\ny");
    for (const r of rows) {
      if (r.kind !== "same") expect(r.tokens).toBeNull();
    }
    expect(rows.filter((r) => r.kind === "del").length).toBe(2);
    expect(rows.filter((r) => r.kind === "ins").length).toBe(2);
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
