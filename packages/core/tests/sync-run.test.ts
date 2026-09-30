/**
 * `brain sync run` in-process, against real repositories and a real remote:
 * the order of its steps, when it stops, and what it pushes. The judge is a
 * fake Jev (never the network) and post-sync a stub that counts its calls;
 * `sync-scenarios.test.ts` runs the real CLI end to end.
 *
 * Also bare `brain sync`: the report first, then the agent only for what the
 * rules left.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { needsAgent, syncCommand, type SyncResult } from "../src/cli/commands/sync";
import { initContext } from "../src/lib/context";
import type { AgentRunner } from "../src/lib/seams";
import { conclude } from "../src/lib/sync/merge-state";
import { MAX_PULLS, resolveConflicts, runSync, type AssessFixEnvelope, type PostSyncResult, type RunEnvelope } from "../src/lib/sync/run";
import {
  brainWithRemote,
  cleanupFixtures,
  commitAndPush,
  envFor,
  fakeJev,
  FIELD_NOTE,
  git,
  gitMayFail,
  judgeWith,
  mergeFileMarkers,
  otherClone,
  OURS_RIDGE,
  POST_SYNC_STUB,
  prePushHook,
  SCENARIO_SETUPS,
  THEIRS_RIDGE,
  type Brain,
  write,
} from "./sync-fixture";

afterEach(cleanupFixtures);

const { sameNote, codeConflict, pushRace } = SCENARIO_SETUPS;

const remoteHead = (brain: Brain) => git(brain.remote, "rev-parse", "main");
const head = (root: string) => git(root, "rev-parse", "HEAD");

describe("runSync", () => {
  test("nothing to do: nothing committed or pushed, post-sync runs, complete", async () => {
    const brain = brainWithRemote();
    const env = await envFor(brain.root, judgeWith(null));
    const before = head(brain.root);

    const run = await runSync(env);
    expect(run.status).toBe("complete");
    expect(run.steps.commit).toEqual([{ commits: [], bumped: [], refused: [], conflicted: [] }]);
    expect(run.steps.pull.map((p) => p.status)).toEqual(["synced"]);
    expect(run.steps.push).toEqual([{ status: "up-to-date", detail: "HEAD is origin/main" }]);
    expect(env.postSyncCalls).toBe(1);
    expect(head(brain.root)).toBe(before);
    expect(run.report.split("\n")[0]).toBe("brain sync: complete");
  });

  test("one judge serves J1 and J2, and the judged merge is what gets pushed", async () => {
    const brain = brainWithRemote();
    sameNote(brain);
    write(brain.root, "exports/visits.csv", "date,visitors\n2026-09-01,41\n");
    const jev = fakeJev((id) => (id.endsWith(".kind") ? { choice: "artifact", confidence: 0.95 } : { choice: "same-fact", confidence: 0.95 }));
    const env = await envFor(brain.root, judgeWith(jev));

    const run = await runSync(env);
    expect(run.status).toBe("complete");
    expect(run.judge.calls).toBe(2);
    expect(run.judge.decided).toBe(2);
    expect((run.steps.assess[0] as { fixed: { judged: unknown[] } }).fixed.judged).toEqual([
      { path: "exports/visits.csv", decision: "artifact", confidence: 0.95 },
    ]);
    expect(run.steps.resolve[0]!.resolved[0]).toMatchObject({ path: FIELD_NOTE, strategy: "synthesize", decisions: { jev: 1, default: 0 } });
    expect(remoteHead(brain)).toBe(head(brain.root));
    const pushed = git(brain.remote, "show", `main:${FIELD_NOTE}`);
    expect(pushed).toContain(OURS_RIDGE);
    expect(pushed).not.toContain(THEIRS_RIDGE);
    expect(gitMayFail(brain.root, "check-ignore", "-q", "exports/visits.csv")).toBe(0);
  });

  test("a conflict no strategy resolves stops before the push, with the merge in progress", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const env = await envFor(brain.root, judgeWith(null));
    const theirs = remoteHead(brain);

    const run = await runSync(env);
    expect(run.status).toBe("needs-judgment");
    expect(run.leftovers.unresolved).toEqual([
      { path: "scripts/backup.sh", strategy: "code-merge", reason: expect.stringContaining("code-merge") },
    ]);
    expect(run.steps.push).toEqual([]);
    expect(env.postSyncCalls).toBe(0);
    expect(remoteHead(brain)).toBe(theirs);
    expect(gitMayFail(brain.root, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toBe(0);
    expect(git(brain.root, "diff", "--name-only", "--diff-filter=U")).toBe("scripts/backup.sh");
  });

  test("a push the remote rejects because it moved is re-pulled and pushed", async () => {
    const brain = brainWithRemote();
    pushRace(brain);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("complete");
    expect(run.steps.push.map((p) => p.status)).toEqual(["rejected", "pushed"]);
    expect(run.steps.pull).toHaveLength(2);
    expect(remoteHead(brain)).toBe(head(brain.root));
    expect(git(brain.root, "log", "--format=%s")).toContain("raced");
  });

  test(`a push rejected every time fails after ${MAX_PULLS} pulls`, async () => {
    const brain = brainWithRemote();
    write(brain.root, "notes/owl-count.md", "---\ntitle: Owl count\ntype: note\n---\n\nThree barred owls.\n");
    prePushHook(brain.root, "exit 1");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("failed");
    expect(run.steps.pull).toHaveLength(MAX_PULLS);
    expect(run.steps.push.map((p) => p.status)).toEqual(Array(MAX_PULLS).fill("rejected"));
    expect(env.postSyncCalls).toBe(0);
  });

  test("a merge of origin/main left uncommitted with nothing unmerged is concluded once, then pulled over", async () => {
    const brain = brainWithRemote();
    commitAndPush(otherClone(brain), { "notes/owl-count.md": "---\ntitle: Owl count\ntype: note\n---\n\nThree barred owls.\n" }, "side");
    write(brain.root, "notes/elk-sighting.md", "# Elk sighting\n\nA bull elk at the ford.\n");
    git(brain.root, "add", "-A");
    git(brain.root, "commit", "-qm", "local");
    git(brain.root, "fetch", "-q", "origin", "main");
    git(brain.root, "merge", "-q", "--no-ff", "--no-commit", "origin/main");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.conclude).toEqual([{ outcome: "committed", kind: "merge" }]);
    expect(run.status).toBe("complete");
    expect(git(brain.remote, "show", "main:notes/owl-count.md")).toContain("Three barred owls.");
    expect(git(brain.remote, "show", "main:notes/elk-sighting.md")).toContain("bull elk");
  });

  test("a merge sync did not start (a local branch origin/main lacks) is not finished: failed, nothing moves", async () => {
    const brain = brainWithRemote();
    git(brain.root, "switch", "-q", "-c", "side");
    write(brain.root, "notes/owl-count.md", "---\ntitle: Owl count\ntype: note\n---\n\nThree barred owls.\n");
    git(brain.root, "add", "-A");
    git(brain.root, "commit", "-qm", "side");
    git(brain.root, "switch", "-q", "main");
    git(brain.root, "merge", "-q", "--no-ff", "--no-commit", "side");
    const before = head(brain.root);
    const theirs = remoteHead(brain);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.conclude).toEqual([{ outcome: "blocked", kind: "merge", detail: expect.stringContaining("which is not in origin/main") }]);
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("could not finish the pending merge");
    expect(head(brain.root)).toBe(before);
    expect(remoteHead(brain)).toBe(theirs);
    expect(run.steps.push).toEqual([]);
  });

  test("a stash leftover resolved while the remote moved on is pulled again before the push, not pushed and rejected", async () => {
    const brain = brainWithRemote();
    SCENARIO_SETUPS.stashPopLeftover(brain);
    commitAndPush(otherClone(brain, "third"), { "notes/elk-sighting.md": "---\ntitle: Elk sighting\ntype: note\n---\n\nA bull elk at the ford.\n" }, "later");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("complete");
    // The first pull found the leftover and integrated nothing; the second rebased onto the remote.
    expect(run.steps.pull.map((p) => p.status)).toEqual(["conflicted", "rebased"]);
    expect(run.steps.push.map((p) => p.status)).toEqual(["pushed"]);
    expect(remoteHead(brain)).toBe(head(brain.root));
  });

  test("a note whose name only may be a secret's is held back for someone to decide; an unmistakable secret is ignored and named", async () => {
    const brain = brainWithRemote();
    const NOTE = "notes/design_token_ideas.md";
    write(brain.root, NOTE, "# Design token ideas\n\nColour names for the trail signs.\n");
    write(brain.root, ".env.local", "COUNTER_TOKEN=fixture\n");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    const fixed = (run.steps.assess[0] as AssessFixEnvelope).fixed;
    expect(fixed.ignored).toEqual([{ line: "/.env.local", reason: "sensitive", paths: [".env.local"] }]);
    expect(fixed.heldBack).toEqual([{ path: NOTE, reason: expect.stringContaining("*_token*") }]);
    // Not ignored, not committed, and handed on as unknown.
    expect(gitMayFail(brain.root, "check-ignore", "-q", NOTE)).toBe(1);
    expect(git(brain.root, "status", "--porcelain", "--", NOTE)).toBe(`?? ${NOTE}`);
    expect(run.leftovers.unknown).toEqual([NOTE]);
    expect(needsAgent(run, false)).toBe(true);
    expect(run.report).toContain(`unknown: ${NOTE} — its name matches *_token*, so it may be a secret: not ignored, not committed`);
    expect(run.report).toContain("Ignored:\n  .env.local (a secret; .gitignore: /.env.local)");
  });

  test("a keep-both conflict completes: the sync's own `-remote` copy is committed with the merge and both are pushed", async () => {
    const brain = brainWithRemote();
    commitAndPush(brain.root, { [OWL_NOTE]: OWL_TEXT }, "owl count");
    commitAndPush(otherClone(brain), { [OWL_NOTE]: OWL_TEXT.replace("Three", "Four") }, "theirs");
    write(brain.root, OWL_NOTE, OWL_TEXT.replace("Three", "Five"));
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.resolve[0]!.resolved).toEqual([expect.objectContaining({ path: OWL_NOTE, strategy: "keep-both", extraFiles: [OWL_REMOTE] })]);
    expect(run.steps.conclude.map((done) => done.outcome)).toEqual(["committed"]);
    expect(run.status).toBe("complete");
    expect(remoteHead(brain)).toBe(head(brain.root));
    expect(git(brain.remote, "show", `main:${OWL_NOTE}`)).toContain("Five barred owls.");
    expect(git(brain.remote, "show", `main:${OWL_REMOTE}`)).toContain("Four barred owls.");
  });

  test("a keep-both copy `resolve` staged is the sync's own for a later `conclude`, and nothing staged beside it is", async () => {
    const brain = brainWithRemote();
    commitAndPush(brain.root, { [OWL_NOTE]: OWL_TEXT }, "owl count");
    commitAndPush(otherClone(brain), { [OWL_NOTE]: OWL_TEXT.replace("Three", "Four") }, "theirs");
    write(brain.root, OWL_NOTE, OWL_TEXT.replace("Three", "Five"));
    git(brain.root, "commit", "-qam", "ours");
    git(brain.root, "fetch", "-q", "origin");
    expect(gitMayFail(brain.root, "merge", "--no-edit", "origin/main")).not.toBe(0);
    const env = await envFor(brain.root, judgeWith(null));

    const resolved = await resolveConflicts(env);
    expect(resolved.resolved.map((file) => file.extraFiles)).toEqual([[OWL_REMOTE]]);
    write(brain.root, "notes/private.md", "# Private\n");
    git(brain.root, "add", "notes/private.md");
    const blocked = conclude(brain.root);
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.detail).toContain("the index stages notes/private.md beside the merge");
    expect(blocked.detail).not.toContain(OWL_REMOTE);

    git(brain.root, "restore", "--staged", "notes/private.md");
    const done = conclude(brain.root);
    expect(done).toEqual({ outcome: "committed", kind: "merge" });
    expect(git(brain.root, "show", `HEAD:${OWL_REMOTE}`)).toContain("Four barred owls.");
  });

  test("off main nothing runs", async () => {
    const brain = brainWithRemote();
    git(brain.root, "switch", "-q", "-c", "draft");
    write(brain.root, "notes/owl-count.md", "# Owl count\n");
    const env = await envFor(brain.root, judgeWith(null));
    const run = await runSync(env);
    expect(run.status).toBe("failed");
    expect(run.reason).toBe("not on main branch (current: draft)");
    expect(run.steps.stash).toEqual([]);
    expect(run.steps.commit).toEqual([]);
  });
});

/** A `name` hook in `root` running `body`, beside any other test hook. */
function hook(root: string, name: string, body: string): void {
  const hooks = join(root, ".git", "test-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(hooks, name), 0o755);
  git(root, "config", "core.hooksPath", hooks);
}

const OWL_NOTE = "notes/owl-count.md";
const OWL_TEXT = "---\ntitle: Owl count\ntype: note\n---\n\nThree barred owls.\n";
const OWL_REMOTE = "notes/owl-count-remote.md";
const MARKED = "notes/ridge-plan.md";
const MARKED_TEXT = "# Ridge plan\n\n<<<<<<< HEAD\nGo at dawn.\n=======\nGo at dusk.\n>>>>>>> origin/main\n";

describe("runSync: what it refuses to commit or push", () => {
  test("a TRACK file holding conflict markers is left uncommitted; the rest is pushed; needs-judgment", async () => {
    const brain = brainWithRemote();
    write(brain.root, OWL_NOTE, OWL_TEXT);
    write(brain.root, MARKED, MARKED_TEXT);
    // A setext heading underline alone is no conflict.
    write(brain.root, "notes/heading.md", "Ridge log\n=======\n\nClear skies.\n");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(git(brain.root, "status", "--porcelain", "--", MARKED)).toBe(`?? ${MARKED}`);
    expect(run.steps.commit[0]!.conflicted).toEqual([MARKED]);
    expect(gitMayFail(brain.remote, "cat-file", "-e", `main:${MARKED}`)).not.toBe(0);
    expect(git(brain.remote, "show", `main:${OWL_NOTE}`)).toContain("Three barred owls.");
    expect(git(brain.remote, "show", "main:notes/heading.md")).toContain("=======");
    expect(run.status).toBe("needs-judgment");
    expect(run.leftovers.unresolved).toEqual([{ path: MARKED, strategy: "keep-both", reason: "holds conflict markers; left uncommitted" }]);
    expect(run.report).toContain(`unresolved: ${MARKED} — holds conflict markers; left uncommitted`);
  });

  test("HEAD carrying a committed file with conflict markers is not pushed", async () => {
    const brain = brainWithRemote();
    write(brain.root, MARKED, MARKED_TEXT);
    git(brain.root, "add", "-A");
    git(brain.root, "commit", "-qm", "a bad hand merge");
    const theirs = remoteHead(brain);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.push).toEqual([]);
    expect(remoteHead(brain)).toBe(theirs);
    expect(run.status).toBe("needs-judgment");
    expect(run.leftovers.unresolved).toEqual([
      { path: MARKED, strategy: "keep-both", reason: "committed with conflict markers; nothing is pushed until it is fixed" },
    ]);
    expect(env.postSyncCalls).toBe(0);
  });

  // `* conflict-marker-size=10` in .gitattributes makes git write these.
  const WIDE = "notes/wide-plan.md";
  const WIDE_TEXT = mergeFileMarkers("# Ridge plan\n\nGo.\n", "# Ridge plan\n\nGo at dawn.\n", "# Ridge plan\n\nGo at dusk.\n", 10);

  test("markers of another size (conflict-marker-size=10) are conflict markers too: left uncommitted", async () => {
    expect(WIDE_TEXT).toContain(`${"<".repeat(10)} HEAD\n`);
    const brain = brainWithRemote();
    write(brain.root, OWL_NOTE, OWL_TEXT);
    write(brain.root, WIDE, WIDE_TEXT);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.commit[0]!.conflicted).toEqual([WIDE]);
    expect(gitMayFail(brain.remote, "cat-file", "-e", `main:${WIDE}`)).not.toBe(0);
    expect(git(brain.remote, "show", `main:${OWL_NOTE}`)).toContain("Three barred owls.");
    expect(run.status).toBe("needs-judgment");
  });

  test("HEAD carrying a committed file with markers of another size is not pushed", async () => {
    const brain = brainWithRemote();
    write(brain.root, WIDE, WIDE_TEXT);
    git(brain.root, "add", "-A");
    git(brain.root, "commit", "-qm", "a bad hand merge");
    const theirs = remoteHead(brain);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.push).toEqual([]);
    expect(remoteHead(brain)).toBe(theirs);
    expect(run.leftovers.unresolved).toEqual([
      { path: WIDE, strategy: "keep-both", reason: "committed with conflict markers; nothing is pushed until it is fixed" },
    ]);
    expect(run.status).toBe("needs-judgment");
  });

  test("an index still holding an unmerged path is not pushed", async () => {
    const brain = brainWithRemote();
    commitAndPush(otherClone(brain), { "notes/elk-sighting.md": "# Elk sighting\n\nA bull elk at the ford.\n" }, "later");
    write(brain.root, OWL_NOTE, OWL_TEXT);
    // After pull merges, something leaves the index with an unmerged path.
    hook(
      brain.root,
      "post-merge",
      [
        'b=$(echo base | git hash-object -w --stdin); o=$(echo ours | git hash-object -w --stdin); t=$(echo theirs | git hash-object -w --stdin)',
        'printf "100644 $b 1\\tnotes/split.md\\n100644 $o 2\\tnotes/split.md\\n100644 $t 3\\tnotes/split.md\\n" | git update-index --index-info',
      ].join("\n")
    );
    const theirs = remoteHead(brain);
    const env = await envFor(brain.root, judgeWith(null));

    env.pullStrategy = "merge"; // This regression injects its unmerged path from post-merge.
    const run = await runSync(env);
    expect(run.steps.pull.map((p) => p.status)).toEqual(["merged"]);
    expect(run.steps.push).toEqual([]);
    expect(remoteHead(brain)).toBe(theirs);
    expect(run.status).toBe("needs-judgment");
    expect(run.leftovers.unresolved).toEqual([{ path: "notes/split.md", strategy: "keep-both", reason: "still unmerged in the index" }]);
  });
});

