import { describe, expect, test } from "bun:test";
import { LENS_IDS, type LensId, type LensVerdict } from "../test-health/catalog";
import { loadConfig, type Profile } from "../test-health/config";
import type { Inventory, Row, Tier } from "../test-health/inventory";
import { mapIssues, type Issue } from "../test-health/issues";
import { ledgerState, type ClusterRecord, type FileAuditState } from "../test-health/ledger";
import { buildAffinity, importSpecifiers, nameTokens, neighboursOf, type ImportIndex } from "../test-health/neighbours";
import { fileState, groupsOf, makeShards, modeFor, planRun, rank, remainingIn, type PlanInput } from "../test-health/select";

const NOW = new Date("2026-07-12T12:00:00Z");
const lenses = Object.fromEntries(LENS_IDS.map(lens => [lens, "clean"])) as Record<LensId, LensVerdict>;

function row(file: string, overrides: Partial<Row> = {}): Row {
  const parts = file.split("/");
  const tier: Tier = file.includes("-runtime.") ? "runtime" : "unit";
  return { file, package: parts[0] === "packages" ? parts[1]! : "root", tier, runner: "bun", projects: [], scenarios: 4, assertions: 8,
    blob: `blob-${file}`, costSeconds: 1, ...overrides };
}

/** Two packages. In `ithaca`, three tests are about the bow and two about the sails; `pylos` holds one runtime test about the bow. */
const BOW = "packages/ithaca/tests/bow.test.ts";
const BOW_STRING = "packages/ithaca/tests/bow-string.test.ts";
const BOW_RUNTIME = "packages/ithaca/tests/bow-runtime.test.ts";
const SAILS = "packages/ithaca/tests/sails.test.ts";
const SAILS_REEF = "packages/ithaca/tests/sails-reef.test.ts";
const LOOM = "packages/ithaca/tests/loom.test.ts";
const HARBOUR = "packages/pylos/tests/bow-harbour-runtime.test.ts";
const SANDS = "packages/pylos/tests/sands.test.ts";
const rows = [BOW, BOW_STRING, BOW_RUNTIME, SAILS, SAILS_REEF, LOOM, HARBOUR, SANDS].map(file => row(file));
const inventory: Inventory = { sha: "0".repeat(40), rows, undiscovered: [] };
const index: ImportIndex = new Map([
  [BOW, ["packages/ithaca/src/bow.ts"]], [BOW_STRING, ["packages/ithaca/src/bow.ts"]], [BOW_RUNTIME, []],
  [SAILS, ["packages/ithaca/src/sails.ts"]], [SAILS_REEF, ["packages/ithaca/src/sails.ts"]], [LOOM, ["packages/ithaca/src/loom.ts"]],
  [HARBOUR, []], [SANDS, ["packages/pylos/src/sands.ts"]],
]);
const affinity = buildAffinity(rows, index);
/** Every package is its own group here; the small group has its own fixture below. */
const profile: Profile = { ...loadConfig("cron").profile, clusterSize: 3, budgetFiles: 4, smallPackageFiles: null };

const audited = (file: string, at: string, blob = `blob-${file}`): [string, FileAuditState] =>
  [file, { at, runId: "th-old", cluster: 0, blobBefore: blob, blobAfter: blob, lenses }];

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return { runId: "th-new", inventory, profile, now: NOW, audits: new Map(), claims: new Map(), signalWeights: new Map(),
    issues: new Map(), openPrFiles: new Set(), affinity, runCount: 0, ...overrides };
}
const members = (plan: ReturnType<typeof planRun>) => plan.clusters.map(cluster => cluster.members);

describe("whether a file needs an audit", () => {
  const audit = (blob: string, at: string): FileAuditState => ({ at, runId: "th-old", cluster: 0, blobBefore: "before", blobAfter: blob, lenses });

  test("never audited, audited at its current content, and edited since are three states", () => {
    const subject = row(BOW, { blob: "after" });
    expect(fileState(subject, undefined, NOW, 180)).toBe("never");
    expect(fileState(subject, audit("after", "2026-07-01T00:00:00Z"), NOW, 180)).toBe("fresh");
    expect(fileState(subject, audit("other", "2026-07-01T00:00:00Z"), NOW, 180)).toBe("stale");
  });

  test("an audit still counts while its change waits on a batch branch: the base holds the content it started from", () => {
    expect(fileState(row(BOW, { blob: "before" }), audit("after", "2026-07-01T00:00:00Z"), NOW, 180)).toBe("fresh");
  });

  test("an audit older than the re-audit window is stale even when nothing changed", () => {
    expect(fileState(row(BOW, { blob: "after" }), audit("after", "2026-01-01T00:00:00Z"), NOW, 180)).toBe("stale");
  });
});

