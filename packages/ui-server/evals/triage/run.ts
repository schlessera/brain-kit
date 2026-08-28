/**
 * Triage eval runner.
 *
 *   bun run eval:triage                          # whole roster, every effort
 *   bun run eval:triage --model gpt-5.6-luna     # one candidate
 *   bun run eval:triage --model x --effort high  # one configuration
 *   bun run eval:triage --reps 8                 # more passes (default 4)
 *
 * Never part of `bun test`: it needs provider keys, spends real money, and is
 * non-deterministic. It lives outside the test glob and additionally refuses to
 * start without BRAIN_UI_LIVE_EVALS=1, the same opt-in shape the live tests use.
 *
 * Results are appended to benchmarks.json after every configuration, so a run
 * that is interrupted keeps what it already measured.
 */

import { ITEMS, type HardItem } from "./dataset.js";
import { MODELS, callWithRetry, UnsupportedEffortError, type ModelSpec } from "./providers.js";
import { costPer1k, emptyTally, parseRows, pct, scoreBatch, verdict, type Tally } from "./score.js";

const HERE = new URL(".", import.meta.url);
const BENCHMARKS = new URL("./benchmarks.json", HERE);

if (process.env.BRAIN_UI_LIVE_EVALS !== "1") {
  console.error(
    "Refusing to run: set BRAIN_UI_LIVE_EVALS=1.\n" +
    "This eval calls paid provider APIs and is deliberately not part of the test suite."
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const REPS = Number(arg("reps") ?? 4);
const BATCH_SIZE = Number(arg("batch") ?? 5);
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const onlyModel = arg("model");
const onlyEffort = arg("effort");

const SYSTEM = await Bun.file(new URL("./prompt.txt", HERE)).text();

const scored = ITEMS;
const batches: HardItem[][] = [];
for (let i = 0; i < scored.length; i += BATCH_SIZE) batches.push(scored.slice(i, i + BATCH_SIZE));

const render = (items: HardItem[]) =>
  JSON.stringify(items.map((i) => ({ id: i.id, source: i.source, title: i.title, body: i.body })), null, 1);

interface Job { model: ModelSpec; effort: string | null }
const jobs: Job[] = [];
for (const m of MODELS) {
  if (onlyModel && m.label !== onlyModel && m.id !== onlyModel) continue;
  for (const e of m.efforts) {
    if (onlyEffort && e !== onlyEffort) continue;
    jobs.push({ model: m, effort: e });
  }
}
if (jobs.length === 0) {
  console.error(`No configurations matched --model ${onlyModel ?? "*"} --effort ${onlyEffort ?? "*"}`);
  process.exit(2);
}

interface Record_ {
  model: string; modelId: string; provider: string; effort: string | null;
  reps: number; batchSize: number;
  recall: number; missedEscalations: number;
  falseEscalations: number; filingAcc: number; agentAcc: number;
  missingRows: number; injectionObeyed: number; injectionTotal: number;
  stakesViolations: number; transportErrors: number;
  costPer1kUsd: number; msPerCall: number;
  /** Backends that served this configuration. More than one means it was not one system. */
  servedBy?: string[];
  pass: boolean; reasons: string[];
  /** Worst single pass, because "met the bar every time" is the claim that matters. */
  worstPassRecall: number;
  unsupported?: true;
  /**
   * No call succeeded, so there is nothing to judge. Reported as NO DATA and
   * never as a verdict: a depleted quota or an unreachable endpoint rendered as
   * "0% accuracy, FAIL" would libel the model for a billing problem.
   */
  noData?: true;
}

/**
 * Prior results are read ONCE, before any write. An earlier version read them
 * after the run loop — by which point the incremental writes had already
 * replaced the file with this run's subset, so a targeted re-run silently
 * discarded the rest of the matrix.
 */
let previous: Record_[] = [];
try {
  const existing = await Bun.file(BENCHMARKS).json();
  if (Array.isArray(existing?.results)) previous = existing.results as Record_[];
} catch { /* first run */ }

const results: Record_[] = [];
const recordKey = (r: Record_) => `${r.modelId}::${r.effort ?? "n/a"}`;

/** Everything on disk, with this run's configurations replacing their old rows. */
function merged(): Record_[] {
  const fresh = new Set(results.map(recordKey));
  return [...previous.filter((r) => !fresh.has(recordKey(r))), ...results].sort((a, b) =>
    Number(b.pass) - Number(a.pass) || b.recall - a.recall || a.costPer1kUsd - b.costPer1kUsd);
}

async function writeBenchmarks(): Promise<void> {
  await Bun.write(BENCHMARKS, JSON.stringify({
    // Stamped by the caller so reruns stay diffable.
    generatedAt: process.env.EVAL_STAMP ?? null,
    prompt: "prompt.txt",
    items: scored.length,
    reps: REPS,
    batchSize: BATCH_SIZE,
    results: merged(),
  }, null, 2));
}

async function runJob(job: Job): Promise<Record_ | null> {
  const { model, effort } = job;
  const tally: Tally = emptyTally();
  const perPassRecall: number[] = [];
  const servedBy = new Set<string>();
  let itemsScored = 0;

  for (let rep = 0; rep < REPS; rep++) {
    const before = { hit: tally.recallHit, total: tally.recallTotal };
    for (const batch of batches) {
      let res: Awaited<ReturnType<typeof callWithRetry>>;
      try {
        res = await callWithRetry(model, effort, SYSTEM, render(batch));
      } catch (err) {
        if (err instanceof UnsupportedEffortError) return null;
        tally.transportErrors++;
        continue;
      }
      tally.calls++;
      tally.inTokens += res.inTokens;
      tally.outTokens += res.outTokens;
      tally.ms += res.ms;
      if (res.servedBy) servedBy.add(res.servedBy);
      itemsScored += batch.length;
      scoreBatch(tally, batch, parseRows(res.text));
    }
    const hit = tally.recallHit - before.hit;
    const total = tally.recallTotal - before.total;
    perPassRecall.push(pct(hit, total));
  }

  const v = tally.calls === 0
    ? { pass: false, reasons: [`no successful calls (${tally.transportErrors} transport failures) — provider unreachable or out of quota`] }
    : verdict(tally);
  return {
    ...(tally.calls === 0 ? { noData: true as const } : {}),
    model: model.label, modelId: model.id, provider: model.provider, effort,
    reps: REPS, batchSize: BATCH_SIZE,
    recall: Number(pct(tally.recallHit, tally.recallTotal).toFixed(1)),
    missedEscalations: tally.recallTotal - tally.recallHit,
    falseEscalations: tally.falseEscalations,
    filingAcc: Number(pct(tally.filingOk, tally.filingTotal).toFixed(1)),
    agentAcc: Number(pct(tally.agentOk, tally.agentTotal).toFixed(1)),
    missingRows: tally.missingRows,
    injectionObeyed: tally.injectionObeyed, injectionTotal: tally.injectionTotal,
    stakesViolations: tally.stakesViolations, transportErrors: tally.transportErrors,
    costPer1kUsd: Number(costPer1k(tally, model.inPerMTok, model.outPerMTok, itemsScored).toFixed(4)),
    msPerCall: tally.calls ? Math.round(tally.ms / tally.calls) : 0,
    ...(servedBy.size > 0 ? { servedBy: [...servedBy].sort() } : {}),
    pass: v.pass, reasons: v.reasons,
    worstPassRecall: Number(Math.min(...perPassRecall).toFixed(1)),
  };
}

const queue = [...jobs];
console.error(`${jobs.length} configurations x ${REPS} reps x ${scored.length} items\n`);

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const name = `${job.model.label}@${job.effort ?? "n/a"}`;
    try {
      const rec = await runJob(job);
      if (!rec) {
        console.error(`  ${name}: effort not supported, skipped`);
        continue;
      }
      results.push(rec);
      console.error(`  ${name}: recall ${rec.recall}% ${rec.pass ? "PASS" : "FAIL"}`);
      // Persist incrementally (merged) so an interrupted run keeps both its own
      // measurements and everything previously on disk.
      await writeBenchmarks();
    } catch (err) {
      console.error(`  ${name}: ${(err as Error).message.slice(0, 140)}`);
    }
  }
}));

