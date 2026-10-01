// Offline scorer for externally collected, authorized evaluation receipts.
import { z } from "zod";
import { fixtures, prepare } from "./fixture";
import { validateProposal } from "./guard";

const receipt = z.strictObject({
  fixture: z.string(), arm: z.enum(["current", "deterministic", "hybrid"]), repetition: z.number().int().nonnegative(),
  predicted: z.enum(["keep", "merge", "promote", "unknown"]), target: z.string().nullable(), escalated: z.boolean(),
  proposal: z.unknown(), runtime: z.string().min(1), fixtureSha256: z.string().regex(/^[a-f0-9]{64}$/), promptVersion: z.string().min(1),
  cache: z.enum(["warm", "cold", "not-applicable"]), totalLatencyMs: z.number().nonnegative(),
  calls: z.array(z.strictObject({
    kind: z.enum(["classification", "generation", "retry", "fallback"]), model: z.string().min(1),
    inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(), cacheWriteTokens: z.number().int().nonnegative().nullable(),
    billedCostUsd: z.number().nonnegative().nullable(), effectiveCostUsd: z.number().nonnegative().nullable(),
  })),
});

function percentile(values: number[], q: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]! : null;
}
function sumKnown(values: Array<number | null>): number | null {
  return values.some(v => v === null) ? null : values.reduce<number>((s, v) => s + v!, 0);
}

export function scoreReceipts(input: unknown, expectedFixtureSha: string) {
  const rows = z.array(receipt).min(1).parse(input);
  const seen = new Set<string>();
  const observations = rows.map(row => {
    if (row.fixtureSha256 !== expectedFixtureSha) throw new Error("fixture checksum mismatch");
    const key = `${row.arm}:${row.cache}:${row.fixture}:${row.repetition}`;
    if (seen.has(key)) throw new Error("duplicate receipt");
    seen.add(key);
    const f = fixtures.find(item => item.id === row.fixture);
    if (!f) throw new Error(`unknown fixture: ${row.fixture}`);
    const p = prepare(f);
    try {
      const correctTarget = row.target === (f.expected === "merge" ? p.env.targets[0]!.path : null);
      const validation = validateProposal(row.proposal, p.env);
      const correctDisposition = row.predicted === f.expected;
      const agreement = validation.ok && validation.proposal.action === row.predicted &&
        (row.predicted === "merge" ? validation.proposal.operations.find(op => op.op === "update")?.path === row.target : row.target === null);
      return { ...row, split: f.split, category: f.category, correctTarget, correctDisposition, accepted: validation.ok, acceptedWrite: validation.ok && validation.proposal.action !== "keep", agreement, rejection: validation.ok ? null : validation.reason };
    } finally { p.close(); }
  });
  return ["current", "deterministic", "hybrid"].flatMap(arm => ["tuning", "held-out"].flatMap(split => ["warm", "cold", "not-applicable"].flatMap(cache => {
    const group = observations.filter(row => row.arm === arm && row.split === split && row.cache === cache);
    if (!group.length) return [];
    const selected = group.filter(row => row.predicted !== "keep" && row.predicted !== "unknown");
    const targets = group.filter(row => row.predicted === "merge");
    const calls = group.flatMap(row => row.calls);
    const unsafe = group.filter(row => row.acceptedWrite && (!row.correctDisposition || !row.correctTarget || !row.agreement)).length;
    return [{
      arm, split, cache, evaluated: group.length,
      completeFixtureCoverage: fixtures.filter(f => f.split === split).every(f => group.some(row => row.fixture === f.id)),
      dispositionAccuracy: group.filter(row => row.correctDisposition).length / group.length,
      dispositionPrecision: selected.length ? selected.filter(row => row.correctDisposition).length / selected.length : null,
      targetPrecision: targets.length ? targets.filter(row => row.correctTarget).length / targets.length : null,
      escalationRate: group.filter(row => row.escalated).length / group.length,
      rejectedProposals: group.filter(row => !row.accepted).length,
      unsafeAccepted: unsafe,
      confusion: group.map(row => ({ fixture: row.fixture, predicted: row.predicted, correct: row.correctDisposition, rejection: row.rejection })),
      allCalls: calls.length, nonClassificationCalls: calls.filter(call => call.kind !== "classification").length,
      inputTokens: sumKnown(calls.map(call => call.inputTokens)), outputTokens: sumKnown(calls.map(call => call.outputTokens)),
      cacheReadTokens: sumKnown(calls.map(call => call.cacheReadTokens)), cacheWriteTokens: sumKnown(calls.map(call => call.cacheWriteTokens)),
      billedCostUsd: sumKnown(calls.map(call => call.billedCostUsd)), effectiveCostUsd: sumKnown(calls.map(call => call.effectiveCostUsd)),
      p50Ms: percentile(group.map(row => row.totalLatencyMs), 0.5), p95Ms: percentile(group.map(row => row.totalLatencyMs), 0.95),
      adoptionVeto: unsafe > 0,
    }];
  })));
}