describe("neighbours", () => {
  test("tests that import the same source module, or share a distinctive name, are neighbours", () => {
    const found = neighboursOf(row(BOW), affinity);
    expect(found.map(neighbour => neighbour.file)).toEqual([BOW_STRING, BOW_RUNTIME, HARBOUR]);
    expect(found.map(neighbour => neighbour.relation)).toEqual(["horizontal", "vertical", "vertical"]);
    expect(found[0]!.shared).toEqual(["packages/ithaca/src/bow.ts", "name:bow"]);
  });

  test("a test with nothing in common is not a neighbour", () => {
    expect(neighboursOf(row(LOOM), affinity)).toEqual([]);
  });

  test("names are split into tokens without the tier words every file carries", () => {
    expect(nameTokens("packages/pylos/tests/bow-harbour-runtime.test.ts")).toEqual(["bow", "harbour"]);
  });

  test("static, re-exported and literal dynamic imports are all specifiers", () => {
    const source = 'import { bow } from "../src/bow";\nexport * from "./helpers";\nconst sails = await import("../src/sails.js");\nconst computed = await import(name);\n';
    expect(importSpecifiers(BOW, source)).toEqual(["../src/bow", "../src/sails.js", "./helpers"]);
  });
});

describe("what a run audits", () => {
  test("the hot queue takes the worst package first and clusters a seed with its neighbours in that package", () => {
    const plan = planRun(input({ signalWeights: new Map([[SAILS, 30]]), mode: "hot" }));
    expect(plan.package).toBe("ithaca");
    // The seed is the file with the signals; its cluster pulls in the other sails test. Equal scores break
    // by path, so the next seed is the first bow file; the budget of 4 stops the run after its cluster.
    expect(members(plan)).toEqual([[SAILS, SAILS_REEF], [BOW_RUNTIME, BOW_STRING, BOW]]);
    expect(plan.stats.selected).toBe(5);
  });

  test("a neighbour in another package is context, never a member", () => {
    const plan = planRun(input({ signalWeights: new Map([[BOW, 30]]), mode: "hot" }));
    expect(plan.clusters[0]).toMatchObject({ seed: BOW, members: [BOW, BOW_STRING, BOW_RUNTIME], context: [HARBOUR] });
  });

  test("cost and open issues raise a file as static signals do", () => {
    const cost = rank(input({ inventory: { ...inventory, rows: rows.map(entry => entry.file === LOOM ? { ...entry, costSeconds: 300 } : entry) } }));
    const issue = rank(input({ issues: new Map([[SANDS, [{ number: 7, title: "sands flake", needsRepro: true, assigned: false }]]]) }));
    const top = (list: typeof cost) => [...list].sort((a, b) => b.hot - a.hot)[0]!.row.file;
    expect([top(cost), top(issue)]).toEqual([LOOM, SANDS]);
  });

  test("the sweep queue takes never-audited files first, then the oldest audit, whatever the signals say", () => {
    const audits = new Map([audited(BOW, "2026-07-10T00:00:00Z", "edited"), audited(SAILS, "2026-07-01T00:00:00Z", "edited"),
      ...[BOW_STRING, BOW_RUNTIME, SAILS_REEF, LOOM, HARBOUR].map(file => audited(file, "2026-07-11T00:00:00Z"))]);
    const plan = planRun(input({ audits, mode: "sweep", signalWeights: new Map([[BOW, 99]]) }));
    // Only SANDS was never audited, so its package goes first.
    expect([plan.package, members(plan)]).toEqual(["pylos", [[SANDS]]]);
    const next = planRun(input({ audits: new Map([...audits, audited(SANDS, "2026-07-11T00:00:00Z")]), mode: "sweep", signalWeights: new Map([[BOW, 99]]) }));
    expect(members(next)).toEqual([[SAILS], [BOW]]);
  });

  test("runs alternate between the two queues", () => {
    expect([0, 1, 2, 3].map(count => modeFor(count, 2))).toEqual(["hot", "sweep", "hot", "sweep"]);
    expect([0, 1, 2].map(count => modeFor(count, 3))).toEqual(["hot", "hot", "sweep"]);
  });

  test("files that are fresh, claimed by another run, or touched by an open pull request are left out", () => {
    const plan = planRun(input({ mode: "sweep", package: "ithaca", audits: new Map([audited(BOW, "2026-07-11T00:00:00Z")]),
      claims: new Map([[BOW_STRING, "th-other"]]), openPrFiles: new Set([BOW_RUNTIME]) }));
    expect(members(plan).flat().sort()).toEqual([LOOM, SAILS_REEF, SAILS]);
    expect(plan.stats).toMatchObject({ fresh: 1, claimed: 1, inOpenPrs: 1 });
  });

  test("a run continues the group of the open batch while it has work", () => {
    const plan = planRun(input({ mode: "hot", preferGroup: "pylos", signalWeights: new Map([[BOW, 99]]) }));
    expect(plan.package).toBe("pylos");
  });

  test("a tier the profile excludes is skipped and counted", () => {
    const plan = planRun(input({ mode: "sweep", package: "ithaca", profile: { ...profile, tiers: ["unit"], budgetFiles: null } }));
    expect(members(plan).flat()).not.toContain(BOW_RUNTIME);
    expect(plan.stats.skippedTiers).toEqual({ runtime: 2 });
  });

  test("the same input always yields the same plan", () => {
    const shuffled = { ...inventory, rows: [...rows].reverse() };
    expect(planRun(input({ inventory: shuffled, affinity: buildAffinity(shuffled.rows, index) })).clusters).toEqual(planRun(input()).clusters);
  });

  test("past the backlog cap a run plans nothing and says why", () => {
    const capped = { ...profile, backlog: { maxParkedChangedFiles: 150 } };
    expect(planRun(input({ profile: capped, parkedChangedFiles: 150 }))).toMatchObject({ clusters: [], throttled: "150 changed files are waiting to land (cap 150)" });
    expect(planRun(input({ profile: capped, parkedChangedFiles: 149 })).throttled).toBeNull();
  });

  test("a package is unfinished while another run holds its files, and finished when the rest sit in open pull requests", () => {
    const audits = new Map([audited(BOW, "2026-07-11T00:00:00Z")]);
    const ithaca = (extra: Partial<PlanInput>) => remainingIn(input({ audits, ...extra }), "ithaca");
    expect(ithaca({})).toBe(5);
    expect(ithaca({ claims: new Map([[SAILS, "th-other"]]) })).toBe(5);
    expect(ithaca({ openPrFiles: new Set([SAILS, SAILS_REEF, LOOM, BOW_STRING, BOW_RUNTIME]) })).toBe(0);
  });

  test("with nothing left to audit a run plans nothing and names no package", () => {
    const audits = new Map(rows.map(entry => audited(entry.file, "2026-07-11T00:00:00Z")));
    expect(planRun(input({ audits }))).toMatchObject({ package: null, clusters: [], throttled: null });
  });
});