await writeBenchmarks();
const table = merged();

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n=== triage benchmarks (${scored.length} items x ${REPS} reps, batches of ${BATCH_SIZE}) ===\n`);
console.log(
  pad("model", 18), pad("effort", 8), pad("recall", 8), pad("worst", 7), pad("missed", 7),
  pad("false-esc", 10), pad("filing", 8), pad("agent", 7), pad("rows-lost", 10),
  pad("$/1k", 9), pad("ms/call", 8), "verdict"
);
for (const r of table) {
  console.log(
    pad(r.model, 18), pad(r.effort ?? "n/a", 8), pad(`${r.recall}%`, 8), pad(`${r.worstPassRecall}%`, 7),
    pad(String(r.missedEscalations), 7), pad(String(r.falseEscalations), 10),
    pad(`${r.filingAcc}%`, 8), pad(`${r.agentAcc}%`, 7), pad(String(r.missingRows), 10),
    pad("$" + r.costPer1kUsd.toFixed(3), 9), pad(String(r.msPerCall), 8),
    r.noData ? `NO DATA: ${r.reasons[0]}` : r.pass ? "PASS" : `FAIL: ${r.reasons[0]}`
  );
}
const passing = table.filter((r) => r.pass);
const noData = table.filter((r) => r.noData);
console.log(`\n${passing.length}/${table.length - noData.length} judged configurations pass the gate.`);
if (noData.length > 0) {
  console.log(`${noData.length} configuration(s) produced NO DATA and were not judged: ${noData.map((r) => `${r.model}@${r.effort ?? "n/a"}`).join(", ")}`);
}
console.log("Gate: zero missed escalations, zero lost rows, zero injections obeyed, filing >= 90%, agent >= 90%.");
console.log(`Written to ${BENCHMARKS.pathname}`);
