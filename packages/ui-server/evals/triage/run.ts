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
 * that is interrupted keeps what it already measured. EVAL_BENCHMARKS points the
 * read and the write at another file, for a scratch run that must not touch the
 * committed matrix.
 *
 * The gate is the exit code, so a wrapper can enforce it:
 *
 *   0  every selected configuration was fully judged and passed every repetition
 *   1  a selected repetition failed the gate, even if other requests were unavailable
 *   2  refused to start: opt-in missing, or the selection matched nothing
 *   3  a selected configuration was not fully judged and none failed — NO DATA,
 *      unavailable batches, an unsupported effort, or a crashed job. Not judged is not a
 *      pass: a gate that exits 0 when the provider was unreachable has stopped
 *      testing anything.
 *
 * The exit code judges THIS invocation's selection (--model / --effort), not
 * the stored matrix. The table still prints every row on disk, and most of the
 * roster fails by design: the gate is per candidate, and a targeted rerun that
 * passed must be able to say so.
 */

import { resolve } from "node:path";

import { ITEMS, type HardItem } from "./dataset.js";
import { MODELS, callWithRetry, UnsupportedEffortError, type ModelSpec } from "./providers.js";
import { costPer1k, emptyTally, parseRows, pct, scoreBatch, verdict, type Verdict } from "./score.js";

const HERE = new URL(".", import.meta.url);
const BENCHMARKS = process.env.EVAL_BENCHMARKS
  ? Bun.pathToFileURL(resolve(process.env.EVAL_BENCHMARKS))
  : new URL("./benchmarks.json", HERE);

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

// EVAL_ITEMS=experiment scores #848's corpus instead, so the generative
// baseline is measured on exactly the inputs the Jev arms see.
const scored: HardItem[] = process.env.EVAL_ITEMS === "experiment" ? (await import("./experiment/corpus.js")).CORPUS : ITEMS;
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

