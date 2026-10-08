/** Reproducible complete-file writer/resume controls; no measured semantic score or live provider. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchmark, prepare, execute, BENCHMARK_SHA } from "./benchmark";
import { observe, assertEffects, assertPreservation } from "./effects";
import { summaryObservation } from "./rubric";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
const rows = [];
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
    rows.push({ caseId: c.id, split: c.split, mode: `scripted-${mode}-control`, before, after, result, repeat: again, elapsedControlMs: elapsed, requests,
      summary: summaryObservation(c, env.files[env.path]!, typeof summary === "string" && summary.length ? summary : null, null),
      completeCurrentStage3Measured: false, actualModelUsage: null, actualInvoiceUsd: null, semanticQuality: null, measuredLatency: null, goNoGo: null });
  } finally { env.close(); }
}
const output = process.argv[2]; if (!output) throw Error("Private output path required");
writeFileSync(output, JSON.stringify({ benchmarkSha: BENCHMARK_SHA, rows, allChecksPassed: true, providerCalls: 0, semanticApproval: null }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ rows: rows.length, allChecksPassed: true, providerCalls: 0 }));
