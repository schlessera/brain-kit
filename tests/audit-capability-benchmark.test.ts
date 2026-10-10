import { expect, test } from "bun:test";
import { cases, commandOutput, detect, fileMap, keylessProof, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";
import { currentProposalStats } from "../scripts/evals/audit-capabilities/live";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("actual audit invocation never calls a provider that would write an unexpected binary source file", async () => {
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
    expect(called).toBe(false);
    expect(fileMap(p, f)).toEqual(before);
  } finally { p.close(); }
});

test("authored complete effects match real detected registry execution, preserve all other findings, and repeat without writes", async () => {
  const proof = await keylessProof();
  expect(proof.rows).toHaveLength(cases.length);
  expect(proof.rows.filter(r => r.candidate.effects.some(e => e.written.length > 0)).length).toBeGreaterThan(0);
  expect(proof.rows.find(r => r.id === "nestor-preview-only")!.candidate.suggestions.some(s => s.canAutoFix)).toBe(true);
  expect(proof.rows.find(r => r.id === "nestor-preview-only")!.candidate.effects.every(e => e.written.length === 0)).toBe(true);
  for (const row of proof.rows) for (const [check, passed] of Object.entries(row.checks)) expect(passed, `${row.id}: ${check}`).toBe(true);
});

test("malformed truthy auto-fix provider claims never enter the CLI results", async () => {
  const f = cases.find(f => f.id === "menelaus-quoted-order")!; const p = await prepareBenchmark(f);
  try {
    const proposed = [{ path: "notes/entry.md", issue: "TODO", suggestion: "delete it", canAutoFix: "false", fix: "invented" }];
    const actual = await commandOutput(p, true, { id: "offline-script", capabilities: { vision: false }, async complete() { return JSON.stringify(proposed); } });
    expect(actual).not.toEqual(proposed);
    const measured = currentProposalStats(actual, f);
    expect(measured.rows.length).toBeGreaterThan(0);
    expect(measured.rows.every(row => !row.claimed && row.supportedShape)).toBe(true);
    expect(fileMap(p, f)).toEqual(f.files);
  } finally { p.close(); }
});

test("held-out entity groups and unique authored template IDs stay outside tuning", () => {
  const tuning = new Set(cases.filter(f => f.split === "tuning").map(f => f.entity));
  const held = cases.filter(f => f.split === "held-out");
  expect(tuning.size).toBeGreaterThan(0); expect(held.length).toBeGreaterThan(0);
  expect(new Set(cases.map(f => f.template)).size).toBe(cases.length);
  for (const f of held) expect(tuning.has(f.entity)).toBe(false);
});

test("actual current command ignores unsafe provider claims without calling the provider or writing", async () => {
  const f = cases.find(f => f.id === "menelaus-long-prose")!;
  const p = await prepareBenchmark(f);
  try {
    const before = await detect(p); let prompt = ""; let calls = 0;
    const proposed = [{ path: "../outside.md", issue: "invented", suggestion: "replace", canAutoFix: true, fix: "invented" }];
    const actual = await commandOutput(p, true, { id: "offline-script", capabilities: { vision: false }, async complete(input) { calls++; prompt = input.prompt; return JSON.stringify(proposed); } });
    expect(calls).toBe(0); expect(prompt).toBe("");
    expect(actual).not.toEqual(proposed);
    expect(actual).toEqual(before.report.issues.map(issue => ({
      path: issue.path, issue: issue.message, suggestion: issue.suggestion || "Manual review needed.",
      canAutoFix: issue.category === "index-stale" && f.expectedAvailablePaths.includes(issue.path),
      ...(issue.category === "index-stale" && f.expectedAvailablePaths.includes(issue.path)
        ? { repair: { capability: "registry", path: issue.path } } : {}),
    })));
    expect(fileMap(p, f)).toEqual(f.files);
    expect((await detect(p)).report).toEqual(before.report);
  } finally { p.close(); }
});
