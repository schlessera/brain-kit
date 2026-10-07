/** Recompute the public routing table from retained measurement rows; no provider calls. */
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "--results" || args[2] !== "--tokens" || args[4] !== "--out") {
  throw Error("usage: --results result.json --tokens token-budget.json --out summary.json");
}
const input = JSON.parse(readFileSync(args[1]!, "utf8"));
const tokenBudget = JSON.parse(readFileSync(args[3]!, "utf8"));
const rows = input.rows as Array<Record<string, any>>;
function spread(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle]
    : (sorted[middle - 1]! + sorted[middle]!) / 2, max: sorted.at(-1) };
}
function measured(values: unknown[]) { return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)); }
function fraction(group: typeof rows, key: string) {
  const included = group.filter(row => typeof row.score?.[key] === "boolean");
  return { numerator: included.filter(row => row.score[key]).length, denominator: included.length };
}
function sumUsage(group: typeof rows, key: string) {
  return group.flatMap(row => row.roundTrips ?? []).reduce((total, usage) => total + usage[key], 0);
}
function jevCharge(group: typeof rows) {
  const receipts = group.flatMap(row => input.jevReceipts.slice(...row.jevAttemptRange));
  if (receipts.some(receipt => typeof receipt.publishedChargeUsd !== "number"
    || !Number.isFinite(receipt.publishedChargeUsd) || receipt.publishedChargeUsd < 0)) return null;
  return receipts.reduce((sum, receipt) => sum + receipt.publishedChargeUsd, 0);
}
const arms = ["baseline", "hint", "load-set", "hard-prune"].map(arm => {
  const attempted = rows.filter(row => row.arm === arm), completed = attempted.filter(row => row.score?.included === true);
  const costKnown = completed.length > 0 && completed.every(row => typeof row.price?.lowerUsd === "number" && typeof row.price?.upperUsd === "number");
  const outcomes = Object.fromEntries([...new Set(completed.map(row => row.router.outcome))].map(outcome =>
    [outcome, completed.filter(row => row.router.outcome === outcome).length]));
  return { arm, attempted: attempted.length, completed: completed.length, expected: 36,
    excluded: attempted.filter(row => row.score?.included !== true).map(row => ({ id: row.id, rep: row.rep, error: row.error })),
    neededToolsHit: fraction(completed, "neededToolsHit"), neededSkillHit: fraction(completed, "neededSkillHit"),
    wrongSkill: fraction(completed, "wrongSkill"), needlessSkill: fraction(completed, "needlessSkill"),
    needlessTool: fraction(completed, "needlessTool"), contentPass: fraction(completed, "contentPass"),
    qualityMisses: completed.filter(row => row.score.neededToolsHit === false || row.score.neededSkillHit === false
      || row.score.contentPass === false || row.score.wrongSkill === true || row.score.needlessSkill === true
      || row.score.needlessTool === true).map(row => ({ id: row.id, rep: row.rep, score: row.score,
        acceptedCalls: row.calls.filter((call: any) => call.accepted).map((call: any) => ({ name: call.name, skill: call.skill })),
        router: row.router })),
    routerOutcomes: outcomes, routerDurationMs: spread(measured(completed.map(row => row.router.durationMs))),
    jevAttempts: completed.reduce((sum, row) => sum + row.jevAttemptRange[1] - row.jevAttemptRange[0], 0),
    jevPublishedChargeUsd: jevCharge(completed),
    totalInputTokens: ["inputTokens", "cacheReadTokens", "cacheWriteTokens"].reduce((sum, key) => sum + sumUsage(completed, key), 0),
    pairedFirstFrameDeltaMs: arm === "baseline" ? null : spread(completed.flatMap(row => {
      const baseline = rows.find(base => base.arm === "baseline" && base.id === row.id && base.rep === row.rep && base.score?.included === true);
      return baseline ? [row.firstFrameMs - baseline.firstFrameMs] : [];
    })),
    durationMs: spread(measured(completed.map(row => row.durationMs))),
    firstFrameMs: spread(measured(completed.map(row => row.firstFrameMs))),
    firstTextMs: spread(measured(completed.map(row => row.firstTextMs))),
    tokens: Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map(key => [key, sumUsage(completed, key)])),
    roundTrips: completed.reduce((total, row) => total + row.roundTrips.length, 0),
    apiEquivalentUsd: costKnown ? { lower: completed.reduce((total, row) => total + row.price.lowerUsd, 0),
      upper: completed.reduce((total, row) => total + row.price.upperUsd, 0),
      unknownCacheTokens: completed.reduce((total, row) => total + row.price.unknownCacheTokens, 0) } : null,
    perCase: [...new Set(completed.map(row => row.id))].map(id => {
      const caseRows = completed.filter(row => row.id === id);
      return { id, completed: caseRows.length, durationMs: spread(measured(caseRows.map(row => row.durationMs))),
        neededToolsHit: fraction(caseRows, "neededToolsHit"), neededSkillHit: fraction(caseRows, "neededSkillHit"),
        contentPass: fraction(caseRows, "contentPass"), wrongSkill: fraction(caseRows, "wrongSkill"),
        needlessSkill: fraction(caseRows, "needlessSkill"), needlessTool: fraction(caseRows, "needlessTool"),
        routerDurationMs: spread(measured(caseRows.map(row => row.router.durationMs))),
        firstFrameMs: spread(measured(caseRows.map(row => row.firstFrameMs))),
        tokens: Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map(key => [key, sumUsage(caseRows, key)])),
        roundTripInputTokens: spread(measured(caseRows.flatMap(row => row.roundTrips.map((trip: any) => trip.inputTokens + trip.cacheReadTokens + trip.cacheWriteTokens)))),
        firstTextMs: spread(measured(caseRows.map(row => row.firstTextMs))),
        rows: caseRows.map(row => ({ rep: row.rep, router: row.router, score: row.score,
          roundTrips: row.roundTrips, price: row.price })) };
    }),
  };
});
const report = { issue: 587, evidence: input.evidence, model: input.model, runtime: input.runtime,
  sourceCommit: input.manifest.sourceCommit, reviewInputSha: input.manifest.reviewInputSha,
  attempted: rows.length, expected: 144, completed: rows.filter(row => row.score?.included === true).length,
  stopped: input.stopped, tokenBudget, arms,
  nativeProcessExits: input.nativeProcessReceipts,
  nativeProcessExitCount: input.nativeProcessReceipts.length,
  jev: { attempts: input.jevReceipts.length, publishedChargeUsd: input.jevPublishedChargeUsd,
    unknownUsageAttempts: input.jevReceipts.filter((receipt: any) => receipt.publishedChargeUsd === null).length },
  reviewerApiEquivalent: input.reviewApiEquivalent, actualSubscriptionBillingUsd: input.actualSubscriptionBillingUsd,
  actualBilledReservationUsd: input.actualBilledReservationUsd,
  notes: ["API-price equivalents are usage diagnostics, separate from actual subscription charges.",
    "Token attribution uses ordered marginals of one native serialized payload.",
    "First-frame/first-text clocks start after fixture and MCP preparation, before Jev classification and native spawn.",
    "Quality fractions retain their own completed-case denominators; content predicates are bounded checks.",
    "Twelve fictional prompts and three toy project skills do not establish general production routing quality."] };
writeFileSync(args[5]!, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ attempted: report.attempted, completed: report.completed,
  arms: arms.map(({ arm, completed, neededToolsHit, neededSkillHit, wrongSkill, needlessSkill, needlessTool, contentPass }) =>
    ({ arm, completed, neededToolsHit, neededSkillHit, wrongSkill, needlessSkill, needlessTool, contentPass })) }, null, 2));
