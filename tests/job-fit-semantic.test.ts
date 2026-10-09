import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJevClient, type JevRequest } from "../packages/core/src/lib/jev";
import { scoreJob, loadScoringConfig } from "../packages/module-jobs/src/score";
import { benchmark, benchmarkInput, researchPacket, BENCHMARK_SHA, LEAKING_TERMS, type BenchmarkCase } from "../scripts/evals/job-fit/benchmark";
import { config } from "../scripts/evals/job-fit/fixtures";
import { assessSemantic, calibrate, EVIDENCE_PRECEDENCE, semanticRanking, semanticRequest } from "../scripts/evals/job-fit/semantic";
import { observe, prepare, materialize } from "../scripts/evals/job-fit/brain";
import { grade } from "../scripts/evals/job-fit/metrics";
function client(c: BenchmarkCase, probability = 1, model = "jev-1.13.0", capture?: (r: JevRequest) => void) {
  // The remaining mass goes to one other option so the distribution always sums to 1;
  // the core client rejects anything else as a bad response.
  const answer = (choice: string) => {
    const probabilities: Record<string, number> = { met: 0, not_met: 0, unclear: 0 };
    probabilities[choice] = probability; probabilities[choice === "unclear" ? "met" : "unclear"] += 1 - probability;
    return { type: "choice", choice, confidence: 1, probabilities };
  };
  return createJevClient({ apiKey: "offline-sentinel", endpoint: "http://127.0.0.1/semantic-control", retryDelayMs: 0,
    fetch: async (_url, init) => { capture?.(JSON.parse(String(init.body))); return Response.json({ model, answers: { passage: answer(c.passage), relocation: answer(c.relocation) }, usage: { input_tokens: 400, output_tokens: 17 } }); } });
}
test("fresh companies/families/prose split and complete input/request/research identities", () => {
  expect(benchmark).toHaveLength(29);
  expect(benchmark.filter(c => c.split === "tuning")).toHaveLength(10);
  for (const field of ["id", "company", "family", "prose"] as const) expect(new Set(benchmark.map(c => c[field])).size, field).toBe(29);
  const tune = benchmark.filter(c => c.split === "tuning"), held = benchmark.filter(c => c.split === "held-out");
  for (const criterion of ["passage", "relocation"] as const) expect([...new Set(tune.map(c => c[criterion]))].sort()).toEqual(["met", "not_met", "unclear"]);
  // The critical classes a go/no-go gate counts misses on need more than one example each.
  expect(held.filter(c => c.relocation === "met").length).toBeGreaterThanOrEqual(4);
  expect(held.filter(c => c.passage === "not_met").length).toBeGreaterThanOrEqual(4);
  expect(held.filter(c => c.passage === "unclear").length).toBeGreaterThanOrEqual(1);
  expect(tune.filter(c => c.relocation === "met").length).toBeGreaterThanOrEqual(2);
  // Goldens are semantic eligibility, never the literal veto's own output.
  for (const c of benchmark.filter(c => c.literalFalseExclusion)) expect(c.decision, c.id).toBe("candidate");
  // A posting never narrates its own label or the harness that grades it.
  for (const c of benchmark) for (const term of LEAKING_TERMS) expect(c.prose.toLowerCase(), `${c.id}: ${term}`).not.toContain(term);
  const levels: Array<BenchmarkCase["autonomy"]> = [0, 1, 2, null];
  expect([...new Set(tune.map(c => c.autonomy))].sort()).toEqual(levels.sort());
  expect(BENCHMARK_SHA).toHaveLength(64);
  for (const c of benchmark) {
    const input = benchmarkInput(c), req = semanticRequest(input);
    expect(input.posting).toContain(c.prose); expect(input.criteria.length).toBeGreaterThan(200); expect(input.identity.length).toBeGreaterThan(100);
    expect(req.state).toEqual({ posting: input.posting, metadata: input.job, criteria: input.criteria, identity: input.identity });
    expect(JSON.stringify(req)).not.toContain('"split"'); expect(JSON.stringify(req)).not.toContain('"decision"');
    expect(JSON.stringify(req)).not.toContain('"autonomy"');
    expect(researchPacket(c).unknown).toHaveLength(4);
    expect(researchPacket(c).externalResearchAllowed).toBe(false);
  }
});
test.each(benchmark)("$id: actual Choice parser and ranking retain arithmetic/exclusions/source", async c => {
  const input = benchmarkInput(c), before = JSON.stringify(input), asks: JevRequest[] = [];
  const row = await assessSemantic(input, client(c, 1, "jev-1.13.0", r => asks.push(r)), 1);
  const routed = c.literalFalseExclusion ? "excluded" : c.decision;
  expect(row.decision, c.id).toBe(routed);
  expect(semanticRanking([row])).toEqual(routed === "candidate" ? [c.id] : []);
  expect(row.baseline).toEqual(scoreJob(input.job, input.config));
  expect(row.hybrid.compensation).toBe(row.baseline.compensation);
  expect(row.hybrid.location).toBe(row.baseline.location);
  expect(row.hybrid.autonomy).toBe(row.baseline.autonomy);
  expect(row.evidence.posting).toBe(input.posting); expect(row.evidence.metadata).toEqual(input.job);
  expect(row.ordinalPreferenceMeasured).toBe(false); expect(row.effect).toBeNull();
  expect(asks).toHaveLength(1); expect(asks[0]).toEqual(semanticRequest(input));
  expect(JSON.stringify(input)).toBe(before);
  if (c.literalFalseExclusion) { expect(row.literalLocationMatches.length).toBeGreaterThan(0); expect(row.semanticDealbreaker).toBe(false); }
});
test.each(["tune-home", "tune-implicit-relocation", "tune-unknown-pay", "held-low-guarantee", "held-title-filter", "held-housing-condition", "held-remote-but-domicile", "held-both-fail", "held-instrument-keeper"])("%s cannot enter the actual candidate ranking", async id => {
  const c = benchmark.find(c => c.id === id)!;
  const row = await assessSemantic(benchmarkInput(c), client(c), 1);
  expect(semanticRanking([row])).toEqual([]);
  expect(row.decision).not.toBe("candidate");
});
test("low selected probability at confidence1 stays out of actual ranking", async () => {
  const c = benchmark[0];
  const row = await assessSemantic(benchmarkInput(c), client(c, 0.01), 0.9);
  expect(semanticRanking([row])).toEqual([]);
  expect(row.judgments).toBeNull(); expect(row.decision).toBe("review");
  // The answer the model actually gave survives for ungated grading.
  expect(row.rawAnswers?.passage.choice).toBe(c.passage); expect(row.rawAnswers?.relocation.choice).toBe(c.relocation);
});
test("null gate dispatches nothing; exact requested model is checked", async () => {
  const c = benchmark[0]; let calls = 0;
  const fake = client(c, 1, "jev-1.13.0", () => calls++);
  const uncalibrated = await assessSemantic(benchmarkInput(c), fake, null);
  expect(calls).toBe(0); expect(semanticRanking([uncalibrated])).toEqual([]);
  const mismatched = await assessSemantic(benchmarkInput(c), client(c, 1, "jev-latest"), 1);
  expect(semanticRanking([mismatched])).toEqual([]);
  expect(mismatched.judgments).toBeNull(); expect(mismatched.rawAnswers).toBeNull();
});
test("binding evidence precedence is explicit, not fabricated metadata", () => {
  expect(EVIDENCE_PRECEDENCE).toContain("Contradictory current binding clauses remain unclear");
  const conflicting = benchmarkInput(benchmark.find(c => c.id === "held-contradictory")!);
  expect(conflicting.job.location).toBe("Troy"); expect(conflicting.job.remote_type).toBeNull();
  const absent = benchmarkInput(benchmark.find(c => c.id === "held-no-residence")!);
  expect(absent.job.location).toBeNull(); expect(absent.job.remote_type).toBe("fully_remote");
  expect(absent.posting.toLowerCase()).not.toContain("residen"); // The posting is silent; only the metadata says remote.
});
test("complete tuning-only calibration excludes held-out rows and all-unknown results", () => {
  const rows = benchmark.filter(c => c.split === "tuning").map(c => ({ id: c.id, split: c.split, accepted: c.decision === "candidate", correct: true, probability: 0.95, confidence: 0.95 }));
  const ids = rows.map(r => r.id);
  expect(calibrate(rows, ids)).toBe(0.7);
  expect(() => calibrate(rows.slice(1), ids)).toThrow("Complete tuning-only");
  expect(() => calibrate([{ ...rows[0], split: "held-out" }, ...rows.slice(1)], ids)).toThrow("Complete tuning-only");
  expect(calibrate(rows.map(r => ({ ...r, accepted: false })), ids)).toBeNull();
});
test.each(benchmark)("$id: full persisted jobs module inputs stay byte-identical during actual report-only assessment", async c => {
  const env = await prepare(c);
  try {
    expect(env.brain.taxonomy.types.opportunity.dir).toBe("career/opportunities");
    expect(env.brain.taxonomy.types.tablet.dir).toBe("tablets");
    const before = observe(env.root);
    expect(Object.keys(before).length).toBeGreaterThan(15);
    const row = await assessSemantic(env.input, client(c), 1);
    expect(row.decision).toBe(c.literalFalseExclusion ? "excluded" : c.decision);
    expect(observe(env.root)).toEqual(before);
  } finally { env.close(); }
});
test("scripted full-denominator confusion retains unknowns and literal false exclusions without a measured verdict", async () => {
  const rows = await Promise.all(benchmark.map(c => assessSemantic(benchmarkInput(c), client(c), 1)));
  const report = grade(benchmark, rows, "scripted-control", config);
  expect(report.denominator).toBe(29);
  // The installed keyword routing is keyless, so its floor is a measurement, not a control:
  // it queues two relocation dealbreakers and three must-have failures and dismisses one eligible role.
  expect(report.keywordBaseline).toEqual({ agreement: 20 / 29, precision: 5 / 11, recall: 5 / 8, candidates: [
    "held-board-vs-contract", "held-instrument-keeper", "held-misleading", "held-old-title", "held-remote-but-domicile", "held-season-quarters",
    "held-troy-distractor", "tune-advertisement", "tune-ledger", "tune-negated-marker", "tune-unknown-pay",
  ], criticalDealbreakerMisses: 2, mustHaveMisses: 3, eligibleDismissed: 1 });
  expect(report.reviewEverythingFloor).toBe(21 / 29);
  expect(grade(benchmark, rows, "scripted-control").keywordBaseline).toBeNull();
  // Scripted gold answers still lose the two literal false exclusions: the golden is eligibility, not the veto.
  expect(report.membershipAgreement).toBe(27 / 29);
  expect(report.expectedCandidates).toHaveLength(8); expect(report.actualCandidates).toHaveLength(6);
  expect(report.candidatePrecision).toBe(1); expect(report.candidateRecall).toBe(6 / 8);
  expect(report.expectedCandidates).toContain("held-quoted-marker"); expect(report.actualCandidates).not.toContain("held-quoted-marker");
  expect(report.confusion.passage["unclear=>unclear"]).toBe(2);
  expect(report.confusion.relocation["unclear=>unclear"]).toBe(4);
  expect(report.rawConfusion).toEqual(report.confusion);
  expect(report.unknown).toEqual({ labels: 6, answered: 0, abstained: 6 });
  expect(report.literalFalseExclusions).toBe(2); expect(report.criticalDealbreakerMisses).toBe(0); expect(report.mustHaveMisses).toBe(0);
  expect(report.labelsApproved).toBeNull(); expect(report.pairwiseRankingAgreement).toBeNull(); expect(report.goNoGo).toBeNull();
  expect(report.measuredProviderCostUsd).toBeNull(); expect(report.reviewEffortSeconds).toBeNull();
  expect(() => grade(benchmark, rows.slice(1), "scripted-control")).toThrow("Complete unique");
});
test("a floor that admits nothing still grades the raw answers the model gave", async () => {
  // Selected probability 0.6 under a 0.9 floor: no judgment is admitted anywhere.
  const rows = await Promise.all(benchmark.map(c => assessSemantic(benchmarkInput(c), client(c, 0.6), 0.9)));
  expect(rows.every(r => r.judgments === null)).toBe(true);
  const report = grade(benchmark, rows, "scripted-control");
  const met = benchmark.filter(c => c.passage === "met").length;
  expect(report.confusion.passage["met=>unclear"]).toBe(met);
  expect(report.rawConfusion.passage["met=>met"]).toBe(met);
  expect(report.rawConfusion.relocation["met=>met"]).toBe(benchmark.filter(c => c.relocation === "met").length);
  expect(report.rawConfusion.passage["met=>no_answer"]).toBeUndefined();
});
test("critical misses count a must-have failure routed to candidate, not only the dealbreaker", async () => {
  const c = benchmark.find(c => c.id === "held-instrument-keeper")!;
  // A wrong but confident answer: the model says the must-have is met.
  const wrong = { ...c, passage: "met" as const };
  const row = await assessSemantic(benchmarkInput(c), client(wrong), 1);
  expect(row.decision).toBe("candidate");
  const others = await Promise.all(benchmark.filter(o => o.id !== c.id).map(o => assessSemantic(benchmarkInput(o), client(o), 1)));
  const report = grade(benchmark, [row, ...others], "scripted-control");
  expect(report.mustHaveMisses).toBe(1); expect(report.criticalDealbreakerMisses).toBe(0);
  expect(report.candidatePrecision).toBe(6 / 7);
});


