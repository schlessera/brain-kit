/**
 * E3: `brain sync run --json` end to end, through the real CLI (keyless, so
 * the judge is off and every unjudged pair keeps both), against a real
 * remote. One row per state a sync can start from; each says what `run`
 * must make of it. The setups live in `sync-fixture.ts`, where
 * `scripts/measure-sync-run.ts` times the same states.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  brainWithRemote,
  CACHE,
  cleanupFixtures,
  FIELD_NOTE,
  git,
  gitMayFail,
  OURS_RIDGE,
  SCENARIO_SETUPS,
  syncJson,
  THEIRS_RIDGE,
  type Brain,
} from "./sync-fixture";

afterEach(cleanupFixtures);

interface Row {
  name: string;
  setup: (brain: Brain) => void;
  code: number;
  status: "complete" | "needs-judgment" | "failed";
  /** What else must hold; `before` is the remote's main before the run. */
  check: (brain: Brain, body: any, before: string) => void;
}

const remoteHead = (brain: Brain) => git(brain.remote, "rev-parse", "main");
const head = (brain: Brain) => git(brain.root, "rev-parse", "HEAD");
const originInHead = (brain: Brain) => gitMayFail(brain.root, "merge-base", "--is-ancestor", "origin/main", "HEAD") === 0;
const pushedFile = (brain: Brain, file: string) => git(brain.remote, "show", `main:${file}`);

/** Pushed: the remote is exactly this clone's HEAD, and post-sync found heads at parity. */
function inSync(brain: Brain, body: any): void {
  expect(remoteHead(brain)).toBe(head(brain));
  expect(body.steps.postSync).toHaveLength(1);
  expect(body.steps.postSync[0].sync).toBe("complete");
}

