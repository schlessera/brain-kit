/**
 * The live shape check's own logic (plan §11; #4205), on the fixtures only:
 * key paths carry no value, the diff names what differs, and the script
 * refuses to run under the test guard or in CI. No gog runs here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffKeyPaths, FIXTURE_DIR, fixtureKeyPaths, keyPaths, SHAPE_FIXTURES, shapeCheckRefusal, type ShapeOperation } from "../scripts/google-shape-check";

const SCRIPT = join(import.meta.dir, "../scripts/google-shape-check.ts");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));

/** Every string, number and boolean in a JSON value, and every object key that is not an identifier. */
function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(values);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(values);
  return value === null ? [] : [String(value)];
}

describe("key paths", () => {
  test("name every leaf with its type, collapse arrays and MIME nesting, and hide keys that could be data", () => {
    expect(keyPaths({ threads: [{ id: "19a0c3d2e4f50601" }, { id: "19a0c3d2e4f50700", messageCount: 2 }], nextPageToken: "", has_more: false, extra: null })).toEqual([
      "$.extra: null", "$.has_more: boolean", "$.nextPageToken: string", "$.threads[].id: string", "$.threads[].messageCount: number",
    ]);
    expect(keyPaths({ payload: { parts: [{ parts: [{ parts: [{ body: { data: "x" } }] }] }, { body: { size: 1 } }] } })).toEqual([
      "$.payload.parts[]*.body.data: string", "$.payload.parts[]*.body.size: number",
    ]);
    expect(keyPaths({ "penelope@example.com": 1, labels: [], color: {} })).toEqual(["$.<key>: number", "$.color: {}", "$.labels: []"]);
  });

  test("never carry a value from the fixtures", () => {
    for (const [operation, names] of Object.entries(SHAPE_FIXTURES) as [ShapeOperation, readonly string[]][]) {
      const paths = fixtureKeyPaths(operation).join("\n");
      expect(paths.length, operation).toBeGreaterThan(0);
      for (const name of names) {
        for (const value of values(fixture(name)).filter(text => text.length > 5)) expect(paths.includes(value), `${operation}: ${value}`).toBe(false);
      }
      for (const forbidden of ["example.com", "Penelope", "Suitors", "19a0c3d2e4f50601", "r-1234567890123456789"]) expect(paths).not.toContain(forbidden);
    }
  });

  test("cover the shapes the codecs read", () => {
    expect(fixtureKeyPaths("gmail.thread.get")).toEqual(expect.arrayContaining([
      "$.downloaded: null", "$.thread.id: string", "$.thread.messages[].internalDate: string", "$.thread.messages[].labelIds[]: string",
      "$.thread.messages[].payload.headers[].name: string", "$.thread.messages[].payload.parts[]*.body.data: string",
      "$.thread.messages[].payload.parts[]*.body.attachmentId: string", "$.thread.messages[].sizeEstimate: number",
    ]));
    expect(fixtureKeyPaths("gmail.search")).toEqual(expect.arrayContaining(["$.threads[].id: string", "$.threads: []", "$.nextPageToken: string"]));
    expect(fixtureKeyPaths("gmail.draft.get")).toEqual(expect.arrayContaining(["$.draft.id: string", "$.draft.message.raw: string"]));
  });
});

describe("the diff", () => {
  test("names the paths only the live answer has, and those only the fixtures have", () => {
    const fixtures = fixtureKeyPaths("gmail.labels.list");
    const live = [...fixtures.filter(path => path !== "$.labels[].color.textColor: string"), "$.labels[].messagesTotal: number"].sort();
    expect(diffKeyPaths(live, fixtures)).toEqual({ only_live: ["$.labels[].messagesTotal: number"], only_fixtures: ["$.labels[].color.textColor: string"] });
    expect(diffKeyPaths(fixtures, fixtures)).toEqual({ only_live: [], only_fixtures: [] });
  });
});

describe("where it may run", () => {
  test("never in CI and never under the offline test guard", () => {
    expect(shapeCheckRefusal({ CI: "true" }, false)).toContain("refuses to run in CI");
    expect(shapeCheckRefusal({ GITHUB_ACTIONS: "true" }, false)).toContain("refuses to run in CI");
    expect(shapeCheckRefusal({}, true)).toContain("refuses to run under the offline test guard");
    expect(shapeCheckRefusal({ NODE_ENV: "test" }, false)).toContain("refuses to run under the offline test guard");
    expect(shapeCheckRefusal({}, false)).toBeNull();
  });

  test("the script itself, started from a test, refuses before it touches any gog", () => {
    // The path does not exist and is not named gog: nothing could run even if the refusal were gone.
    const child = Bun.spawnSync([process.execPath, SCRIPT, "--gog", "/nonexistent/ithaca-mail-cli", "--account", "ithaca"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.stderr.toString()).toContain("refuses to run under the offline test guard");
    expect(child.stdout.toString()).toBe("");
    expect(child.exitCode).toBe(2);
  });
});