describe("runSync: a failed step fails the run", () => {
  test("a commit the pre-commit hook rejects: failed, nothing pushed", async () => {
    const brain = brainWithRemote();
    write(brain.root, OWL_NOTE, OWL_TEXT);
    hook(brain.root, "pre-commit", 'echo "owl counts are frozen" >&2; exit 1');
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("commit failed");
    expect(run.reason).toContain("owl counts are frozen");
    expect(run.steps.push).toEqual([]);
    expect(env.postSyncCalls).toBe(0);
  });

  test("a .gitignore commit the hook rejects: failed before anything else is committed", async () => {
    const brain = brainWithRemote();
    write(brain.root, "debug.log", "trail counter restarted\n");
    write(brain.root, OWL_NOTE, OWL_TEXT);
    hook(brain.root, "pre-commit", "exit 1");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("failed");
    expect(run.reason).toStartWith("the .gitignore commit failed");
    expect(run.steps.commit).toEqual([]);
  });

  const post = (result: Partial<PostSyncResult>) => ({ ...POST_SYNC_STUB, ...result });
  const cases: [string, PostSyncResult, string][] = [
    ["the reindex failed", post({ index: "FAILED — disk full" }), "index FAILED — disk full"],
    ["the cache commit failed", post({ cacheCommit: "FAILED to commit — hook said no", sync: "dirty" }), "caches FAILED to commit"],
    ["the skill sync failed", post({ skills: "FAILED — bad module" }), "skills FAILED — bad module"],
    ["heads diverged", post({ sync: "diverged", localHead: "aaaaaaa", remoteHead: "bbbbbbb" }), "local aaaaaaa and remote bbbbbbb diverged"],
    ["dirt nothing lists", post({ sync: "dirty", treeDirty: ["notes/stray.md"] }), "left uncommitted: notes/stray.md"],
  ];
  for (const [name, result, reason] of cases) {
    test(`post-sync: ${name} → failed`, async () => {
      const brain = brainWithRemote();
      const env = await envFor(brain.root, judgeWith(null));
      env.postSync = async () => result;

      const run = await runSync(env);
      expect(run.status).toBe("failed");
      expect(run.reason).toContain(reason);
    });
  }

  test("post-sync dirt that is a listed leftover does not fail the run", async () => {
    const brain = brainWithRemote();
    write(brain.root, "misc/blob.dat", "unclear\n");
    const env = await envFor(brain.root, judgeWith(null));
    env.postSync = async () => post({ sync: "dirty", treeDirty: ["misc/blob.dat"] });

    const run = await runSync(env);
    expect(run.leftovers.unknown).toEqual(["misc/blob.dat"]);
    expect(run.status).toBe("complete");
  });

  test("a strategy that throws leaves its file unresolved; the run does not throw", async () => {
    const brain = brainWithRemote();
    sameNote(brain);
    const env = await envFor(brain.root, judgeWith(null));
    // Only strategyFor asks this; assess and commit do not.
    env.taxonomy = new Proxy(env.taxonomy, {
      get(target, key, receiver) {
        if (key === "isValidType") return () => { throw new Error("taxonomy exploded"); };
        return Reflect.get(target, key, receiver);
      },
    });

    const run = await runSync(env);
    expect(run.status).toBe("needs-judgment");
    expect(run.leftovers.unresolved).toEqual([{ path: FIELD_NOTE, strategy: "code-merge", reason: expect.stringContaining("taxonomy exploded") }]);
    expect(run.steps.push).toEqual([]);
  });

  test("a step that throws ends the run failed, naming the step", async () => {
    const brain = brainWithRemote();
    const env = await envFor(brain.root, judgeWith(null));
    env.postSync = async () => {
      throw new Error("indexer crashed");
    };

    const run = await runSync(env);
    expect(run.status).toBe("failed");
    expect(run.reason).toBe("postSync threw: indexer crashed");
  });

  test("what an autostash pop puts back before the push is committed and pushed, not left behind", async () => {
    const brain = brainWithRemote();
    const LOG = "notes/trail-log.md";
    const lines = Array.from({ length: 12 }, (_, i) => `Day ${i + 1}: quiet.`);
    commitAndPush(brain.root, { [LOG]: lines.join("\n") + "\n" }, "trail log");
    // The autostash changes the first day; the local edit the last.
    write(brain.root, LOG, ["Day 1: an owl.", ...lines.slice(1)].join("\n") + "\n");
    git(brain.root, "stash", "store", "-m", "autostash", git(brain.root, "stash", "create"));
    git(brain.root, "checkout", "--", LOG);
    write(brain.root, LOG, [...lines.slice(0, 11), "Day 12: an elk."].join("\n") + "\n");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.stash[0]!.kept).toHaveLength(1);
    expect(run.steps.stash[1]!.popped).toHaveLength(1);
    const pushed = git(brain.remote, "show", `main:${LOG}`);
    expect(pushed).toContain("Day 1: an owl.");
    expect(pushed).toContain("Day 12: an elk.");
    expect(git(brain.root, "status", "--porcelain", "--", LOG)).toBe("");
    expect(run.status).toBe("complete");
  });

  test("a stash drop git refuses (refs/stash locked) fails the run instead of counting as kept", async () => {
    const brain = brainWithRemote();
    const edited = readFileSync(join(brain.root, FIELD_NOTE), "utf-8").replace("Boots resoled in March.", "Boots resoled in April.");
    write(brain.root, FIELD_NOTE, edited);
    git(brain.root, "stash", "-q");
    // The tree holds the entry's change again, so the entry is dropped.
    write(brain.root, FIELD_NOTE, edited);
    writeFileSync(git(brain.root, "rev-parse", "--path-format=absolute", "--git-path", "refs/stash.lock"), "");
    const theirs = remoteHead(brain);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.stash[0]!.kept).toEqual([]);
    expect(run.steps.stash[0]!.failed.map((entry) => entry.ref)).toEqual(["stash@{0}"]);
    expect(run.status).toBe("failed");
    expect(run.reason).toStartWith("stash: stash@{0}");
    expect(run.reason).toContain("drop failed");
    expect(run.steps.commit).toEqual([]);
    expect(remoteHead(brain)).toBe(theirs);
  });

  test("an autostash pop git refuses before the push fails the run, and nothing is pushed", async () => {
    const brain = brainWithRemote();
    const LOG = "notes/trail-log.md";
    const lines = Array.from({ length: 12 }, (_, i) => `Day ${i + 1}: quiet.`);
    commitAndPush(brain.root, { [LOG]: lines.join("\n") + "\n" }, "trail log");
    write(brain.root, LOG, ["Day 1: an owl.", ...lines.slice(1)].join("\n") + "\n");
    git(brain.root, "stash", "store", "-m", "autostash", git(brain.root, "stash", "create"));
    git(brain.root, "checkout", "--", LOG);
    // A local edit keeps the first reconcile from touching the entry.
    write(brain.root, LOG, [...lines.slice(0, 11), "Day 12: an elk."].join("\n") + "\n");
    writeFileSync(git(brain.root, "rev-parse", "--path-format=absolute", "--git-path", "refs/stash.lock"), "");
    const theirs = remoteHead(brain);
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.stash[0]!.failed).toEqual([]);
    expect(run.steps.stash[1]!.failed.map((entry) => entry.reason.split(":")[0])).toEqual(["pop failed"]);
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("pop failed");
    expect(run.steps.push).toEqual([]);
    expect(remoteHead(brain)).toBe(theirs);
  });

  // A real `git check-ignore` failure: once assess has listed misc/blob.dat,
  // its directory becomes a symlink, and git refuses a path beyond one.
  test("an ignore check git cannot run fails the run instead of counting as a refusal", async () => {
    const brain = brainWithRemote();
    write(brain.root, "debug.log", "trail counter restarted\n");
    write(brain.root, "misc/blob.dat", "unclear\n");
    let swapped = false;
    const jev = fakeJev(() => {
      if (!swapped) {
        swapped = true;
        renameSync(join(brain.root, "misc"), join(brain.root, "elsewhere"));
        symlinkSync("elsewhere", join(brain.root, "misc"));
      }
      return { choice: "artifact", confidence: 0.4 };
    });
    const env = await envFor(brain.root, judgeWith(jev));

    const run = await runSync(env);
    expect(swapped).toBe(true);
    const fixed = (run.steps.assess[0] as AssessFixEnvelope).fixed;
    expect(fixed.refused).toBeUndefined();
    expect(fixed.failed).toContain("git check-ignore failed");
    expect(fixed.failed).toContain("beyond a symbolic link");
    expect(run.status).toBe("failed");
    expect(run.reason).toStartWith("the .gitignore lines could not be checked: git check-ignore failed");
    expect(readFileSync(join(brain.root, ".gitignore"), "utf-8")).not.toContain("debug.log");
  });

  test(`a push rejected every time names the rejection`, async () => {
    const brain = brainWithRemote();
    write(brain.root, OWL_NOTE, OWL_TEXT);
    prePushHook(brain.root, 'echo "pushes are closed today" >&2; exit 1');
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("pushes are closed today");
  });
});

