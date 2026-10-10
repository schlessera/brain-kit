/** Reproducible complete-file writer/resume controls; no measured semantic score or live provider. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchmark, definitions, prepare, execute, BENCHMARK_SHA } from "./benchmark";
import { observe, assertEffects, assertPreservation } from "./effects";
import { summaryObservation } from "./rubric";
import { score, predictionFrom, type Prediction } from "./score";
import { parseFrontmatter } from "../../../packages/common/src/frontmatter-parse";
const rows = [];
// Raw classifier replies per arm. With the scripted provider these are the goldens by construction,
// so the scores below are a check of the scoring path, not a measurement.
const predictions: Record<string, Record<string, Prediction>> = { combined: {}, classification: {}, hybrid: {} };
for (const mode of ["combined", "classification", "hybrid"] as const) for (const c of benchmark) {
  const env = prepare(c, mode);
  try {
    const before = observe(env.root), start = performance.now(), result = await execute(env), elapsed = performance.now() - start;
    const after = observe(env.root); assertEffects(before, after, env.settings, result.written);
    for (const [path, expected] of Object.entries(env.expected)) {
      const raw = readFileSync(join(env.root, path), "utf8"); if (raw !== expected) throw Error("Independent full expected file mismatch");
      const approved = env.settings.files.find(f => f.path === path); if (approved) assertPreservation(env.files[path]!, raw, approved.mutable);
    }
    const requests = [...env.requests], again = await execute(env);
    if (JSON.stringify(observe(env.root)) !== JSON.stringify(after) || again.written.length) throw Error("Resume churned completed input");
    const summary = parseFrontmatter(readFileSync(join(env.root, env.path), "utf8")).data.summary;
    const classified = requests.find(r => r.kind !== "summary");
    predictions[mode]![c.id] = classified ? predictionFrom(classified.output) : { refused: result.failed.find(f => f.path === env.path)?.reason ?? "no classification request" };
    rows.push({ caseId: c.id, split: c.split, mode: `scripted-${mode}-control`, before, after, result, repeat: again, elapsedControlMs: elapsed, requests, prediction: predictions[mode]![c.id],
      summary: summaryObservation(c, env.files[env.path]!, typeof summary === "string" && summary.length ? summary : null, null),
      completeCurrentStage3Measured: false, actualModelUsage: null, actualInvoiceUsd: null, semanticQuality: null, measuredLatency: null, goNoGo: null });
  } finally { env.close(); }
}
const output = process.argv[2]; if (!output) throw Error("Private output path required");
const vocabulary = Object.keys(definitions.tags);
const scriptedControlScores = Object.fromEntries(Object.entries(predictions).map(([mode, p]) => [mode, score(benchmark, p, vocabulary)]));
writeFileSync(output, JSON.stringify({ benchmarkSha: BENCHMARK_SHA, rows, scriptedControlScores, scoresAreScriptedControls: true, allChecksPassed: true, providerCalls: 0, semanticApproval: null }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ rows: rows.length, allChecksPassed: true, providerCalls: 0, scriptedControlScores: Object.fromEntries(Object.entries(scriptedControlScores).map(([m, s]) => [m, { typeAccuracy: s.all.typeAccuracy, tagF1: s.all.tags.f1, abstained: s.all.abstained }])) }));
