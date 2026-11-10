import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { branchFor, batchIdFor, changedFilesOf, landingSlots, openBatch, parkedChangedFiles, ripeness, trailerFor, verifyBatch } from "../test-health/batch";
import { LENS_IDS, type LensId, type LensVerdict } from "../test-health/catalog";
import { loadConfig, type Profile } from "../test-health/config";
import { ledgerState, type BatchRecord, type ClusterRecord, type LedgerRecord } from "../test-health/ledger";
import type { Finding } from "../test-health/worksheet";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

const OARS = "packages/ithaca/tests/oars.test.ts";
const SAILS = "packages/ithaca/tests/sails.test.ts";
const RUN = "th-20260712000000-abc123";
const lenses = Object.fromEntries(LENS_IDS.map(lens => [lens, "clean"])) as Record<LensId, LensVerdict>;
const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 6, day, hour)).toISOString();
const HEAD = 'import { expect, test } from "bun:test";\n';
const OARS_TEST = `${HEAD}test("counts the oars", () => { expect(oars()).toBe(12); });\ntest("has oars", () => { expect(oars()).toBeDefined(); });\n`;

function cluster(index: number, files: string[], findings: Finding[] = [], changed = true, when = at(10, index + 1)): ClusterRecord {
  return { v: 1, type: "cluster", at: when, runId: RUN, cluster: index, batchId: "ithaca-th-1", commit: null, package: "ithaca",
    worksheet: { schemaVersion: 1, runId: RUN, cluster: index, seed: files[0]!, members: files, context: [], audits: files.map(file => ({ file, lenses })), findings },
    audits: files.map(file => ({ file, blobBefore: "a".repeat(40), blobAfter: (changed ? "b" : "a").repeat(40), lenses })),
    // The executed-case comparison `record cluster` stores for each changed file.
    accounting: files.map(file => ({ file, testsBefore: 2, testsAfter: 2, declaredRemoved: 0, runtime: { casesBefore: 2, casesAfter: 2, assertionsBefore: 2, assertionsAfter: 2 } })) };
}