describe("needsAgent", () => {
  const run = (status: RunEnvelope["status"], leftovers: Partial<RunEnvelope["leftovers"]> = {}) =>
    ({ status, leftovers: { unresolved: [], unknown: [], media: [], ...leftovers } }) as RunEnvelope;

  test("a blocked push or an unknown file goes to the agent; media only at a terminal", () => {
    expect(needsAgent(run("complete"), true)).toBe(false);
    expect(needsAgent(run("failed"), true)).toBe(false);
    expect(needsAgent(run("needs-judgment"), false)).toBe(true);
    expect(needsAgent(run("complete", { unknown: ["misc/blob.dat"] }), false)).toBe(true);
    expect(needsAgent(run("complete", { media: [{ path: "photos/owl.jpg", bytes: 2048 }] }), false)).toBe(false);
    expect(needsAgent(run("complete", { media: [{ path: "photos/owl.jpg", bytes: 2048 }] }), true)).toBe(true);
  });
});

describe("bare `brain sync`", () => {
  // In-process, so a key in the developer's environment would reach Jev.
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  });
  afterAll(() => {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  });

  type Runner = "none" | "plain" | ((opts: { onRuntime?: (r: { name: string; version?: string }) => void }) => Promise<string>);

  async function bare(
    root: string,
    agent: Runner,
    json = false
  ): Promise<{ code: number | void; prompts: string[]; lines: string[]; errors: string[] }> {
    const prompts: string[] = [];
    const agentRunner: AgentRunner = {
      id: "stub",
      capabilities: { streaming: false, skills: true },
      async run(prompt, opts) {
        prompts.push(prompt);
        return typeof agent === "function" ? agent(opts) : "agent finished the merge";
      },
    };
    const cli = { brain: await initContext({ root }), json, ...(agent !== "none" ? { agentRunner } : {}) };
    const lines: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (line: string) => lines.push(String(line));
    console.error = (line: string) => errors.push(String(line));
    try {
      const code = await syncCommand.run([], cli as never);
      return { code, prompts, lines, errors };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  test("a conflict it cannot resolve: the report, then the agent", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { prompts, lines } = await bare(brain.root, "plain");
    expect(prompts).toEqual(["/sync"]);
    expect(lines[0]).toStartWith("brain sync: needs-judgment");
    expect(lines[1]).toBe("agent finished the merge");
  });

  test("the same conflict without an agent runner exits 3, the report as text", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { code, lines } = await bare(brain.root, "none");
    expect(code).toBe(3);
    expect(lines[0]).toStartWith("brain sync: needs-judgment");
    expect(() => JSON.parse(lines.join("\n"))).toThrow();
  });

  test("a sync the rules finish never calls the agent", async () => {
    const brain = brainWithRemote();
    sameNote(brain);
    const { code, prompts, lines } = await bare(brain.root, "plain");
    expect(code).toBe(0);
    expect(prompts).toEqual([]);
    expect(lines[0]!.split("\n")[0]).toBe("brain sync: complete");
    expect(readFileSync(join(brain.root, FIELD_NOTE), "utf-8")).toContain(THEIRS_RIDGE);
  });
});