test("native input paths expose neither private case IDs nor split/golden labels", () => {
  for (const c of benchmark) {
    const files = materialize(c);
    expect(Object.keys(files).filter(p => p.startsWith("career/opportunities/"))).toEqual([
      "career/opportunities/voyage-role/posting.md", "career/opportunities/voyage-role/status.md", "career/opportunities/voyage-role/company-packet.md",
    ]);
    expect(JSON.stringify(files)).not.toContain(c.id);
    expect(JSON.stringify(files)).not.toContain('"split":');
  }
});
test("actual persisted jobs scoring resolves the same nonempty rules as the frozen numeric arm", async () => {
  const c = benchmark[0]!, env = await prepare(c);
  try {
    const resolved = loadScoringConfig(env.root, "career/criteria.md");
    expect(resolved.groups.map(g => g.name)).toEqual(["passage", "autonomy", "seniority"]);
    expect(resolved).toEqual(env.input.config);
    expect(scoreJob(env.input.job, resolved)).toEqual(scoreJob(env.input.job, env.input.config));
  } finally { env.close(); }
});

// Independent actual filesystem controls for the complete effect observer.
test("whole-fixture observer detects binary changes, extra members, same-length link retargeting and same-byte touches", () => {
  const root = mkdtempSync(join(tmpdir(), "job-fit-effect-")), binary = join(root, "guard.bin"), link = join(root, "route");
  try {
    writeFileSync(binary, Buffer.from([0, 255, 128, 13, 10]));
    writeFileSync(join(root, "alpha"), "same"); writeFileSync(join(root, "omega"), "same");
    symlinkSync("alpha", link); const before = observe(root);
    writeFileSync(binary, Buffer.from([0, 254, 128, 13, 10]));
    expect((observe(root)["guard.bin"] as { content: string }).content).not.toBe((before["guard.bin"] as { content: string }).content);
    writeFileSync(join(root, "extra.bin"), Buffer.from([0])); expect(Object.keys(observe(root))).toContain("extra.bin");
    unlinkSync(link); symlinkSync("omega", link);
    expect((observe(root).route as { content: string }).content).toBe("omega");
    expect((before.route as { content: string }).content).toBe("alpha");
    const touchBefore = observe(root); utimesSync(join(root, "alpha"), 1234, 5678); const touched = observe(root);
    expect((touched.alpha as { content: string }).content).toBe((touchBefore.alpha as { content: string }).content);
    expect((touched.alpha as { mtimeNs: string }).mtimeNs).not.toBe((touchBefore.alpha as { mtimeNs: string }).mtimeNs);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
