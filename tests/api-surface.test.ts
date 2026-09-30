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
import { join, relative, resolve } from "path";
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
        expect(lines[at + 1]).toMatch(new RegExp(`^    export (interface|type|function) ${name}\\b`));
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

  /** The signature section for `Seam` in `seam.ts`, over these files. */
  function generate(files: Record<string, string>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "api-report-")));
    try {
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
      // The report prints paths relative to ROOT, including when the fixture
      // and checkout are siblings under tmpdir(). Normalize that same path.
      return seamSignatures([{ file: join(dir, "seam.ts"), names: ["Seam"] }], dir)
        .join("\n")
        .replaceAll(relative(ROOT, dir), "<dir>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const signatures = (bodyType: string, internal: string) =>
    generate({ "seam.ts": seam, "client.ts": client(bodyType, internal) });

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

  // What the report cannot see, it refuses. Each case below is a surface
  // whose type could change while its printed signature stayed the same.
  const reachedClass = (member: string) => ({
    "seam.ts": `import type { Client } from "./client";
export interface Seam {
  client: Client;
}
`,
    "client.ts": `export class Client {
${member}
}
`,
  });

  test.each([
    ["an initialized property", `  value = "x";`, "client.ts:2 Client: property `value` has no type annotation"],
    ["an inferred method return", `  get() { return 1; }`, "client.ts:2 Client: `get` has no return type annotation"],
    ["an inferred getter", `  get size() { return 1; }`, "client.ts:2 Client: `size` has no return type annotation"],
    ["a default parameter", `  get(n = 1): number { return n; }`, "client.ts:2 Client: parameter `n` has no type annotation"],
    ["a constructor parameter property", `  constructor(public limit = 1) {}`, "client.ts:2 Client: parameter `limit` has no type annotation"],
  ])("a seam-reachable class with %s is refused", (_, member, message) => {
    expect(() => generate(reachedClass(member))).toThrow(message);
  });

  test("a seam-reachable function with an inferred return is refused", () => {
    const files = {
      "seam.ts": `import type { make } from "./make";
export interface Seam {
  make: typeof make;
}
`,
      "make.ts": `export function make(n: number) {
  return n;
}
`,
    };
    expect(() => generate(files)).toThrow("make.ts:1 make: `make` has no return type annotation");
  });

  test("an unannotated constant whose inferred type names a repo type is refused", () => {
    const page = (body: string) => `export interface Page {
  body: ${body};
}
function makePage(): Page {
  return null!;
}
export const page = makePage();
export const pages = [makePage()];
`;
    const seam = (query: string) => `import type { page, pages } from "./page";
export interface Seam {
  value: typeof ${query};
}
`;
    expect(() => generate({ "seam.ts": seam("page"), "page.ts": page("string") })).toThrow(
      "page.ts:7 page: no type annotation, and its inferred type names Page"
    );
    expect(() => generate({ "seam.ts": seam("pages"), "page.ts": page("string") })).toThrow(
      "page.ts:8 pages: no type annotation, and its inferred type names Page"
    );
  });

  test("an unannotated constant of purely structural type is recorded in full", () => {
    // What BLOCK_SCHEMA relies on: nothing named is hidden behind its type.
    const out = generate({
      "seam.ts": `import type { shape } from "./shape";
export interface Seam {
  value: typeof shape;
}
`,
      "shape.ts": `export const shape = { kind: "a" as const, n: 1 };
`,
    });
    expect(out).toContain('kind: "a";');
  });

  test.each([
    ["an inline import of a whole module", `import("./client")`],
    ["a namespace import", `typeof client`],
  ])("a module-valued type (%s) is refused", (_, type) => {
    const files = {
      "seam.ts": `import * as client from "./client";
export interface Seam {
  client: ${type === "typeof client" ? type : `typeof ${type}`};
}
`,
      "client.ts": `export interface Page {
  body: string;
}
`,
    };
    expect(() => generate(files)).toThrow("is a whole module");
  });
});
