import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkQualification, decideLane, isGreen, laneRefusal, lastProofSystemSquash, qualificationRunIds, qualificationSection, readLane,
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

const green = (id: number): MainRun => ({ id, status: "completed", conclusion: "success" });
const runs = (entries: Record<string, MainRun | null>) => new Map(Object.entries(entries).map(([name, run]) => [sha[name]!, run]));

describe("stability window (#3269)", () => {
  test("finds the last proof-system squash and the squashes after it", () => {
    expect(lastProofSystemSquash(sha.mast!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [sha.oars!, sha.mast!], scanned: 3 });
    expect(lastProofSystemSquash(sha.oars!, { cwd: dir })).toEqual({ squash: sha.sails!, later: [sha.oars!], scanned: 2 });
    expect(lastProofSystemSquash(sha.raft!, { cwd: dir })).toEqual({ squash: null, later: [], scanned: 2 });
  });

  test("own run green and only one later green run: 1 more green main run required", () => {
    const history = lastProofSystemSquash(sha.mast!, { cwd: dir });
    const decision = decideLane(sha.mast!, history, runs({ sails: green(1), oars: green(2), mast: null }));
    expect(decision.open).toBe(false);
    expect(decision.missing).toBe(1);
    expect(laneRefusal(decision)).toContain("1 more green main run required");
    expect(laneRefusal(decision)).toContain(`the last proof-system squash ${sha.sails}`);
    expect(laneRefusal(decision)).toContain("next run 2 at");
  });

  test("own run and two later green runs open the lane", () => {
    const history = lastProofSystemSquash(sha.mast!, { cwd: dir });
    const decision = decideLane(sha.mast!, history, runs({ sails: green(1), oars: green(2), mast: green(3) }));
    expect(decision).toMatchObject({ open: true, missing: 0, proofSystemSquash: sha.sails });
    expect(laneRefusal(decision)).toBeNull();
  });

  test("a missing, in-progress, cancelled or failed window run is not green", () => {
    const history = lastProofSystemSquash(sha.mast!, { cwd: dir });
    for (const run of [null, { id: 3, status: "in_progress", conclusion: null }, { id: 3, status: "queued", conclusion: null },
      { id: 3, status: "completed", conclusion: "cancelled" }, { id: 3, status: "completed", conclusion: "failure" },
      { id: 3, status: "completed", conclusion: "skipped" }, { id: 3, status: "completed", conclusion: "timed_out" }]) {
      expect(isGreen(run), `NOT_GREEN:${JSON.stringify(run)}`).toBe(false);
      const decision = decideLane(sha.mast!, history, runs({ sails: green(1), oars: green(2), mast: run }));
      expect(decision.open, `LANE_CLOSED:${JSON.stringify(run)}`).toBe(false);
      expect(laneRefusal(decision)).toContain("1 more green main run required");
    }
    // A squash with no later main squash yet counts as missing too.
    const fresh = decideLane(sha.sails!, lastProofSystemSquash(sha.sails!, { cwd: dir }), runs({ sails: green(1) }));
    expect(laneRefusal(fresh)).toContain("2 more green main runs required");
    expect(laneRefusal(fresh)).toContain("next run 1: no main squash yet");
  });

  test("readLane reads at most the window's runs and agrees with the refusal", async () => {
    const asked: string[] = [];
    const decision = await readLane(sha.mast!, async at => { asked.push(at); return at === sha.mast ? { id: 3, status: "completed", conclusion: "cancelled" } : green(1); }, { cwd: dir });
    expect(asked).toEqual([sha.sails!, sha.oars!, sha.mast!]);
    expect(decision).toMatchObject({ open: false, missing: 1 });
    expect(laneRefusal(decision)).toContain("run 3 cancelled");
    const product = await readLane(sha.raft!, async () => { throw new Error("NO_RUN_READ_WITHOUT_A_PROOF_SYSTEM_SQUASH"); }, { cwd: dir });
    expect(product).toMatchObject({ open: true, proofSystemSquash: null });
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
