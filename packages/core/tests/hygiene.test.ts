/**
 * `brain hygiene`: the content-hygiene log's IDs, state machine and write
 * policy, moved out of the skill's prose into the CLI (#396).
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { audit, auditWithModules, type AuditDoc } from "../src/lib/auditor";
import { brainConfigSchema } from "../src/lib/config";
import { openDatabase } from "../src/lib/db";
import {
  candidateFromAudit,
  detectCandidates,
  HygieneLogError,
  hygieneId,
  indexTableLag,
  reconcile,
  replaceIfUnchanged,
  shortPath,
  type HygieneCandidate,
} from "../src/lib/hygiene";
import type { LoadedModule } from "../src/lib/module-types";
import { buildTaxonomy } from "../src/lib/taxonomy";
import type { AuditIssue } from "../src/lib/types";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-01T12:00:00Z");
const TODAY = "2026-07-01";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix = "brain-hygiene-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
    ["conflict", "me/basics/short-bio.md", "king of Ithaca", "conflict-basics-short-bio-e149"],
    ["silent-edit", "health/knee-injury.md", "health/knee-injury.md", "silent-edit-health-knee-injury-5fa7"],
  ])("%s on %s", (category, path, evidence, id) => {
    expect(hygieneId(category, path, evidence)).toBe(id);
  });

  test("shortpath keeps the last two segments, without the extension, as a slug", () => {
    expect(shortPath("projects/active/raft/_index.md")).toBe("raft-_index");
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
    const writes: string[] = [];
    const spy = (path: string, text: string) => {
      writes.push(path);
      writeFileSync(path, text);
    };
    expect(reconcile(root, [stale], docs, { now: NOW, write: spy }).changedFiles.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    writes.length = 0;
    const before = ["open.md", "snoozed.md", "resolved.md", "_index.md", "last-run.md"].map((n) => read(root, n));
    expect(reconcile(root, [stale], docs, { now: NOW, write: spy }).changedFiles).toEqual([]);
    expect(writes).toEqual([]);
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

  const wikiTable = (cell: string) => `| Item | Updated |\n| --- | --- |\n| ${cell} | 2026-03-11 |\n`;

  test("wiki detail resolution chooses the same-directory sibling regardless of document order", () => {
    const index = doc("a/_index.md", "index", "2026-06-30", wikiTable("[[bio]]"));
    const sibling = doc("a/bio.md", "note", "2026-06-11");
    const unrelated = doc("b/x/bio.md", "note", "2026-06-20", "", "archived");
    for (const docs of [[unrelated, index, sibling], [sibling, unrelated, index], [index, sibling, unrelated]]) {
      expect(indexTableLag(docs)).toEqual([
        expect.objectContaining({ evidence: "[[bio]]", message: expect.stringContaining("; a/bio.md has updated 2026-06-11") }),
      ]);
    }
  });

  test("an up-to-date wiki sibling is not a false lag against an unrelated newer basename", () => {
    const index = doc("a/_index.md", "index", "2026-06-30", wikiTable("[[bio]]"));
    const sibling = doc("a/bio.md", "note", "2026-03-11");
    const unrelated = doc("b/x/bio.md", "note", "2026-06-11");
    expect(indexTableLag([unrelated, index, sibling])).toEqual([]);
    expect(indexTableLag([sibling, index, unrelated])).toEqual([]);
  });

  test("ambiguous and unresolved wiki rows do not select a detail", () => {
    const docs = [doc("a/_index.md", "index", "2026-06-30", wikiTable("[[bio]]") + "\n" + wikiTable("[[absent]]")),
      doc("b/x/bio.md", "note", "2026-06-11"), doc("b/y/bio.md", "note", "2026-06-20")];
    expect(indexTableLag(docs)).toEqual([]);
    expect(indexTableLag([...docs].reverse())).toEqual([]);
  });

  test.each([
    ["[[guide]]", "a/registry/guide.md"],
    ["[[b/x/guide]]", "b/x/guide.md"],
    ["[[a/guide.md]]", "a/guide.md"],
    ["[[guide#Overview|Odysseus guide]]", "a/registry/guide.md"],
    ["[[route]]", "a/_route.md"],
  ])("wiki detail %s preserves indexer precedence and syntax", (cell, expectedPath) => {
    const docs = [doc("a/registry.md", "index", "2026-06-30", wikiTable(cell)),
      ...["b/x/guide.md", "a/guide.md", "a/registry/guide.md", "b/x/_route.md", "a/_route.md"]
        .map((path) => doc(path, "note", "2026-06-11"))];
    for (const ordered of [docs, [...docs].reverse()]) {
      expect(indexTableLag(ordered)).toEqual([
        expect.objectContaining({ evidence: cell, message: expect.stringContaining(`; ${expectedPath} has updated 2026-06-11`) }),
      ]);
    }
  });

  test("a generated registry table of an index that opts in is left to brain registry; the rest is diffed", () => {
    const table = "| Item | Status | Updated |\n| --- | --- | --- |\n| [Alpha](alpha.md) | active | 2026-05-01 |\n";
    const outside = "| Item | Status | Updated |\n| --- | --- | --- |\n| [Beta](beta.md) | active | 2026-05-01 |\n";
    const details = [doc("work/alpha.md", "note", "2026-06-10"), doc("work/beta.md", "note", "2026-06-10")];
    const region = `<!-- brain:generated:registry -->\n\n${table}\n<!-- /brain:generated:registry -->\n`;
    const lag = (content: string, optedIn: boolean) =>
      indexTableLag([doc("work/_index.md", "index", "2026-06-01", content), ...details], new Set(optedIn ? ["work/_index.md"] : [])).map(
        (c) => c.evidence
      );
    expect(lag(table, true)).toEqual(["[Alpha](alpha.md)"]); // the premise: the same table by hand lags
    expect(lag(`${region}\n${outside}`, true)).toEqual(["[Beta](beta.md)"]);
    // An index that has not opted in is diffed as written, markers or not.
    expect(lag(`${region}\n${outside}`, false)).toEqual(["[Alpha](alpha.md)", "[Beta](beta.md)"]);
  });

  test("a marker quoted in a fenced example suppresses nothing", () => {
    const table = "| Item | Status | Updated |\n| --- | --- | --- |\n| [Alpha](alpha.md) | active | 2026-05-01 |\n";
    const example = "```markdown\n<!-- brain:generated:registry -->\n\n<!-- /brain:generated:registry -->\n```\n";
    const found = indexTableLag(
      [doc("work/_index.md", "index", "2026-06-01", `${example}\n${table}`), doc("work/alpha.md", "note", "2026-06-10")],
      new Set(["work/_index.md"])
    );
    expect(found.map((c) => c.evidence)).toEqual(["[Alpha](alpha.md)"]);
  });

  test("a table without outer pipes, and a wiki-link with a label, are read as GFM reads them", () => {
    const detail = doc("work/alpha.md", "note", "2026-06-10");
    const lag = (table: string) => indexTableLag([doc("work/_index.md", "index", "2026-06-01", table), detail]);
    expect(lag("Item | Status | Updated\n--- | --- | ---\n[Alpha](alpha.md) | active | 2026-05-01\n")).toEqual([
      expect.objectContaining({ evidence: "[Alpha](alpha.md)", message: expect.stringContaining('Row "alpha" says updated 2026-05-01, status active') }),
    ]);
    expect(lag("| Item | Status | Updated |\n| --- | --- | --- |\n| [[alpha|Alpha]] | active | 2026-05-01 |\n")).toEqual([
      expect.objectContaining({ evidence: "[[alpha|Alpha]]", message: expect.stringContaining('Row "alpha" says updated 2026-05-01, status active') }),
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
  const git = (root: string, ...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString()}`);
    }
    return proc.stdout.toString();
  };
  async function reconcileCli(root: string, ...flags: string[]) {
    const { stdout, stderr, code } = await runCli(root, ["hygiene", "reconcile", ...flags, "--json"]);
    return { out: code === 0 ? JSON.parse(stdout) : null, stderr, code };
  }

  test("fixture Git errors report the command, exit and stderr", async () => {
    const root = await corpusBrain();
    expect(() => git(root, "--fixture-invalid-option"))
      .toThrow(/git --fixture-invalid-option failed \(129\):[\s\S]*unknown option/);
  });

  for (const [name, cell, link, expectedPath] of [
    ["same-directory sibling", "[[bio]]", "bio", "a/bio.md"],
    ["namesake before sibling and alias", "[[guide]]", "guide", "a/registry/guide.md"],
    ["exact repository path", "[[b/x/bio]]", "b/x/bio", "b/x/bio.md"],
    ["heading and display text", "[[bio#Overview|Odysseus bio]]", "bio#Overview", "a/bio.md"],
    ["frontmatter alias", "[[profile]]", "profile", "a/person.md"],
    ["escaped wiki display pipe", "[[bio\\|Odysseus bio]]", "bio\\", null],
    ["escaped alias display pipe", "[[profile\\|Odysseus profile]]", "profile\\", null],
    ["underscore basename", "[[route]]", "route", "a/_route.md"],
    ["configured directory anchor", "[[harbor/]]", "harbor/", "a/harbor/landing.md"],
    ["same-document heading", "[[#Overview]]", "#Overview", "a/registry.md"],
    ["ambiguous basename", "[[ambiguous]]", "ambiguous", null],
    ["unresolved target", "[[absent]]", "absent", null],
    ["hygiene-log basename ambiguity", "[[collision]]", "collision", null],
    ["hygiene-log alias ambiguity", "[[log-profile]]", "log-profile", null],
  ] as const) {
    test(`real CLI wiki detail parity: ${name}`, async () => {
      const root = makeTempBrain({ empty: true });
      brains.push(root);
      writeFileSync(join(root, "brain.config.json"), JSON.stringify({ taxonomy: { dirAnchors: ["landing.md"] } }));
      const sourcePath = "a/registry.md";
      const body = `| Item | Updated |\n| --- | --- |\n| ${cell} | 2026-03-11 |\n\nSee [[bio]] and [[profile]].\n`;
      const sources = new Map<string, string>();
      const writeDoc = (path: string, aliases: string[] = []) => {
        const index = path === sourcePath;
        const source = `---\ntitle: Odysseus ${path}\ntype: ${index ? "index" : "note"}\ncreated: 2026-03-01\nupdated: ${index ? "2026-06-30" : "2026-06-11"}\nstatus: active\ntags: [links]\naliases: ${JSON.stringify(aliases)}\n---\n${index ? body : "# Overview\nOdysseus keeps this reference.\n"}`;
        mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
        writeFileSync(join(root, path), source);
        sources.set(path, source);
      };
      for (const path of [sourcePath, "a/bio.md", "b/x/bio.md", "a/guide.md", "a/registry/guide.md", "b/x/guide.md",
        "a/_route.md", "b/x/_route.md", "a/harbor/landing.md", "b/harbor/landing.md", "b/x/ambiguous.md", "b/y/ambiguous.md", "b/x/collision.md"])
        writeDoc(path);
      writeDoc("a/person.md", [" Profile ", "guide"]);
      writeDoc("b/x/person.md", ["PROFILE", "log-profile"]);
      writeDoc("context/hygiene/collision.md", ["log-profile"]);

      const indexed = await runCli(root, ["index", "--force", "--json"]);
      expect(indexed.code).toBe(0);
      const database = openDatabase(join(root, "brain.db"));
      try {
        const target = database.query(`SELECT target.path AS targetPath FROM links l
          JOIN documents source ON source.id = l.source_id
          LEFT JOIN documents target ON target.id = l.target_id WHERE source.path = ? AND l.target = ?`)
          .get(sourcePath, link) as { targetPath: string | null } | null;
        expect(target).toEqual({ targetPath: expectedPath });
        const aliases = database.query(`SELECT f.aliases FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE d.path = ?`)
          .get("a/person.md") as { aliases: string };
        expect(aliases.aliases).toContain("Profile");
        expect(aliases.aliases.trim().length).toBeGreaterThan(0);
      } finally { database.close(); }

      const result = await reconcileCli(root, "--dry-run");
      expect(result.code).toBe(0);
      const finding = result.out.detected.find((candidate: { id: string }) => candidate.id === hygieneId("index-lag", sourcePath, cell));
      if (expectedPath) {
        expect(finding).toEqual(expect.objectContaining({
          category: "index-lag", path: sourcePath, message: expect.stringContaining(`; ${expectedPath} has updated `),
        }));
      } else expect(result.out.detected.filter((candidate: { category: string; path: string }) =>
        candidate.category === "index-lag" && candidate.path === sourcePath)).toEqual([]);
      expect(existsSync(log(root, "open.md"))).toBe(false);
      for (const [path, source] of sources) expect(readFileSync(join(root, path), "utf8")).toBe(source);
    });
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
    // Require signing with an unavailable fixture signer. Each command's
    // override must isolate the commit without changing this local preference.
    git(root, "config", "--local", "commit.gpgsign", "true");
    git(root, "config", "--local", "gpg.program", "fixture-missing-signer");
    git(root, "config", "--local", "gpg.format", "openpgp");
    git(root, "add", "-A");
    git(root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.com", "commit", "-qm", "after the first run");
    expect(git(root, "config", "--local", "--get", "commit.gpgsign").trim()).toBe("true");
    // Back-date the log, so any write at all, even of the same bytes, shows in the mtimes.
    const names = ["open.md", "snoozed.md", "resolved.md", "_index.md", "last-run.md"];
    const past = new Date("2020-01-01T00:00:00Z");
    for (const name of names) utimesSync(log(root, name), past, past);
    const second = await reconcileCli(root);
    expect(second.out.changedFiles).toEqual([]);
    expect(names.map((name) => statSync(log(root, name)).mtimeMs)).toEqual(names.map(() => past.getTime()));
    expect(git(root, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
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
      JSON.stringify([{ category: "conflict", path: "me/basics/short-bio.md", evidence: "king of Ithaca", message: "Role differs from me/identity.md" }])
    );
    const { out } = await reconcileCli(root, "--extra", extra);
    expect(out.detected).toContainEqual({
      id: "conflict-basics-short-bio-e149",
      category: "conflict",
      path: "me/basics/short-bio.md",
      message: "Role differs from me/identity.md",
    });
    const { stdout } = await runCli(root, ["hygiene", "list", "--state", "open", "--json"]);
    const listed = JSON.parse(stdout).entries.find((e: { id: string }) => e.id === "conflict-basics-short-bio-e149");
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
    for (const gone of ["brain briefing --json", "sha1sum", "shasum", "no writes anywhere", "no writes performed"]) {
      expect(skill).not.toContain(gone);
    }
    expect(skill).toContain("brain hygiene reconcile --extra");
  });

  test("the skill hands reconcile only conflicts that survive its fixes, and the fixes themselves", () => {
    const skill = readFileSync(join(import.meta.dir, "../skills/content-hygiene/SKILL.md"), "utf-8");
    const phase4 = skill.slice(skill.indexOf("## Phase 4"), skill.indexOf("## Phase 5"));
    expect(phase4).toContain("drop from the Phase 2 conflicts every one a Phase 3 fix cleared");
    expect(phase4).toContain("--fixed .brain/scratch/hygiene-fixed.json");
    // The template matches what reconcile writes to last-run.md.
    const lastRun = readFileSync(join(import.meta.dir, "../skills/content-hygiene/templates/last-run.md"), "utf-8");
    expect(lastRun).toContain("- Auto-fixed: 0\n- New open: 0\n");
    expect(lastRun).toContain("## Auto-fixes applied this run\n\n(none)\n");
  });

  test("--fixed entries are checked before anything is written", async () => {
    const root = await corpusBrain();
    writeFileSync(join(root, "fixed.json"), '[{"path": "a.md"}]');
    const { code, stderr } = await reconcileCli(root, "--fixed", join(root, "fixed.json"));
    expect(code).toBe(1);
    expect(stderr).toContain('--fixed: entry 0 needs a non-empty string "fix"');
    expect(existsSync(join(root, "context/hygiene"))).toBe(false);
  });
});

describe("writing the log", () => {
  const docs = new Map<string, { updated: string }>();
  const todo = (name: string): HygieneCandidate => ({
    category: "todo",
    path: `notes/${name}.md`,
    evidence: `[TODO: ${name}]`,
    message: `Contains marker: [TODO: ${name}]`,
  });
  const idOf = (c: HygieneCandidate) => hygieneId(c.category, c.path, c.evidence);
  const [stays, goes, wakes, lapses, returns, rests, fresh] = ["stays", "goes", "wakes", "lapses", "returns", "rests", "fresh"].map(todo);

  /** A log with an entry on every transition that moves it between files. */
  function seed(root: string): void {
    const seen = "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01";
    write(root, "open.md", "Open", `## TODO markers\n\n${entry(idOf(stays), seen)}\n\n${entry(idOf(goes), seen)}\n`);
    write(root, "snoozed.md", "Snoozed", `## Snoozed\n\n${entry(idOf(wakes), "- until: 2026-06-15")}\n\n${entry(idOf(lapses), "- until: 2026-06-15")}\n`);
    write(root, "resolved.md", "Resolved", `## Resolved\n\n${entry(idOf(returns), "- resolved-by: manual", "- resolved-on: 2026-06-10")}\n\n${entry(idOf(rests), "- resolved-by: dismissed", "- resolved-on: 2026-06-10")}\n`);
  }
  // Detected: stays (open), wakes (snoozed → open), returns (resolved → open), fresh (new).
  // Not detected: goes (open → resolved), lapses (snoozed → resolved), rests (stays resolved).
  const candidates = [stays, wakes, returns, fresh];
  const everyId = [stays, goes, wakes, lapses, returns, rests].map(idOf);

  const state = (root: string) =>
    Object.fromEntries(
      ["open.md", "snoozed.md", "resolved.md"].map((name) => [
        name,
        [...read(root, name).matchAll(/^### (\S+)/gm)].map((m) => m[1]).sort(),
      ])
    );

  test("a write that fails part-way loses no entry, and the next run settles the log", () => {
    const baseline = tempRoot();
    seed(baseline);
    const writes: string[] = [];
    reconcile(baseline, candidates, docs, {
      now: NOW,
      write: (path, text) => {
        writes.push(path);
        writeFileSync(path, text);
      },
    });
    const settled = state(baseline);
    // Every file moves, so each of the writes below is one a crash could stop.
    expect(settled["open.md"]).toEqual([stays, wakes, returns, fresh].map(idOf).sort());
    expect(settled["resolved.md"]).toEqual([goes, lapses, rests].map(idOf).sort());
    expect(writes.length).toBeGreaterThanOrEqual(5);

    for (let fail = 0; fail < writes.length; fail++) {
      const root = tempRoot();
      seed(root);
      let n = 0;
      expect(() =>
        reconcile(root, candidates, docs, {
          now: NOW,
          write: (path, text) => {
            if (n++ === fail) throw new Error(`injected failure writing ${path}`);
            writeFileSync(path, text);
          },
        })
      ).toThrow("injected failure");
      const present = new Set(Object.values(state(root)).flat());
      expect({ fail, missing: everyId.filter((id) => !present.has(id)) }).toEqual({ fail, missing: [] });
      reconcile(root, candidates, docs, { now: NOW });
      expect({ fail, state: state(root) }).toEqual({ fail, state: settled });
    }
  });

  test("sections and text the tool does not own are kept byte for byte", () => {
    const root = tempRoot();
    const notes = "## Operator notes\n\nChecked the TODOs with the team; leave `goes` alone.\n";
    const seen = "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01";
    write(root, "open.md", "Open", `## How to use this file\n\nMove entries by hand.\n\n## TODO markers\n\n${entry(idOf(goes), seen)}\n\n${notes}`);
    write(root, "resolved.md", "Resolved", `## Resolved\n\n(empty)\n\n## Kept elsewhere\n\n- a list a person keeps\n`);
    write(root, "_index.md", "Hygiene", `## Overview\n\nThe log.\n\n## Latest counts\n\n- Open: 1\n\n## History\n\nStarted in June.\n`);
    // `goes` disappears: open.md, resolved.md and _index.md all change.
    expect(reconcile(root, [], docs, { now: NOW })).toMatchObject({ resolved: 1 });
    expect(read(root, "open.md")).toContain(`## How to use this file\n\nMove entries by hand.\n\n${notes}`);
    expect(read(root, "open.md")).not.toContain(`### ${idOf(goes)}`);
    expect(read(root, "resolved.md")).toContain(`### ${idOf(goes)}`);
    expect(read(root, "resolved.md")).toContain("\n\n## Kept elsewhere\n\n- a list a person keeps\n");
    expect(read(root, "_index.md")).toEndWith(
      "## Overview\n\nThe log.\n\n## Latest counts\n\n- Open: 0\n- Snoozed: 0\n- Resolved: 1\n\n## History\n\nStarted in June.\n"
    );
    // And the result is stable.
    expect(reconcile(root, [], docs, { now: NOW }).changedFiles).toEqual([]);
  });

  test("a note a person adds under an entry moves with it", () => {
    const root = tempRoot();
    const seen = "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01";
    write(root, "open.md", "Open", `## TODO markers\n\n${entry(idOf(goes), seen, "", "Asked about this on Monday.")}\n`);
    reconcile(root, [], docs, { now: NOW });
    expect(read(root, "resolved.md")).toContain(`### ${idOf(goes)}\n${seen}\n\nAsked about this on Monday.\n- resolved-by: auto-disappeared`);
  });

  test.each([
    ["frontmatter that is not valid YAML", '---\ntitle: "unclosed\nupdated: 2026-01-01\n---\n\n## Resolved\n', "not valid YAML"],
    ["frontmatter that is never closed", "---\ntitle: Resolved\n\n## Resolved\n", "never closed"],
    ["frontmatter that is a list, not a mapping", "---\n- one\n- two\n---\n\n## Resolved\n", "not a YAML mapping"],
    ["a section holding entries and other text", "## Parked\n\nA note.\n\n### todo-notes-goes-abcd\n- resolved-by: manual\n", 'section "## Parked"'],
  ])("a log file with %s is refused, and nothing is written", (_, text, message) => {
    const root = tempRoot();
    const seen = "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01";
    write(root, "open.md", "Open", `## TODO markers\n\n${entry(idOf(goes), seen)}\n`);
    writeFileSync(log(root, "resolved.md"), text);
    const before = read(root, "open.md");
    const writes: string[] = [];
    expect(() => reconcile(root, [], docs, { now: NOW, write: (path) => writes.push(path) })).toThrow(HygieneLogError);
    expect(() => reconcile(root, [], docs, { now: NOW })).toThrow(message);
    expect(writes).toEqual([]);
    expect(read(root, "open.md")).toBe(before);
    expect(read(root, "resolved.md")).toBe(text);
  });

  test("a log file changed by someone else during the run is not overwritten", () => {
    const root = tempRoot();
    seed(root);
    let edited = false;
    expect(() =>
      reconcile(root, candidates, docs, {
        now: NOW,
        write: (path, text) => {
          if (!edited) {
            edited = true;
            writeFileSync(log(root, "resolved.md"), `${read(root, "resolved.md")}\nA hand edit.\n`);
          }
          writeFileSync(path, text);
        },
      })
    ).toThrow("changed while brain hygiene reconcile ran");
    expect(read(root, "resolved.md")).toContain("A hand edit.");
  });

  test("--fixed auto-fixes go into last-run.md, even on a run that moves no entry", () => {
    const root = tempRoot();
    reconcile(root, [stays], docs, { now: NOW });
    const later = new Date("2026-07-02T08:00:00Z");
    const result = reconcile(root, [stays], docs, {
      now: later,
      fixed: [{ path: "work/_index.md", fix: "Alpha row status active → paused" }],
    });
    expect(result).toMatchObject({ autoFixed: 1, opened: 0, resolved: 0, reopened: 0 });
    expect(result.changedFiles).toContain("context/hygiene/last-run.md");
    expect(read(root, "last-run.md")).toContain(
      "## Last run: 2026-07-02T08:00:00Z\n\n- Auto-fixed: 1\n- New open: 0\n- Resolved (disappeared): 0\n- Reopened: 0\n- Still open: 1\n- Snoozed: 0\n\n" +
        "## Auto-fixes applied this run\n\n- `work/_index.md`: Alpha row status active → paused\n"
    );
  });

  test("while a check could not run, nothing that was not detected again resolves", () => {
    const root = tempRoot();
    // A module category that starts like a core one says nothing about who owns it.
    const moduleId = hygieneId("todo-module", "notes/a.md", "x");
    const seen = "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01";
    write(root, "open.md", "Open", `## TODO markers\n\n${entry(idOf(goes), seen)}\n\n${entry(idOf(stays), seen)}\n\n## Other: todo-module\n\n${entry(moduleId, seen)}\n`);
    write(root, "snoozed.md", "Snoozed", `## Snoozed\n\n${entry(idOf(lapses), "- until: 2026-06-15")}\n`);
    const before = { open: read(root, "open.md"), snoozed: read(root, "snoozed.md") };
    const result = reconcile(root, [stays], docs, { now: NOW, failedChecks: ["moods"] });
    expect(result).toMatchObject({ resolved: 0, stillOpen: 3, snoozed: 1, failedChecks: ["moods"] });
    // The two entries not detected again are kept as they were, in their sections.
    expect(read(root, "open.md")).toContain(`## TODO markers\n\n${entry(idOf(goes), seen)}`);
    expect(read(root, "open.md")).toContain(`## Other: todo-module\n\n${entry(moduleId, seen)}`);
    expect(read(root, "snoozed.md")).toBe(before.snoozed);
    expect(existsSync(log(root, "resolved.md")) ? read(root, "resolved.md") : "").not.toContain("### ");
    // Once every check runs again and still finds nothing, they resolve.
    expect(reconcile(root, [stays], docs, { now: NOW })).toMatchObject({ resolved: 3, stillOpen: 1 });
  });

});