describe("bare `brain sync --json`: one result for the whole workflow (#290)", () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  });
  afterAll(() => {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  });

  async function bareJson(root: string, runner: AgentRunner | undefined) {
    const cli = { brain: await initContext({ root }), json: true, ...(runner ? { agentRunner: runner } : {}) };
    const lines: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (line: string) => lines.push(String(line));
    console.error = (line: string) => errors.push(String(line));
    try {
      const code = await syncCommand.run(["--json"], cli as never);
      // Everything on stdout is the one document.
      return { code, body: JSON.parse(lines.join("\n")) as SyncResult, errors };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  function stub(run: AgentRunner["run"]): AgentRunner & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      id: "stub",
      capabilities: { streaming: false, skills: true },
      prompts,
      run(prompt, opts) {
        prompts.push(prompt);
        return run(prompt, opts);
      },
    };
  }

  test("nothing for an agent: the run, and no agent invoked", async () => {
    const brain = brainWithRemote();
    sameNote(brain);
    const runner = stub(async () => "unused");
    const { code, body } = await bareJson(brain.root, runner);
    expect(code).toBe(0);
    expect(runner.prompts).toEqual([]);
    expect(body.run.status).toBe("complete");
    expect(body.run.report).toStartWith("brain sync: complete");
    expect(body.agent).toEqual({ invoked: false, reason: "not-needed" });
  });

  test("a conflict and no runner: exit 3, no agent, and says why", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { code, body } = await bareJson(brain.root, undefined);
    expect(code).toBe(3);
    expect(body.run.status).toBe("needs-judgment");
    expect(body.agent).toEqual({ invoked: false, reason: "no-runner" });
  });

  test("an agent that reports its version: the version, unchanged, and its text in the result only", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const runner = stub(async (_prompt, opts) => {
      opts.onRuntime?.({ name: "claude-code", version: "9.8.7-fake" });
      return "agent finished the merge";
    });
    const { code, body } = await bareJson(brain.root, runner);
    // No code is main's 0, as the human path has always returned after the agent.
    expect(code ?? 0).toBe(0);
    expect(runner.prompts).toEqual(["/sync"]);
    expect(body.run.status).toBe("needs-judgment");
    expect(body.agent).toEqual({
      invoked: true,
      runner: "stub",
      outcome: "success",
      runtime: { name: "claude-code", version: "9.8.7-fake" },
      text: "agent finished the merge",
    });
  });

  test("an agent that reports nothing: invoked, runtime unknown, nothing borrowed", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { body } = await bareJson(brain.root, stub(async () => "merged"));
    expect(body.agent).toMatchObject({ invoked: true, outcome: "success", runtime: null, text: "merged" });
  });

  test("an agent that names itself without a version: version null", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { body } = await bareJson(
      brain.root,
      stub(async (_prompt, opts) => {
        opts.onRuntime?.({ name: "claude-code" });
        return "merged";
      })
    );
    expect(body.agent).toMatchObject({ invoked: true, runtime: { name: "claude-code", version: null } });
  });

  test("an agent that fails after reporting: exit 2, the error on stderr, and the runtime kept", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { code, body, errors } = await bareJson(
      brain.root,
      stub(async (_prompt, opts) => {
        opts.onRuntime?.({ name: "claude-code", version: "9.8.7-fake" });
        throw new Error("claude CLI failed (exit 1): boom");
      })
    );
    expect(code).toBe(2);
    expect(errors).toEqual(["claude CLI failed (exit 1): boom"]);
    expect(body.run.status).toBe("needs-judgment");
    expect(body.agent).toEqual({
      invoked: true,
      runner: "stub",
      outcome: "failed",
      runtime: { name: "claude-code", version: "9.8.7-fake" },
      text: null,
      error: "claude CLI failed (exit 1): boom",
    });
  });

  test("a failed agent in human mode still throws, as it always did", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const cli = {
      brain: await initContext({ root: brain.root }),
      json: false,
      agentRunner: stub(async () => {
        throw new Error("boom");
      }),
    };
    const log = console.log;
    console.log = () => {};
    try {
      await expect(syncCommand.run([], cli as never)).rejects.toThrow("boom");
    } finally {
      console.log = log;
    }
  });
});
