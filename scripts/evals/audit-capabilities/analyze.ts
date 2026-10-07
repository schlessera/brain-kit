/** Analysis requires reviewed natural-language annotations; no keyword oracle. */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { cases } from "./benchmark";
import { protocol } from "./protocol";
import { sha } from "./freeze";
import type { PhysicalCall } from "./live";
export interface Annotation {
  fixture: string; repetition: number; arm: string; suggestionIndex: number;
  findingIds: string[]; correct: boolean; reason: string;
}
export interface ReviewedAnnotations {
  observationsSha: string; reviewedByFamily: "GPT"; annotations: Annotation[];
}
const quantile = (xs: number[], q: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1]! : null;
export function analyze(observationsRaw: string, calls: PhysicalCall[], review: ReviewedAnnotations) {
  if (review.observationsSha !== sha(observationsRaw) || review.reviewedByFamily !== "GPT") throw Error("Exact output-independent GPT-family semantic annotation required for Claude answers");
  const rows = JSON.parse(observationsRaw) as any[];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.fixture}:${row.repetition}:${row.arm}`;
    if (seen.has(key)) throw Error("Duplicate observation"); seen.add(key);
  }
  for (const f of cases) for (let repetition = 0; repetition < protocol.repetitions; repetition++) for (const arm of protocol.arms)
    if (!seen.has(`${f.id}:${repetition}:${arm}`)) throw Error("Incomplete original three-arm comparison");
  if (rows.length !== cases.length * protocol.repetitions * protocol.arms.length) throw Error("Unexpected extra observations");
  if (review.annotations.some(a => !seen.has(`${a.fixture}:${a.repetition}:${a.arm}`))) throw Error("Annotation names an unobserved output");
  const usedCalls = rows.flatMap(r => r.physicalCallIndices);
  if (usedCalls.length !== calls.length || new Set(usedCalls).size !== calls.length || usedCalls.some((n: number) => !Number.isInteger(n) || n < 0 || n >= calls.length)) throw Error("Physical attempts do not reconcile to observations");
  const results = rows.map(row => {
    const f = cases.find(f => f.id === row.fixture)!;
    const suggestions = row.arm === "capability-backed-registry" ? row.output.suggestions : row.output;
    if (!Array.isArray(suggestions)) throw Error("Malformed suggestion shape requires explicit failed-run report");
    const annotations = review.annotations.filter(a => a.fixture === row.fixture && a.repetition === row.repetition && a.arm === row.arm);
    if (annotations.length !== suggestions.length || new Set(annotations.map(a => a.suggestionIndex)).size !== suggestions.length) throw Error("Every natural suggestion needs one independent semantic annotation");
    const actual = new Map<string, any>(row.detected.findings.map((d: any) => [d.id, d.issue]));
    const matched = new Map<string, number>(); let qualityCorrect = 0, falseAutoFix = 0, autoClaims = 0, availableMissed = 0;
    for (const a of annotations) {
      if (!Number.isInteger(a.suggestionIndex) || a.suggestionIndex < 0 || a.suggestionIndex >= suggestions.length || typeof a.correct !== "boolean" || !a.reason.trim() || new Set(a.findingIds).size !== a.findingIds.length || a.findingIds.some(id => !actual.has(id))) throw Error("Invalid/unexplained natural annotation");
      const suggestion = suggestions[a.suggestionIndex];
      if (a.correct && a.findingIds.length > 0) qualityCorrect++;
      for (const id of a.findingIds) matched.set(id, (matched.get(id) ?? 0) + 1);
      if (suggestion.canAutoFix === true) {
        autoClaims++;
        if (a.findingIds.length !== 1 || a.findingIds.some(id => { const issue = actual.get(id); return issue.category !== "index-stale" || !f.expectedAvailablePaths.includes(issue.path); })) falseAutoFix++;
      }
    }
    for (const [id, issue] of actual) if (issue.category === "index-stale" && f.expectedAvailablePaths.includes(issue.path)) {
      const label = annotations.filter(a => a.findingIds.includes(id));
      if (!label.some(a => suggestions[a.suggestionIndex].canAutoFix === true)) availableMissed++;
    }
    const correctFindings = [...actual.keys()].filter(id => matched.get(id) === 1 && annotations.some(a => a.correct && a.findingIds.includes(id))).length;
    const candidate = row.arm === "capability-backed-registry";
    const physical = row.physicalCallIndices.map((n: number) => calls[n]!);
    return {
      fixture: f.id, split: f.split, arm: row.arm, repetition: row.repetition,
      findings: actual.size, suggestions: suggestions.length, qualityCorrect, correctFindings,
      covered: [...matched].filter(([, n]) => n === 1).length, duplicateCoverage: [...matched].filter(([, n]) => n > 1).length,
      autoClaims, falseAutoFix, availableMissed,
      expectedAvailable: f.expectedAvailablePaths.length,
      invalidProposalShape: row.projection?.rows.filter((r: any) => !r.supportedShape).length ?? 0,
      unsafeProjectedClaim: row.projection?.rows.filter((r: any) => r.claimed && !r.safePath).length ?? 0,
      noOpProjectedClaim: row.projection?.rows.filter((r: any) => r.proposedNoOp).length ?? 0,
      nonGoldenProjectedClaim: row.projection?.rows.filter((r: any) => r.claimed && !r.exactAuthoredPreview).length ?? 0,
      actualWrites: candidate ? row.output.effects.flatMap((e: any) => e.written).length : 0,
      previewCorrect: candidate ? isDeepStrictEqual(row.output.previewFiles, f.expectedPreviewFiles) : null,
      effectCorrect: candidate ? isDeepStrictEqual(row.output.effectFiles, f.expectedEffectFiles) : null,
      repeatNoOp: candidate ? row.output.repeated.every((r: any) => r.written.length === 0) : null,
      authorizationViolation: candidate && !f.authorization && row.output.effects.some((e: any) => e.written.length > 0),
      sourceUnchanged: row.sourceFilesUnchanged, totalsUnchanged: row.ordinaryTotalsUnchanged,
      physicalCalls: physical.length,
      inputTokens: physical.reduce((sum: number, c: PhysicalCall) => sum + ((c.response as any)?.usage?.input_tokens ?? 0), 0),
      outputTokens: physical.reduce((sum: number, c: PhysicalCall) => sum + ((c.response as any)?.usage?.output_tokens ?? 0), 0),
      cacheReadTokens: physical.reduce((sum: number, c: PhysicalCall) => sum + ((c.response as any)?.usage?.cache_read_input_tokens ?? 0), 0),
      cacheWriteTokens: physical.reduce((sum: number, c: PhysicalCall) => sum + ((c.response as any)?.usage?.cache_creation_input_tokens ?? 0), 0),
      costLowerUsd: physical.every((c: PhysicalCall) => c.cost !== null) ? physical.reduce((s: number, c: PhysicalCall) => s + c.cost!.lowerUsd, 0) : null,
      costUpperUsd: physical.every((c: PhysicalCall) => c.cost !== null) ? physical.reduce((s: number, c: PhysicalCall) => s + c.cost!.upperUsd, 0) : null,
      durationMs: row.durationMs, taskDurationMs: row.taskDurationMs,
    };
  });
  const summaries = [];
  for (const split of ["tuning", "held-out"]) for (const arm of protocol.arms) {
    const group = results.filter(r => r.split === split && r.arm === arm);
    const sum = (key: keyof typeof group[number]) => group.reduce((s, r) => s + Number(r[key] ?? 0), 0);
    const nullMetrics = group.some(r => r.costUpperUsd === null);
    summaries.push({ split, arm, observations: group.length,
      ...Object.fromEntries(["findings", "suggestions", "qualityCorrect", "correctFindings", "covered", "duplicateCoverage", "autoClaims", "falseAutoFix", "availableMissed", "expectedAvailable", "actualWrites", "physicalCalls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "invalidProposalShape", "unsafeProjectedClaim", "noOpProjectedClaim", "nonGoldenProjectedClaim"].map(k => [k, sum(k as keyof typeof group[number])])),
      perFindingCorrectRate: sum("findings") ? sum("correctFindings") / sum("findings") : null,
      semanticCorrectRate: sum("suggestions") ? sum("qualityCorrect") / sum("suggestions") : null,
      coverageRate: sum("findings") ? sum("covered") / sum("findings") : null,
      costLowerUsd: nullMetrics ? null : sum("costLowerUsd"), costUpperUsd: nullMetrics ? null : sum("costUpperUsd"),
      p50Ms: quantile(group.map(r => r.durationMs), .5), p95Ms: quantile(group.map(r => r.durationMs), .95),
      taskP50Ms: quantile(group.map(r => r.taskDurationMs), .5), taskP95Ms: quantile(group.map(r => r.taskDurationMs), .95),
      measuredCasesPerSecond: group.length / (sum("taskDurationMs") / 1000),
      allPreviewEffectsCorrect: arm === "capability-backed-registry" ? group.every(r => r.previewCorrect && r.effectCorrect && r.repeatNoOp && !r.authorizationViolation) : null,
    });
  }
  return { observationsSha: review.observationsSha, summaries, rows: results, adoption: "requires separate root-reviewed measured decision; no automatic production adoption", invoice: "not supplied" };
}
if (import.meta.main) console.log(JSON.stringify(analyze(readFileSync(process.argv[2]!, "utf8"), JSON.parse(readFileSync(process.argv[3]!, "utf8")), JSON.parse(readFileSync(process.argv[4]!, "utf8"))), null, 2));
