/**
 * Planning and making the commits of the TRACK files, against real
 * repositories. A plan groups by domain and names its files; applying one
 * commits exactly the files it lists, each of them allowed by the caller,
 * and leaves anything else staged where it was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyCommitPlan,
  bumpUpdated,
  composeSubject,
  parsePlan,
  planCommits,
  planFromFile,
  serializePlan,
  type GroupedFile,
} from "../src/lib/sync/commit.js";

const TODAY = "2026-09-28";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with one commit, a local empty hooks directory, and Odysseus as its author. */
function repo(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "brain-sync-commit-"));
  dirs.push(base);
  const root = join(base, "brain");
  mkdirSync(join(base, "hooks"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  git(root, "config", "user.name", "Odysseus");
  git(root, "config", "user.email", "odysseus@example.test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(base, "hooks"));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf-8");
const note = (title: string, body = "Body.\n") => `---\ntitle: ${title}\nupdated: 2026-01-01\n---\n${body}`;
const filesOf = (root: string, rev: string) => git(root, "show", "--no-renames", "--name-only", "--format=", rev).split("\n");

describe("composeSubject", () => {
  test("names the domains and titles when they fit", () => {
    expect(composeSubject("Update", ["routes"], ["Ogygia Shore", "Cave Path"])).toBe("Update routes: Ogygia Shore, Cave Path");
  });

  test("drops titles into the `+N more` count until it fits in 72 characters", () => {
    const titles = ["Ogygia Shore route survey", "Cave Path erosion", "Visitor centre rota", "Bear box inventory"];
    const subject = composeSubject("Update", ["routes"], titles);
    expect(subject).toBe("Update routes: Ogygia Shore route survey, Cave Path erosion (+2 more)");
    expect([...subject].length).toBeLessThanOrEqual(72);
    // 73 characters with both titles: one drops.
    expect(composeSubject("Update", ["routes"], ["A".repeat(28), "B".repeat(28)])).toBe(`Update routes: ${"A".repeat(28)} (+1 more)`);
  });

  test("a first title too long alone is shortened, still within 72 characters", () => {
    const subject = composeSubject("Add", ["routes"], ["A".repeat(100), "B"]);
    expect([...subject].length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("… (+1 more)")).toBe(true);
  });
});

describe("planCommits", () => {
  test("one domain is one commit, split into chunks of at most ten files", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) files[`routes/t${String(i).padStart(2, "0")}.md`] = note(`Route ${i}`);
    const root = repo({ "README.md": "# Brain\n" });
    for (const [path, text] of Object.entries(files)) write(root, path, text);
    const groups: GroupedFile[] = Object.keys(files).map((path) => ({ domain: "routes", status: "?", path }));

    const plan = planCommits(root, groups);
    expect(plan.commits.map((c) => c.files.length)).toEqual([10, 2]);
    expect(plan.commits.every((c) => c.domains.join() === "routes")).toBe(true);
    expect(plan.commits[1]!.subject).toBe("Add routes: Route 11, Route 12");
  });

  test("single-file domains are gathered into one commit, after the others", () => {
    const root = repo({ "README.md": "# Brain\n" });
    write(root, "routes/a.md", note("Ogygia Shore"));
    write(root, "routes/b.md", note("Cave Path"));
    write(root, "wildlife/elk.md", note("Elk count"));
    write(root, "gear/radio.md", note("Radio check"));
    const plan = planCommits(root, [
      { domain: "wildlife", status: "?", path: "wildlife/elk.md" },
      { domain: "routes", status: "?", path: "routes/a.md" },
      { domain: "gear", status: "?", path: "gear/radio.md" },
      { domain: "routes", status: "?", path: "routes/b.md" },
    ]);
    expect(plan.commits.map((c) => c.domains)).toEqual([["routes"], ["gear", "wildlife"]]);
    expect(plan.commits[1]!.subject).toBe("Add gear, wildlife: Radio check, Elk count");
  });

  test("a lone single-file domain stays alone", () => {
    const root = repo({ "README.md": "# Brain\n" });
    write(root, "gear/radio.md", note("Radio check"));
    const plan = planCommits(root, [{ domain: "gear", status: "?", path: "gear/radio.md" }]);
    expect(plan.commits).toHaveLength(1);
    expect(plan.commits[0]!.domains).toEqual(["gear"]);
  });

  test("the verb is Add, Remove or Update from the statuses; titles fall back to the file name", () => {
    const root = repo({ "routes/old.md": note("Old Route"), "routes/gone.md": note("Gone Route"), "routes/kept.md": note("Kept") });
    git(root, "rm", "-q", "routes/old.md", "routes/gone.md");
    write(root, "routes/kept.md", note("Kept", "Changed.\n"));
    write(root, "gear/list.txt", "rope\n");
    write(root, "gear/notes.md", "no frontmatter\n");

    const removed = planCommits(root, [
      { domain: "routes", status: "D", path: "routes/old.md" },
      { domain: "routes", status: "D", path: "routes/gone.md" },
    ]).commits[0]!;
    // A deletion is titled as HEAD had it.
    expect(removed.subject).toBe("Remove routes: Gone Route, Old Route");
    expect(removed.body).toBe("- D routes/gone.md\n- D routes/old.md");

    const added = planCommits(root, [
      { domain: "gear", status: "?", path: "gear/list.txt" },
      { domain: "gear", status: "A", path: "gear/notes.md" },
    ]).commits[0]!;
    expect(added.subject).toBe("Add gear: list, notes");
    expect(added.body).toBe("- A gear/list.txt\n- A gear/notes.md");

    const mixed = planCommits(root, [
      { domain: "routes", status: "D", path: "routes/old.md" },
      { domain: "routes", status: "M", path: "routes/kept.md" },
    ]).commits[0]!;
    expect(mixed.subject).toBe("Update routes: Kept, Old Route");
  });

  test("a path listed twice counts once", () => {
    const root = repo({ "README.md": "# Brain\n" });
    write(root, "routes/a.md", note("Ogygia Shore"));
    write(root, "routes/b.md", note("Cave Path"));
    const plan = planCommits(root, [
      { domain: "routes", status: "?", path: "routes/a.md" },
      { domain: "routes", status: "?", path: "routes/a.md" },
      { domain: "routes", status: "?", path: "routes/b.md" },
    ]);
    expect(plan.commits[0]!.files.map((f) => f.path)).toEqual(["routes/a.md", "routes/b.md"]);
  });
});