describe("writing the log, round 2", () => {
  const docs = new Map<string, { updated: string }>();
  const goes: HygieneCandidate = { category: "todo", path: "notes/goes.md", evidence: "[TODO: goes]", message: "Contains marker: [TODO: goes]" };
  const goesId = hygieneId(goes.category, goes.path, goes.evidence);
  const seen = "- **First seen**: 2026-06-01 · **Last seen**: 2026-06-01";

  test("a quoted updated key is set in place, and the file stays readable", () => {
    const root = tempRoot();
    mkdirSync(join(root, "context/hygiene"), { recursive: true });
    writeFileSync(log(root, "open.md"), `---\ntype: context\n"updated": 2026-01-01 # set by the tool\n---\n\n## TODO markers\n\n${entry(goesId, seen)}\n`);
    expect(reconcile(root, [], docs, { now: NOW })).toMatchObject({ resolved: 1 });
    expect(read(root, "open.md")).toStartWith(`---\ntype: context\n"updated": ${TODAY} # set by the tool\n---\n`);
    // The next run reads it back.
    expect(reconcile(root, [], docs, { now: NOW }).changedFiles).toEqual([]);
  });

  test("the first entry goes after a notes-only open.md without trimming a byte of it", () => {
    const root = tempRoot();
    const body = "\n## Operator notes\n\nLeft as is.   \n  \n";
    mkdirSync(join(root, "context/hygiene"), { recursive: true });
    writeFileSync(log(root, "open.md"), `---\ntype: context\nupdated: 2026-01-01\n---\n${body}`);
    reconcile(root, [goes], docs, { now: NOW });
    expect(read(root, "open.md")).toStartWith(`---\ntype: context\nupdated: ${TODAY}\n---\n${body}\n## TODO markers\n\n### ${goesId}\n`);
    expect(reconcile(root, [goes], docs, { now: NOW }).changedFiles).toEqual([]);
  });

  test("a save that lands while the new bytes are staged is not overwritten", () => {
    const dir = tempRoot();
    const path = join(dir, "open.md");
    writeFileSync(path, "old\n");
    expect(() =>
      replaceIfUnchanged(path, "new\n", "old\n", () => writeFileSync(path, "old\nA person's note.\n"))
    ).toThrow("changed while brain hygiene reconcile ran");
    expect(readFileSync(path, "utf-8")).toBe("old\nA person's note.\n");
    expect(readdirSync(dir)).toEqual(["open.md"]);
    // The control: unchanged, it is replaced.
    replaceIfUnchanged(path, "new\n", "old\nA person's note.\n");
    expect(readFileSync(path, "utf-8")).toBe("new\n");
  });
});

