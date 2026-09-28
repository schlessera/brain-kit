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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { needsAgent, syncCommand } from "../src/cli/commands/sync";
import { initContext } from "../src/lib/context";
import type { AgentRunner } from "../src/lib/seams";
import { MAX_PULLS, runSync, type RunEnvelope } from "../src/lib/sync/run";
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
  otherClone,
  OURS_RIDGE,
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
    expect(run.steps.commit).toEqual([{ commits: [], bumped: [], refused: [] }]);
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

  test("a merge left uncommitted with nothing unmerged is concluded once, then pulled over", async () => {
    const brain = brainWithRemote();
    git(brain.root, "switch", "-q", "-c", "side");
    write(brain.root, "notes/owl-count.md", "---\ntitle: Owl count\ntype: note\n---\n\nThree barred owls.\n");
    git(brain.root, "add", "-A");
    git(brain.root, "commit", "-qm", "side");
    git(brain.root, "switch", "-q", "main");
    git(brain.root, "merge", "-q", "--no-ff", "--no-commit", "side");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.conclude).toEqual([{ outcome: "committed", kind: "merge" }]);
    expect(run.status).toBe("complete");
    expect(git(brain.remote, "show", "main:notes/owl-count.md")).toContain("Three barred owls.");
  });

  test("a stash leftover resolved while the remote moved on is pulled again before the push, not pushed and rejected", async () => {
    const brain = brainWithRemote();
    SCENARIO_SETUPS.stashPopLeftover(brain);
    commitAndPush(otherClone(brain, "third"), { "notes/elk-sighting.md": "---\ntitle: Elk sighting\ntype: note\n---\n\nA bull elk at the ford.\n" }, "later");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.status).toBe("complete");
    // The first pull found the leftover and merged nothing; the second merged the remote.
    expect(run.steps.pull.map((p) => p.status)).toEqual(["conflicted", "merged"]);
    expect(run.steps.push.map((p) => p.status)).toEqual(["pushed"]);
    expect(remoteHead(brain)).toBe(head(brain.root));
  });

  test("a note ignored because its name looks like a secret is named in the report, not dropped silently", async () => {
    const brain = brainWithRemote();
    write(brain.root, "notes/design_token_ideas.md", "# Design token ideas\n\nColour names for the trail signs.\n");
    const env = await envFor(brain.root, judgeWith(null));

    const run = await runSync(env);
    expect(run.steps.assess[0]).toMatchObject({ fixed: { ignored: [{ reason: "sensitive", paths: ["notes/design_token_ideas.md"] }] } });
    expect(run.report).toContain("notes/design_token_ideas.md (looks like a secret; .gitignore: /notes/design_token_ideas.md)");
    expect(run.report).toContain("ignored as a secret, check it is one: notes/design_token_ideas.md");
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

  async function bare(root: string, agent: boolean): Promise<{ code: number | void; prompts: string[]; lines: string[] }> {
    const prompts: string[] = [];
    const agentRunner: AgentRunner = {
      id: "stub",
      capabilities: { streaming: false, skills: true },
      async run(prompt) {
        prompts.push(prompt);
        return "agent finished the merge";
      },
    };
    const cli = { brain: await initContext({ root }), json: true, ...(agent ? { agentRunner } : {}) };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(String(line));
    try {
      const code = await syncCommand.run([], cli as never);
      return { code, prompts, lines };
    } finally {
      console.log = log;
    }
  }

  test("a conflict it cannot resolve: the report, then the agent", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { prompts, lines } = await bare(brain.root, true);
    expect(prompts).toEqual(["/sync"]);
    expect(lines[0]).toStartWith("brain sync: needs-judgment");
    expect(lines[1]).toBe("agent finished the merge");
  });

  test("the same conflict without an agent runner exits 3, the report as text", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const { code, lines } = await bare(brain.root, false);
    expect(code).toBe(3);
    expect(lines[0]).toStartWith("brain sync: needs-judgment");
    expect(() => JSON.parse(lines.join("\n"))).toThrow();
  });

  test("a sync the rules finish never calls the agent", async () => {
    const brain = brainWithRemote();
    sameNote(brain);
    const { code, prompts, lines } = await bare(brain.root, true);
    expect(code).toBe(0);
    expect(prompts).toEqual([]);
    expect(lines[0]!.split("\n")[0]).toBe("brain sync: complete");
    expect(readFileSync(join(brain.root, FIELD_NOTE), "utf-8")).toContain(THEIRS_RIDGE);
  });
});
