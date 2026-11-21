/**
 * The live shape check's own logic (plan §11; #4205), on the fixtures only:
 * key paths carry no value, the diff names what differs, the transport's own
 * codec gives its verdict as a code and a key path, and the script refuses to
 * run under the test guard or in CI. No gog runs here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  codecVerdict, diffKeyPaths, FIXTURE_DIR, fixtureKeyPaths, keyPaths, liveRead, operationReport, parseShapeCheckArgs, SHAPE_FIXTURES, shapeCheckEnvironment,
  shapeCheckRefusal, shapePath, type ShapeOperation,
} from "../scripts/google-shape-check";
import { createFakeGog, type FakeGog } from "../packages/common/tests/support/fake-gog";

const SCRIPT = join(import.meta.dir, "../scripts/google-shape-check.ts");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));

/** Every string, number and boolean in a JSON value, and every object key that is not an identifier. */
function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(values);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(values);
  return value === null ? [] : [String(value)];
}

/**
 * Every key path gog 0.48.1 emitted in the live round that found the drift
 * (#4205): key paths only, never a value. A fixture set that lacks one is
 * not shaped like gog's output.
 */
const LIVE_ROUND: Readonly<Record<ShapeOperation, readonly string[]>> = {
  "gmail.labels.list": [
    "$.labels[].color.backgroundColor: string",
    "$.labels[].color.textColor: string",
    "$.labels[].id: string",
    "$.labels[].labelListVisibility: string",
    "$.labels[].messageListVisibility: string",
    "$.labels[].name: string",
    "$.labels[].type: string",
  ],
  "gmail.search": [
    "$.count: number",
    "$.has_more: boolean",
    "$.nextPageToken: string",
    "$.threads[].id: string",
  ],
  "gmail.thread.get": [
    "$.downloaded: null",
    "$.thread.historyId: string",
    "$.thread.id: string",
    "$.thread.messages[].historyId: string",
    "$.thread.messages[].id: string",
    "$.thread.messages[].internalDate: string",
    "$.thread.messages[].labelIds[]: string",
    "$.thread.messages[].payload.body: {}",
    "$.thread.messages[].payload.headers[].name: string",
    "$.thread.messages[].payload.headers[].value: string",
    "$.thread.messages[].payload.mimeType: string",
    "$.thread.messages[].payload.parts[]*.body.data: string",
    "$.thread.messages[].payload.parts[]*.body.size: number",
    "$.thread.messages[].payload.parts[]*.headers[].name: string",
    "$.thread.messages[].payload.parts[]*.headers[].value: string",
    "$.thread.messages[].payload.parts[]*.mimeType: string",
    "$.thread.messages[].payload.parts[]*.partId: string",
    "$.thread.messages[].sizeEstimate: number",
    "$.thread.messages[].snippet: string",
    "$.thread.messages[].threadId: string",
  ],
  "gmail.message.get": [
    "$.body: string",
    "$.headers.bcc: string",
    "$.headers.cc: string",
    "$.headers.date: string",
    "$.headers.from: string",
    "$.headers.in_reply_to: string",
    "$.headers.message_id: string",
    "$.headers.references: string",
    "$.headers.reply_to: string",
    "$.headers.subject: string",
    "$.headers.to: string",
    "$.message.historyId: string",
    "$.message.id: string",
    "$.message.internalDate: string",
    "$.message.labelIds[]: string",
    "$.message.payload.body: {}",
    "$.message.payload.headers[].name: string",
    "$.message.payload.headers[].value: string",
    "$.message.payload.mimeType: string",
    "$.message.payload.parts[]*.body.data: string",
    "$.message.payload.parts[]*.body.size: number",
    "$.message.payload.parts[]*.headers[].name: string",
    "$.message.payload.parts[]*.headers[].value: string",
    "$.message.payload.parts[]*.mimeType: string",
    "$.message.payload.parts[]*.partId: string",
    "$.message.sizeEstimate: number",
    "$.message.snippet: string",
    "$.message.threadId: string",
    "$.unsubscribe: string",
  ],
  "gmail.draft.get": [
    "$.draft.id: string",
    "$.draft.message.historyId: string",
    "$.draft.message.id: string",
    "$.draft.message.internalDate: string",
    "$.draft.message.labelIds[]: string",
    "$.draft.message.raw: string",
    "$.draft.message.sizeEstimate: number",
    "$.draft.message.snippet: string",
    "$.draft.message.threadId: string",
  ],
};

