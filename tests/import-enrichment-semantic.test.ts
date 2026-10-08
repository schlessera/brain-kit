import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { benchmark, definitions, materialize, prepare, execute, BENCHMARK_SHA } from "../scripts/evals/import-enrichment/benchmark";
import { receipts, hash } from "../scripts/evals/import-enrichment/prototype";
import { assertEffects, assertPreservation, observe } from "../scripts/evals/import-enrichment/effects";
import { rubricKey, summaryObservation } from "../scripts/evals/import-enrichment/rubric";
test("source/entity/prose-format holdout and substantive explicit definitions remain separate from legacy failures", () => {
  expect(benchmark).toHaveLength(18); expect(benchmark.filter(c => c.split === "tuning")).toHaveLength(6);
  for (const field of ["entity", "family", "format"] as const) expect(new Set(benchmark.map(c => c[field])).size).toBe(18);
  for (const c of benchmark) { expect(c.body.length).toBeGreaterThan(140); expect(c.facts.length).toBeGreaterThan(1); expect(c.prohibited.length).toBeGreaterThan(1); expect(c.summary.length).toBeLessThanOrEqual(240); }
  expect(Object.values(definitions.types).every(d => d.length > 70)).toBe(true); expect(Object.keys(definitions.tags)).toHaveLength(3); expect(BENCHMARK_SHA).toHaveLength(64);
});
for (const mode of ["combined", "classification", "hybrid"] as const) test.each(benchmark)(`${mode}/$id: complete real writes/metadata/body/mtime/member effects and unchanged resume`, async c => {
  const env = prepare(c, mode);
  try {
    const before = observe(env.root), result = await execute(env);
    for (const [path, gold] of Object.entries(env.expected)) {
      const raw = readFileSync(join(env.root, path), "utf8"); expect(raw, path).toBe(gold);
      if (env.settings.files.some(f => f.path === path)) assertPreservation(env.files[path]!, raw, env.settings.files.find(f => f.path === path)!.mutable);
    }
    assertEffects(before, observe(env.root), env.settings, result.written);
    for (const request of env.requests.filter(r => r.kind !== "summary")) {
      const input = request.input as any; expect(input.untrusted_note.length).toBeGreaterThan(200); expect(input.typeDefinitions).toEqual(env.settings.typeDefinitions); expect(input.tagDefinitions).toEqual(definitions.tags);
      if (c.id === "held-escort") {
        expect(input.untrusted_note).toContain("Recovered complete archival letter, written before the Thrinacia loss.");
        expect(input.untrusted_note).toContain("not a delivery on 2026-07-12");
        expect(input.untrusted_note).not.toContain("this morning");
        expect(readFileSync(join(env.root, env.path), "utf8")).toContain("date is unknown");
      }
      expect(JSON.stringify(input)).not.toContain(c.id); expect(JSON.stringify(input)).not.toContain('"split"');
    }
    const after = observe(env.root), calls = env.requests.length, repeat = await execute(env);
    expect(observe(env.root)).toEqual(after); expect(repeat.written).toEqual([]);
    if (c.type !== "unclear") { expect(env.requests).toHaveLength(calls); expect(repeat.skipped.toSorted()).toEqual(env.settings.files.map(f => f.path).toSorted()); }
    else { expect(receipts(env.root).filter(r => r.status === "complete")).toEqual([]); expect(result.review).toContain(env.path); }
    expect(summaryObservation(c, env.files[env.path]!, mode === "classification" ? null : c.summary, null).taskEquivalent).toBeNull();
  } finally { env.close(); }
});
test("definition changes invalidate completed source and cached context", async () => {
  const env = prepare(benchmark[0]!);
  try { await execute(env); env.settings.typeDefinitions!.logbook += " Require an explicit dated record."; const before = env.requests.length, result = await execute(env); expect(result.skipped).toEqual([]); expect(result.processed).toContain(env.path); expect(env.requests.length).toBeGreaterThan(before); }
  finally { env.close(); }
});
test("changed source remains re-evaluated instead of accepting its stale completion", async () => {
  const env = prepare(benchmark[0]!);
  try { await execute(env); const changed = readFileSync(join(env.root, env.path), "utf8") + "\nA new observation requires fresh review.\n"; writeFileSync(join(env.root, env.path), changed); const before = env.requests.length, result = await execute(env); expect(result.skipped).toEqual([]); expect(result.processed).toContain(env.path); expect(env.requests.length).toBeGreaterThan(before); expect(readFileSync(join(env.root, env.path), "utf8")).toContain("new observation"); }
  finally { env.close(); }
});
test("actual source protection rejects added owner fields, missing comments and changed body", async () => {
  const env = prepare(benchmark[0]!);
  try { await execute(env); const good = readFileSync(join(env.root, env.path), "utf8"), before = env.files[env.path]!; expect(() => assertPreservation(before, good, ["type", "tags", "summary"])).not.toThrow();
    expect(() => assertPreservation(before, good.replace("status: draft", "status: draft\nowner_note: invented"), ["type", "tags", "summary"])).toThrow("Unapproved frontmatter");
    expect(() => assertPreservation(before, good.replace("# The original custody comment stays.\n", ""), ["type", "tags", "summary"])).toThrow("Unapproved frontmatter");
    expect(() => assertPreservation(before, good.replace("eastern coast", "western coast"), ["type", "tags", "summary"])).toThrow("Imported body bytes");
  } finally { env.close(); }
});
test("whole-tree observer detects binary/member/link/touch effects rather than only text", () => {
  const env = prepare(benchmark[0]!);
  try { const before = observe(env.root); writeFileSync(join(env.root, "assets/guard.bin"), Buffer.from([0, 254, 128, 13, 10])); expect(() => assertEffects(before, observe(env.root), env.settings, [])).toThrow("Unexpected whole import effect");
    writeFileSync(join(env.root, "extra.bin"), Buffer.from([0])); expect(Object.keys(observe(env.root))).toContain("extra.bin");
    symlinkSync("alpha", join(env.root, "route")); const linkBefore = observe(env.root); unlinkSync(join(env.root, "route")); symlinkSync("omega", join(env.root, "route")); expect(observe(env.root).route!.bytes).not.toBe(linkBefore.route!.bytes);
    const touchBefore = observe(env.root); utimesSync(join(env.root, env.path), 1, 2); expect(observe(env.root)[env.path]!.bytes).toBe(touchBefore[env.path]!.bytes); expect(observe(env.root)[env.path]!.mtimeNs).not.toBe(touchBefore[env.path]!.mtimeNs);
  } finally { env.close(); }
});
test("summary rubric binds actual full source, written paraphrase and exact source facts; no authored claim supplies approval", () => {
  const c = benchmark[0]!, source = materialize(c).files["import/source-export/document.md"]!, paraphrase = "The eastern-coast journey reached the inlet before noon.";
  const annotation = { sourceSha: hash(source), summarySha: hash(paraphrase), rubricSha: rubricKey(c), caseSha: hash(JSON.stringify(c)), supportedFacts: [0, 1], unsupportedClaims: [], conditionPreserved: true, useful: true, reviewerFamily: "gpt", independentlyApproved: false };
  expect(summaryObservation(c, source, paraphrase, annotation).factuality).toBeNull(); expect(summaryObservation(c, source, paraphrase, annotation).taskEquivalent).toBeNull();
  expect(() => summaryObservation(c, source + "changed", paraphrase, annotation)).toThrow("exact source/output/rubric");
  expect(() => summaryObservation(c, source, paraphrase + "changed", annotation)).toThrow("exact source/output/rubric");
  expect(() => summaryObservation({ ...c, facts: [...c.facts, "new condition"] }, source, paraphrase, annotation)).toThrow("exact source/output/rubric");
});
