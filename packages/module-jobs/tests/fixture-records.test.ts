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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures");
const BOARDS = join(FIXTURES, "boards");

/** What sits beside a record and is not one of the bytes it describes. */
const NOT_A_FIXTURE = new Set(["capture.json", "README.md"]);

/**
 * Where a fixture's bytes came from.
 *
 * `captured` is the original and the default: a verbatim slice of what a real
 * site served, described by a vantage point. `constructed` exists because one
 * thing this suite has to test cannot be captured at all — what a HEALTHY
 * board serves on a day it has no postings (#37). Nobody can go and record
 * that, and a constructed body given a URL and an egress country would be a
 * record that lies. So it says what it is, and carries the reason instead.
 *
 * The byte facts are checked for both. A constructed fixture rots the same
 * way: its README and the test reading it both describe bytes nobody re-hashes.
 */
type Provenance = "captured" | "constructed";

interface Capture {
  fixture: string;
  source: string;
  provenance?: Provenance;
  /** Constructed only: why these bytes exist and what they stand for. */
  why?: string;
  /** Captured only. */
  url?: string;
  transport?: "http" | "rendered";
  captured_at_utc?: string;
  egress_country?: string;
  user_agent?: string;
  excerpt_bytes: number;
  excerpt_sha256: string;
  full_response_bytes: number | null;
  full_response_sha256: string | null;
}

/** Absent means captured — every record written before #37 is one. */
function provenanceOf(capture: Capture): Provenance {
  return capture.provenance ?? "captured";
}

/**
 * Every directory under `fixtures/` that holds captured bytes.
 *
 * Found by the FIXTURES it holds, never by the record beside them. Listing the
 * board directories was what made a missing `capture.json` fail this suite,
 * and a walk that looks for `capture.json` instead would quietly drop a
 * directory the moment its record went missing — turning the one check nobody
 * can do by reading into a check that disables itself.
 *
 * The walk exists because the captures are no longer one shape: #34's are
 * organised by the JSON-LD shape they demonstrate rather than by board, so
 * they sit beside `boards/` instead of inside it, and the next such directory
 * is covered on the day it lands rather than the day someone remembers.
 */
function fixtureDirs(): string[] {
  const dirs: string[] = [];
  const walk = (relative: string): void => {
    const entries = readdirSync(join(FIXTURES, relative), { withFileTypes: true });
    const holdsFixtures = entries.some((entry) => entry.isFile() && !NOT_A_FIXTURE.has(entry.name));
    if (relative && holdsFixtures) dirs.push(relative);
    for (const entry of entries) {
      if (entry.isDirectory()) walk(relative ? join(relative, entry.name) : entry.name);
    }
  };
  walk("");
  return dirs.sort();
}

function capturesOf(dir: string): Capture[] {
  return (JSON.parse(readFileSync(join(FIXTURES, dir, "capture.json"), "utf-8")) as {
    captures: Capture[];
  }).captures;
}

/**
 * A trimmed JSON-LD fixture must not claim entries it does not carry.
 *
 * Both structured-data fixtures were cut down, and both kept the served
 * `numberOfItems` — 15 against 12, 19 against 3. #34's mapper is pointed at
 * them, and "the list says 15 and I found 12" is precisely the kind of thing a
 * mapper is entitled to treat as a parse failure.
 */
describe("trimmed JSON-LD fixtures", () => {
  const structured = [
    ["remotelyde", "listing.html"],
    ["builtin", "listing-jsonld.html"],
  ] as const;

  for (const [board, fixture] of structured) {
    test(`${board}/${fixture} declares the number of entries it has`, () => {
      const html = readFileSync(join(BOARDS, board, fixture), "utf-8");
      const json = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
      const lists: Array<{ numberOfItems?: number; itemListElement: unknown[] }> = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        if (record["@type"] === "ItemList") {
          lists.push(record as unknown as { numberOfItems?: number; itemListElement: unknown[] });
        }
        Object.values(record).forEach(walk);
      };
      walk(JSON.parse(json));

      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        if (list.numberOfItems === undefined) continue;
        expect(list.numberOfItems).toBe(list.itemListElement.length);
      }
    });
  }
});

describe("capture records", () => {
  test("some fixture is a whole response, so that check is not dead", () => {
    // The check above `continue`s past an excerpt, which is nine of the ten
    // captures. If the tenth ever stops being a complete response the check
    // becomes unreachable and reads as coverage it is not providing.
    const whole = fixtureDirs()
      .flatMap(capturesOf)
      .filter((c) => c.full_response_bytes !== null && c.excerpt_bytes === c.full_response_bytes);
    expect(whole.length).toBeGreaterThan(0);
  });

  test("every directory holding fixtures has a record, and none is empty", () => {
    const dirs = fixtureDirs();
    expect(dirs.length).toBeGreaterThan(0);
    // Both roots are covered: the per-board captures and #34's per-shape ones.
    expect(dirs.some((dir) => dir.startsWith("boards"))).toBe(true);
    expect(dirs).toContain("jsonld");
    expect(dirs).toContain("reporting");
    for (const dir of dirs) {
      // Named here rather than left to throw out of `capturesOf`, because
      // "this directory has no record" is the failure this guard exists for.
      expect(existsSync(join(FIXTURES, dir, "capture.json")), `${dir} has no capture.json`).toBe(
        true
      );
      expect(capturesOf(dir).length).toBeGreaterThan(0);
    }
  });

  for (const board of fixtureDirs()) {
    describe(board, () => {
      test("every recorded fixture exists, and its bytes match the record", () => {
        for (const capture of capturesOf(board)) {
          const bytes = readFileSync(join(FIXTURES, board, capture.fixture));
          expect(capture.excerpt_bytes).toBe(bytes.byteLength);
          expect(capture.excerpt_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        }
      });

      test("every committed fixture is recorded", () => {
        const recorded = new Set(capturesOf(board).map((c) => c.fixture));
        const onDisk = readdirSync(join(FIXTURES, board)).filter((f) => !NOT_A_FIXTURE.has(f));
        expect([...onDisk].sort()).toEqual([...recorded].sort());
      });

      test("the vantage point is stated, and names no host or address", () => {
        for (const capture of capturesOf(board)) {
          // No IP in either kind of record. An address or a host name would be
          // personal infrastructure, and the leakage gate does not know what
          // an IP is.
          expect(JSON.stringify(capture)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);

          if (provenanceOf(capture) === "constructed") {
            // A constructed body has no vantage point to state. What it owes
            // the next reader instead is why it exists, and a record that it
            // is not standing in for a real response.
            expect(capture.why, `${capture.fixture} says nothing about why it exists`).toBeTruthy();
            expect(capture.url).toBeUndefined();
            expect(capture.full_response_sha256).toBeNull();
            expect(capture.full_response_bytes).toBeNull();
            continue;
          }

          expect(capture.captured_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          // Country only, for the same reason.
          expect(capture.egress_country).toMatch(/^[A-Z]{2}$/);
          expect(capture.user_agent).toBeTruthy();
        }
      });

      test("nothing constructed is filed under the captured boards", () => {
        // `boards/` and `jsonld/` are evidence: four issues take what they
        // hold as the premise for a repair. A constructed body among them
        // would read as one more measurement.
        if (board === "reporting") return;
        for (const capture of capturesOf(board)) {
          expect(provenanceOf(capture), `${board}/${capture.fixture}`).toBe("captured");
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