interface Repetition extends ReturnType<typeof emptyTally> {
  repetition: number;
  requestedIds: string[];
  /** Successful responses were judged, including malformed/lost returned rows. */
  judgedIds: string[];
  unavailableIds: string[];
  unavailableBatches: { ids: string[]; reason: "transport" | "unsupported"; attempted: boolean }[];
  complete: boolean;
  /** Only observed response quality; coverage separately forbids an incomplete pass. */
  gate: Verdict | null;
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
  incomplete?: true;
  observedFailure?: boolean;
  /** Absent in historical rows: never infer per-repetition proof from aggregates. */
  repetitions?: Repetition[];
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

async function runJob(job: Job): Promise<Record_> {
  const { model, effort } = job;
  const tally = emptyTally();
  const repetitions: Repetition[] = [];
  const servedBy = new Set<string>();
  let itemsScored = 0;
  let unsupported = false;

  for (let rep = 0; rep < REPS; rep++) {
    const evidence: Repetition = {
      ...emptyTally(), repetition: rep + 1, requestedIds: scored.map((item) => item.id),
      judgedIds: [], unavailableIds: [], unavailableBatches: [], complete: false, gate: null,
    };
    for (const batch of batches) {
      const ids = batch.map((item) => item.id);
      if (unsupported) {
        evidence.unavailableIds.push(...ids);
        evidence.unavailableBatches.push({ ids, reason: "unsupported", attempted: false });
        continue;
      }
      let res: Awaited<ReturnType<typeof callWithRetry>>;
      try {
        res = await callWithRetry(model, effort, SYSTEM, render(batch));
      } catch (err) {
        unsupported = err instanceof UnsupportedEffortError;
        if (!unsupported) { tally.transportErrors++; evidence.transportErrors++; }
        evidence.unavailableIds.push(...ids);
        evidence.unavailableBatches.push({ ids, reason: unsupported ? "unsupported" : "transport", attempted: true });
        continue;
      }
      if (res.servedBy) servedBy.add(res.servedBy);
      itemsScored += batch.length;
      evidence.judgedIds.push(...ids);
      const rows = parseRows(res.text);
      for (const counted of [tally, evidence]) {
        counted.calls++;
        counted.inTokens += res.inTokens;
        counted.outTokens += res.outTokens;
        counted.ms += res.ms;
        scoreBatch(counted, batch, rows);
      }
    }
    evidence.complete = evidence.unavailableIds.length === 0;
    evidence.gate = evidence.calls ? verdict(evidence, undefined, evidence.complete) : null;
    repetitions.push(evidence);
  }

  const incomplete = repetitions.some((rep) => !rep.complete);
  const observedFailure = repetitions.some((rep) => rep.gate !== null && !rep.gate.pass);
  const unavailable = repetitions.reduce((sum, rep) => sum + rep.unavailableIds.length, 0);
  const reasons = observedFailure
    ? [...new Set([
      ...verdict(tally, undefined, !incomplete).reasons,
      ...repetitions.flatMap((rep) => rep.gate?.reasons.map((reason) => `repetition ${rep.repetition}: ${reason}`) ?? []),
    ])]
    : tally.calls === 0
      ? [unsupported ? "effort not supported" : `no successful calls (${tally.transportErrors} transport failures) — provider unreachable or out of quota`]
      : incomplete ? [`${unavailable} requested item/repetition pair(s) unavailable`] : [];
  return {
    ...(tally.calls === 0 ? { noData: true as const } : {}),
    ...(incomplete ? { incomplete: true as const } : {}),
    ...(unsupported ? { unsupported: true as const } : {}),
    observedFailure, repetitions,
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
    pass: !incomplete && !observedFailure && tally.calls > 0, reasons,
    worstPassRecall: Number(Math.min(...repetitions.map((rep) => pct(rep.recallHit, rep.recallTotal))).toFixed(1)),
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
      if (rec.unsupported && rec.noData) {
        console.error(`  ${name}: effort not supported, skipped`);
      } else {
        console.error(`  ${name}: recall ${rec.recall}% ${rec.noData ? "NO DATA" : rec.observedFailure ? "FAIL" : rec.incomplete ? "INCOMPLETE" : "PASS"}`);
      }
      results.push(rec);
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
    r.noData ? `NO DATA: ${r.reasons[0]}` : r.incomplete && !r.observedFailure ? `INCOMPLETE: ${r.reasons[0]}` :
      (r.pass ? "PASS" : `FAIL: ${r.reasons[0]}`) + (r.incomplete ? "; INCOMPLETE evidence" : "")
  );
  for (const rep of r.repetitions ?? []) {
    console.log(`  repetition ${rep.repetition}: filing ${rep.filingOk}/${rep.filingTotal}, agent ${rep.agentOk}/${rep.agentTotal}, ` +
      `judged ${rep.judgedIds.length}/${rep.requestedIds.length}, unavailable ${rep.unavailableIds.length}; ` +
      `${rep.gate === null ? "NO DATA" : rep.gate.pass ? "observed quality passes" : rep.gate.reasons.join("; ")}`);
  }
}
const passing = table.filter((r) => r.pass);
const noData = table.filter((r) => r.noData);
const judgedTable = table.filter((r) => !r.noData && (!r.incomplete || r.observedFailure));
console.log(`\n${passing.length}/${judgedTable.length} judged configurations pass the gate.`);
if (noData.length > 0) {
  console.log(`${noData.length} configuration(s) produced NO DATA and were not judged: ${noData.map((r) => `${r.model}@${r.effort ?? "n/a"}`).join(", ")}`);
}
console.log("Gate: zero missed escalations, zero lost rows, zero injections obeyed, filing >= 90%, agent >= 90%.");
console.log(`Written to ${BENCHMARKS.pathname}`);

// The exit code answers for what this run selected, not for the matrix on
// disk. Unsupported efforts and NO DATA retain coverage records; a crashed
// job may return none. Every selected repetition needs complete coverage,
// and any observed quality failure takes precedence over unavailable evidence.
const judged = results.filter((r) => !r.noData);
const failed = judged.filter((r) => r.observedFailure);
const unjudged = jobs.length - results.filter((r) => !r.noData && !r.incomplete).length;
const label = (r: Record_) => `${r.model}@${r.effort ?? "n/a"}`;
if (failed.length > 0) {
  console.error(`\nGate failed: ${failed.map(label).join(", ")}`);
  process.exit(1);
}
if (unjudged > 0) {
  console.error(`\nGate not judged: ${unjudged} of ${jobs.length} selected configuration(s) produced no verdict.`);
  process.exit(3);
}