/** A repository with `main` and a batch branch; `commit` adds one commit to the branch. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-batch-"));
  scratch.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: ENV });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const write = (file: string, text: string | null) => {
    if (text === null) { git("rm", "-q", "--", file); return; }
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    git("add", "--", file);
  };
  git("init", "-q", "-b", "main");
  write("packages/ithaca/src/oars.ts", "export const oars = () => 12;\n");
  write(OARS, OARS_TEST);
  write(SAILS, `${HEAD}test("reefs the sail", () => { expect(reef()).toBe(1); });\n`);
  git("commit", "-q", "-m", "main");
  git("switch", "-q", "-c", "test-health/ithaca-th-1");
  const commit = (changes: Record<string, string | null>, trailer: string | null) => {
    for (const [file, text] of Object.entries(changes)) write(file, text);
    git("commit", "-q", "-m", `test: audit\n\n${trailer ?? "No trailer here."}`);
    return git("rev-parse", "HEAD");
  };
  const verify = (clusters: ClusterRecord[]) => verifyBatch({ root, base: "main", head: "HEAD", clusters, classify: () => ({ proofSystem: false, reasons: [] }) });
  return { root, git, commit, verify };
}

const STRENGTHENED = OARS_TEST.replace("toBeDefined()", "toBe(12)");

describe("the gate a batch passes before it lands", () => {
  test("a commit of recorded members with its trailer passes, and the gate counts what changed", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: STRENGTHENED }, trailerFor(RUN, 0));
    expect(await verify([cluster(0, [OARS])])).toEqual({ ok: true, violations: [],
      stats: { commits: 1, files: 1, testsBefore: 2, testsAfter: 2, assertionsBefore: 2, assertionsAfter: 2, testsRemoved: 0, declaredRemoved: 0 } });
  });

  test("a commit without a trailer has no audit behind it", async () => {
    const { commit, verify } = fixture();
    const sha = commit({ [OARS]: STRENGTHENED }, null);
    expect((await verify([cluster(0, [OARS])])).violations).toEqual([`commit ${sha.slice(0, 10)}: no Test-Health trailer, so no audit stands behind it`]);
  });

  test("a trailer that names no recorded cluster is refused", async () => {
    const { commit, verify } = fixture();
    const sha = commit({ [OARS]: STRENGTHENED }, trailerFor(RUN, 7));
    expect((await verify([cluster(0, [OARS])])).violations).toEqual([`commit ${sha.slice(0, 10)}: ${RUN}#7 is not a recorded cluster`]);
  });

  test("a test file that is not a member of the commit's cluster is refused", async () => {
    const { commit, verify } = fixture();
    const sha = commit({ [SAILS]: `${HEAD}test("reefs the sail", () => { expect(reef()).toBe(2); });\n` }, trailerFor(RUN, 0));
    expect((await verify([cluster(0, [OARS])])).violations).toEqual([`commit ${sha.slice(0, 10)}: ${SAILS} is not a member of ${RUN}#0`,
      `${SAILS}: no comparison of executed cases before and after was recorded for this change`]);
  });

  test("a change outside test code is refused, while test support and the authoring guide may move", async () => {
    const { commit, verify } = fixture();
    commit({ "packages/ithaca/src/oars.ts": "export const oars = () => 13;\n", "packages/ithaca/tests/helpers/ship.ts": "export const ship = 1;\n",
      "docs/process/test-authoring.md": "# Writing tests\n", "scripts/test.ts": "export {};\n" }, trailerFor(RUN, 0));
    expect((await verify([cluster(0, [OARS])])).violations).toEqual([
      "packages/ithaca/src/oars.ts: outside test code; a product or tooling change is filed, not made here",
      "scripts/test.ts: outside test code; a product or tooling change is filed, not made here"]);
  });

  test.each([
    ["skipped", 'test.skip("has oars", () => { expect(oars()).toBeDefined(); });'],
    ["conditional-skip", 'test.skipIf(!calm)("has oars", () => { expect(oars()).toBeDefined(); });'],
    ["retry", 'test("has oars", () => { expect(oars()).toBeDefined(); }, { retry: 2 });'],
    ["only", 'test.only("has oars", () => { expect(oars()).toBeDefined(); });'],
    ["long-timeout", 'test("has oars", () => { expect(oars()).toBeDefined(); }, 120000);'],
  ])("a change that adds %s hides a test instead of fixing it", async (smell, replacement) => {
    const { commit, verify } = fixture();
    commit({ [OARS]: OARS_TEST.replace('test("has oars", () => { expect(oars()).toBeDefined(); });', replacement) }, trailerFor(RUN, 0));
    expect((await verify([cluster(0, [OARS])])).violations).toEqual([`${OARS}: adds ${smell} (0 before, 1 after)`]);
  });

  const ONLY_COUNT = `${HEAD}test("counts the oars", () => { expect(oars()).toBe(12); });\n`;
  const removal = (removes: string[], overrides: Partial<Finding> = {}): Finding =>
    ({ id: "F1", file: OARS, lens: "overlap", smell: "duplicate-case", action: "remove", status: "fixed", note: "the count already proves it", evidence: { removes }, ...overrides });

  test("a test that disappears without being declared is refused by name, by edit or by deleting the file", async () => {
    const edited = fixture();
    edited.commit({ [OARS]: ONLY_COUNT }, trailerFor(RUN, 0));
    expect((await edited.verify([cluster(0, [OARS])])).violations).toEqual([`${OARS}: 1 test(s) disappeared without being declared: "has oars"`]);
    const deleted = fixture();
    deleted.commit({ [OARS]: null }, trailerFor(RUN, 0));
    const result = await deleted.verify([cluster(0, [OARS])]);
    expect(result.violations).toEqual([`${OARS}: 2 test(s) disappeared without being declared: "counts the oars", "has oars"`]);
    expect(result.stats).toMatchObject({ testsRemoved: 2, declaredRemoved: 0 });
  });

  test("the same removal passes once a fixed finding names the test, and only while that finding is fixed", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: ONLY_COUNT }, trailerFor(RUN, 0));
    const passed = await verify([cluster(0, [OARS], [removal(["has oars"])])]);
    expect([passed.ok, passed.stats.testsRemoved, passed.stats.declaredRemoved]).toEqual([true, 1, 1]);
    expect((await verify([cluster(0, [OARS], [removal(["has oars"], { status: "deferred" })])])).ok).toBe(false);
  });

  test("one declared removal does not cover for a second test that went missing with it", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: `${HEAD}test("rows", () => { expect(oars()).toBe(12); });\n` }, trailerFor(RUN, 0));
    expect((await verify([cluster(0, [OARS], [removal(["has oars"])])])).violations)
      .toEqual([`${OARS}: 1 test(s) disappeared without being declared: "counts the oars"`]);
  });

  test("a declaration that names a test still present is refused, so the record cannot claim a removal that did not happen", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: STRENGTHENED }, trailerFor(RUN, 0));
    expect((await verify([cluster(0, [OARS], [removal(["has oars"])])])).violations).toEqual([`${OARS}: declared as removed or renamed but still present: "has oars"`]);
  });

  test("a rename is not a removal when a fixed finding declares it, and is one when nothing does", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: OARS_TEST.replace('"has oars"', '"the ship has twelve oars"') }, trailerFor(RUN, 0));
    expect((await verify([cluster(0, [OARS])])).violations).toEqual([`${OARS}: 1 test(s) disappeared without being declared: "has oars"`]);
    const rename: Finding = { id: "F1", file: OARS, lens: "hygiene", smell: "unclear-name", action: "cleanup", status: "fixed", note: "the name states the claim",
      evidence: { renames: [{ from: "has oars", to: "the ship has twelve oars" }] } };
    expect((await verify([cluster(0, [OARS], [rename])])).ok).toBe(true);
    const wrong: Finding = { ...rename, evidence: { renames: [{ from: "has oars", to: "the ship has oars" }] } };
    expect((await verify([cluster(0, [OARS], [wrong])])).violations).toEqual([`${OARS}: renamed to a title that does not exist after the change: "the ship has oars"`]);
  });

  test("a changed Bun test file whose executed cases were never compared is refused", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: STRENGTHENED }, trailerFor(RUN, 0));
    expect((await verify([{ ...cluster(0, [OARS]), accounting: [] }])).violations).toEqual([`${OARS}: no comparison of executed cases before and after was recorded for this change`]);
    const staticOnly = { ...cluster(0, [OARS]), accounting: [{ file: OARS, testsBefore: 2, testsAfter: 2, declaredRemoved: 0, runtime: null }] };
    expect((await verify([staticOnly])).ok).toBe(false);
  });

  test("a new test file may join a cluster's commit: the cheap owner of a case has to come from somewhere", async () => {
    const { commit, verify } = fixture();
    commit({ [OARS]: STRENGTHENED, "packages/ithaca/tests/oar-count.test.ts": `${HEAD}test("an empty ship has no oars", () => { expect(oars()).toBe(0); });\n` }, trailerFor(RUN, 0));
    expect(await verify([cluster(0, [OARS])])).toMatchObject({ ok: true, stats: { files: 2, testsBefore: 2, testsAfter: 3 } });
  });

  test("a dropped cluster passes once its commit is reverted, and is refused while its file still differs", async () => {
    const { root, git, commit } = fixture();
    const sha = commit({ [OARS]: STRENGTHENED }, trailerFor(RUN, 0));
    const dropped = [cluster(0, [OARS])];
    const verify = () => verifyBatch({ root, base: "main", head: "HEAD", clusters: [], voided: dropped, classify: () => ({ proofSystem: false, reasons: [] }) });
    expect((await verify()).violations).toContain(`${RUN}#0 was dropped, but ${OARS} still differs from the base`);
    git("revert", "--no-commit", sha);
    git("commit", "-q", "-m", `revert: drop ${RUN}#0\n\n${trailerFor(RUN, 0)}`);
    expect(await verify()).toMatchObject({ ok: true, stats: { commits: 2, files: 0 } });
  });

  test("a whole-branch check skips the per-commit trail and still refuses what the diff itself shows", async () => {
    const { root, commit } = fixture();
    commit({ [OARS]: STRENGTHENED }, null);
    const net = (clusters: ClusterRecord[]) => verifyBatch({ root, base: "main", head: "HEAD", clusters, netOnly: true, classify: () => ({ proofSystem: false, reasons: [] }) });
    const recorded = [cluster(0, [OARS, SAILS])];
    expect((await net(recorded)).ok).toBe(true);
    commit({ [SAILS]: null, "packages/ithaca/src/oars.ts": "export const oars = () => 13;\n" }, null);
    expect((await net(recorded)).violations).toEqual([
      "packages/ithaca/src/oars.ts: outside test code; a product or tooling change is filed, not made here",
      `${SAILS}: 1 test(s) disappeared without being declared: "reefs the sail"`]);
  });

  test("the repository's own classifier passes an assertion fix and refuses a changed time budget", async () => {
    const { root, commit } = fixture();
    const real = (clusters: ClusterRecord[]) => verifyBatch({ root, base: "main", head: "HEAD", clusters });
    commit({ [OARS]: STRENGTHENED }, trailerFor(RUN, 0));
    expect((await real([cluster(0, [OARS, SAILS])])).violations).toEqual([]);
    commit({ [SAILS]: `${HEAD}test("reefs the sail", () => { expect(reef()).toBe(1); }, 9000);\n` }, trailerFor(RUN, 0));
    const after = await real([cluster(0, [OARS, SAILS])]);
    expect(after.violations.length).toBe(1);
    expect(after.violations[0]).toStartWith("the diff is a proof-system change (");
  });
});

describe("when a batch lands", () => {
  const opened = (batchId: string, when: string, extra: Partial<BatchRecord> = {}): BatchRecord =>
    ({ v: 1, type: "batch", event: "opened", at: when, runId: "th-1", batchId, package: "ithaca", branch: branchFor(batchId), base: "origin/main", profile: "cron", ...extra });
  const event = (name: BatchRecord["event"], batchId: string, when: string, extra: Partial<BatchRecord> = {}): BatchRecord =>
    ({ v: 1, type: "batch", event: name, at: when, runId: "th-1", batchId, ...extra });
  const profile: Profile = { ...loadConfig("cron").profile, ripe: { changedFiles: 2, ageHours: 72, maxChangedFiles: 3, whenExhausted: true },
    landing: { maxOpenCandidates: 1, maxPerDay: 2 } };
  const stateOf = (records: LedgerRecord[]) => ledgerState(records, new Date(at(12)));
  const files = (count: number) => Array.from({ length: count }, (_, i) => `packages/ithaca/tests/oar-${i}.test.ts`);

  test("a batch is named after its package and opening run, and a run continues the oldest open one on its base", () => {
    expect([batchIdFor("ithaca", RUN), branchFor(batchIdFor("ithaca", RUN))]).toEqual([`ithaca-${RUN}`, `test-health/ithaca-${RUN}`]);
    const state = stateOf([opened("b-new", at(11)), opened("b-old", at(10)), opened("b-epic", at(9), { base: "origin/epic/9-ithaca" }), opened("b-landed", at(8)), event("landed", "b-landed", at(9))]);
    expect([openBatch(state, "origin/main")?.batchId, openBatch(state, "origin/epic/9-ithaca")?.batchId, openBatch(state, "origin/main", "pylos")]).toEqual(["b-old", "b-epic", undefined]);
  });

  test("only files whose content changed count toward a batch", () => {
    const state = stateOf([opened("ithaca-th-1", at(10)), cluster(0, files(2)), cluster(1, [SAILS], [], false)]);
    const batch = state.batches.get("ithaca-th-1")!;
    expect([changedFilesOf(batch, state), parkedChangedFiles(state)]).toEqual([files(2), 2]);
  });

  test("a batch ripens by size, by age, or when its package has nothing left, and never while it is empty", () => {
    const now = new Date(at(12));
    const check = (records: LedgerRecord[], exhausted: boolean, when = now) => {
      const state = stateOf(records);
      return ripeness(state.batches.get("ithaca-th-1")!, state, profile, when, exhausted);
    };
    expect(check([opened("ithaca-th-1", at(11)), cluster(0, files(1), [], true, at(11, 1))], false)).toMatchObject({ ripe: false, reasons: [], changedFiles: 1, full: false });
    expect(check([opened("ithaca-th-1", at(11)), cluster(0, files(2), [], true, at(11, 1))], false).reasons).toEqual(["2 changed files (threshold 2)"]);
    expect(check([opened("ithaca-th-1", at(9)), cluster(0, files(1), [], true, at(9, 1))], false).reasons).toEqual(["72 h old (threshold 72)"]);
    expect(check([opened("ithaca-th-1", at(11)), cluster(0, files(1), [], true, at(11, 1))], true).reasons).toEqual(["nothing left to audit in its package"]);
    expect(check([opened("ithaca-th-1", at(1)), cluster(0, files(1), [], false, at(1, 1))], true)).toMatchObject({ ripe: false, changedFiles: 0 });
    expect(check([opened("ithaca-th-1", at(11)), cluster(0, files(3), [], true, at(11, 1))], false).full).toBe(true);
  });

  test("the landing lane admits one candidate at a time and a daily number of landings", () => {
    const now = new Date(at(12));
    expect(landingSlots(stateOf([opened("b-1", at(11))]), profile, now)).toEqual({ open: true, reason: null });
    expect(landingSlots(stateOf([opened("b-1", at(11)), event("pr", "b-1", at(11, 1), { pr: 4242 })]), profile, now).reason).toBe("1 batch pull request(s) already open (cap 1)");
    const landedToday = [opened("b-1", at(10)), event("landed", "b-1", at(11, 6)), opened("b-2", at(10)), event("landed", "b-2", at(11, 9))];
    expect(landingSlots(stateOf(landedToday), profile, now).reason).toBe("2 batches landed in the last 24 h (cap 2)");
    expect(landingSlots(stateOf(landedToday), profile, new Date(at(13))).open).toBe(true);
    expect(landingSlots(stateOf(landedToday), { ...profile, landing: { maxOpenCandidates: null, maxPerDay: null } }, now).open).toBe(true);
  });
});
