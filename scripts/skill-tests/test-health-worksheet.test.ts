import { describe, expect, test } from "bun:test";
import { ACTIONS, LENS_IDS, REDUCING_ACTIONS, SMELLS, requiredEvidence, type LensId, type LensVerdict } from "../test-health/catalog";
import { parseConfig } from "../test-health/config";
import { resolveWorksheet, validateWorksheet, type DraftWorksheet, type Finding, type Worksheet } from "../test-health/worksheet";

const OARS = "packages/ithaca/tests/oars.test.ts";
const SAILS = "packages/ithaca/tests/sails.test.ts";
const HARBOUR = "packages/pylos/tests/harbour-runtime.test.ts";

const lenses = (overrides: Partial<Record<LensId, LensVerdict>> = {}) =>
  Object.fromEntries(LENS_IDS.map(lens => [lens, overrides[lens] ?? "clean"])) as Record<LensId, LensVerdict>;

function sheet(findings: Finding[] = [], verdicts: Partial<Record<LensId, LensVerdict>> = {}): Worksheet {
  return { schemaVersion: 1, runId: "th-20260712000000-abc123", cluster: 0, seed: OARS, members: [OARS, SAILS], context: [HARBOUR],
    audits: [{ file: OARS, lenses: lenses(verdicts) }, { file: SAILS, lenses: lenses() }], findings };
}
const killed = (test = OARS) => ({ verdict: "killed", test, patchSha256: "a".repeat(64), expect: "Expected: 12" });
const validate = (value: Worksheet) => validateWorksheet(value, { stableRuns: 10 });

describe("the catalogue", () => {
  test("smell ids are unique and each belongs to a known lens", () => {
    expect(new Set(SMELLS.map(smell => smell.id)).size).toBe(SMELLS.length);
    expect(SMELLS.filter(smell => !LENS_IDS.includes(smell.lens))).toEqual([]);
  });

  test("every lens has at least one smell", () => {
    expect(LENS_IDS.filter(lens => !SMELLS.some(smell => smell.lens === lens))).toEqual([]);
  });

  test("only static smells carry a ranking weight", () => {
    expect(SMELLS.filter(smell => (smell.weight > 0) !== (smell.detect === "static")).map(smell => smell.id)).toEqual([]);
  });

  test("every action that takes assertions away needs an obligation map and a killed mutation", () => {
    for (const action of REDUCING_ACTIONS) expect(requiredEvidence("overlap", action).sort()).toEqual(["mutation", "obligations"]);
    expect(ACTIONS.filter(action => requiredEvidence("hygiene", action).includes("obligations"))).toEqual([...REDUCING_ACTIONS]);
  });
});

describe("a worksheet that may be recorded", () => {
  test("a clean audit of every member through every lens is valid", () => {
    expect(validate(sheet())).toEqual([]);
  });

  test("a fixed cannot-fail finding with a killed mutation on its own file is valid", () => {
    const finding: Finding = { id: "F1", file: OARS, lens: "cannot-fail", smell: "weak-matcher", action: "strengthen", status: "fixed",
      note: "toBeDefined replaced by the crew list", evidence: { mutation: killed() } };
    expect(validate(sheet([finding], { "cannot-fail": "findings" }))).toEqual([]);
  });
});