describe("key paths", () => {
  test("name every leaf with its type, collapse arrays and MIME nesting, and hide keys that could be data", () => {
    expect(keyPaths({ threads: [{ id: "19a0c3d2e4f50601" }, { id: "19a0c3d2e4f50700", messageCount: 2 }], nextPageToken: "", has_more: false, extra: null })).toEqual([
      "$.<key>: null", "$.has_more: boolean", "$.nextPageToken: string", "$.threads[].id: string", "$.threads[].messageCount: number",
    ]);
    expect(keyPaths({ payload: { parts: [{ parts: [{ parts: [{ body: { data: "x" } }] }] }, { body: { size: 1 } }] } })).toEqual([
      "$.payload.parts[]*.body.data: string", "$.payload.parts[]*.body.size: number",
    ]);
    expect(keyPaths({ "penelope@example.com": 1, labels: [], color: {} })).toEqual(["$.<key>: number", "$.color: {}", "$.labels: []"]);
  });

  test("print a key only when it is a structural name gog or Gmail uses, whatever its shape", () => {
    expect(keyPaths({ Ithaca: 1, abcdef0123456789: { snippet: "x" }, labels: [{ Penelope: true, id: "Label_12" }] })).toEqual([
      "$.<key>.snippet: string", "$.<key>: number", "$.labels[].<key>: boolean", "$.labels[].id: string",
    ]);
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

  test("cover every key path the live round saw", () => {
    for (const [operation, paths] of Object.entries(LIVE_ROUND) as [ShapeOperation, readonly string[]][]) {
      expect(diffKeyPaths(paths, fixtureKeyPaths(operation)).only_live, operation).toEqual([]);
    }
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

describe("the codec's verdict", () => {
  test("every fixture is accepted by the transport's own codec", async () => {
    for (const [operation, names] of Object.entries(SHAPE_FIXTURES) as [ShapeOperation, readonly string[]][]) {
      for (const name of names) expect(await codecVerdict(operation, fixture(name)), name).toBe("accepted");
    }
  });

  test("a refusal is the transport's code and a key path, never a value", async () => {
    const hall = fixture("thread-hall.json");
    hall.thread.messages[1].payload.headers[3].value = 7;
    const swine = fixture("thread-swine.json");
    swine.thread.messages[0].payload.parts[1].body = "herd.csv";
    const draft = fixture("draft-raw.json");
    draft.draft.message.raw = "%%%";
    const { count: _count, ...uncounted } = fixture("search-ids.json");
    const cases: [ShapeOperation, unknown, string][] = [
      ["gmail.message.get", { ...fixture("message-herald.json"), unsubscribe: ["https://example.com/herald/leave"] }, "$.unsubscribe"],
      ["gmail.thread.get", hall, "$.thread.messages[].payload.headers[].value"],
      ["gmail.thread.get", swine, "$.thread.messages[].payload.parts[]*.body"],
      ["gmail.labels.list", { ...fixture("labels-list.json"), "penelope@example.com": [] }, "$.<key>"],
      ["gmail.search", uncounted, "$.count"],
      ["gmail.draft.get", draft, "$.draft.message.raw"],
      ["gmail.message.get", [], "$"],
    ];
    for (const [operation, json, at] of cases) {
      const verdict = await codecVerdict(operation, json);
      expect(verdict, at).toEqual({ refused: "transport_incompatible", at });
      const shown = JSON.stringify(verdict);
      for (const value of values(json).filter(text => text.length > 5)) expect(shown.includes(value), value).toBe(false);
    }
  });

  test("a codec that throws anything else is a codec_error, and its message is not carried", async () => {
    const thrown = () => { throw new TypeError("penelope@example.com"); };
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: thrown, ownKeys: thrown, has: thrown, get: thrown });
    expect(await codecVerdict("gmail.labels.list", hostile)).toEqual({ refused: "codec_error" });
  });

  test("an error path is written as a key path, or not at all", () => {
    expect(shapePath("$.thread.messages[3].payload.parts[0].parts[12].headers[1].value")).toBe("$.thread.messages[].payload.parts[]*.headers[].value");
    expect(shapePath("$.headers.<key>")).toBe("$.headers.<key>");
    expect(shapePath("$")).toBe("$");
    for (const path of ["$.penelope@example.com", "$.a b", "$.threads[0].id=19a0c3d2e4f50601", "Suitors"]) expect(shapePath(path), path).toBe("<path>");
    for (const path of ["$.Ithaca", "$.thread.abcdef0123456789", "$.headers.Penelope"]) expect(shapePath(path), path).toBe("<path>");
  });

  test("an operation's report carries the verdict beside the key paths, and no verdict without an answer", async () => {
    const json = fixture("message-herald.json");
    expect(await operationReport("gmail.message.get", { exit: 0, end: "exit", json })).toEqual({
      exit: 0, live: keyPaths(json), ...diffKeyPaths(keyPaths(json), fixtureKeyPaths("gmail.message.get")), codec: "accepted",
    });
    expect((await operationReport("gmail.message.get", { exit: 0, end: "exit", json: { ...json, unsubscribe: 7 } })).codec)
      .toEqual({ refused: "transport_incompatible", at: "$.unsubscribe" });
    expect(await operationReport("gmail.thread.get", { exit: 5, end: "exit", json: null })).toEqual({ exit: 5, end: "exit" });
  });
});

describe("its arguments and environment", () => {
  test("an argument error names the flag at most, never a value it was given", () => {
    for (const argv of [["--Ithaca", "penelope@example.com"], ["penelope@example.com"], ["--gog"], ["--query"], ["--gog", "/srv/ithaca/gog", "Suitors at the hall"]]) {
      const parsed = parseShapeCheckArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      const error = parsed.ok ? "" : parsed.error;
      for (const supplied of ["Ithaca", "penelope", "example.com", "srv", "Suitors"]) expect(error, argv.join(" ")).not.toContain(supplied);
    }
    expect(parseShapeCheckArgs(["--query"])).toEqual({ ok: false, error: "--query needs a value" });
    expect(parseShapeCheckArgs(["--gog", "/srv/ithaca/gog", "--account", "ithaca"])).toEqual({ ok: true, args: { gog: "/srv/ithaca/gog", account: "ithaca" } });
  });

  test("the maintainer's environment, narrowed; --home names the gog home as both GOG_HOME and HOME", () => {
    const shell = {
      HOME: "/home/odysseus", PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", GOG_KEYRING_BACKEND: "auto",
      GOG_ACCESS_TOKEN: "ya29.suitor", GOG_ACCOUNT: "suitor", GOG_CONFIG_DIR: "/srv/elsewhere", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "leaked",
    };
    expect(shapeCheckEnvironment(shell)).toEqual({
      HOME: "/home/odysseus", PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", GOG_KEYRING_BACKEND: "auto",
    });
    expect(shapeCheckEnvironment(shell, "ithaca-home")).toMatchObject({ GOG_HOME: resolve("ithaca-home"), HOME: resolve("ithaca-home") });
  });

  const fakes: FakeGog[] = [];
  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.dispose();
  });

  test("a live read is capped at the transport's 8 MiB, like any operation", async () => {
    const fake = createFakeGog({ "gmail.labels.list": [{ stdout_bytes: 8 * 1024 * 1024 + 1 }, { stdout: { labels: [] } }] });
    fakes.push(fake);
    const argv = ["--enable-commands-exact=gmail.labels.list", "gmail", "labels", "list"];
    expect(await liveRead(fake.executable, argv, { PATH: "/usr/bin:/bin" })).toEqual({ exit: null, end: "output_too_large", json: null });
    expect(await liveRead(fake.executable, argv, { PATH: "/usr/bin:/bin" })).toEqual({ exit: 0, end: "exit", json: { labels: [] } });
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