describe("shards for parallel workers", () => {
  const many = Array.from({ length: 40 }, (_, i) => row(`packages/ithaca/tests/oar-${String(i).padStart(2, "0")}.test.ts`));
  const small = ["sparta", "argos", "mycenae"].flatMap(name => [row(`packages/${name}/tests/shield.test.ts`), row(`packages/${name}/tests/spear.test.ts`)]);
  const all = [...many, row(SANDS), row(HARBOUR), ...small];
  const grouped: Profile = { ...profile, smallPackageFiles: 25 };
  const groups = groupsOf(all, grouped);
  const candidates = rank(input({ inventory: { ...inventory, rows: all }, affinity: buildAffinity(all, new Map()) }));
  const groupOf = (file: string) => groups.get(file.split("/")[1]!);

  test("every file that needs an audit is in exactly one shard, and a shard never spans groups", () => {
    const shards = makeShards(candidates, 4, groups);
    const files = shards.flatMap(shard => shard.files);
    expect(files.sort()).toEqual(all.map(entry => entry.file).sort());
    expect(new Set(files).size).toBe(files.length);
    for (const shard of shards) expect([...new Set(shard.files.map(groupOf))]).toEqual([shard.group]);
  });

  test("a large package is split, and the small packages share a shard instead of taking one each", () => {
    const shards = makeShards(candidates, 4, groups);
    expect(shards.map(shard => [shard.id, shard.files.length])).toEqual([["ithaca-01", 14], ["ithaca-02", 14], ["ithaca-03", 12], ["small-01", 8]]);
    expect(new Set(shards.find(shard => shard.group === "small")!.files.map(file => file.split("/")[1])).size).toBe(4);
  });

  test("files already audited are not handed out", () => {
    const audits = new Map(many.slice(0, 30).map(entry => audited(entry.file, "2026-07-11T00:00:00Z")));
    const remaining = rank(input({ inventory: { ...inventory, rows: all }, audits, affinity: buildAffinity(all, new Map()) }));
    expect(makeShards(remaining, 4, groups).flatMap(shard => shard.files).length).toBe(18);
  });
});

