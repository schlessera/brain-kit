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


describe("stability window (#3269, single run as amended in #2938 issuecomment-6580707195)", () => {
  test("finds the last proof-system squash and the squashes after it", () => {
    expect(lastProofSystemSquash(sha.mast!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [sha.oars!, sha.mast!], omitted: 0, scanned: 3 });
    expect(lastProofSystemSquash(sha.oars!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [sha.oars!], omitted: 0, scanned: 2 });
    expect(lastProofSystemSquash(sha.sails!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [], omitted: 0, scanned: 1 });
    expect(lastProofSystemSquash(sha.raft!, { cwd: dir })).toEqual({ squash: null, later: [], omitted: 0, scanned: 2 });
  });

  // Synthetic merge order: p is the proof-system squash, a..k the squashes after it.
  const later = "abcdefghijk".split("");
  const history = (count: number, omitted = 0) => ({ squash: "p", later: later.slice(0, count), omitted, scanned: count + omitted + 1 });
  const ok = (id: number): MainRun => ({ id, status: "completed", conclusion: "success" });
  const bad = (id: number, conclusion = "failure"): MainRun => ({ id, status: "completed", conclusion });
  const busy = (id: number): MainRun => ({ id, status: "in_progress", conclusion: null });
  const decide = (own: MainRun | null, rest: (MainRun | null)[], omitted = 0) =>
    decideLane("main", history(rest.length, omitted), new Map([["p", own], ...rest.map((run, index): [string, MainRun | null] => [later[index]!, run])]));

  test("the own green run opens the lane without waiting for later runs", () => {
    for (const rest of [[], [busy(2)], [null], [busy(2), null], [ok(2)]]) {
      const decision = decide(ok(1), rest);
      expect(decision, `OWN_GREEN_OPENS:${JSON.stringify(rest)}`).toMatchObject({ state: "open", open: true, ownGreen: true, required: 0 });
      expect(laneRefusal(decision)).toBeNull();
    }
  });

  test("an own run that has not settled holds the lane, whatever later runs show", () => {
    for (const [own, rest] of [[busy(1), []], [null, []], [{ id: 1, status: "queued", conclusion: null }, [ok(2)]], [busy(1), [ok(2), ok(3)]]] as const) {
      const decision = decide(own, [...rest]);
      expect(decision, `OWN_RUN_NOT_SETTLED:${JSON.stringify(own)}`).toMatchObject({ state: "closed", open: false, required: 1, decisive: null });
      expect(laneRefusal(decision)).toContain("has no settled main run of its own yet");
      expect(laneRefusal(decision)).toContain("1 more green main run required");
    }
  });

  test("a failed, cancelled or timed-out own run holds the lane until the next green main run", () => {
    for (const own of [bad(1), bad(1, "cancelled"), bad(1, "timed_out")]) {
      const decision = decide(own, [busy(2)]);
      expect(decision, `OWN_RUN_NOT_GREEN:${JSON.stringify(own)}`).toMatchObject({ state: "closed", ownGreen: false, required: 1, decisive: { position: 0 } });
      expect(laneRefusal(decision)).toContain("its own main run is not green");
      expect(decide(own, [busy(2), ok(3)]), `NEXT_GREEN_AFTER_A_RED_OWN_RUN:${JSON.stringify(own)}`).toMatchObject({ state: "open", ownGreen: false, decisive: { position: 2 } });
    }
    // A squash that never got a run is settled not green once a later squash exists.
    expect(decide(null, [busy(2)])).toMatchObject({ state: "closed", ownGreen: false, decisive: { position: 0, settled: true } });
  });

  test("after a later failure, a single later green run reopens the lane", () => {
    const failed = decide(ok(1), [bad(2)]);
    expect(failed, "LATER_FAILURE_CLOSES").toMatchObject({ state: "closed", ownGreen: true, required: 1, decisive: { position: 1 } });
    expect(laneRefusal(failed)).toContain("the newest settled main run after it is not green");
    expect(laneRefusal(failed)).toContain("run 1 after it at a: run 2 failure");
    expect(decide(ok(1), [bad(2), busy(3)]), "PENDING_IS_NOT_GREEN").toMatchObject({ state: "closed", required: 1 });
    expect(decide(ok(1), [bad(2), ok(3)]), "ONE_GREEN_REOPENS").toMatchObject({ state: "open", required: 0, decisive: { position: 2 } });
    expect(decide(ok(1), [bad(2), ok(3), busy(4)])).toMatchObject({ state: "open" });
    expect(decide(ok(1), [ok(2), bad(3)]), "GREEN_BEFORE_THE_FAILURE_DOES_NOT_COUNT").toMatchObject({ state: "closed", decisive: { position: 2 } });
  });

  test("cancelled and missing later runs are not green", () => {
    const cancelled = decide(ok(1), [bad(2, "cancelled")]);
    expect(cancelled, "CANCELLED_IS_NOT_GREEN").toMatchObject({ state: "closed", required: 1 });
    expect(laneRefusal(cancelled)).toContain("run 2 cancelled");
    expect(decide(ok(1), [bad(2, "cancelled"), ok(3)])).toMatchObject({ state: "open" });
    // A squash with no run before a later squash never gets one.
    expect(decide(ok(1), [null, busy(3)]), "MISSING_IS_NOT_GREEN").toMatchObject({ state: "closed", decisive: { position: 1, run: null, settled: true } });
    expect(laneRefusal(decide(ok(1), [null, busy(3)]))).toContain("run 1 after it at a: no main-push CI run)");
  });

  test("when every later run read is unsettled and older ones were not read, the lane is unknown and refused", () => {
    const pending = Array.from({ length: MAX_MAIN_RUNS - 1 }, (_, index) => busy(index + 2));
    const unknown = decide(ok(1), pending, 3);
    expect(unknown).toMatchObject({ state: "unknown", open: false, required: null });
    expect(laneRefusal(unknown)).toContain("Proof-system lane unknown");
    expect(decide(ok(1), pending, 0)).toMatchObject({ state: "open" });
  });

  test("readLane reads the own run, then later runs newest first, stops once decided and agrees with the refusal", async () => {
    const asked: string[] = [];
    const runs: Record<string, MainRun> = { [sha.sails!]: ok(1), [sha.oars!]: bad(2), [sha.mast!]: busy(3) };
    const decision = await readLane(sha.mast!, async at => { asked.push(at); return runs[at]!; }, { cwd: dir });
    expect(asked).toEqual([sha.sails!, sha.mast!, sha.oars!]);
    expect(decision).toMatchObject({ state: "closed", required: 1, next: null });
    expect(laneRefusal(decision)).toContain("run 2 failure");
    const own: string[] = [];
    await readLane(sha.mast!, async at => { own.push(at); return busy(1); }, { cwd: dir });
    expect(own, "NO_LATER_READS_BEFORE_THE_OWN_RUN_SETTLES").toEqual([sha.sails!]);
    const newest: string[] = [];
    await readLane(sha.mast!, async at => { newest.push(at); return ok(1); }, { cwd: dir });
    expect(newest, "STOPS_AT_THE_NEWEST_SETTLED_RUN").toEqual([sha.sails!, sha.mast!]);
    const product = await readLane(sha.raft!, async () => { throw new Error("NO_RUN_READ_WITHOUT_A_PROOF_SYSTEM_SQUASH"); }, { cwd: dir });
    expect(product).toMatchObject({ open: true, proofSystemSquash: null });
  });

  test("readLane never reads more than the bound", async () => {
    // Twelve product squashes after mast whose runs are all still in progress.
    let tip = sha.mast!;
    for (let index = 0; index < 12; index++) tip = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", `wave ${index}`);
    const asked: string[] = [];
    const decision = await readLane(tip, async at => { asked.push(at); return at === sha.sails ? ok(1) : busy(asked.length); }, { cwd: dir });
    expect(asked, "BOUNDED_MAIN_RUN_READS").toHaveLength(MAX_MAIN_RUNS);
    expect(asked[0]).toBe(sha.sails!);
    expect(asked[1]).toBe(tip);
    expect(decision).toMatchObject({ state: "unknown", open: false, required: null });
  });
});

