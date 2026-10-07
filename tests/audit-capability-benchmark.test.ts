import { expect, test } from "bun:test";
import { cases, commandOutput, detect, fileMap, keylessProof, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";

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

test("actual current command accepts unsafe provider claims but neither writes nor sends source content", async () => {
  const f = cases.find(f => f.id === "menelaus-long-prose")!;
  const p = await prepareBenchmark(f);
  try {
    const before = await detect(p); let prompt = ""; let calls = 0;
    const proposed = [{ path: "../outside.md", issue: "invented", suggestion: "replace", canAutoFix: true, fix: "invented" }];
    const actual = await commandOutput(p, true, { id: "offline-script", capabilities: { vision: false }, async complete(input) { calls++; prompt = input.prompt; return JSON.stringify(proposed); } });
    expect(calls).toBe(1); expect(prompt).toContain("no longer matches");
    expect(prompt).not.toContain("beacon observation 99");
    expect(actual).toEqual(proposed);
    expect(fileMap(p, f)).toEqual(f.files);
    expect((await detect(p)).report).toEqual(before.report);
  } finally { p.close(); }
});