describe("small packages share a group", () => {
  // Three packages under the threshold of 3 test files and one, ithaca, above it.
  // sparta's march shares a distinctive name with pylos's sands test, so the two are neighbours across packages of one group.
  const SHIELD = "packages/sparta/tests/shield.test.ts", MARCH = "packages/sparta/tests/sands-march.test.ts";
  const WALLS = "packages/argos/tests/walls.test.ts";
  const smallRows = [SANDS, HARBOUR, SHIELD, MARCH, WALLS].map(file => row(file));
  const largeRows = [BOW, BOW_STRING, BOW_RUNTIME, SAILS, SAILS_REEF, LOOM].map(file => row(file));
  const all = [...largeRows, ...smallRows];
  const grouped: Profile = { ...profile, smallPackageFiles: 3, budgetFiles: null };
  const groupInput = (extra: Partial<PlanInput> = {}) => input({ inventory: { ...inventory, rows: all }, affinity: buildAffinity(all, index), profile: grouped, ...extra });
  const packageOf = (file: string) => file.split("/")[1]!;

  test("a sweep of the small group takes clusters from several packages, and each cluster stays inside one", () => {
    const audits = new Map(largeRows.map(entry => audited(entry.file, "2026-07-11T00:00:00Z")));
    const plan = planRun(groupInput({ mode: "sweep", audits }));
    expect(new Set(members(plan).flat().map(packageOf))).toEqual(new Set(["argos", "pylos", "sparta"]));
    expect([plan.group, plan.package]).toEqual(["small", null]);
    for (const cluster of plan.clusters) expect(cluster.members.map(packageOf)).toEqual(cluster.members.map(() => cluster.package));
    // A neighbour in another package of the group, or in another group, is context, never a member.
    expect(plan.clusters.find(cluster => cluster.members.includes(SANDS))).toMatchObject({ members: [SANDS], context: [MARCH] });
    expect(plan.clusters.find(cluster => cluster.seed === HARBOUR)?.members).toEqual([HARBOUR]);
  });

  test("a plan for the large package contains only that package", () => {
    const plan = planRun(groupInput({ mode: "hot", signalWeights: new Map([[BOW, 99]]) }));
    expect([plan.group, plan.package, [...new Set(members(plan).flat().map(packageOf))]]).toEqual(["ithaca", "ithaca", ["ithaca"]]);
  });

  test("a package named like the shared group is refused rather than merged into it", () => {
    expect(() => groupsOf([row("packages/small/tests/a.test.ts"), ...all], grouped)).toThrow('A package named "small"');
  });

  test("the group is counted over the profile's tiers, and null turns grouping off", () => {
    expect(groupsOf(all, grouped).get("pylos")).toBe("small");
    expect(groupsOf(all, { ...grouped, tiers: ["runtime"] }).get("ithaca")).toBe("small");
    expect(groupsOf(all, { ...grouped, smallPackageFiles: null }).get("pylos")).toBe("pylos");
  });

  test("the small group is unfinished while any of its packages has an eligible file", () => {
    const allAudited = (except: string[]) => new Map(all.filter(entry => !except.includes(entry.file)).map(entry => audited(entry.file, "2026-07-11T00:00:00Z")));
    expect(remainingIn(groupInput({ audits: allAudited([WALLS]) }), "small")).toBe(1);
    expect(remainingIn(groupInput({ audits: allAudited([]) }), "small")).toBe(0);
    // A batch opened before groups records its package; that package's group is the one counted.
    expect(remainingIn(groupInput({ audits: allAudited([WALLS]) }), "sparta")).toBe(1);
  });
});