describe("bumpUpdated", () => {
  // Comments, quoting, a list and CRLF line endings: everything editFrontmatter must leave as it was.
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const original = crlf(
    "---\n# kept comment\ntitle: 'Ogygia Shore'   # trailing comment\nupdated: 2026-01-01\ntags: [route, survey]\naliases:\n  - ridge\n---\n# Ogygia Shore\n\nRockfall beside the cave.\n"
  );

  test("sets `updated` on a body change and leaves every other byte as it was", () => {
    const root = repo({ "routes/ridge.md": original });
    const edited = original.replace("Rockfall beside the cave.", "Rockfall beside the cave, cleared.");
    write(root, "routes/ridge.md", edited);

    expect(bumpUpdated(root, [{ path: "routes/ridge.md", status: "M" }], TODAY)).toEqual({ bumped: ["routes/ridge.md"], refused: [] });
    expect(read(root, "routes/ridge.md")).toBe(edited.replace("updated: 2026-01-01", `updated: ${TODAY}`));
  });

  test("adds `updated` when the frontmatter has none, touching nothing else", () => {
    const text = "---\ntitle: Cave Path\n---\nOld.\n";
    const root = repo({ "routes/lake.md": text });
    write(root, "routes/lake.md", "---\ntitle: Cave Path\n---\nNew.\n");
    expect(bumpUpdated(root, [{ path: "routes/lake.md", status: "M" }], TODAY).bumped).toEqual(["routes/lake.md"]);
    expect(read(root, "routes/lake.md")).toBe(`---\ntitle: Cave Path\nupdated: ${TODAY}\n---\nNew.\n`);
  });

  test("a whitespace-only body change is not a change", () => {
    const root = repo({ "routes/ridge.md": original });
    const reflowed = original.replace("Rockfall beside the cave.", "Rockfall  beside\r\nthe cave.  ");
    write(root, "routes/ridge.md", reflowed);
    expect(bumpUpdated(root, [{ path: "routes/ridge.md", status: "M" }], TODAY).bumped).toEqual([]);
    expect(read(root, "routes/ridge.md")).toBe(reflowed);
  });

  test("a frontmatter-only change is not a body change", () => {
    const root = repo({ "routes/ridge.md": original });
    const retagged = original.replace("[route, survey]", "[route]");
    write(root, "routes/ridge.md", retagged);
    expect(bumpUpdated(root, [{ path: "routes/ridge.md", status: "M" }], TODAY).bumped).toEqual([]);
    expect(read(root, "routes/ridge.md")).toBe(retagged);
  });

  test("a file listed with another status is left alone, even when its body changed", () => {
    const root = repo({ "routes/ridge.md": original });
    const edited = original.replace("Rockfall beside the cave.", "Washout repaired.");
    write(root, "routes/ridge.md", edited);
    expect(bumpUpdated(root, [{ path: "routes/ridge.md", status: "A" }], TODAY).bumped).toEqual([]);
    expect(read(root, "routes/ridge.md")).toBe(edited);
  });

  test("only modified markdown files are considered", () => {
    const root = repo({ "routes/ridge.md": original, "gear/list.txt": "rope\n" });
    write(root, "routes/new.md", note("New", "Fresh.\n"));
    write(root, "gear/list.txt", "rope\nmap\n");
    const result = bumpUpdated(root, [{ path: "routes/new.md", status: "?" }, { path: "gear/list.txt", status: "M" }], TODAY);
    expect(result.bumped).toEqual([]);
    expect(read(root, "routes/new.md")).toBe(note("New", "Fresh.\n"));
  });
});