describe("evidence a fixed finding must carry", () => {
  const fixed = (overrides: Partial<Finding>): Worksheet => {
    const finding: Finding = { id: "F1", file: OARS, lens: "cannot-fail", smell: "weak-matcher", action: "strengthen", status: "fixed", note: "strengthened", ...overrides };
    return sheet([finding], { [finding.lens]: "findings" });
  };

  test("a cannot-fail fix without a mutation receipt is refused", () => {
    expect(validate(fixed({}))).toEqual(["finding F1: needs a mutation receipt"]);
  });

  test("a mutation that survived is refused", () => {
    expect(validate(fixed({ evidence: { mutation: { ...killed(), verdict: "survived" } } }))).toEqual(["finding F1: the mutation was not killed (survived)"]);
  });

  test("a mutation receipt for another file is refused", () => {
    expect(validate(fixed({ evidence: { mutation: killed(SAILS) } }))).toEqual([`finding F1: the mutation receipt is for ${SAILS}`]);
  });

  test("a rewrite in any lens needs a killed mutation, and a cleanup does not", () => {
    const rewrite = { lens: "tier-and-doubles" as const, smell: "double-too-high", action: "rewrite" as const };
    expect(validate(fixed(rewrite))).toEqual(["finding F1: needs a mutation receipt"]);
    expect(validate(fixed({ ...rewrite, evidence: { mutation: killed() } }))).toEqual([]);
    expect(validate(fixed({ lens: "hygiene", smell: "unclear-name", action: "cleanup" }))).toEqual([]);
  });

  test("a removal needs an obligation map as well as a killed mutation on the retained owner", () => {
    const removal = { lens: "overlap" as const, smell: "duplicate-case", action: "remove" as const };
    const removes = ["counts the oars again"];
    expect(validate(fixed({ ...removal, evidence: { removes, mutation: killed(SAILS) } }))).toEqual(["finding F1: needs an obligation map"]);
    expect(validate(fixed({ ...removal, evidence: { removes, mutation: killed(SAILS), obligations: [{ claim: "twelve oars", owner: `${SAILS} > counts the oars` }] } }))).toEqual([]);
    expect(validate(fixed({ ...removal, evidence: { removes, mutation: killed(SAILS), obligations: [{ claim: "twelve oars", owner: "" }] } })))
      .toEqual(["finding F1: every obligation names a claim and its retained owner"]);
  });

  test("a removal names the tests it removes, and nothing else may declare a removed test", () => {
    const proof = { mutation: killed(SAILS), obligations: [{ claim: "twelve oars", owner: `${SAILS} > counts the oars` }] };
    const removal = { lens: "overlap" as const, smell: "duplicate-case", action: "remove" as const };
    expect(validate(fixed({ ...removal, evidence: proof })))
      .toEqual(["finding F1: names the tests it removes (evidence.removes), or how many executed cases it removes (evidence.removedCases)"]);
    expect(validate(fixed({ ...removal, evidence: { ...proof, removedCases: 2 } }))).toEqual([]);
    expect(validate(fixed({ lens: "hygiene", smell: "unclear-name", action: "cleanup", evidence: { removes: ["has oars"] } })))
      .toEqual(["finding F1: only a fixed remove, merge or move-tier finding may declare removed tests"]);
    expect(validate(fixed({ lens: "hygiene", smell: "unclear-name", action: "cleanup", evidence: { renames: [{ from: "works", to: "counts the oars" }] } }))).toEqual([]);
    expect(validate(fixed({ lens: "hygiene", smell: "unclear-name", action: "cleanup", evidence: { renames: [{ from: "works", to: "" }] } })))
      .toEqual(["finding F1: renames is a list of { from, to } titles"]);
  });

  test("a deflake needs the configured number of clean runs after the change", () => {
    const deflake = { lens: "nondeterminism" as const, smell: "settling-sleep", action: "deflake" as const };
    expect(validate(fixed({ ...deflake, evidence: { after: { runs: 9, failures: 0, medianMs: 40 } } })))
      .toEqual(["finding F1: needs 10 clean runs after the change (0 failed of 9)"]);
    expect(validate(fixed({ ...deflake, evidence: { after: { runs: 12, failures: 1, medianMs: 40 } } })))
      .toEqual(["finding F1: needs 10 clean runs after the change (1 failed of 12)"]);
    expect(validate(fixed({ ...deflake, evidence: { after: { runs: 10, failures: 0, medianMs: 40 } } }))).toEqual([]);
  });

  test("a speed-up must be measurably faster on passing runs", () => {
    const speed = { lens: "cost" as const, smell: "real-time-wait", action: "speed-up" as const };
    const runs = (medianMs: number, failures = 0) => ({ runs: 5, failures, medianMs });
    expect(validate(fixed({ ...speed, evidence: { before: runs(900), after: runs(900) } }))).toEqual(["finding F1: not faster (900 ms before, 900 ms after)"]);
    expect(validate(fixed({ ...speed, evidence: { before: runs(900), after: runs(300, 1) } }))).toEqual(["finding F1: timings from failing runs prove nothing"]);
    expect(validate(fixed({ ...speed, evidence: { before: runs(900), after: runs(300) } }))).toEqual([]);
  });
});

