/**
 * API surface snapshot.
 *
 * The checked-in reports under api-report/ are the reviewable artifact of each
 * package's public surface. This test regenerates them from the sources
 * (statically — nothing is imported) and fails on any drift, in either
 * direction: an export added or removed without regenerating the report, a
 * public declaration (or a type it is made of) whose signature changed, or a
 * report left behind for a package that is gone.
 *
 * On failure: review the change ON PURPOSE, then `bun run api-report`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { generateReports, isInternalSubpath, seamSignatures, SEAMS, SIGNATURES_HEADING } from "../scripts/api-report";

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
      test(`api-report/${file} matches the current public signatures`, () => {
        expect(checkedIn().signatures).toBe(expected.signatures);
      });
    }
  }

  test("every public export is recorded with its signature", () => {
    // A signature section that silently came out empty, or that skipped a
    // name, would pass the test above for every retype of what it skipped.
    // Every name a public (non-`./internal`) entry exports must have an
    // entry: printed here, referenced to its owning report, or named as a
    // third-party re-export.
    const publicNames = (report: string) => {
      const names = new Set<string>();
      let internal = false;
      for (const line of sections(report).names.split("\n")) {
        const entry = /^export "([^"]+)"/.exec(line);
        if (entry) {
          internal = isInternalSubpath(entry[1]);
          continue;
        }
        const name = /^  (?:type )?([\w$]+)$/.exec(line)?.[1];
        if (name && !internal) names.add(name);
      }
      return names;
    };
    let checked = 0;
    for (const [file, content] of reports) {
      const names = publicNames(content);
      const signatures = sections(content).signatures.split("\n");
      for (const name of names) {
        const recorded = signatures.some(
          (line) => line.startsWith(`  ${name} (`) || line.startsWith(`  ${name} re-exported from `)
        );
        if (!recorded) {
          expect.unreachable(`${name} has no signature entry in api-report/${file}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
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
    ["a default parameter", `  get(n = 1): number { return n; }`, "client.ts:2 Client: parameter `n` has no type annotation"],
    ["a constructor parameter property", `  constructor(public limit = 1) {}`, "client.ts:2 Client: parameter `limit` has no type annotation"],
  ])("a seam-reachable class with %s is refused", (_, member, message) => {
    expect(() => generate(reachedClass(member))).toThrow(message);
  });

  // An inferred return type is printed from the checker, and the repo types it
  // names are followed, so changing what the body returns changes the report.
  test("an inferred function, method or getter return is printed and follows what it names", () => {
    const files = (ret: string) => ({
      "seam.ts": `import type { make } from "./make";
import type { Client } from "./client";
export interface Seam {
  make: typeof make;
  client: Client;
}
`,
      "make.ts": `export interface Made {
  value: ${ret};
}
export function make(n: number) {
  return { value: n } as Made;
}
`,
      "client.ts": `import type { Made } from "./make";
export class Client {
  get(): Made { return null!; }
  read() { return 1; }
  get size() { return "s"; }
}
`,
    });
    const baseline = generate(files("number"));
    expect(baseline).toContain("export function make(n: number): Made;");
    expect(baseline).toContain("read(): number;");
    expect(baseline).toContain("get size(): string;");
    expect(baseline).toContain("  Made (");
    expect(generate(files("string"))).not.toBe(baseline);
  });

  test("an unannotated constant whose inferred type names a repo type records that type", () => {
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
    for (const query of ["page", "pages"]) {
      const baseline = generate({ "seam.ts": seam(query), "page.ts": page("string") });
      expect(baseline).toContain("  Page (");
      expect(baseline).toContain("body: string;");
      // The constant prints only the name; the followed declaration shows the retype.
      expect(generate({ "seam.ts": seam(query), "page.ts": page("number") })).not.toBe(baseline);
    }
  });

  test("an inferred type that names a repo type only through an index signature records it", () => {
    const files = (value: string) => ({
      "seam.ts": `import type { make } from "./make";
export interface Seam {
  make: typeof make;
}
`,
      "make.ts": `export interface Made {
  value: ${value};
}
export function make() {
  return {} as { [key: string]: Made };
}
`,
    });
    const baseline = generate(files("number"));
    expect(baseline).toContain("  Made (");
    expect(generate(files("string"))).not.toBe(baseline);
  });

  // The checker orders an inferred union by type creation, which depends on
  // what it checked first; two CI shards printed one type two ways.
  test("an inferred union and a mapped record over it print in a canonical order", () => {
    const out = generate({
      "seam.ts": `import type { make } from "./make";
export interface Seam {
  make: typeof make;
}
`,
      "make.ts": `const early: "teal" = "teal";
export function make(flag: boolean) {
  const tone = flag ? early : ("gold" as const);
  const keys = {} as { [K in typeof tone]: K };
  return { tone, keys };
}
`,
    });
    expect(out).toContain('tone: "gold" | "teal";');
    expect(out.indexOf('gold: "gold";')).toBeGreaterThan(-1);
    expect(out.indexOf('gold: "gold";')).toBeLessThan(out.indexOf('teal: "teal";'));
  });

  test("an @internal member is left out of the recorded surface", () => {
    const files = (hidden: string) => ({
      "seam.ts": `export interface Hidden { n: ${hidden}; }
export class Host {
  /** @internal first-party wiring */
  readonly wiring: Hidden = { n: null! };
  visible(): number { return 1; }
}
export interface Options {
  /** @internal test hook */
  hook?: Hidden;
  name: string;
}
export interface Seam {
  host: Host;
  options: Options;
}
`,
    });
    const baseline = generate(files("number"));
    expect(baseline).toContain("visible(): number;");
    expect(baseline).toContain("name: string;");
    expect(baseline).not.toContain("wiring");
    expect(baseline).not.toContain("hook");
    expect(baseline).not.toContain("Hidden");
    expect(generate(files("string"))).toBe(baseline);
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