describe("work deferred for budget or proof stays in the rotation", () => {
  const at = "2026-07-11T00:00:00Z";
  const finding = (file: string, smell: string, extra: Record<string, unknown> = {}) => ({ id: `F-${smell}`, file, lens: "nondeterminism", smell,
    action: "deflake", status: "deferred", note: "Ten runs of the browser file did not fit the run.", ...extra });
  const record = (findings: unknown[]): ClusterRecord => ({ v: 1, type: "cluster", at, runId: "th-old", cluster: 0, batchId: null, commit: null,
    package: "ithaca", audits: [BOW, BOW_STRING].map(file => ({ file, blobBefore: `blob-${file}`, blobAfter: `blob-${file}`, lenses })),
    worksheet: { schemaVersion: 1, runId: "th-old", cluster: 0, seed: BOW, members: [BOW, BOW_STRING], context: [], audits: [], findings } as never });
  const planned = (findings: unknown[]) => planRun(input({ mode: "hot", package: "ithaca", audits: ledgerState([record(findings)], NOW).audits }));

  test("a file whose audit deferred a finding for budget is planned again and counted as unfinished", () => {
    const plan = planned([finding(BOW, "settling-sleep", { deferredFor: "budget" })]);
    expect(members(plan).flat()).toContain(BOW);
    expect(members(plan).flat()).not.toContain(BOW_STRING);
    expect(plan.stats).toMatchObject({ unfinished: 1, fresh: 1 });
  });

  test("a finding left to an issue's owner, or one that did not reproduce, leaves the file fresh", () => {
    for (const deferredFor of ["assigned", "unreproduced"]) {
      const plan = planned([finding(BOW, "settling-sleep", { deferredFor })]);
      expect(members(plan).flat()).not.toContain(BOW);
      expect(plan.stats).toMatchObject({ unfinished: 0, fresh: 2 });
    }
  });

  test("in the hot queue an unfinished file ranks ahead of a never-audited file with the same score", () => {
    const audits = ledgerState([record([finding(BOW, "settling-sleep", { deferredFor: "proof" })])], NOW).audits;
    const plan = planRun(input({ mode: "hot", package: "ithaca", audits, profile: { ...profile, clusterSize: 1 } }));
    expect(plan.clusters[0]!.seed).toBe(BOW);
  });

  test("the sweep queue keeps its oldest-audit order: an unfinished file deferred again does not hold every run", () => {
    const audits = new Map([...ledgerState([record([finding(BOW, "settling-sleep", { deferredFor: "budget" })])], NOW).audits,
      audited(SAILS, "2026-07-01T00:00:00Z", "edited")]);
    const plan = planRun(input({ mode: "sweep", package: "ithaca", audits, profile: { ...profile, clusterSize: 1, budgetFiles: null } }));
    const seeds = plan.clusters.map(cluster => cluster.seed);
    // Never-audited files first, then the oldest audit (SAILS, 07-01), then BOW's audit of 07-11.
    expect(seeds.indexOf(BOW)).toBeGreaterThan(seeds.indexOf(SAILS));
    expect(seeds.indexOf(SAILS)).toBeGreaterThan(seeds.indexOf(LOOM));
  });

  test("a prepared patch that changes only a helper still belongs to the unfinished file it resumes", () => {
    const helper = "packages/ithaca/tests/helpers/bow.ts";
    const withPatch = { ...record([finding(BOW, "settling-sleep", { deferredFor: "proof" })]),
      wip: { path: "wip/th-old-0.patch", sha256: "0".repeat(64), bytes: 10, files: [helper] } };
    const audits = ledgerState([withPatch], NOW).audits;
    expect([audits.get(BOW)?.wip, audits.get(BOW_STRING)?.wip]).toEqual(["wip/th-old-0.patch", undefined]);
  });

  test("a record from before deferredFor, shaped like th-20261110115220-5ecaed#0, leaves its browser file unfinished", () => {
    const REVIEW = "packages/ui-react/tests/browser/hygiene-review.layout.tsx";
    const MEDIA = "packages/ui-react/tests/browser/hygiene-media-flow.layout.tsx";
    const HANDOFF = "packages/ui-react/tests/render/handoff-entry.test.tsx";
    const deferred = (id: string, lens: string, smell: string, action: string) => ({ id, file: REVIEW, lens, smell, action, status: "deferred", note: "Left for a later run." });
    const accepted = (id: string, file: string, lens: string, smell: string) => ({ id, file, lens, smell, action: "none", status: "accepted", note: "Fine in context." });
    const old: ClusterRecord = { v: 1, type: "cluster", at, runId: "th-20261110115220-5ecaed", cluster: 0, batchId: "ui-react-th-20261110115220-5ecaed",
      commit: "c".repeat(40), package: "ui-react",
      audits: [{ file: REVIEW, blobBefore: "review", blobAfter: "review", lenses }, { file: MEDIA, blobBefore: "media", blobAfter: "media-fixed", lenses },
        { file: HANDOFF, blobBefore: "handoff", blobAfter: "handoff", lenses }],
      worksheet: { schemaVersion: 1, runId: "th-20261110115220-5ecaed", cluster: 0, seed: REVIEW, members: [REVIEW, MEDIA, HANDOFF], context: [], audits: [], findings: [
        deferred("F1", "failure-issues", "test-fault", "deflake"), deferred("F2", "failure-issues", "unreproduced", "deflake"),
        deferred("F3", "failure-issues", "unreproduced", "deflake"), deferred("F4", "overlap", "matrix-multiplier", "remove"),
        accepted("F5", REVIEW, "nondeterminism", "settling-sleep"),
        { id: "F8", file: MEDIA, lens: "cannot-fail", smell: "conditional-assertion", action: "strengthen", status: "fixed", note: "Asserts the media now." },
        accepted("F10", HANDOFF, "cannot-fail", "weak-matcher"),
      ] } as never };
    const audits = ledgerState([old], NOW).audits;
    const state = (file: string, blob: string) => fileState(row(file, { blob }), audits.get(file), NOW, 180);
    expect([state(REVIEW, "review"), state(MEDIA, "media-fixed"), state(HANDOFF, "handoff")]).toEqual(["unfinished", "fresh", "fresh"]);
    expect(audits.get(REVIEW)!.deferred!.map(entry => [entry.id, entry.deferredFor])).toEqual([["F1", "budget"], ["F2", "unreproduced"], ["F3", "unreproduced"], ["F4", "budget"]]);
  });
});

