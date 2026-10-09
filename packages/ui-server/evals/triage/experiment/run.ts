/**
 * The live Jev arms over the experiment corpus.
 *
 *   BRAIN_UI_LIVE_EVALS=1 TYPESAFE_API_KEY=... \
 *     bun packages/ui-server/evals/triage/experiment/run.ts --out /tmp/jev-848.json
 *   ... --shape choice --batch 8 --reps 1        # one configuration, one pass
 *
 * Never part of `bun test`: it spends money and is non-deterministic, so it
 * refuses to start without the same opt-in the donor runner uses. Every
 * configuration's repetitions, verdicts, confusion, fallback rows, physical
 * calls, cost and latency go to one JSON report; the exit code is the gate:
 *
 *   0  every selected configuration passed every repetition
 *   1  a repetition failed the gate
 *   2  refused to start
 *   3  a configuration was not fully judged and none failed
 *
 * The baseline arm is the donor runner on the same inputs:
 *   EVAL_ITEMS=experiment EVAL_BENCHMARKS=/tmp/baseline.json bun run eval:triage --model claude-sonnet-5-5 --effort low
 */
import { resolve } from "node:path";
import { CORPUS, corpusSha } from "./corpus";
import { classify, type BatchSize, type Shape } from "./adapter";
import { configurationVerdict, evaluateRepetition } from "./evaluate";
import { classificationAccounting, costPer1kItems, latencySummary } from "./accounting";
import { protocol } from "./protocol";

if (process.env.BRAIN_UI_LIVE_EVALS !== "1") {
  console.error("Refusing to run: set BRAIN_UI_LIVE_EVALS=1 (calls the paid Jev API).");
  process.exit(2);
}
const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("Refusing to run: TYPESAFE_API_KEY is not set.");
  process.exit(2);
}
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const out = arg("out");
if (!out) { console.error("Refusing to run: --out <report.json> is required."); process.exit(2); }
const shapes = (arg("shape") ? [arg("shape")] : [...protocol.shapes]) as Shape[];
const batching = (arg("batch") ? [Number(arg("batch"))] : [...protocol.batching]) as BatchSize[];
const reps = Number(arg("reps") ?? protocol.repetitions);
if (shapes.some((s) => !protocol.shapes.includes(s)) || batching.some((b) => !protocol.batching.includes(b)) || !(reps >= 1)) {
  console.error(`Refusing to run: shape must be one of ${protocol.shapes.join("/")}, batch one of ${protocol.batching.join("/")}, reps >= 1.`);
  process.exit(2);
}

const rubric = await Bun.file(new URL("../prompt.txt", import.meta.url)).text();
const started = new Date().toISOString();
const configurations = [];
for (const shape of shapes) for (const batchSize of batching) {
  const repetitions = [];
  for (let repetition = 1; repetition <= reps; repetition++) {
    const wallStart = performance.now();
    const observation = await classify(CORPUS, shape, batchSize, rubric, { fetch, apiKey });
    const wallMs = performance.now() - wallStart;
    const evaluated = evaluateRepetition(CORPUS, observation);
    const cost = classificationAccounting(observation.calls);
    const operational = Object.values(evaluated.confusion);
    repetitions.push({
      repetition, ...evaluated, boundsRejected: observation.boundsRejected, stopReason: observation.stopReason,
      falseEscalations: evaluated.gates[0]!.tally.falseEscalations,
      missedEscalations: evaluated.gates[0]!.tally.recallTotal - evaluated.gates[0]!.tally.recallHit,
      fallbackFraction: evaluated.fallbackIds.length / CORPUS.length,
      /** Items the operational route sends past T1 (agent or human), the T2 demand. */
      t2Fraction: operational.filter((o) => o.operational === "needs_agent" || o.operational === "needs_user").length / CORPUS.length,
      cost: { ...cost, costPer1kItemsUsd: costPer1kItems(cost.knownListEstimateUsd, CORPUS.length) },
      latency: { perCall: latencySummary(observation.calls.map((c) => c.durationMs)), wallMs, itemsPerSecond: (CORPUS.length * 1000) / wallMs },
      calls: observation.calls,
    });
    const gate = evaluated.gates.map((g) => `${g.split}: ${g.gate === null ? "NO DATA" : g.gate.pass ? "ok" : g.gate.reasons.join("; ")}`).join(" | ");
    console.error(`${shape}/${batchSize} repetition ${repetition}: ${evaluated.pass ? "PASS" : "FAIL"} (${gate}); ` +
      `fallback ${evaluated.fallbackIds.length}, calls ${observation.calls.length}, $${cost.knownListEstimateUsd.toFixed(4)}`);
  }
  configurations.push({ shape, batchSize, ...configurationVerdict(repetitions, reps) });
}
const report = { issue: protocol.issue, started, finished: new Date().toISOString(), corpusSha: corpusSha(), items: CORPUS.length, protocol, configurations };
await Bun.write(resolve(out), JSON.stringify(report, null, 2));
console.error(`Written to ${resolve(out)}`);

const failed = configurations.filter((c) => c.repetitions.some((r) => r.judgmentCoverageComplete && !r.pass));
const unjudged = configurations.filter((c) => !c.pass && c.repetitions.some((r) => !r.judgmentCoverageComplete));
if (failed.length) { console.error(`Gate failed: ${failed.map((c) => `${c.shape}/${c.batchSize}`).join(", ")}`); process.exit(1); }
if (unjudged.length) { console.error(`Gate not judged: ${unjudged.map((c) => `${c.shape}/${c.batchSize}`).join(", ")}`); process.exit(3); }