describe("detection", () => {
  const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: {} }) });

  function db(rows: { path: string; content?: string; updated?: string; status?: string; next_review?: string | null }[]): Database {
    const d = openDatabase(":memory:");
    for (const r of rows) {
      d.run(
        `INSERT INTO documents
           (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, next_review, indexed_at)
         VALUES (?, ?, 'note', ?, 'primary', NULL, '2026-01-01', ?, ?, ?, 'markdown', ?, '2026-01-01')`,
        [r.path, r.path, r.status ?? "active", r.updated ?? "2026-06-30", r.content ?? "", `h-${r.path}`, r.next_review ?? null]
      );
    }
    return d;
  }
  const idOfDoc = (d: Database, path: string) => (d.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;

  test("an unchanged finding keeps its ID as the days pass", () => {
    const database = db([
      { path: "notes/draft.md", status: "draft", updated: "2026-01-10" },
      { path: "notes/review.md", next_review: "2026-03-01" },
      { path: "context/current-focus.md", updated: "2026-02-01", content: `- 2026-02-15 send the offer\n${"word ".repeat(1000)}` },
    ]);
    const ids = (now: string) => {
      const issues = audit(database, taxonomy, { now: new Date(now) });
      const docs = new Map(
        (database.prepare("SELECT * FROM documents").all() as AuditDoc[]).map((d) => [d.path, d])
      );
      return new Map(issues.map((i) => [i.category, hygieneId(i.category, i.path, candidateFromAudit(i, docs).evidence)]));
    };
    const july = ids("2026-07-01T12:00:00Z");
    const september = ids("2026-09-20T12:00:00Z");
    for (const category of ["stale-draft", "past-date", "review-overdue", "budget"]) {
      expect({ category, july: july.get(category) }).toEqual({ category, july: expect.any(String) });
      expect({ category, id: september.get(category) }).toEqual({ category, id: july.get(category) });
    }
  });

  test("fact-drift keys on the wrong value, repeated-text on the paragraph, a failed module on its name", () => {
    const docs = new Map<string, AuditDoc>();
    const id = (issue: Partial<AuditIssue>) => {
      const full = { path: "me/bio.md", severity: "warning", ...issue } as AuditIssue;
      return hygieneId(full.category, full.path, candidateFromAudit(full, docs).evidence);
    };
    const drift = (message: string) => id({ category: "fact-drift", message });
    expect(drift("employer: found Ithaca Tours, canonical Aegean Ferries")).toBe(drift("employer: found Ithaca Tours, canonical Troy Travel"));
    expect(drift("employer: found Ithaca Tours, canonical Aegean Ferries")).not.toBe(drift("employer: found Sparta Sails, canonical Aegean Ferries"));
    const repeated = (n: number, shown: string) =>
      id({ category: "repeated-text", path: "(corpus)", message: `A paragraph appears in ${n} documents (${shown}): "The sea was calm that year"` });
    expect(repeated(5, "a.md, b.md, c.md, …")).toBe(repeated(7, "a.md, d.md, e.md, …"));
    const failed = (error: string) =>
      id({ category: "module-hygiene", path: "(module)", message: `hygiene check from module "moods" failed: ${error}` });
    expect(failed("ENOENT at 03:00")).toBe(failed("timeout at 04:00"));
  });

  test("grouped markers keep one ID per document and kind; a broken link keys on its target (#394)", () => {
    const docs = new Map<string, AuditDoc>();
    const id = (issue: Partial<AuditIssue>) => {
      const full = { path: "notes/plan.md", severity: "info", ...issue } as AuditIssue;
      return hygieneId(full.category, full.path, candidateFromAudit(full, docs).evidence);
    };
    const todo = (count: number, examples: string[]) =>
      id({ category: "todo", message: `${count} TODO markers: ${examples.join(", ")}`, count, examples });
    // A marker added or resolved is the same open entry, not a new one.
    expect(todo(2, ["[TODO: a]", "[TODO: b]"])).toBe(todo(3, ["[TODO: c]", "[TODO: a]", "[TODO: b]"]));
    expect(todo(2, ["[TODO: a]", "[TODO: b]"])).not.toBe(id({ category: "verify", message: "2 VERIFY markers: [VERIFY: a], [VERIFY: b]" }));
    expect(todo(2, ["[TODO: a]", "[TODO: b]"])).not.toBe(id({ category: "todo", path: "notes/other.md", message: "1 TODO marker: [TODO: a]" }));

    const broken = (target: string, message: string) => id({ category: "broken-link", severity: "warning", message, target });
    expect(broken("plan", "Ambiguous wiki-link: [[plan]] matches 2 files and none is a same-directory sibling — qualify it (e.g. [[dir/plan]])")).toBe(
      broken("plan", "Ambiguous wiki-link: [[plan]] matches 3 files and none is a same-directory sibling — qualify it (e.g. [[dir/plan]])")
    );
    expect(broken("plan", "Unresolved wiki-link: [[plan]]")).not.toBe(broken("mill", "Unresolved wiki-link: [[mill]]"));
  });

  test("an excluded document's links un-orphan nothing", () => {
    const database = db([{ path: "notes/lonely.md" }, { path: "context/hygiene/open.md" }]);
    database.run("INSERT INTO links (source_id, target, target_id) VALUES (?, 'lonely', ?)", [
      idOfDoc(database, "context/hygiene/open.md"),
      idOfDoc(database, "notes/lonely.md"),
    ]);
    const orphans = (exclude?: (p: string) => boolean) =>
      audit(database, taxonomy, { now: new Date("2026-07-01T12:00:00Z"), exclude }).filter((i) => i.category === "orphan").map((i) => i.path);
    // The control: the link does count when nothing is excluded.
    expect(orphans()).not.toContain("notes/lonely.md");
    expect(orphans((p) => p.startsWith("context/hygiene/"))).toEqual(["notes/lonely.md"]);
  });

  test("a module finding on an excluded path is dropped, and a failing check is reported", async () => {
    const database = db([{ path: "notes/a.md" }]);
    const mod = (name: string, check: () => AuditIssue[]) =>
      ({ key: name, dir: "/", config: {}, manifest: { name, hygieneChecks: [check] } }) as unknown as LoadedModule;
    const brain = {
      taxonomy,
      root: tempRoot("brain-hygiene-empty-"),
      modules: [
        mod("moods", () => [
          { path: "context/hygiene/open.md", severity: "info", category: "mood-drift", message: "in the log" },
          { path: "notes/a.md", severity: "info", category: "mood-drift", message: "in a note" },
        ]),
        mod("broken", () => {
          throw new Error("no network");
        }),
      ],
    };
    const exclude = (p: string) => p.startsWith("context/hygiene/");
    const found = (await auditWithModules(database, brain, { now: new Date("2026-07-01T12:00:00Z"), exclude })).filter(
      (i) => i.category === "mood-drift"
    );
    expect(found.map((i) => i.path)).toEqual(["notes/a.md"]);
    const detection = await detectCandidates(database, brain, new Date("2026-07-01T12:00:00Z"));
    expect(detection.failedChecks).toEqual(["broken"]);
    expect(detection.candidates.filter((c) => c.category === "mood-drift").map((c) => c.path)).toEqual(["notes/a.md"]);
  });

  test("a root that is given but missing fails the registry check out loud; no root audits the index alone", async () => {
    const database = db([{ path: "notes/a.md" }]);
    const failed: string[] = [];
    await auditWithModules(database, { taxonomy, root: "/nonexistent", modules: [] }, { now: new Date("2026-07-01T12:00:00Z"), onCheckFailed: (c) => failed.push(c) });
    expect(failed).toEqual(["index-stale"]);
    expect((await detectCandidates(database, { taxonomy, root: "/nonexistent", modules: [] }, new Date("2026-07-01T12:00:00Z"))).failedChecks).toEqual(["index-stale"]);

    const quiet: string[] = [];
    audit(database, taxonomy, { now: new Date("2026-07-01T12:00:00Z"), onCheckFailed: (c) => quiet.push(c) });
    expect(quiet).toEqual([]);
  });
});

