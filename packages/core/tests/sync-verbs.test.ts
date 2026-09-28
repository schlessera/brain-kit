/**
 * The sync verbs that act — `assess --fix`, `commit`, `stash`, `resolve` —
 * against real repositories. The spawned CLI runs keyless, so its judge is
 * off; the judged paths run in-process with a fake Jev, never the network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assessFix, localDate, resolveConflicts } from "../src/lib/sync/run";
import { SYNC_JUDGE_THRESHOLDS } from "../src/lib/sync/judge";
import {
  brainWithRemote,
  cleanupFixtures,
  envFor,
  fakeJev,
  FIELD_NOTE,
  FIELD_NOTE_TEXT,
  git,
  gitMayFail,
  judgeWith,
  syncJson,
  write,
} from "./sync-fixture";

afterEach(cleanupFixtures);

const IGNORE_SUBJECT = "Ignore generated artifacts and secrets";

describe("assess --fix", () => {
  test("ignores artifacts by pattern and secrets by path in one .gitignore commit, deleting nothing", async () => {
    const { root } = brainWithRemote();
    write(root, "credentials.json", "{}\n");
    git(root, "add", "credentials.json");
    git(root, "commit", "-qm", "a secret someone committed");
    write(root, "credentials.json", '{"fixture":true}\n');
    write(root, "debug.log", "trail counter restarted\n");
    write(root, ".env.local", "COUNTER_TOKEN=fixture\n");
    write(root, "notes/field-day.md", "# Field day\n");
    write(root, "survey.xyz", "owl survey grid\n");

    const { code, body } = await syncJson(root, "assess", "--fix");
    expect(code).toBe(0);
    expect(body.fixed.ignored).toContainEqual({ line: "*.log", reason: "artifact", paths: ["debug.log"] });
    expect(body.fixed.ignored).toContainEqual({ line: "/.env.local", reason: "sensitive", paths: [".env.local"] });
    expect(body.fixed.committed.status).toBe("committed");
    expect(git(root, "log", "-1", "--format=%s")).toBe(IGNORE_SUBJECT);
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe(".gitignore");
    expect(body.fixed.trackedArtifacts).toEqual([{ path: "credentials.json", reason: "sensitive" }]);
    expect(body.fixed.judged).toEqual([]);
    expect(body.files).toContainEqual({ status: "?", class: "UNKNOWN", path: "survey.xyz" });
    // Ignored, never deleted; the rest is left for commit.
    expect(existsSync(join(root, "debug.log"))).toBe(true);
    expect(gitMayFail(root, "check-ignore", "-q", "debug.log")).toBe(0);
    expect(gitMayFail(root, "check-ignore", "-q", ".env.local")).toBe(0);
    expect(git(root, "status", "--porcelain", "--", "notes/field-day.md")).toBe("?? notes/field-day.md");
  });

  test("the judge settles UNKNOWN files that clear its line and leaves the rest UNKNOWN", async () => {
    const { root } = brainWithRemote();
    write(root, "exports/visits.csv", "date,visitors\n2026-09-01,41\n");
    write(root, "sketches/bench.scad", "cube([120, 40, 45]);\n");
    write(root, "misc/blob.dat", "unclear\n");
    const verdicts: Record<string, { choice: string; confidence: number }> = {
      "exports/visits.csv": { choice: "artifact", confidence: 0.95 },
      "sketches/bench.scad": { choice: "track", confidence: 0.9 },
      "misc/blob.dat": { choice: "artifact", confidence: SYNC_JUDGE_THRESHOLDS.file - 0.05 },
    };
    const jev = fakeJev((_, item) => verdicts[item.path!]!);
    const env = await envFor(root, judgeWith(jev));

    const result = await assessFix(env);
    expect(jev.requests).toHaveLength(1);
    expect(result.fixed.judged).toHaveLength(2);
    expect(result.fixed.judged).toContainEqual({ path: "exports/visits.csv", decision: "artifact", confidence: 0.95 });
    expect(result.fixed.judged).toContainEqual({ path: "sketches/bench.scad", decision: "track", confidence: 0.9 });
    expect(result.files).toContainEqual({ status: "?", class: "ARTIFACT", path: "exports/visits.csv" });
    expect(result.files).toContainEqual({ status: "?", class: "TRACK", path: "sketches/bench.scad" });
    expect(result.files).toContainEqual({ status: "?", class: "UNKNOWN", path: "misc/blob.dat" });
    expect(result.fixed.ignored).toContainEqual({ line: "/exports/visits.csv", reason: "artifact", paths: ["exports/visits.csv"] });
    expect(result.fixed.committed?.status).toBe("committed");
    expect(gitMayFail(root, "check-ignore", "-q", "exports/visits.csv")).toBe(0);
    expect(gitMayFail(root, "check-ignore", "-q", "misc/blob.dat")).toBe(1);
  });
});

describe("commit", () => {
  const OWL = "notes/quick-note-owl.md";
  const IDEA = "notes/loose-idea.md";
  const HYDRATION = "health/ranger-hydration.md";

  function edits(root: string): void {
    for (const file of [OWL, IDEA]) writeFileSync(join(root, file), readFileSync(join(root, file), "utf-8") + "\nSeen again at dusk.\n");
    write(root, HYDRATION, "---\ntitle: Ranger hydration\ntype: health\n---\n\nTwo litres on patrol days.\n");
  }

  test("commits TRACK files by domain and bumps `updated` on the edited notes", async () => {
    const { root } = brainWithRemote();
    edits(root);
    const before = Number(git(root, "rev-list", "--count", "HEAD"));

    const { code, body } = await syncJson(root, "commit");
    expect(code).toBe(0);
    expect([...body.bumped].sort()).toEqual([IDEA, OWL]);
    for (const file of [OWL, IDEA]) expect(readFileSync(join(root, file), "utf-8")).toContain(`updated: ${localDate()}`);
    const subjects = body.commits.map((c: { subject: string }) => c.subject);
    expect(subjects).toHaveLength(2);
    expect(subjects.some((s: string) => s.startsWith("Update note: "))).toBe(true);
    expect(subjects.some((s: string) => s.startsWith("Add health: Ranger hydration"))).toBe(true);
    for (const c of body.commits) expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(git(root, "rev-list", "--count", "HEAD"))).toBe(before + 2);
    expect(git(root, "status", "--porcelain", "--", OWL, IDEA, HYDRATION)).toBe("");
  });

  test("--plan prints the plan and changes nothing, not even `updated`", async () => {
    const { root } = brainWithRemote();
    edits(root);
    const head = git(root, "rev-parse", "HEAD");
    const owl = readFileSync(join(root, OWL), "utf-8");

    const { code, body } = await syncJson(root, "commit", "--plan");
    expect(code).toBe(0);
    const planned = body.commits.flatMap((c: { files: { path: string }[] }) => c.files.map((f) => f.path)).sort();
    expect(planned).toEqual([HYDRATION, IDEA, OWL]);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, OWL), "utf-8")).toBe(owl);
  });

  test("--plan-file applies an edited message, and refuses a file outside the TRACK set", async () => {
    const { root, base } = brainWithRemote();
    edits(root);
    const plan = (await syncJson(root, "commit", "--plan")).body;
    plan.commits[0].subject = "Field notes after the dusk walk";
    const file = join(base, "plan.json");
    writeFileSync(file, JSON.stringify(plan));

    const applied = await syncJson(root, "commit", "--plan-file", file);
    expect(applied.code).toBe(0);
    expect(applied.body.commits[0].subject).toBe("Field notes after the dusk walk");
    expect(git(root, "log", "--format=%s", `-${plan.commits.length}`).split("\n")).toContain("Field notes after the dusk walk");

    write(root, ".env", "COUNTER_TOKEN=fixture\n");
    edits(root);
    const owl = readFileSync(join(root, OWL), "utf-8");
    const head = git(root, "rev-parse", "HEAD");
    writeFileSync(file, JSON.stringify({ commits: [{ domains: ["note"], files: [{ path: ".env", status: "?" }, { path: OWL, status: "M" }], subject: "Sneak a secret in", body: "" }] }));
    const refused = await syncJson(root, "commit", "--plan-file", file);
    expect(refused.code).toBe(1);
    expect(refused.body.commits[0].error).toContain("not in the assessed set");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, OWL), "utf-8")).toBe(owl);
  });
});

describe("stash", () => {
  test("an entry the tree already holds is dropped; --dry-run only reports it", async () => {
    const { root } = brainWithRemote();
    const edited = FIELD_NOTE_TEXT.replace("Boots resoled in March.", "Boots resoled in March; laces replaced.");
    write(root, FIELD_NOTE, edited);
    git(root, "stash", "-q");
    write(root, FIELD_NOTE, edited);

    const dry = await syncJson(root, "stash", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.body.dropped).toHaveLength(1);
    expect(git(root, "stash", "list")).not.toBe("");

    const real = await syncJson(root, "stash");
    expect(real.body.dropped).toHaveLength(1);
    expect(real.body.dropped[0].reason).toContain("already in the working tree");
    expect(git(root, "stash", "list")).toBe("");
  });
});

describe("resolve", () => {
  const OWL = "notes/quick-note-owl.md";
  const CACHE = ".context-cache.jsonl";
  const LINE = "Hike the ridge loop twice a week.";
  const PATROL = "health/patrol-log.md";
  const PATROL_TEXT = "---\ntitle: Patrol log\ntype: health\n---\n\n# Patrol log\n\nRadio check at noon.\n";

  /** A merge of `side` into main that conflicts on FIELD_NOTE, a note, a script and the cache. */
  function conflictedMerge(): string {
    const { root } = brainWithRemote();
    const owl = readFileSync(join(root, OWL), "utf-8");
    // keep-both's first choice of name is taken.
    write(root, "notes/quick-note-owl-remote.md", "# An older copy\n");
    write(root, PATROL, PATROL_TEXT);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "switch", "-q", "-c", "side");
    write(root, PATROL, PATROL_TEXT.replace("Radio check at noon.", "Radio check at noon and dusk."));
    write(root, FIELD_NOTE, FIELD_NOTE_TEXT.replace(LINE, "Hike the ridge loop at dawn, twice a week."));
    write(root, OWL, owl.replace("---\n\n", "---\n\nTheirs: heard at the north gate.\n\n"));
    write(root, "scripts/backup.sh", "#!/bin/sh\necho backing up to the ranger station\n");
    write(root, CACHE, '{"k":"side","v":"from side"}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "side");
    git(root, "switch", "-q", "main");
    write(root, PATROL, PATROL_TEXT.replace("Radio check at noon.", "Radio check at noon, channel 4."));
    write(root, FIELD_NOTE, FIELD_NOTE_TEXT.replace(LINE, "Hike the ridge loop with the dog, twice a week."));
    write(root, OWL, owl.replace("---\n\n", "---\n\nOurs: heard at the south gate.\n\n"));
    write(root, "scripts/backup.sh", "#!/bin/sh\necho backing up to the cloud\n");
    write(root, CACHE, '{"k":"main","v":"from main"}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "main");
    expect(gitMayFail(root, "merge", "side", "--no-edit")).not.toBe(0);
    return root;
  }

  const unmerged = (root: string) => git(root, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

  test("merges by strategy, stages the result, and leaves code and caches as git left them", async () => {
    const root = conflictedMerge();
    const { code, body } = await syncJson(root, "resolve");
    expect(code).toBe(0);
    expect(body.status).toBe("needs-judgment");

    const field = body.resolved.find((r: { path: string }) => r.path === FIELD_NOTE);
    expect(field.strategy).toBe("synthesize");
    expect(field.decisions).toEqual({ jev: 0, default: 1 });
    expect(field.notes).toContain("1 of 1 passage pairs kept both by default (Jev is off)");
    const text = readFileSync(join(root, FIELD_NOTE), "utf-8");
    expect(text).toContain("Hike the ridge loop with the dog, twice a week.");
    expect(text).toContain("Hike the ridge loop at dawn, twice a week.");
    expect(text).not.toContain("<<<<<<<");

    const owl = body.resolved.find((r: { path: string }) => r.path === OWL);
    expect(owl.strategy).toBe("keep-both");
    expect(owl.extraFiles).toEqual(["notes/quick-note-owl-remote-2.md"]);
    expect(readFileSync(join(root, "notes/quick-note-owl-remote-2.md"), "utf-8")).toContain("Theirs: heard at the north gate.");
    expect(git(root, "diff", "--cached", "--name-only")).toContain("notes/quick-note-owl-remote-2.md");

    expect(body.unresolved).toEqual([{ path: "scripts/backup.sh", strategy: "code-merge", reason: expect.stringContaining("code-merge") }]);
    expect(body.skipped).toEqual([{ path: CACHE, reason: expect.stringContaining("derived cache") }]);
    expect(unmerged(root).sort()).toEqual([CACHE, "scripts/backup.sh"]);
    expect(body.judge.calls).toBe(0);
  });

  test("a pair the judge decides takes its decision; one judge call covers every file", async () => {
    const root = conflictedMerge();
    const jev = fakeJev(() => ({ choice: "same-fact", confidence: 0.95 }));
    const env = await envFor(root, judgeWith(jev));

    const result = await resolveConflicts(env);
    const field = result.resolved.find((r) => r.path === FIELD_NOTE)!;
    expect(field.decisions).toEqual({ jev: 1, default: 0 });
    expect(result.resolved.find((r) => r.path === PATROL)!.decisions).toEqual({ jev: 1, default: 0 });
    const text = readFileSync(join(root, FIELD_NOTE), "utf-8");
    expect(text).toContain("Hike the ridge loop with the dog, twice a week.");
    expect(text).not.toContain("Hike the ridge loop at dawn, twice a week.");
    expect(jev.requests).toHaveLength(1);
    expect(result.judge.calls).toBe(1);
    expect(result.judge.decided).toBe(2);
  });
});
