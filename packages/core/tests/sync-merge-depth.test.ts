import { expect, test } from "bun:test";
import { headingTexts, MAX_BODY_DEPTH, parseDoc } from "../src/lib/sync/resolve/markdown";
import { planMerge } from "../src/lib/sync/resolve/plan";

function merge(body: string) {
  return planMerge({ path: "notes/a.md", base: "Intro.\n", ours: body, theirs: "Intro, revised.\n" }, "synthesize").render(new Map());
}
function refused(body: string) {
  expect(merge(body)).toEqual({ status: "unresolved", reason: "unparseable: ours: the body nests too deeply to parse" });
  expect(() => headingTexts(body)).toThrow("text: the body nests too deeply to parse");
}
test("body budget limit plus one has the exact unresolved reason", () => {
  refused(`${"> ".repeat(MAX_BODY_DEPTH + 1)}deep\n`);
  refused(`${"- * ".repeat(MAX_BODY_DEPTH)}deep\n`);
});
test("body budget exact boundary survives parsing and merge reparse", () => {
  const body = `${"> ".repeat(MAX_BODY_DEPTH)}deep\n`;
  expect(merge(body).status).toBe("resolved");
  expect(parseDoc(body, "ours", { tables: "rows" }).body).toBe(body);
  expect(headingTexts(body)).toEqual([]);
});
test("body budget counts nested list indentation and tabs", () => {
  for (const indent of ["  ", "\t"]) {
    refused(Array.from({ length: MAX_BODY_DEPTH + 1 }, (_, i) => `${indent.repeat(i)}- item`).join("\n"));
  }
});
test("body budget preserves ordinary fences thematic breaks and shallow lists", () => {
  for (const body of ["```md\n" + "> ".repeat(100) + "code\n```\n", "~".repeat(100) + "\ncode\n" + "~".repeat(100), "- ".repeat(100) + "\n", "- one\n  - two\n\t- three\n", "    > code\n"]) {
    expect(merge(body).status).toBe("resolved");
  }
});

test("bounded inline nesting controls survive parser and text walks", () => {
  for (const depth of [64, 128, 256]) {
    for (const text of ["![".repeat(depth) + "mast" + "](route)".repeat(depth), "*".repeat(depth) + "mast" + "*".repeat(depth), "[".repeat(depth) + "mast" + "]".repeat(depth)]) {
      const body = `# ${text}\n`;
      expect(headingTexts(body)).toHaveLength(1);
      expect(merge(body).status).toBe("resolved");
    }
  }
});