describe("applyCommitPlan", () => {
  function fixture(): string {
    const root = repo({ "routes/ridge.md": note("Ogygia Shore"), "routes/old.md": note("Old"), "gear/radio.md": note("Radio") });
    write(root, "routes/ridge.md", note("Ogygia Shore", "Washout.\n"));
    write(root, "routes/lake.md", note("Cave Path"));
    rmSync(join(root, "routes/old.md"));
    git(root, "rm", "-q", "gear/radio.md");
    // Someone else's staged work, which no commit may take.
    write(root, "staged.md", "staged by someone else\n");
    git(root, "add", "staged.md");
    return root;
  }

  const groups: GroupedFile[] = [
    { domain: "routes", status: "M", path: "routes/ridge.md" },
    { domain: "routes", status: "?", path: "routes/lake.md" },
    { domain: "routes", status: "D", path: "routes/old.md" },
    { domain: "gear", status: "D", path: "gear/radio.md" },
  ];
  const allowed = new Set(groups.map((g) => g.path));

  test("commits each group with only its files and the message as planned", () => {
    const root = fixture();
    const plan = planCommits(root, groups);
    const results = applyCommitPlan(root, plan, allowed);
    expect(results.map((r) => ("sha" in r ? r.subject : r.error))).toEqual(plan.commits.map((c) => c.subject));

    expect(filesOf(root, "HEAD~1").sort()).toEqual(["routes/lake.md", "routes/old.md", "routes/ridge.md"]);
    expect(filesOf(root, "HEAD")).toEqual(["gear/radio.md"]);
    const message = git(root, "log", "-1", "--format=%B", "HEAD~1");
    expect(message).toBe(`${plan.commits[0]!.subject}\n\n${plan.commits[0]!.body}`);
    expect(message).not.toMatch(/co-authored-by/i);
    expect(git(root, "log", "-1", "--format=%an")).toBe("Odysseus");
    // The unrelated staged file is still staged and in no commit.
    expect(git(root, "status", "--porcelain")).toBe("A  staged.md");
  });

  test("someone else's staged file stays staged and out of the commit", () => {
    const root = fixture();
    const results = applyCommitPlan(root, planCommits(root, [groups[0]!, groups[1]!]), allowed);
    expect(filesOf(root, "HEAD").sort()).toEqual(["routes/lake.md", "routes/ridge.md"]);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("gear/radio.md\nstaged.md");
    expect("sha" in results[0]!).toBe(true);
  });

  test("a file outside the allowed set refuses the whole plan and commits nothing", () => {
    const root = fixture();
    const head = git(root, "rev-parse", "HEAD");
    const plan = planCommits(root, [...groups, { domain: "misc", status: "A", path: "staged.md" }]);
    const results = applyCommitPlan(root, plan, allowed);
    expect(results.every((r) => "error" in r)).toBe(true);
    expect(results.some((r) => "error" in r && r.error === "refused: not in the assessed set: staged.md")).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("a file in two commits is refused", () => {
    const root = fixture();
    const head = git(root, "rev-parse", "HEAD");
    const file = { path: "routes/lake.md", status: "?" };
    const results = applyCommitPlan(
      root,
      { commits: [{ domains: ["routes"], files: [file], subject: "One", body: "" }, { domains: ["routes"], files: [file], subject: "Two", body: "" }] },
      allowed
    );
    expect(results[1]).toEqual({ subject: "Two", error: "refused: already in an earlier commit: routes/lake.md" });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  test("a path is a name, never a pattern", () => {
    const root = repo({ "README.md": "# Brain\n" });
    write(root, "a*.md", "star\n");
    write(root, "ab.md", "not allowed\n");
    const results = applyCommitPlan(root, { commits: [{ domains: ["x"], files: [{ path: "a*.md", status: "?" }], subject: "Add x: a*", body: "" }] }, new Set(["a*.md"]));
    expect("sha" in results[0]!).toBe(true);
    expect(filesOf(root, "HEAD")).toEqual(["a*.md"]);
    expect(git(root, "status", "--porcelain")).toBe("?? ab.md");
  });

  test("a commit git rejects leaves a file it added untracked again", () => {
    const root = repo({ "README.md": "# Brain\n" });
    const hooks = git(root, "config", "core.hooksPath");
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    write(root, "routes/lake.md", note("Cave Path"));
    const results = applyCommitPlan(root, planCommits(root, [{ domain: "routes", status: "?", path: "routes/lake.md" }]), new Set(["routes/lake.md"]));
    expect("error" in results[0]!).toBe(true);
    expect(git(root, "status", "--porcelain", "-uall")).toBe("?? routes/lake.md");
  });
});

describe("serializePlan / parsePlan / planFromFile", () => {
  test("a plan survives a round trip, and an edited message is applied as given", () => {
    const root = repo({ "README.md": "# Brain\n" });
    write(root, "routes/lake.md", note("Cave Path"));
    const plan = planCommits(root, [{ domain: "routes", status: "?", path: "routes/lake.md" }]);
    expect(parsePlan(serializePlan(plan))).toEqual({ plan });

    const edited = JSON.parse(serializePlan(plan));
    edited.commits[0].subject = "Record the Cave Path survey";
    edited.commits[0].body = "Written by hand.";
    const file = join(root, "..", "plan.json");
    writeFileSync(file, JSON.stringify(edited));
    const loaded = planFromFile(file);
    if (!("plan" in loaded)) throw new Error(loaded.error);
    applyCommitPlan(root, loaded.plan, new Set(["routes/lake.md"]));
    expect(git(root, "log", "-1", "--format=%B")).toBe("Record the Cave Path survey\n\nWritten by hand.");
  });

  test("an edited plan's files are still checked against the allowed set", () => {
    const root = repo({ "README.md": "# Brain\n" });
    write(root, "secret.md", "not assessed\n");
    const parsed = parsePlan(JSON.stringify({ commits: [{ domains: [], files: [{ path: "secret.md", status: "?" }], subject: "Sneak", body: "" }] }));
    if (!("plan" in parsed)) throw new Error(parsed.error);
    expect(applyCommitPlan(root, parsed.plan, new Set())).toEqual([{ subject: "Sneak", error: "refused: not in the assessed set: secret.md" }]);
    expect(git(root, "status", "--porcelain")).toBe("?? secret.md");
  });

  test("malformed input is an error, not a plan", () => {
    expect(parsePlan("{")).toMatchObject({ error: expect.stringContaining("not valid JSON") });
    expect(parsePlan('{"commits":[{"files":[]}]}')).toMatchObject({ error: expect.stringContaining("not a commit plan") });
    expect(planFromFile("/nonexistent/plan.json")).toMatchObject({ error: expect.stringContaining("cannot read") });
  });
});
