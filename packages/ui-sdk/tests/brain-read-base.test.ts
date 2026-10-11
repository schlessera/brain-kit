import { expect, test } from "bun:test";
import { brainReadBaseInput, brainReadBaseResult, BRAIN_READ_BASE_PAGE_CHARS } from "../src/server/index.js";

const hash = "a".repeat(64);
const base = (content: string) => ({ content, expectedBaseHash: hash });

test("a fitting unranged read is the whole document, hash first", () => {
  const result = brainReadBaseResult(base("Odysseus rows.\nAthena watches."));
  expect(Object.keys(result)).toEqual(["expectedBaseHash", "bytes", "lines", "content"]);
  expect(result).toEqual({ expectedBaseHash: hash, bytes: 30, lines: 2, content: "Odysseus rows.\nAthena watches." });
  expect(brainReadBaseResult(base(""))).toEqual({ expectedBaseHash: hash, bytes: 0, lines: 0, content: "" });
});

test("pages keep line terminators, count UTF-8 bytes and stop at the end", () => {
  const doc = "Ithaca\r\nPylos\nSparta ☀";
  expect(brainReadBaseResult(base(doc), { offset: 2 })).toEqual({ expectedBaseHash: hash, bytes: 24, lines: 3,
    offset: 2, returnedLines: 2, text: "Pylos\nSparta ☀" });
  expect(brainReadBaseResult(base(doc), { offset: 1, limit: 1 })).toMatchObject({ text: "Ithaca\r\n", nextOffset: 2 });
  expect(brainReadBaseResult(base(doc), { offset: 9 })).toEqual({ expectedBaseHash: hash, bytes: 24, lines: 3,
    offset: 9, returnedLines: 0, text: "" });
});

test("the page budget counts the serialized text and an oversized default read pages with a hint", () => {
  const line = `${"\"Odysseus\" ".repeat(10)}\n`; // quotes double in JSON
  const doc = line.repeat(200);
  const result = brainReadBaseResult(base(doc), {}, 2_000);
  expect("content" in result).toBe(false);
  if ("content" in result) return;
  expect(JSON.stringify(result.text).length - 2).toBeLessThanOrEqual(2_000);
  expect(result.returnedLines).toBe(Math.floor(2_000 / (JSON.stringify(line).length - 2)));
  expect(result.nextOffset).toBe(result.returnedLines + 1);
  expect(result.hint).toContain(`offset: ${result.nextOffset}`);
});

test("a single line longer than the budget is cut on a code point and flagged", () => {
  const doc = `${"☀".repeat(50)}\nAthena\n`;
  const result = brainReadBaseResult(base(doc), { offset: 1 }, 21);
  expect(result).toEqual({ expectedBaseHash: hash, bytes: Buffer.byteLength(doc), lines: 2,
    offset: 1, returnedLines: 1, text: "☀".repeat(21), nextOffset: 2, truncated: true });
});

test("the default budget keeps every result under the Claude harness pass-through size", () => {
  const doc = "Day: Odysseus logs the wind and the oars.\n".repeat(3_000);
  let offset: number | undefined = 1;
  while (offset !== undefined) {
    const page = brainReadBaseResult(base(doc), { offset });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(50_000);
    offset = "content" in page ? undefined : page.nextOffset;
  }
  expect(BRAIN_READ_BASE_PAGE_CHARS).toBeLessThan(50_000);
});

test("the input is exact: a path plus an optional 1-based offset and non-negative limit", () => {
  expect(brainReadBaseInput.safeParse({ path: "notes/raft.md", offset: 2, limit: 0 }).success).toBe(true);
  expect(brainReadBaseInput.safeParse({ path: "notes/raft.md", offset: 0 }).success).toBe(false);
  expect(brainReadBaseInput.safeParse({ path: "notes/raft.md", limit: -1 }).success).toBe(false);
  expect(brainReadBaseInput.safeParse({ path: "notes/raft.md", content: false }).success).toBe(false);
});
