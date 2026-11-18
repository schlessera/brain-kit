import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeJsonLines } from "./helpers/json-lines.js";

let dir = "", files = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "odysseus-json-lines-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const file = (text?: string) => {
  const path = join(dir, `calls-${++files}.jsonl`);
  if (text !== undefined) writeFileSync(path, text);
  return path;
};

test("a JSON-lines read in the middle of an append gives only the complete records (#4247)", () => {
  expect(completeJsonLines(file()), "MISSING_FILE_HAS_NO_RECORDS").toEqual([]);
  expect(completeJsonLines(file("")), "CREATED_BUT_UNWRITTEN_FILE_HAS_NO_RECORDS").toEqual([]);
  expect(completeJsonLines(file('{"tool":"web_se')), "PARTIAL_FIRST_LINE_IS_DROPPED").toEqual([]);
  expect(completeJsonLines(file('{"tool":"web_search"}\n{"tool":"web_fe')), "UNTERMINATED_LAST_LINE_IS_DROPPED").toEqual([{ tool: "web_search" }]);
  expect(completeJsonLines(file('{"tool":"web_search"}\n{"tool":"web_fetch"}\n')), "COMPLETE_LINES_ARE_ALL_READ").toEqual([{ tool: "web_search" }, { tool: "web_fetch" }]);
});
