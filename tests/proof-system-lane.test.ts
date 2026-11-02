import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkQualification, decideLane, laneRefusal, MAX_MAIN_RUNS, lastProofSystemSquash, qualificationRunIds, qualificationSection, readLane,
  type MainRun, type QualificationRun } from "../scripts/proof-system-lane";

// Odysseus's fleet history on main: a product squash, a proof-system squash,
// then two product squashes. A side branch carries a candidate whose first
// commit changes the proof system and whose second does not.
let dir = "";
const sha: Record<string, string> = {};
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env,
    GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid",
    GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z" } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}
function commit(name: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); }
  git("add", "."); git("commit", "-q", "-m", name); sha[name] = git("rev-parse", "HEAD");
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "odysseus-lane-"));
  git("init", "-q", "-b", "main");
  commit("ithaca", { "README.md": "Ithaca.\n" });
  commit("raft", { "raft.md": "The raft.\n" });
  commit("sails", { ".github/workflows/ci.yml": "name: ci\n" });
  commit("oars", { "oars.md": "Oars.\n" });
  commit("mast", { "mast.md": "Mast.\n" });
  git("checkout", "-q", "-b", "candidate");
  commit("shards", { "scripts/ci-shards.ts": "export const shards = 3;\n" });
  commit("chart", { "chart.md": "The chart.\n" });
  git("checkout", "-q", "main");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));


describe("stability window (#3269, as clarified in issuecomment-6575963951)", () => {
  test("finds the last proof-system squash and the squashes after it", () => {
    expect(lastProofSystemSquash(sha.mast!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [sha.oars!, sha.mast!], more: false, scanned: 3 });
    expect(lastProofSystemSquash(sha.oars!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [sha.oars!], more: false, scanned: 2 });
    expect(lastProofSystemSquash(sha.raft!, { cwd: dir })).toEqual({ squash: null, later: [], more: false, scanned: 2 });
  });

  // Synthetic merge order: p is the proof-system squash, a..k the squashes after it.
  const later = "abcdefghijk".split("");
  const history = (count: number, more = false) => ({ squash: "p", later: later.slice(0, count), more, scanned: count + 1 });
  const ok = (id: number): MainRun => ({ id, status: "completed", conclusion: "success" });
  const bad = (id: number, conclusion = "failure"): MainRun => ({ id, status: "completed", conclusion });
  const busy = (id: number): MainRun => ({ id, status: "in_progress", conclusion: null });
  const decide = (own: MainRun | null, rest: (MainRun | null)[], more = false) =>
    decideLane("main", history(rest.length, more), new Map([["p", own], ...rest.map((run, index): [string, MainRun | null] => [later[index]!, run])]));

  test("the own run must be green", () => {
    for (const own of [bad(1), bad(1, "cancelled"), busy(1), null]) {
      const decision = decide(own, [ok(2), ok(3)]);
      expect(decision, `OWN_RUN_NOT_GREEN:${JSON.stringify(own)}`).toMatchObject({ state: "closed", open: false, ownGreen: false, required: 3 });
      expect(laneRefusal(decision)).toContain("needs its own main run green first");
    }
  });

  test("own green and one later green run: 1 more green main run required", () => {
    for (const tail of [[], [null], [busy(3)], [{ id: 3, status: "queued", conclusion: null }]]) {
      const decision = decide(ok(1), [ok(2), ...tail]);
      expect(decision, `ONE_MORE:${JSON.stringify(tail)}`).toMatchObject({ state: "closed", ownGreen: true, streak: 1, required: 1 });
      expect(laneRefusal(decision)).toContain("1 more green main run required");
    }
  });

  test("own green and the next two green open the lane", () => {
    const decision = decide(ok(1), [ok(2), ok(3)]);
    expect(decision).toMatchObject({ state: "open", open: true, streak: 2, required: 0 });
    expect(laneRefusal(decision)).toBeNull();
  });

  test("a later failure restarts the count: one green after it is not enough, two consecutive are", () => {
    const one = decide(ok(1), [bad(2), ok(3)]);
    expect(one, "FAILURE_RESTARTS_THE_COUNT").toMatchObject({ state: "closed", streak: 1, required: 1 });
    expect(laneRefusal(one)).toContain("1 more green main run required");
    expect(laneRefusal(one)).toContain("next run 1 at a: run 2 failure");
    expect(decide(ok(1), [ok(2), bad(3), ok(4)]), "GREEN_BEFORE_THE_FAILURE_DOES_NOT_COUNT").toMatchObject({ state: "closed", streak: 1, required: 1 });
    expect(decide(ok(1), [bad(2), ok(3), ok(4)])).toMatchObject({ state: "open", required: 0 });
    expect(decide(ok(1), [ok(2), bad(3), ok(4), ok(5)])).toMatchObject({ state: "open", required: 0 });
  });

  test("cancelled and missing runs are not green; pending runs stop the count", () => {
    expect(decide(ok(1), [ok(2), bad(3, "cancelled")]), "CANCELLED_IS_NOT_GREEN").toMatchObject({ state: "closed", streak: 0, required: 2 });
    expect(laneRefusal(decide(ok(1), [ok(2), bad(3, "cancelled")]))).toContain("2 more green main runs required");
    // A squash with no run before a later squash never gets one: it restarts the count.
    expect(decide(ok(1), [ok(2), null, ok(4)])).toMatchObject({ state: "closed", streak: 1, required: 1 });
    expect(decide(ok(1), [null, ok(3), ok(4)])).toMatchObject({ state: "open" });
    // An in-progress run may still fail: nothing after it counts yet.
    expect(decide(ok(1), [busy(2), ok(3), ok(4)])).toMatchObject({ state: "closed", streak: 0, required: 2 });
    expect(decide(ok(1), [])).toMatchObject({ state: "closed", required: 2 });
  });

  test("beyond the bound the lane is unknown and refused", () => {
    const flapping = Array.from({ length: MAX_MAIN_RUNS - 1 }, (_, index) => index % 2 ? bad(index + 2) : ok(index + 2));
    const unknown = decide(ok(1), flapping, true);
    expect(unknown).toMatchObject({ state: "unknown", open: false, required: null });
    expect(laneRefusal(unknown)).toContain("Proof-system lane unknown");
    expect(decide(ok(1), flapping, false)).toMatchObject({ state: "closed", required: 1 });
  });

  test("readLane reads runs in merge order, stops once decided and agrees with the refusal", async () => {
    const asked: string[] = [];
    const decision = await readLane(sha.mast!, async at => { asked.push(at); return at === sha.oars ? { id: 2, status: "completed", conclusion: "failure" } : ok(1); }, { cwd: dir });
    expect(asked).toEqual([sha.sails!, sha.oars!, sha.mast!]);
    expect(decision).toMatchObject({ state: "closed", streak: 1, required: 1, next: null });
    expect(laneRefusal(decision)).toContain("run 2 failure");
    const own: string[] = [];
    await readLane(sha.mast!, async at => { own.push(at); return bad(1); }, { cwd: dir });
    expect(own, "NO_LATER_READS_AFTER_A_RED_OWN_RUN").toEqual([sha.sails!]);
    const product = await readLane(sha.raft!, async () => { throw new Error("NO_RUN_READ_WITHOUT_A_PROOF_SYSTEM_SQUASH"); }, { cwd: dir });
    expect(product).toMatchObject({ open: true, proofSystemSquash: null });
  });

  test("readLane never reads more than the bound", async () => {
    // Twelve product squashes after mast whose runs alternate red and green.
    let tip = sha.mast!;
    for (let index = 0; index < 12; index++) tip = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", `wave ${index}`);
    const asked: string[] = [];
    const decision = await readLane(tip, async at => { asked.push(at); return asked.length % 2 ? ok(asked.length) : bad(asked.length); }, { cwd: dir });
    expect(asked, "BOUNDED_MAIN_RUN_READS").toHaveLength(MAX_MAIN_RUNS);
    expect(asked[0]).toBe(sha.sails!);
    expect(decision).toMatchObject({ state: "unknown", open: false, required: null });
  });
});