describe("off-main qualification (#3271)", () => {
  const repository = "odysseus/brain-kit";
  const url = (id: number, repo = repository) => `https://github.com/${repo}/actions/runs/${id}`;
  const body = (section: string) => `Odysseus re-rigs the shards.\n\n## Off-main qualification\n\n${section}\n\n## Anything left open\n\n${url(999)}\n`;
  const check = (text: string | null, runsById: Record<number, string>) => checkQualification({ body: text, repository, head: sha.chart!, cwd: dir,
    async readRun(id): Promise<QualificationRun | null> { return runsById[id] ? { id, headSha: runsById[id]!, repository, status: "completed", conclusion: "success" } : null; } });

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

  test.each([
    ["completed", "failure"], ["completed", "cancelled"], ["completed", "skipped"],
    ["completed", "timed_out"], ["completed", null], ["in_progress", null], ["queued", null],
    ["in_progress", "success"], ["queued", "success"],
  ])("refuses qualification run state %s / %s", async (status, conclusion) => {
    const result = await checkQualification({ body: body(url(45)), repository, head: sha.chart!, cwd: dir,
      async readRun() { return { id: 45, headSha: sha.chart!, repository, status: status!, conclusion }; } });
    expect(result).toEqual({ refusal: expect.stringContaining(`run 45 is ${status} with conclusion ${conclusion ?? "none"}`) });
  });

  test("a refused run leaves later successful evidence usable within the five-run bound", async () => {
    const reads: number[] = [];
    const input = { body: body([1, 2, 3, 4, 5, 6].map(id => url(id)).join("\n")), repository, head: sha.chart!, cwd: dir };
    const readRun = async (id: number): Promise<QualificationRun> => {
      reads.push(id);
      return { id, headSha: sha.chart!, repository, status: "completed", conclusion: id === 6 ? "success" : "failure" };
    };
    expect(await checkQualification({ ...input, readRun })).toHaveProperty("refusal");
    expect(reads).toEqual([1, 2, 3, 4, 5]);
    expect(await checkQualification({ ...input, readRun: async id => ({ ...await readRun(id), conclusion: id === 2 ? "success" : "failure" }) }))
      .toEqual({ evidence: { run: 2, headSha: sha.chart!, via: "head" } });
  });

  test("a run whose head SHA has proof-system changes after it is refused", async () => {
    const result = await check(body(`Replay ${url(43)}.`), { 43: sha.mast! });
    expect(result).toEqual({ refusal: expect.stringContaining("is a proof-system change (scripts/ci-shards.ts)") });
    const unrelated = await check(body(`Replay ${url(44)}.`), { 44: sha.raft!.replace(/^./, c => c === "a" ? "b" : "a") });
    expect(unrelated).toEqual({ refusal: expect.stringContaining("not an ancestor of the head") });
  });
});
