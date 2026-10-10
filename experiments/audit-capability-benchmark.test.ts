import { expect, test } from "bun:test";
import { cases, keylessProof } from "../scripts/evals/audit-capabilities/benchmark";

// The real `audit --fix` provider-claim tests this file used to hold live in
// tests/audit-fix-provider-claims.test.ts (#1386).

test("authored complete effects match real detected registry execution, preserve all other findings, and repeat without writes", async () => {
  const proof = await keylessProof();
  expect(proof.rows).toHaveLength(cases.length);
  expect(proof.rows.filter(r => r.candidate.effects.some(e => e.written.length > 0)).length).toBeGreaterThan(0);
  expect(proof.rows.find(r => r.id === "nestor-preview-only")!.candidate.suggestions.some(s => s.canAutoFix)).toBe(true);
  expect(proof.rows.find(r => r.id === "nestor-preview-only")!.candidate.effects.every(e => e.written.length === 0)).toBe(true);
  for (const row of proof.rows) for (const [check, passed] of Object.entries(row.checks)) expect(passed, `${row.id}: ${check}`).toBe(true);
});

test("held-out entity groups and unique authored template IDs stay outside tuning", () => {
  const tuning = new Set(cases.filter(f => f.split === "tuning").map(f => f.entity));
  const held = cases.filter(f => f.split === "held-out");
  expect(tuning.size).toBeGreaterThan(0); expect(held.length).toBeGreaterThan(0);
  expect(new Set(cases.map(f => f.template)).size).toBe(cases.length);
  for (const f of held) expect(tuning.has(f.entity)).toBe(false);
});
