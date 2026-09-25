/**
 * `brain hygiene`: the content-hygiene log's IDs, state machine and write
 * policy, moved out of the skill's prose into the CLI (#396).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AuditDoc } from "../src/lib/auditor";
import { hygieneId, indexTableLag, reconcile, shortPath, type HygieneCandidate } from "../src/lib/hygiene";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-01T12:00:00Z");
const TODAY = "2026-07-01";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-hygiene-"));
  dirs.push(dir);
  return dir;
}

const log = (root: string, name: string) => join(root, "context/hygiene", name);
const read = (root: string, name: string) => readFileSync(log(root, name), "utf-8");

function write(root: string, name: string, title: string, body: string): void {
  mkdirSync(join(root, "context/hygiene"), { recursive: true });
  writeFileSync(log(root, name), `---\ntype: context\ntitle: "${title}"\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${body}`);
}

const stale: HygieneCandidate = {
  category: "staleness",
  path: "context/current-focus.md",
  evidence: "context",
  message: "Last updated 40 days ago (threshold: 30 days)",
};
const STALE_ID = "staleness-context-current-focus-c515";

const entry = (id: string, ...lines: string[]) => [`### ${id}`, ...lines].join("\n");

describe("stable IDs", () => {
  // Each hash4 below was computed from the documented formula with
  // `printf '%s' '<category>|<path>|<evidence>' | sha1sum | cut -c1-4`.
  test.each([
    ["staleness", "context/current-focus.md", "context", STALE_ID],
    ["todo", "notes/plan.md", "[TODO: call the mill]", "todo-notes-plan-b486"],
    ["conflict", "me/basics/short-bio.md", "park ranger", "conflict-basics-short-bio-662d"],
    ["silent-edit", "health/knee-injury.md", "health/knee-injury.md", "silent-edit-health-knee-injury-5fa7"],
  ])("%s on %s", (category, path, evidence, id) => {
    expect(hygieneId(category, path, evidence)).toBe(id);
  });

  test("shortpath keeps the last two segments, without the extension, as a slug", () => {
    expect(shortPath("projects/active/bookshelf/_index.md")).toBe("bookshelf-_index");
    expect(shortPath("_index.md")).toBe("_index");
    expect(shortPath("Notes/My File.v2.md")).toBe("notes-my-file-v2");
    expect(shortPath("(corpus)")).toBe("corpus");
  });
});

describe("the state machine", () => {
  const docs = new Map([["context/current-focus.md", { updated: "2026-05-20" }]]);
  const run = (root: string, candidates: HygieneCandidate[]) => reconcile(root, candidates, docs, { now: NOW });
  const ids = (root: string, name: string) => [...read(root, name).matchAll(/^### (\S+)/gm)].map((m) => m[1]);

  test("(none) + detected → open", () => {
    const root = tempRoot();
    expect(run(root, [stale])).toMatchObject({ opened: 1, stillOpen: 0 });
    expect(ids(root, "open.md")).toEqual([STALE_ID]);
    expect(read(root, "open.md")).toContain(
      "- **Files**: `context/current-focus.md` (updated 2026-05-20)\n" +
        "- **Issue**: Last updated 40 days ago (threshold: 30 days)\n" +
        `- **First seen**: ${TODAY} · **Last seen**: ${TODAY}`
    );
  });

  test("open + detected → stays open, last seen moves, first seen and notes stay", () => {
    const root = tempRoot();
    write(root, "open.md", "Open", `## Staleness\n\n${entry(STALE_ID, "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01", "- note: waiting on the new role")}\n`);
    expect(run(root, [stale])).toMatchObject({ opened: 0, stillOpen: 1, resolved: 0 });
    const open = read(root, "open.md");
    expect(open).toContain(`- **First seen**: 2026-06-01 · **Last seen**: ${TODAY}`);
    expect(open).toContain("- note: waiting on the new role");
  });

  test("open + not detected → resolved as auto-disappeared", () => {
    const root = tempRoot();
    write(root, "open.md", "Open", `## Staleness\n\n${entry(STALE_ID, "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01")}\n`);
    expect(run(root, [])).toMatchObject({ resolved: 1 });
    expect(ids(root, "open.md")).toEqual([]);
    expect(ids(root, "resolved.md")).toEqual([STALE_ID]);
    expect(read(root, "resolved.md")).toContain(`- resolved-by: auto-disappeared\n- resolved-on: ${TODAY}`);
  });

  test("snoozed until a later day → stays snoozed, detected or not", () => {
    for (const candidates of [[stale], []]) {
      const root = tempRoot();
      write(root, "snoozed.md", "Snoozed", `## Snoozed\n\n${entry(STALE_ID, "- until: 2026-08-01")}\n`);
      expect(run(root, candidates)).toMatchObject({ snoozed: 1, opened: 0, resolved: 0, reopened: 0 });
      expect(ids(root, "snoozed.md")).toEqual([STALE_ID]);
      expect(ids(root, "open.md")).toEqual([]);
    }
  });

  test("snoozed until today + detected → back to open, until dropped", () => {
    const root = tempRoot();
    write(root, "snoozed.md", "Snoozed", `## Snoozed\n\n${entry(STALE_ID, `- until: ${TODAY}`)}\n`);
    expect(run(root, [stale])).toMatchObject({ reopened: 1, snoozed: 0 });
    expect(ids(root, "open.md")).toEqual([STALE_ID]);
    expect(read(root, "open.md")).not.toContain("until:");
  });

  test("snoozed until a past day + not detected → resolved as auto-disappeared", () => {
    const root = tempRoot();
    write(root, "snoozed.md", "Snoozed", `## Snoozed\n\n${entry(STALE_ID, "- until: 2026-06-01")}\n`);
    expect(run(root, [])).toMatchObject({ resolved: 1, snoozed: 0 });
    expect(ids(root, "resolved.md")).toEqual([STALE_ID]);
    expect(read(root, "resolved.md")).toContain("- resolved-by: auto-disappeared");
  });

  test("resolved + detected → reopened, naming who resolved it", () => {
    const root = tempRoot();
    write(root, "resolved.md", "Resolved", `## Resolved\n\n${entry(STALE_ID, "- resolved-by: manual", "- resolved-on: 2026-06-10")}\n`);
    expect(run(root, [stale])).toMatchObject({ reopened: 1, resolved: 0 });
    expect(ids(root, "open.md")).toEqual([STALE_ID]);
    expect(ids(root, "resolved.md")).toEqual([]);
    expect(read(root, "open.md")).toContain(`- reopened: ${TODAY} (was resolved-by: manual)`);
  });

  test("resolved + not detected → stays resolved, untouched", () => {
    const root = tempRoot();
    const body = `## Resolved\n\n${entry(STALE_ID, "- resolved-by: dismissed", "- resolved-on: 2026-06-10")}\n`;
    write(root, "resolved.md", "Resolved", body);
    expect(run(root, [])).toMatchObject({ resolved: 0, reopened: 0 });
    expect(read(root, "resolved.md")).toContain(body);
  });

  test("an entry moved by hand to snoozed with a later until stays snoozed", () => {
    const root = tempRoot();
    run(root, [stale]);
    // The person moves the entry, as the log's _index.md tells them to.
    const moved = read(root, "open.md").match(new RegExp(`### ${STALE_ID}[\\s\\S]*?(?=\\n\\n##|\\n*$)`))![0];
    writeFileSync(log(root, "open.md"), read(root, "open.md").replace(moved, ""));
    write(root, "snoozed.md", "Snoozed", `## Snoozed\n\n${moved}\n- until: 2026-08-01\n`);
    expect(run(root, [stale])).toMatchObject({ snoozed: 1, opened: 0, reopened: 0 });
    expect(ids(root, "snoozed.md")).toEqual([STALE_ID]);
    expect(ids(root, "open.md")).toEqual([]);
  });

  test("a run that changes nothing writes nothing", () => {
    const root = tempRoot();
    expect(run(root, [stale]).changedFiles.length).toBeGreaterThan(0);
    const before = ["open.md", "snoozed.md", "resolved.md", "_index.md", "last-run.md"].map((n) => read(root, n));
    expect(run(root, [stale]).changedFiles).toEqual([]);
    expect(["open.md", "snoozed.md", "resolved.md", "_index.md", "last-run.md"].map((n) => read(root, n))).toEqual(before);
  });

  test("--dry-run computes the same and writes nothing", () => {
    const root = tempRoot();
    const result = reconcile(root, [stale], docs, { now: NOW, dryRun: true });
    expect(result.opened).toBe(1);
    expect(result.changedFiles).toContain("context/hygiene/open.md");
    expect(existsSync(join(root, "context/hygiene"))).toBe(false);
  });
});

describe("index table lag", () => {
  const doc = (path: string, type: string, updated: string, content = "", status = "active"): AuditDoc =>
    ({ id: 0, path, title: path, type, status, relevance: "primary", updated, next_review: null, content }) as AuditDoc;

  test("a row older than its detail file is an index-lag issue keyed by its first cell", () => {
    const index = doc(
      "work/_index.md",
      "index",
      "2026-06-01",
      "| Item | Status | Updated |\n| --- | --- | --- |\n" +
        "| [Alpha](alpha.md) | active | 2026-05-01 |\n" +
        "| [Beta](beta/) | active | 2026-06-20 |\n" +
        "| [Gone](gone.md) | active | 2026-01-01 |\n"
    );
    const found = indexTableLag([
      index,
      doc("work/alpha.md", "note", "2026-05-10", "", "draft"),
      doc("work/beta/status.md", "note", "2026-06-10"),
    ]);
    expect(found).toEqual([
      {
        category: "index-lag",
        path: "work/_index.md",
        evidence: "[Alpha](alpha.md)",
        message: 'Row "alpha" says updated 2026-05-01, status active; work/alpha.md has updated 2026-05-10, status draft',
      },
    ]);
  });
});

describe("brain hygiene", () => {
  const brains: string[] = [];
  afterAll(() => brains.forEach(cleanup));

  async function corpusBrain(): Promise<string> {
    const root = makeTempBrain();
    brains.push(root);
    return root;
  }
  const git = (root: string, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  async function reconcileCli(root: string, ...flags: string[]) {
    const { stdout, stderr, code } = await runCli(root, ["hygiene", "reconcile", ...flags, "--json"]);
    return { out: code === 0 ? JSON.parse(stdout) : null, stderr, code };
  }

  test("the second reconcile writes no file and leaves git status clean", async () => {
    const root = await corpusBrain();
    const first = await reconcileCli(root);
    expect(first.code).toBe(0);
    expect(first.out.opened).toBeGreaterThan(0);
    expect(first.out.changedFiles.length).toBeGreaterThan(0);
    // A brain ignores its disposable index, as the template's .gitignore does.
    writeFileSync(join(root, ".gitignore"), "brain.db*\nnode_modules\n");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.com", "commit", "-qm", "after the first run");
    const second = await reconcileCli(root);
    expect(second.out.changedFiles).toEqual([]);
    expect(second.out.stillOpen).toBe(first.out.opened);
    expect(git(root, "status", "--porcelain")).toBe("");
    // The IDs are the same on both runs.
    expect(second.out.detected.map((d: { id: string }) => d.id)).toEqual(first.out.detected.map((d: { id: string }) => d.id));
  });

  test("--extra candidates get IDs and open like detected ones", async () => {
    const root = await corpusBrain();
    const extra = join(root, "extra.json");
    writeFileSync(
      extra,
      JSON.stringify([{ category: "conflict", path: "me/basics/short-bio.md", evidence: "park ranger", message: "Role differs from me/identity.md" }])
    );
    const { out } = await reconcileCli(root, "--extra", extra);
    expect(out.detected).toContainEqual({
      id: "conflict-basics-short-bio-662d",
      category: "conflict",
      path: "me/basics/short-bio.md",
      message: "Role differs from me/identity.md",
    });
    const { stdout } = await runCli(root, ["hygiene", "list", "--state", "open", "--json"]);
    const listed = JSON.parse(stdout).entries.find((e: { id: string }) => e.id === "conflict-basics-short-bio-662d");
    expect(listed).toMatchObject({ state: "open", path: "me/basics/short-bio.md", issue: "Role differs from me/identity.md" });
  });

  test("a malformed --extra file exits 1 with a message and writes nothing", async () => {
    const root = await corpusBrain();
    const cases: Array<[string, string]> = [
      ["{ not json", "is not JSON"],
      ['{"category": "conflict"}', "must hold a JSON array"],
      ['[{"category": "conflict", "path": "a.md", "message": "m"}]', 'needs a string "evidence"'],
      ['[{"category": "Bad Category", "path": "a.md", "evidence": "e", "message": "m"}]', "use lowercase letters"],
    ];
    for (const [content, expected] of cases) {
      writeFileSync(join(root, "extra.json"), content);
      const { code, stderr } = await reconcileCli(root, "--extra", join(root, "extra.json"));
      expect({ content, code }).toEqual({ content, code: 1 });
      expect(stderr).toContain(expected);
    }
    expect(existsSync(join(root, "context/hygiene"))).toBe(false);
  });

  test("the skill no longer carries the ID recipe or asks briefing for JSON", () => {
    const skill = readFileSync(join(import.meta.dir, "../skills/content-hygiene/SKILL.md"), "utf-8");
    for (const gone of ["brain briefing --json", "sha1sum", "shasum"]) expect(skill).not.toContain(gone);
    expect(skill).toContain("brain hygiene reconcile --extra");
  });
});
