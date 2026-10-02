/** Offline controls only. The current skill's actual agent path is not measured here. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cycle, existingCycle, fixtures, fixtureSha256, prepare, snapshot } from "./fixture";

const percentile = (samples: number[], fraction: number) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];

export async function report(repeats = 3, sizes = [20, 1000]) {
  let exact = 0, baselineExact = 0, unintended = 0, churn = 0, secondDiff = 0, dryDiff = 0;
  const outcomes: Array<{ id: string; exact: boolean; writes: string[]; refused: string[] }> = [];
  for (const fixture of fixtures) {
    const baseline = prepare(fixture);
    try {
      await existingCycle(baseline);
      baselineExact += Number(Object.entries(fixture.expected).every(([p, text]) => readFileSync(join(baseline.root, p), "utf8") === text));
    } finally { baseline.close(); }
    const env = prepare(fixture);
    try {
      const before = snapshot(env.root, env.brain.taxonomy);
      await cycle(env, true);
      dryDiff += Number(JSON.stringify(snapshot(env.root, env.brain.taxonomy)) !== JSON.stringify(before));
      const result = await cycle(env);
      const expectedPaths = Object.keys(fixture.files).filter(p => fixture.files[p] !== fixture.expected[p]);
      const agreement = Object.entries(fixture.expected).every(([p, text]) => readFileSync(join(env.root, p), "utf8") === text);
      exact += Number(agreement);
      unintended += result.applied.written.filter(p => !expectedPaths.includes(p)).length;
      churn += Object.keys(fixture.files).filter(p => !expectedPaths.includes(p) && statSync(join(env.root, p)).mtimeMs !== before[p].mtimeMs).length;
      const once = snapshot(env.root, env.brain.taxonomy);
      await cycle(env);
      secondDiff += Number(JSON.stringify(snapshot(env.root, env.brain.taxonomy)) !== JSON.stringify(once));
      outcomes.push({ id: fixture.id, exact: agreement, writes: result.applied.written, refused: result.proposal.refused.map(r => r.reason) });
    } finally { env.close(); }
  }
  const runtime = [];
  for (const size of sizes) {
    const cold: number[] = [], repeated: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      const env = prepare(fixtures.find(f => f.id === "single-status-column")!, size - 2);
      try {
        let start = performance.now(); const first = await cycle(env); cold.push(performance.now() - start);
        if (first.applied.written.length !== 1) throw new Error("benchmark did not exercise a table write");
        start = performance.now(); const second = await cycle(env); repeated.push(performance.now() - start);
        if (second.applied.written.length || second.log.changedFiles.length) throw new Error("benchmark repeated run changed files");
      } finally { env.close(); }
    }
    runtime.push({ documents: size, repetitions: repeats, cold: { samplesMs: cold, p50Ms: percentile(cold, .5), p95Ms: percentile(cold, .95) }, repeated: { samplesMs: repeated, p50Ms: percentile(repeated, .5), p95Ms: percentile(repeated, .95) } });
  }
  return {
    mode: "keyless-prototype", runtimeVersion: Bun.version, fixtureSha256, cases: fixtures.length,
    draftSplits: { tuning: fixtures.filter(f => f.split === "tuning").length, heldOut: fixtures.filter(f => f.split === "held-out").length },
    prototype: { exact, unintendedWrites: unintended, unchangedFileMtimeChurn: churn, secondRunDiffs: secondDiff, dryRunDiffs: dryDiff, inferenceCalls: 0 },
    cliWithoutAgentControl: { expectedContentAgreement: baselineExact, inferenceCalls: 0, explanation: "Executed the current index/detect/reconcile path without an agent; this is not the current skill's agent path." },
    actualSkillBaseline: { measured: false, calls: null, tokens: null, billedCostUsd: null, effectiveCostUsd: null, latencyMs: null, modelCallReduction: null },
    adoption: "not decided", goldenReview: "pending independent review", outcomes, runtime,
  };
}

if (import.meta.main) {
  if (process.argv.includes("--timezone-probe")) {
    const env = prepare(fixtures[0]);
    try { console.log((await cycle(env, true)).proposal.edits[0]?.after); } finally { env.close(); }
  } else console.log(JSON.stringify(await report(), null, 2));
}