const ROWS: Row[] = [
  {
    name: "(a) nothing to do",
    setup: SCENARIO_SETUPS.nothing,
    code: 0,
    status: "complete",
    check(brain, body, before) {
      expect(body.steps.commit[0].commits).toEqual([]);
      expect(body.steps.push).toEqual([{ status: "up-to-date", detail: "HEAD is origin/main" }]);
      expect(remoteHead(brain)).toBe(before);
      inSync(brain, body);
    },
  },
  {
    name: "(b) local edits only: committed by domain and pushed",
    setup: SCENARIO_SETUPS.localOnly,
    code: 0,
    status: "complete",
    check(brain, body) {
      const subjects = body.steps.commit[0].commits.map((c: { subject: string }) => c.subject);
      // Two single-file domains gathered into one commit.
      expect(subjects).toEqual(["Update health, note: Trail fitness, Owl count"]);
      expect(body.steps.pull[0].status).toBe("synced");
      expect(body.steps.push[0].status).toBe("pushed");
      expect(pushedFile(brain, "notes/owl-count.md")).toContain("Three barred owls");
      inSync(brain, body);
    },
  },
  {
    name: "(c) two clones, different files: rebased and pushed",
    setup: SCENARIO_SETUPS.differentFiles,
    code: 0,
    status: "complete",
    check(brain, body) {
      expect(body.steps.pull[0].status).toBe("rebased");
      expect(body.steps.resolve).toEqual([]);
      expect(pushedFile(brain, "notes/elk-sighting.md")).toContain("bull elk");
      expect(pushedFile(brain, "notes/owl-count.md")).toContain("Three barred owls");
      inSync(brain, body);
    },
  },
  {
    name: "(d) two clones, the same note: resolved by its strategy and pushed, no agent",
    setup: SCENARIO_SETUPS.sameNote,
    code: 0,
    status: "complete",
    check(brain, body) {
      expect(body.steps.pull[0].status).toBe("conflicted");
      expect(body.steps.resolve[0].resolved).toEqual([
        expect.objectContaining({ path: FIELD_NOTE, strategy: "synthesize", decisions: { jev: 0, default: 1 } }),
      ]);
      expect(body.steps.conclude).toEqual([{ outcome: "committed", kind: "merge" }]);
      expect(body.report).toContain(`Resolved:\n  ${FIELD_NOTE} — synthesize`);
      const merged = pushedFile(brain, FIELD_NOTE);
      expect(merged).toContain(OURS_RIDGE);
      expect(merged).toContain(THEIRS_RIDGE);
      inSync(brain, body);
    },
  },
  {
    name: "(e) a code conflict: needs-judgment, nothing pushed, the merge left in progress",
    setup: SCENARIO_SETUPS.codeConflict,
    code: 3,
    status: "needs-judgment",
    check(brain, body, before) {
      expect(body.leftovers.unresolved).toEqual([
        { path: "scripts/backup.sh", strategy: "code-merge", reason: expect.stringContaining("code-merge") },
      ]);
      expect(body.steps.push).toEqual([]);
      expect(body.steps.postSync).toEqual([]);
      expect(body.report).toContain("unresolved: scripts/backup.sh — code-merge");
      expect(remoteHead(brain)).toBe(before);
      expect(gitMayFail(brain.root, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toBe(0);
      expect(git(brain.root, "diff", "--name-only", "--diff-filter=U")).toBe("scripts/backup.sh");
    },
  },
  {
    name: "(f) a push race: re-pulled and pushed",
    setup: SCENARIO_SETUPS.pushRace,
    code: 0,
    status: "complete",
    check(brain, body) {
      expect(body.steps.push.map((p: { status: string }) => p.status)).toEqual(["rejected", "pushed"]);
      expect(body.steps.pull).toHaveLength(2);
      expect(git(brain.remote, "log", "--format=%s", "main")).toContain("raced");
      inSync(brain, body);
    },
  },
  {
    name: "(g) #328 S1: a pending cache-only merge and a newer remote commit",
    setup: SCENARIO_SETUPS.pendingCacheMerge,
    code: 0,
    status: "complete",
    check(brain, body) {
      expect(body.steps.assess[0].skipped).toContain("merge state is pending (merge)");
      expect(body.steps.pull[0].concluded).toBe("merge");
      expect(body.steps.pull[0].status).toBe("merged");
      expect(originInHead(brain)).toBe(true);
      expect(body.steps.pull[0].mergedCaches).toEqual([CACHE]);
      // The concluded merge holds both clones' entries (post-sync's reindex
      // prunes these made-up keys from the file afterwards).
      const merges = git(brain.root, "log", "--merges", "--format=%H").split("\n");
      const concluded = merges.map((sha) => git(brain.root, "show", `${sha}:${CACHE}`));
      expect(concluded.some((cache) => cache.includes('"k":"ours"') && cache.includes('"k":"theirs"'))).toBe(true);
      expect(pushedFile(brain, "notes/elk-sighting.md")).toContain("bull elk");
      inSync(brain, body);
    },
  },
  {
    name: "(h) a stash-pop leftover: resolved, committed as local work, the entry kept and named",
    setup: SCENARIO_SETUPS.stashPopLeftover,
    code: 0,
    status: "complete",
    check(brain, body) {
      expect(body.steps.assess[0].skipped).toContain("merge state is pending (stash)");
      expect(body.steps.resolve[0].resolved[0]).toMatchObject({ path: FIELD_NOTE, strategy: "synthesize" });
      expect(body.steps.conclude).toEqual([{ outcome: "unstaged", kind: "stash" }]);
      const committed = body.steps.commit.flatMap((c: { commits: { subject: string }[] }) => c.commits);
      expect(committed).toHaveLength(1);
      const merged = pushedFile(brain, FIELD_NOTE);
      expect(merged).toContain(OURS_RIDGE);
      expect(merged).toContain(THEIRS_RIDGE);
      // The merge put a new neighbour beside the stash's line, so its change is
      // not provably held: when uncertain, keep.
      expect(git(brain.root, "stash", "list").split("\n")).toHaveLength(1);
      expect(body.report).toContain("stash kept: stash@{0} — not an autostash");
      inSync(brain, body);
    },
  },
];

describe("brain sync run: E3 scenarios", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const brain = brainWithRemote();
      row.setup(brain);
      const before = remoteHead(brain);
      const { code, body, stderr } = await syncJson(brain.root, "run");
      if (body?.status !== row.status) console.error(stderr, typeof body === "string" ? body : body?.report);
      expect(body.status).toBe(row.status);
      expect(code).toBe(row.code);
      expect(typeof body.report).toBe("string");
      row.check(brain, body, before);
    });
  }
});
