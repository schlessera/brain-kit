import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import { documents, type Fixture, type Plan, vocabulary } from "./pipeline";

/** Evaluate real post-write documents; counters are not inferred from a planner. */
export function observe(f: Fixture, root: string, plan?: Plan) {
  const after = documents(root), before = f.files;
  const changedExisting = Object.keys(before).filter(path => after.find(d => d.path === path)?.raw !== before[path]);
  const captured = after.filter(d => parseFrontmatter(d.raw).content.includes(f.content.trim()));
  const originalsRetained = Object.entries(before).every(([path, raw]) => {
    const actual = after.find(d => d.path === path);
    return actual && parseFrontmatter(actual.raw).content.includes(parseFrontmatter(raw).content.trim());
  });
  const metadataRetained = Object.entries(before).every(([path, raw]) => {
    const actual = after.find(d => d.path === path);
    return actual && Object.entries(parseFrontmatter(raw).data).filter(([key]) => key !== "updated")
      .every(([key, value]) => JSON.stringify(parseFrontmatter(actual.raw).data[key]) === JSON.stringify(value));
  });
  const created = after.filter(d => !Object.hasOwn(before, d.path));
  const unintendedCreates = Math.max(0, created.length - (f.generation ? 2 : f.expected.appendTarget ? 0 : 1));
  const wrongTargetAppend = changedExisting.some(path => path !== f.expected.appendTarget);
  const appendTarget = changedExisting.length === 1 ? changedExisting[0]! : null;
  const capture = captured.find(d => !Object.hasOwn(before, d.path)) ?? captured[0];
  const parsed = capture ? parseFrontmatter(capture.raw) : null;
  const actualTags = parsed && Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [];
  const truePositiveTags = actualTags.filter(tag => f.expected.tags.includes(tag)).length;
  const draftBodies = after.filter(d => !Object.hasOwn(before, d.path) && !parseFrontmatter(d.raw).content.includes(f.content.trim())).map(d => `${String(parseFrontmatter(d.raw).data.title ?? "")}\n${parseFrontmatter(d.raw).content}`);
  const generatedFactsKept = f.generation ? draftBodies.some(body => /\b(?:Penelope|she)\b/i.test(body) && /\b(?:three|3)\b/i.test(body) && /\bsealed\b/i.test(body) && /\bcracked\b/i.test(body) && /\b(?:separat\w*|apart|aside|distinct)\b|\baway from\b/i.test(body) && !/\b(?:two|four|five|six|seven|eight|nine|ten)\b/i.test(body)) : null;
  return {
    actualType: capture?.type ?? null, expectedType: f.expected.type,
    correctType: capture?.type === f.expected.type, captureRetained: captured.length > 0,
    originalsRetained, metadataRetained, contentLoss: !captured.length || !originalsRetained || !metadataRetained, unintendedCreates,
    changedExisting, appendTarget, correctAppendTarget: appendTarget === f.expected.appendTarget,
    wrongTargetAppend, expectedReviewTarget: f.expected.reviewTarget, reviewTarget: plan?.reviewTarget ?? null,
    correctReviewTarget: (plan?.reviewTarget ?? null) === f.expected.reviewTarget,
    actualTags, truePositiveTags, predictedTags: actualTags.length, expectedTags: f.expected.tags.length,
    tagPrecision: actualTags.length ? truePositiveTags / actualTags.length : null,
    tagRecall: f.expected.tags.length ? truePositiveTags / f.expected.tags.length : null,
    inventedTags: actualTags.filter(tag => !vocabulary.includes(tag)),
    generationRequested: f.generation !== null, generatedFactsKept,
    abstained: capture?.type === "note" && !changedExisting.length && !plan?.reviewTarget,
    files: Object.fromEntries(after.map(d => [d.path, d.raw])),
  };
}
export function chooseThreshold(rows: Array<{ fixture: Fixture; plan: (threshold: number) => Plan }>) {
  if (rows.some(row => row.fixture.split !== "tuning")) throw Error("Held-out rows cannot tune gates");
  for (const threshold of [0.7, 0.8, 0.9, 0.95, 1]) {
    let accepted = 0, errors = 0;
    for (const row of rows) {
      const plan = row.plan(threshold), expected = row.fixture.expected;
      if (plan.type !== "note") { accepted++; errors += Number(plan.type !== expected.type); }
      if (plan.reviewTarget) { accepted++; errors += Number(plan.reviewTarget !== expected.reviewTarget); }
      for (const tag of plan.tags) { accepted++; errors += Number(!expected.tags.includes(tag)); }
    }
    if (accepted > 0 && errors === 0) return threshold;
  }
  return null;
}
export function summarize(rows: any[]) {
  return ["current", "deterministic", "hybrid"].flatMap(arm => ["tuning", "held-out"].map(split => {
    const group = rows.filter(row => row.arm === arm && row.split === split);
    const ordered = group.map(r => r.durationMs).sort((a, b) => a - b);
    const percentile = (q: number) => ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)] ?? null;
    const tags = group.reduce((s, r) => ({ correct: s.correct + r.truePositiveTags, predicted: s.predicted + r.predictedTags, expected: s.expected + r.expectedTags }), { correct: 0, predicted: 0, expected: 0 });
    const eligible = group.filter(r => r.classificationEligible), eligibleTags = eligible.reduce((s, r) => ({ correct: s.correct + r.truePositiveTags, predicted: s.predicted + r.predictedTags, expected: s.expected + r.expectedTags }), { correct: 0, predicted: 0, expected: 0 });
    const calls = group.flatMap(r => r.calls ?? []);
    return { arm, split, observations: group.length, correctTypes: group.filter(r => r.correctType).length,
      confusion: group.map(r => ({ fixture: r.fixture, repetition: r.repetition, expected: r.expectedType, actual: r.actualType })),
      wrongTargetAppends: group.filter(r => r.wrongTargetAppend).length, contentLoss: group.filter(r => r.contentLoss).length,
      unintendedCreates: group.reduce((s, r) => s + r.unintendedCreates, 0),
      correctAppendTargets: group.filter(r => r.correctAppendTarget).length, correctReviewTargets: group.filter(r => r.correctReviewTarget).length,
      appendPrecision: group.some(r => r.appendTarget) ? group.filter(r => r.appendTarget && r.correctAppendTarget).length / group.filter(r => r.appendTarget).length : null,
      reviewTargetPrecision: group.some(r => r.reviewTarget) ? group.filter(r => r.reviewTarget && r.correctReviewTarget).length / group.filter(r => r.reviewTarget).length : null,
      requestedGeneration: group.filter(r => r.generationRequested).length, generatedFactsKept: group.filter(r => r.generatedFactsKept === true).length,
      abstentions: group.filter(r => r.abstained).length, abstentionMetrics: { expectedNotes: group.filter(r => r.expectedType === "note").length, safeExpectedNoteAbstentions: group.filter(r => r.expectedType === "note" && r.abstained).length, nonNoteAbstentions: group.filter(r => r.expectedType !== "note" && r.abstained).length }, reviewTargetRecall: group.some(r => r.expectedReviewTarget) ? group.filter(r => r.expectedReviewTarget && r.correctReviewTarget).length / group.filter(r => r.expectedReviewTarget).length : null, tagPrecision: tags.predicted ? tags.correct / tags.predicted : null,
      tagRecall: tags.expected ? tags.correct / tags.expected : null, classificationEligibleTagMetrics: { observations: eligible.length, ...eligibleTags, precision: eligibleTags.predicted ? eligibleTags.correct / eligibleTags.predicted : null, recall: eligibleTags.expected ? eligibleTags.correct / eligibleTags.expected : null }, inventedTags: group.flatMap(r => r.inventedTags).length,
      calls: calls.length, callsWithUnknownUsage: calls.filter(c => c.inputTokens == null || c.outputTokens == null).length,
      inputTokens: calls.every(c => c.inputTokens != null) ? calls.reduce((s, c) => s + c.inputTokens, 0) : null,
      outputTokens: calls.every(c => c.outputTokens != null) ? calls.reduce((s, c) => s + c.outputTokens, 0) : null,
      cacheReadTokens: calls.every(c => c.cacheReadTokens != null) ? calls.reduce((s, c) => s + c.cacheReadTokens, 0) : null,
      cacheWriteTokens: calls.every(c => c.cacheWriteTokens != null) ? calls.reduce((s, c) => s + c.cacheWriteTokens, 0) : null,
      apiEquivalentLowerUsd: calls.every(c => c.apiEquivalentLowerUsd != null) ? calls.reduce((s, c) => s + c.apiEquivalentLowerUsd, 0) : null,
      apiEquivalentUpperUsd: calls.every(c => c.apiEquivalentUpperUsd != null) ? calls.reduce((s, c) => s + c.apiEquivalentUpperUsd, 0) : null,
      observedAdditionalBilledUsd: calls.every(c => c.observedAdditionalBilledUsd != null) ? calls.reduce((s, c) => s + c.observedAdditionalBilledUsd, 0) : null,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), durationMs: group.reduce((s, r) => s + r.durationMs, 0),
      throughputPerSecond: group.length ? group.length / (group.reduce((s, r) => s + r.durationMs, 0) / 1000) : null,
      gate: !group.length ? "not evaluable" : group.some(r => r.wrongTargetAppend || r.contentLoss || r.unintendedCreates) ? "safety veto" : "safety retained on observed sample only",
    };
  }));
}