describe("off-main qualification (#3271)", () => {
  const repository = "odysseus/brain-kit";
  const url = (id: number, repo = repository) => `https://github.com/${repo}/actions/runs/${id}`;
  const body = (section: string) => `Odysseus re-rigs the shards.\n\n## Off-main qualification\n\n${section}\n\n## Anything left open\n\n${url(999)}\n`;
  const check = (text: string | null, runsById: Record<number, string>) => checkQualification({ body: text, repository, head: sha.chart!, cwd: dir,
    async readRun(id): Promise<QualificationRun | null> { return runsById[id] ? { id, headSha: runsById[id]!, repository } : null; } });

  test("reads only the qualification section, without comments, and only this repository's runs", () => {
    const text = body(`<!-- e.g. ${url(1)} -->\nReplay ${url(2)} and ${url(3, "circe/brain-kit")} and ${url(2)}/attempts/1`);
    expect(qualificationRunIds(qualificationSection(text)!, repository)).toEqual([2]);
    expect(qualificationSection("## Proof\n\nnone")).toBeNull();
  });

  test("a body without the section is refused, naming the missing evidence", async () => {
    const result = await check("Odysseus re-rigs the shards.", {});
    expect(result).toEqual({ refusal: expect.stringContaining('no "Off-main qualification" section') });
    const empty = await check(body("Replayed by hand."), {});
    expect(empty).toEqual({ refusal: expect.stringContaining("links no GitHub Actions run in odysseus/brain-kit") });
  });

  test("a run on the head, or on an ancestor with no proof-system change after it, qualifies", async () => {
    expect(await check(body(`Replay ${url(41)} on the head.`), { 41: sha.chart! })).toEqual({ evidence: { run: 41, headSha: sha.chart!, via: "head" } });
    expect(await check(body(`Dispatch ${url(42)}.`), { 42: sha.shards! })).toEqual({ evidence: { run: 42, headSha: sha.shards!, via: "ancestor" } });
  });

  test("a run whose head SHA has proof-system changes after it is refused", async () => {
    const result = await check(body(`Replay ${url(43)}.`), { 43: sha.mast! });
    expect(result).toEqual({ refusal: expect.stringContaining("is a proof-system change (scripts/ci-shards.ts)") });
    const unrelated = await check(body(`Replay ${url(44)}.`), { 44: sha.raft!.replace(/^./, c => c === "a" ? "b" : "a") });
    expect(unrelated).toEqual({ refusal: expect.stringContaining("not an ancestor of the head") });
  });
});