describe("mapping open failure issues to test files", () => {
  const files = [BOW, BOW_RUNTIME, "packages/ithaca/tests/connection-continuity-runtime.test.ts", "packages/pylos/tests/bow.test.ts"];
  const issue = (number: number, title: string, body = "", labels = ["type: test"]): Issue => ({ number, title, body, labels, assignees: 0 });

  test("an issue maps by full path, by a unique file name, or by a unique distinctive stem", () => {
    const mapped = mapIssues([
      issue(1, "bow flake", `Fails in \`${BOW}\` under load.`),
      issue(2, "bow-runtime.test.ts times out"),
      issue(3, "ui: connection-continuity-runtime loses its socket", "", ["type: test", "needs: repro"]),
    ], files);
    expect([...mapped].map(([file, refs]) => [file, refs.map(ref => ref.number)])).toEqual([
      [BOW, [1]], [BOW_RUNTIME, [2]], ["packages/ithaca/tests/connection-continuity-runtime.test.ts", [3]]]);
    expect(mapped.get("packages/ithaca/tests/connection-continuity-runtime.test.ts")![0]!.needsRepro).toBe(true);
  });

  test("a name two files share, or a short ordinary word, maps to nothing", () => {
    expect(mapIssues([issue(4, "bow.test.ts is flaky"), issue(5, "the bow breaks")], files).size).toBe(0);
  });

  test("an issue that is neither a test issue nor reads like a failure is ignored", () => {
    expect(mapIssues([issue(6, "feat: string the bow", `See ${BOW}`, ["type: feat"])], files).size).toBe(0);
    expect(mapIssues([issue(7, "bow shot is intermittent", `See ${BOW}`, ["type: fix"])], files).get(BOW)!.length).toBe(1);
  });
});
