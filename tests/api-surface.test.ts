/**
 * API surface snapshot.
 *
 * The checked-in reports under api-report/ are the reviewable artifact of each
 * package's public surface. This test regenerates them from the sources
 * (statically — nothing is imported) and fails on any drift, in either
 * direction: an export added or removed without regenerating the report, a
 * seam declaration (or a type it is made of) whose signature changed, or a
 * report left behind for a package that is gone.
 *
 * On failure: review the change ON PURPOSE, then `bun run api-report`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { generateReports, seamSignatures, SEAMS, SIGNATURES_HEADING } from "../scripts/api-report";

const ROOT = resolve(import.meta.dir, "..");
const REPORT_DIR = join(ROOT, "api-report");

const reports = generateReports();

/** A report's export names and its signature section, apart. */
function sections(report: string): { names: string; signatures: string } {
  const at = report.indexOf(`\n${SIGNATURES_HEADING}\n`);
  return at === -1
    ? { names: report, signatures: "" }
    : { names: report.slice(0, at), signatures: report.slice(at) };
}

describe("api surface reports", () => {
  for (const [file, content] of reports) {
    const expected = sections(content);
    const checkedIn = () => {
      expect(
        existsSync(join(REPORT_DIR, file)),
        `api-report/${file} is missing — run \`bun run api-report\` and commit it`
      ).toBe(true);
      return sections(readFileSync(join(REPORT_DIR, file), "utf8"));
    };

    test(`api-report/${file} matches the current exports`, () => {
      expect(checkedIn().names).toBe(expected.names);
    });

    if (expected.signatures) {
      test(`api-report/${file} matches the current seam signatures`, () => {
        expect(checkedIn().signatures).toBe(expected.signatures);
      });
    }
  }

  test("the frozen set is recorded where it is expected", () => {
    // A signature section that silently came out empty would pass the test
    // above for every retype.
    const withSignatures = [...reports]
      .filter(([, content]) => sections(content).signatures !== "")
      .map(([file]) => file)
      .sort();
    expect(withSignatures).toEqual(Object.keys(SEAMS).map((dir) => `${dir}.txt`).sort());
    // Every seam is recorded with its declaration printed under it. Checked
    // by shape, not by content, so retyping a seam on purpose needs only the
    // regenerated report.
    for (const [dir, subpaths] of Object.entries(SEAMS)) {
      const lines = sections(reports.get(`${dir}.txt`)!).signatures.split("\n");
      for (const name of Object.values(subpaths).flat()) {
        const at = lines.findIndex((line) => line.startsWith(`  ${name} (`));
        expect(at, `${name} has no entry in api-report/${dir}.txt`).toBeGreaterThan(-1);
        expect(lines[at + 1]).toMatch(new RegExp(`^    export (interface|type) ${name}\\b`));
      }
    }
  });

  test("no report survives its package", () => {
    const stale = readdirSync(REPORT_DIR)
      .filter((f) => f.endsWith(".txt"))
      .filter((f) => !reports.has(f));
    expect(stale).toEqual([]);
  });
});

describe("seam signature traversal", () => {
  // Fixture sources, so the traversal is tested on shapes the real seams may
  // not use today. Declarations count as the repo's own under `dir`.
  const seam = `export interface Seam {
  http: import("./client").Client;
}
`;
  const client = (bodyType: string, internal: string) => `interface InternalState {
  ${internal};
}
export interface Page {
  body: ${bodyType};
}
export class Client {
  private scratch?: InternalState;
  #hidden?: InternalState;
  get(): Promise<Page> {
    return Promise.resolve({ body: undefined as never });
  }
}
`;

  function signatures(bodyType: string, internal: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "api-report-")));
    try {
      writeFileSync(join(dir, "seam.ts"), seam);
      writeFileSync(join(dir, "client.ts"), client(bodyType, internal));
      return seamSignatures([{ file: join(dir, "seam.ts"), names: ["Seam"] }], dir)
        .join("\n")
        .replaceAll(dir, "<dir>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a type reached through an inline import is recorded, and a retype of it shows", () => {
    const baseline = signatures("string", "n: number");
    expect(baseline).toContain("  Page (");
    expect(baseline).toContain("body: string;");
    expect(signatures("number", "n: number")).not.toBe(baseline);
  });

  test("a private member's type is not part of the surface", () => {
    const baseline = signatures("string", "n: number");
    expect(baseline).toContain("  Client (");
    expect(baseline).not.toContain("InternalState");
    expect(signatures("string", "n: string")).toBe(baseline);
  });
});