describe("consistency between audits and findings", () => {
  const finding = (overrides: Partial<Finding> = {}): Finding =>
    ({ id: "F1", file: OARS, lens: "hygiene", smell: "unclear-name", action: "cleanup", status: "fixed", note: "renamed to state the claim", ...overrides });

  test("a lens marked clean cannot carry an open finding", () => {
    expect(validate(sheet([finding()]))).toEqual([`${OARS}: lens hygiene says clean but has 1 finding(s)`]);
  });

  test("a lens marked findings must list one", () => {
    expect(validate(sheet([], { hygiene: "findings" }))).toEqual([`${OARS}: lens hygiene says findings but lists none`]);
  });

  test("an accepted finding leaves its lens clean", () => {
    expect(validate(sheet([finding({ action: "none", status: "accepted", note: "the name is the documented scenario id" })]))).toEqual([]);
  });

  test("a smell is refused under a lens it does not belong to", () => {
    expect(validate(sheet([finding({ lens: "cost" })], { cost: "findings" }))).toContain("finding F1: smell unclear-name belongs to lens hygiene");
  });

  test("a context file is read-only: its finding cannot be fixed here", () => {
    expect(validate(sheet([finding({ file: HARBOUR })]))).toEqual(["finding F1: a context file is read-only; defer the finding to its own package"]);
    expect(validate(sheet([finding({ file: HARBOUR, status: "deferred", deferredFor: "context" })]))).toEqual([]);
  });

  test("a deferred finding says why, with a known reason, and only a deferred finding carries one", () => {
    const deferred = (extra: Partial<Finding>) => validate(sheet([finding({ status: "deferred", ...extra })], { hygiene: "findings" }));
    const why = "finding F1: a deferred finding says why in deferredFor (budget, proof, assigned, unreproduced, context)";
    expect(deferred({})).toEqual([why]);
    expect(deferred({ deferredFor: "tired" as never })).toEqual([why]);
    expect(deferred({ deferredFor: "budget" })).toEqual([]);
    expect(deferred({ deferredFor: "context" })).toEqual(["finding F1: deferredFor context is for a finding on a context file"]);
    expect(validate(sheet([finding({ action: "none", status: "accepted", note: "fine", deferredFor: "budget" })])))
      .toEqual(["finding F1: only a deferred finding carries deferredFor"]);
  });

  test("a filed finding names its issue", () => {
    const filed = finding({ action: "file-issue", status: "filed" });
    expect(validate(sheet([filed], { hygiene: "findings" }))).toEqual(["finding F1: a filed finding names its issue number"]);
    expect(validate(sheet([{ ...filed, evidence: { issue: 4242 } }], { hygiene: "findings" }))).toEqual([]);
  });

  test("a member without an audit, and a lens without a verdict, are refused", () => {
    const missing = sheet();
    missing.audits.pop();
    expect(validate(missing)).toEqual([`${SAILS}: a member without an audit`]);
    const todo = sheet();
    (todo.audits[0]!.lenses as Record<string, string>).cost = "TODO";
    expect(validate(todo)).toContain(`${OARS}: lens cost needs one of clean, findings, not-applicable`);
  });
});

describe("resolving a draft", () => {
  const draft: DraftWorksheet = { ...sheet(), findings: [
    { id: "F1", file: OARS, lens: "cannot-fail", smell: "weak-matcher", action: "strengthen", status: "fixed", note: "strengthened", evidence: { mutation: "receipts/F1.json" } },
    { id: "F2", file: SAILS, lens: "cost", smell: "real-time-wait", action: "speed-up", status: "fixed", note: "clock controlled", evidence: { before: "before.json", after: "after.json" } },
  ] };
  const files: Record<string, unknown> = {
    "receipts/F1.json": { ...killed(), tool: "test-health mutate" },
    "before.json": { files: [{ file: SAILS, runs: 5, failures: 0, medianMs: 1800 }] },
    "after.json": { files: [{ file: SAILS, runs: 5, failures: 0, medianMs: 200 }, { file: OARS, runs: 5, failures: 2, medianMs: 10 }] },
  };

  test("evidence paths become the receipts and the measurement of the finding's own file", () => {
    const resolved = resolveWorksheet(draft, path => files[path]);
    expect(resolved.findings[0]!.evidence).toEqual({ mutation: killed() });
    expect(resolved.findings[1]!.evidence).toEqual({ before: { runs: 5, failures: 0, medianMs: 1800 }, after: { runs: 5, failures: 0, medianMs: 200 } });
  });

  test("a file that is not a mutation receipt, or measures another file, is refused", () => {
    expect(() => resolveWorksheet(draft, path => path === "receipts/F1.json" ? { verdict: "killed" } : files[path])).toThrow("F1: receipts/F1.json is not a mutation receipt");
    expect(() => resolveWorksheet(draft, path => path === "before.json" ? { files: [{ file: OARS, runs: 5, failures: 0 }] } : files[path])).toThrow(`F2 before: no measurement of ${SAILS}`);
  });
});

describe("configuration profiles", () => {
  const text = JSON.stringify({ ledgerRemote: "origin", ledgerRef: "refs/heads/brain-test-health",
    defaults: { base: "origin/main", clusterSize: 5, budgetFiles: 25, sweepEvery: 2, claimHours: 3, reauditDays: 180, smallPackageFiles: 25, wipMaxBytes: 262144, proofOverrunMinutes: 60,
      ripe: { changedFiles: 25, ageHours: 72, maxChangedFiles: 60, whenExhausted: true } },
    profiles: { cron: {}, push: { budgetFiles: null, ripe: { changedFiles: null } } } });

  test("a profile overrides only what it names, and null replaces a number", () => {
    const push = parseConfig(text, "push").profile;
    expect([push.budgetFiles, push.ripe.changedFiles, push.ripe.ageHours, push.clusterSize]).toEqual([null, null, 72, 5]);
    expect(parseConfig(text, "cron").profile.budgetFiles).toBe(25);
  });

  test("a command-line base overrides the profile, and an unknown profile is refused", () => {
    expect(parseConfig(text, "push", { base: "origin/epic/9-ithaca" }).profile.base).toBe("origin/epic/9-ithaca");
    expect(() => parseConfig(text, "nightly")).toThrow("Unknown test-health profile: nightly (known: cron, push)");
  });
});
