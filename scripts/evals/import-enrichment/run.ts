/** Offline controls only: scripted responses cannot measure agent or JEV quality. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execute, fixtureSha256, fixtures, prepare, snapshot } from "./fixtures";
import { enrich, hash, type Mode } from "./prototype";

const modes: Mode[] = ["combined", "classification", "hybrid"];
const sumCalls = (calls: Record<string, number>) => Object.values(calls).reduce((a, b) => a + b, 0);
type Outcome = Awaited<ReturnType<typeof enrich>>;
const cases: Array<{ mode: Mode; fixture: string; split: string; exactExpectedFiles: number; sourceBytes: number; cold: Outcome; repeat: Outcome; localMs: number; transcriptSha256: string }> = [];
for (const mode of modes) {
  for (const fixture of fixtures) {
    const env = prepare(fixture, mode);
    try {
      const started = performance.now();
      const cold = await execute(env);
      const localMs = performance.now() - started;
      let sourceBytes = 0;
      for (const [path, expected] of Object.entries(env.expected)) {
        const actual = readFileSync(join(env.root, path), "utf8");
        if (actual !== expected) throw Error(`byte mismatch: ${mode}/${fixture.id}/${path}`);
        sourceBytes += Buffer.byteLength(actual);
      }
      const after = snapshot(env);
      const repeat = await execute(env);
      if (JSON.stringify(snapshot(env)) !== JSON.stringify(after)) throw Error("repeat changed files");
      cases.push({
        mode, fixture: fixture.id, split: fixture.split, exactExpectedFiles: Object.keys(env.expected).length,
        sourceBytes, cold, repeat, localMs,
        transcriptSha256: hash(JSON.stringify(env.requests)),
      });
    } finally { env.close(); }
  }
}

// Sequential local pages exercise state overhead, not provider batching or concurrency.
const batches = [];
for (const size of [20, 100]) for (const pageSize of [1, 20]) for (let repetition = 0; repetition < 3; repetition++) {
  const env = prepare(fixtures[0]);
  try {
    env.settings.batchSize = pageSize;
    const approval = env.settings.files[0];
    for (let i = 1; i < size; i++) {
      const path = `import/council-export/source-${String(i).padStart(3, "0")}.md`;
      const suffix = `\nSource copy ${i}.\n`;
      env.files[path] = env.files[env.path] + suffix;
      env.expected[path] = env.expected[env.path] + suffix;
      writeFileSync(join(env.root, path), env.files[path]);
      env.settings.files.push({ ...approval, path });
    }
    const start = performance.now();
    const cold = await execute(env);
    const coldLocalMs = performance.now() - start;
    for (const [path, raw] of Object.entries(env.expected)) {
      if (readFileSync(join(env.root, path), "utf8") !== raw) throw Error("batch byte mismatch");
    }
    const after = snapshot(env), warmStart = performance.now();
    const warm = await execute(env);
    const warmLocalMs = performance.now() - warmStart;
    if (warm.skipped.length !== size || sumCalls(warm.calls) || JSON.stringify(after) !== JSON.stringify(snapshot(env))) throw Error("batch resume mismatch");
    batches.push({ size, pageSize, repetition, coldLocalMs, warmLocalMs, coldCalls: sumCalls(cold.calls), warmCalls: sumCalls(warm.calls), coldPages: cold.batches, warmPages: warm.batches });
  } finally { env.close(); }
}

const arms = modes.map(mode => {
  const rows = cases.filter(c => c.mode === mode);
  return {
    mode, scriptedCases: rows.length, exactExpectedFiles: rows.reduce((n, c) => n + c.exactExpectedFiles, 0),
    coldCalls: rows.reduce((n, c) => n + sumCalls(c.cold.calls), 0),
    repeatCalls: rows.reduce((n, c) => n + sumCalls(c.repeat.calls), 0),
    coldCacheHits: rows.reduce((n, c) => n + c.cold.cacheHits, 0),
    written: rows.reduce((n, c) => n + c.cold.written.length, 0),
    review: rows.reduce((n, c) => n + c.cold.review.length, 0),
    failed: rows.reduce((n, c) => n + c.cold.failed.length, 0),
    sourceBytes: rows.reduce((n, c) => n + c.sourceBytes, 0),
  };
});
const report = {
  kind: "private-import-enrichment-offline-controls", fixtureSha256,
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  arms, batches, cases,
  live: {
    currentAgent: null, jevClassification: null, focusedSummary: null, typeTagQuality: null,
    summaryUsefulness: null, summaryFactuality: null, tokens: null, usd: null, modelLatencyMs: null,
    sharedStateBuildCost: null, modelStateBytes: null, amortizationBreakEven: null,
  },
  interpretation: "Scripted exact-byte and resume controls only. Draft goldens need independent review; no provider access, model comparison, production adoption or optimal batch-size claim.",
};
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out")) throw Error("usage: run.ts [--out <report.json>]");
if (args.length) await Bun.write(args[1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ fixtureSha256, arms, batchRuns: batches.length, live: report.live }, null, 2));
