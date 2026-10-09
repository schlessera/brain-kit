import { expect, test } from "bun:test";
import { cases, commandOutput, detect, fileMap, keylessProof, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";
import { currentProposalStats } from "../scripts/evals/audit-capabilities/live";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("actual audit invocation observes an unexpected binary source file", async () => {
  const f = cases.find(f => f.id === "menelaus-quoted-order")!;
  const p = await prepareBenchmark(f);
  try {
    const before = fileMap(p, f);
    let called = false;
    await commandOutput(p, true, { id: "offline-effects-control", capabilities: { vision: false }, async complete() {
      called = true;
      writeFileSync(join(p.root, "unexpected.bin"), Buffer.from([0, 255, 128]));
      return "[]";
    } });
    expect(called).toBe(true);
    expect(fileMap(p, f)).not.toEqual(before);
  } finally { p.close(); }
});

test("authored complete effects match real detected registry execution, preserve all other findings, and repeat without writes", async () => {
  const proof = await keylessProof();
  expect(proof.rows).toHaveLength(cases.length);
  expect(proof.rows.filter(r => r.candidate.effects.some(e => e.written.length > 0)).length).toBeGreaterThan(0);
  expect(proof.rows.find(r => r.id === "nestor-preview-only")!.candidate.suggestions.some(s => s.canAutoFix)).toBe(true);
  expect(proof.rows.find(r => r.id === "nestor-preview-only")!.candidate.effects.every(e => e.written.length === 0)).toBe(true);
  // Counts follow from the authored goldens: 9 valid registries over 26 brains,
  // one of them unauthorized, and 28 detected findings in total. Asserted
  // before the per-row checks so an eligibility regression fails here first.
  expect(proof.summary).toEqual([
    { split: "tuning", arm: "actual-providerless", cases: 6, findings: 8, suggestions: 8, autoClaims: 0, falseAutoFix: 0, availableMissed: 3, expectedAvailable: 3, actualWrites: 0, authorizedCases: null, allPreviewEffectsCorrect: null, providerCalls: 0 },
    { split: "tuning", arm: "capability-backed-registry", cases: 6, findings: 8, suggestions: 8, autoClaims: 3, falseAutoFix: 0, availableMissed: 0, expectedAvailable: 3, actualWrites: 3, authorizedCases: 6, allPreviewEffectsCorrect: true, providerCalls: 0 },
    { split: "held-out", arm: "actual-providerless", cases: 20, findings: 20, suggestions: 20, autoClaims: 0, falseAutoFix: 0, availableMissed: 6, expectedAvailable: 6, actualWrites: 0, authorizedCases: null, allPreviewEffectsCorrect: null, providerCalls: 0 },
    { split: "held-out", arm: "capability-backed-registry", cases: 20, findings: 20, suggestions: 20, autoClaims: 6, falseAutoFix: 0, availableMissed: 0, expectedAvailable: 6, actualWrites: 5, authorizedCases: 19, allPreviewEffectsCorrect: true, providerCalls: 0 },
  ]);
  for (const row of proof.rows) for (const [check, passed] of Object.entries(row.checks)) expect(passed, `${row.id}: ${check}`).toBe(true);
});

test("malformed truthy auto-fix flag remains visible as the current CLI claim and invalid shape", async () => {
  const f = cases.find(f => f.id === "menelaus-quoted-order")!; const p = await prepareBenchmark(f);
  try {
    const proposed = [{ path: "notes/entry.md", issue: "TODO", suggestion: "delete it", canAutoFix: "false", fix: "invented" }];
    const actual = await commandOutput(p, true, { id: "offline-script", capabilities: { vision: false }, async complete() { return JSON.stringify(proposed); } });
    expect(actual).toEqual(proposed);
    const measured = currentProposalStats(actual, f);
    expect(measured.rows[0]!.claimed).toBe(true);
    expect(measured.rows[0]!.supportedShape).toBe(false);
    expect(fileMap(p, f)).toEqual(f.files);
  } finally { p.close(); }
});

test("held-out entity groups and unique authored template IDs stay outside tuning", () => {
  const tuning = new Set(cases.filter(f => f.split === "tuning").map(f => f.entity));
  const held = cases.filter(f => f.split === "held-out");
  expect(tuning.size).toBeGreaterThan(0); expect(held.length).toBeGreaterThan(0);
  expect(new Set(cases.map(f => f.template)).size).toBe(cases.length);
  for (const f of held) expect(tuning.has(f.entity)).toBe(false);
  // Labels alone do not separate the splits: no held-out brain may reuse a
  // tuning file byte for byte.
  const tuningFiles = new Set(cases.filter(f => f.split === "tuning").flatMap(f => Object.values(f.files)));
  expect(tuningFiles.size).toBeGreaterThan(0);
  for (const f of held) for (const [path, raw] of Object.entries(f.files)) expect(tuningFiles.has(raw), `${f.id}: ${path} duplicates a tuning file`).toBe(false);
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