describe("a core check that cannot read its input", () => {
  const taxonomy = buildTaxonomy({
    user: brainConfigSchema.parse({
      taxonomy: { facts: { troy_fell: { source: "me/basics/FACTS.md", patterns: ["Troy fell in (\\d{4})"] } } },
    }),
  });

  test("fact-drift that cannot read the canonical file reports a failed check, and its entry stays open", async () => {
    const root = tempRoot();
    const database = openDatabase(":memory:");
    const files = {
      "me/basics/FACTS.md": ["---\ntype: identity\ntitle: Facts\nfacts: { troy_fell: 2016 }\n---\n", "Facts.\n"],
      "me/basics/long-bio.md": ["---\ntype: identity\ntitle: Bio\n---\n", "Troy fell in 2015.\n"],
    };
    for (const [path, [front, body]] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), front + body);
      database.run(
        `INSERT INTO documents
           (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, next_review, indexed_at)
         VALUES (?, ?, 'identity', 'active', 'primary', NULL, '2026-01-01', '2026-06-01', ?, ?, 'markdown', NULL, '2026-01-01')`,
        [path, path, body, `h-${path}`]
      );
    }
    const brain = { taxonomy, root, modules: [] };
    const docs = new Map<string, { updated: string }>();
    const first = await detectCandidates(database, brain, NOW);
    expect(first.failedChecks).toEqual([]);
    expect(first.candidates.filter((c) => c.category === "fact-drift").map((c) => c.message)).toEqual(["troy_fell: found 2015, canonical 2016"]);
    expect(reconcile(root, first.candidates, docs, { now: NOW, failedChecks: first.failedChecks })).toMatchObject({ opened: first.candidates.length });

    const real = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(path).endsWith("me/basics/FACTS.md")) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: "EACCES" });
      }
      return (real as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    let second;
    try {
      second = await detectCandidates(database, brain, NOW);
    } finally {
      spy.mockRestore();
    }
    expect(second.failedChecks).toEqual(["fact-drift"]);
    expect(second.candidates.filter((c) => c.category === "fact-drift")).toEqual([]);
    const result = reconcile(root, second.candidates, docs, { now: NOW, failedChecks: second.failedChecks });
    expect(result).toMatchObject({ resolved: 0, failedChecks: ["fact-drift"] });
    expect(read(root, "open.md")).toContain("troy_fell: found 2015, canonical 2016");
  });
});
