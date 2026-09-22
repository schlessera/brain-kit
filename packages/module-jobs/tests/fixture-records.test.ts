/**
 * Every `capture.json` must describe the bytes actually committed next to it.
 *
 * The records started out hand-maintained and drifted within a day: nine of
 * ten `excerpt_bytes` were the length of the string before the writer
 * normalised its trailing whitespace, and the one fixture claiming to BE a
 * complete response was eight bytes shorter than the response it named. None
 * of that is visible by reading — a byte count is exactly the kind of fact
 * nobody re-checks — and four issues downstream take these fixtures as their
 * premise.
 *
 * `measure-boards.ts --seal` rewrites the byte facts from disk. This is the
 * part that matters: a generator only helps whoever remembers to run it.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BOARDS = join(import.meta.dir, "fixtures", "boards");

interface Capture {
  fixture: string;
  source: string;
  url: string;
  transport: "http" | "rendered";
  captured_at_utc: string;
  egress_country: string;
  user_agent: string;
  excerpt_bytes: number;
  excerpt_sha256: string;
  full_response_bytes: number | null;
  full_response_sha256: string | null;
}

function boardDirs(): string[] {
  return readdirSync(BOARDS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function capturesOf(board: string): Capture[] {
  return (JSON.parse(readFileSync(join(BOARDS, board, "capture.json"), "utf-8")) as {
    captures: Capture[];
  }).captures;
}

describe("board capture records", () => {
  test("there is at least one board, and each has a record", () => {
    const boards = boardDirs();
    expect(boards.length).toBeGreaterThan(0);
    for (const board of boards) {
      expect(capturesOf(board).length).toBeGreaterThan(0);
    }
  });

  for (const board of boardDirs()) {
    describe(board, () => {
      test("every recorded fixture exists, and its bytes match the record", () => {
        for (const capture of capturesOf(board)) {
          const bytes = readFileSync(join(BOARDS, board, capture.fixture));
          expect(capture.excerpt_bytes).toBe(bytes.byteLength);
          expect(capture.excerpt_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        }
      });

      test("every committed fixture is recorded", () => {
        const recorded = new Set(capturesOf(board).map((c) => c.fixture));
        const onDisk = readdirSync(join(BOARDS, board)).filter((f) => f !== "capture.json");
        expect([...onDisk].sort()).toEqual([...recorded].sort());
      });

      test("the vantage point is stated, and names no host or address", () => {
        for (const capture of capturesOf(board)) {
          expect(capture.captured_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          // Country only. An address or a host name would be personal
          // infrastructure, and the leakage gate does not know what an IP is.
          expect(capture.egress_country).toMatch(/^[A-Z]{2}$/);
          expect(capture.user_agent).toBeTruthy();
          expect(JSON.stringify(capture)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
        }
      });

      test("a fixture claiming to be a whole response is one", () => {
        for (const capture of capturesOf(board)) {
          if (capture.full_response_sha256 === null) continue;
          if (capture.excerpt_bytes !== capture.full_response_bytes) continue;
          // Same length as the response it names, so it must be that response
          // byte for byte — the claim `remotive/robots.txt` got wrong.
          expect(capture.excerpt_sha256).toBe(capture.full_response_sha256);
        }
      });
    });
  }
});
