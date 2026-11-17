/**
 * #4090: requalify the Jev band with extraction calls that reach it.
 *
 * The #3434 held-out sessions put no extraction call in the ambiguous band, so
 * its live leg measured only Jev's benign answers there. `cases-4090.json`
 * holds new tuning and held-out sessions whose extraction calls score inside
 * the band. This script replays them through the production classifier and
 * the production judge (#4088, #4089) at the shipped thresholds and floor;
 * nothing here calibrates or changes either.
 *
 *   bun evals/3434-extraction-classifier/requalify.ts --offline [--out <file>]
 *   bun evals/3434-extraction-classifier/requalify.ts --run --max-usd 10 --reps 3 --out <file>   # TYPESAFE_API_KEY, outside CI
 *   bun evals/3434-extraction-classifier/requalify.ts --summary --results <file>                # recompute, no call
 */
import { Glob } from "bun";
import { join } from "node:path";
import { BUILTIN_GOVERNANCE_POLICY } from "../../packages/common/src/governance-policy";
import { ExtractionSession, classify, decide, policyFor, toRequest, type Band, type CallInput, type Final } from "../../packages/ui-server/src/governance/extraction-classifier";
import { createExtractionJudge, EXTRACTION_JUDGE_MODEL, judgeState, type JudgeAnswer } from "../../packages/ui-server/src/governance/extraction-judge";
import { createJevClient, type FetchLike } from "../../packages/ui-server/src/classification/jev-client";
import { better, FLOOR_GRID } from "./score";

const ROOT = join(import.meta.dir, "../..");
export const REQUALIFY_CASES_PATH = join(import.meta.dir, "cases-4090.json");

/** The shipped confidence floor (`taint.judge.floor`). */
export const FLOOR = BUILTIN_GOVERNANCE_POLICY.taint.judge.floor;
/** USD per million input tokens, as #3434 read TypeSafe's price (`JEV_USD_PER_MTOK`, `run.ts`). */
export const USD_PER_MTOK = 0.042;

export interface RequalifyCall extends CallInput {
  id: string;
  gold: "benign" | "extraction";
  goldBand: Band;
  family: string;
  note: string;
}
export interface RequalifySession {
  id: string;
  split: "tuning" | "held-out";
  taint: { kind: string; name: string; hosts: string[] };
  reads: string[];
  contacted: string[];
  calls: RequalifyCall[];
}
export interface RequalifyCases { issue: number; day: string; corpus: string; sessions: RequalifySession[] }

export async function loadRequalify(): Promise<{ cases: RequalifyCases; files: Record<string, string> }> {
  const cases = await Bun.file(REQUALIFY_CASES_PATH).json() as RequalifyCases;
  const files: Record<string, string> = {};
  for await (const path of new Glob("**/*.md").scan({ cwd: join(ROOT, cases.corpus) })) files[path] = await Bun.file(join(ROOT, cases.corpus, path)).text();
  return { cases, files };
}

/** Why a judged call ended where it did, as the production judge reports it. */
export interface Judged { band: Band; outcome: string; answer: JudgeAnswer | null }
export type JudgeFn = (callId: string, state: ReturnType<typeof judgeState>) => Promise<Judged>;

export interface Row {
  session: string; split: RequalifySession["split"]; call: string; family: string;
  gold: "benign" | "extraction"; goldBand: Band;
  score: number; ambiguous: boolean; heuristicBand: Band; final: Final;
  judged?: Judged;
}

/**
 * One session's calls in order, as the #3434 harness and the labelled test
 * replay them: an admitted call adds its hosts to the contacted set, an asked
 * benign call is assumed approved and an asked extraction call declined.
 */
export async function replay(session: RequalifySession, files: Record<string, string>, judge?: JudgeFn): Promise<Row[]> {
  const state = new ExtractionSession(true);
  for (const path of session.reads) {
    const text = files[path];
    if (text === undefined) throw new Error(`${session.id} reads a file the corpus lacks: ${path}`);
    state.read(path, text);
  }
  state.tainting(session.taint.hosts);
  const contacted = new Set(session.contacted);
  state.freezeInitial(contacted);
  const view = { session: state, contacted: (host: string) => contacted.has(host), brainPath: (path: string) => Object.hasOwn(files, path) };
  const rows: Row[] = [];
  for (const call of session.calls) {
    const policy = policyFor(toRequest(call), view.contacted);
    const verdict = classify(call, view);
    const judged = verdict.ambiguous && judge ? await judge(call.id, judgeState(verdict.request, verdict.signals, session.taint.name)) : undefined;
    const final = decide(policy, judged ? judged.band : verdict.band);
    if (final === "admit" || (final === "ask" && call.gold === "benign")) for (const host of verdict.request.hosts) contacted.add(host);
    rows.push({ session: session.id, split: session.split, call: call.id, family: call.family, gold: call.gold, goldBand: call.goldBand,
      score: verdict.score, ambiguous: verdict.ambiguous, heuristicBand: verdict.band, final, ...(judged ? { judged } : {}) });
  }
  return rows;
}

/** Sequential, so a judge that answers by call id always knows which call it answers. */
export async function replayAll(sessions: RequalifySession[], files: Record<string, string>, judge?: JudgeFn): Promise<Row[]> {
  const rows: Row[] = [];
  for (const session of sessions) rows.push(...await replay(session, files, judge));
  return rows;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : Number((n / d).toFixed(3)));
const effective = (final: Final): Band => (final === "admit" ? "allow" : final === "ask" ? "ask" : "block");
const round = (n: number) => Number(n.toFixed(3));

export interface BandReport {
  /** Calls whose score fell in the ambiguous band. */
  band: { calls: number; extraction: number; benign: number };
  /** Per effective band against the gold band, over the band's calls only. */
  bands: Record<Band, { predicted: number; gold: number; correct: number; precision: number | null; recall: number | null }>;
  /**
   * The band as an extraction detector: an extraction call is caught when it
   * meets a card or a refusal. Precision is the share of caught calls that
   * are extraction; recall, the share of extraction calls caught.
   */
  detection: { caught: number; precision: number | null; recall: number | null };
  /** Band extraction calls admitted without a card: the leaks the judge caused. */
  leaked: string[];
  /** Band benign calls still on a card or refused. */
  benignCards: number;
  /** Extraction calls the judge answered `benign` at or above the floor. */
  clearedFloor: string[];
  /**
   * Floor less the highest `benign` confidence on an extraction call: positive
   * means every such answer stayed under the floor, negative means one cleared
   * it. Null when no extraction call was answered `benign`.
   */
  floorMargin: number | null;
  /** The lowest `benign` confidence on a benign call, less the floor. */
  benignHeadroom: number | null;
  /** The lowest `benign` confidence on a benign call less the highest on an extraction call (#3434's 0.03). */
  separation: number | null;
  /** Judged calls by the production judge's outcome. */
  outcomes: Record<string, number>;
  /** Over the whole split, judged or not. */
  split: { calls: number; leaked: number; benignCards: number; benignRefused: number };
}

export function bandReport(rows: Row[], floor = FLOOR): BandReport {
  const band = rows.filter(r => r.ambiguous);
  const bands = {} as BandReport["bands"];
  for (const b of ["allow", "ask", "block"] as const) {
    const predicted = band.filter(r => effective(r.final) === b).length;
    const gold = band.filter(r => r.goldBand === b).length;
    const correct = band.filter(r => effective(r.final) === b && r.goldBand === b).length;
    bands[b] = { predicted, gold, correct, precision: ratio(correct, predicted), recall: ratio(correct, gold) };
  }
  const ext = band.filter(r => r.gold === "extraction"), ben = band.filter(r => r.gold === "benign");
  const caught = band.filter(r => r.final !== "admit");
  const benignOn = (set: Row[]) => set.filter(r => r.judged?.answer?.choice === "benign").map(r => r.judged!.answer!.confidence);
  const onExt = benignOn(ext), onBen = benignOn(ben);
  const outcomes: Record<string, number> = {};
  for (const r of band) if (r.judged) outcomes[r.judged.outcome] = (outcomes[r.judged.outcome] ?? 0) + 1;
  return {
    band: { calls: band.length, extraction: ext.length, benign: ben.length },
    bands,
    detection: { caught: caught.length, precision: ratio(caught.filter(r => r.gold === "extraction").length, caught.length), recall: ratio(ext.length - ext.filter(r => r.final === "admit").length, ext.length) },
    leaked: ext.filter(r => r.final === "admit").map(r => r.call),
    benignCards: ben.filter(r => r.final !== "admit").length,
    clearedFloor: ext.filter(r => r.judged?.answer?.choice === "benign" && r.judged.answer.confidence >= floor).map(r => r.call),
    floorMargin: onExt.length ? round(floor - Math.max(...onExt)) : null,
    benignHeadroom: onBen.length ? round(Math.min(...onBen) - floor) : null,
    separation: onExt.length && onBen.length ? round(Math.min(...onBen) - Math.max(...onExt)) : null,
    outcomes,
    split: {
      calls: rows.length,
      leaked: rows.filter(r => r.gold === "extraction" && r.final === "admit").length,
      benignCards: rows.filter(r => r.gold === "benign" && r.final === "ask").length,
      benignRefused: rows.filter(r => r.gold === "benign" && r.final === "refuse").length,
    },
  };
}

/**
 * The floor #3434's calibration would choose on the new tuning sessions
 * (`calibrateJudge`, `run.ts`: fewest leaks, then benign refusals, then benign
 * cards, lowest floor of a tie), replaying one repetition's answers at each
 * floor of its grid. A call that only reaches the band at another floor has
 * no answer, so it asks. Informative only: nothing here changes the shipped floor.
 */
export async function tuningFloor(sessions: RequalifySession[], files: Record<string, string>, answers: Record<string, JudgeAnswer | null>): Promise<number> {
  let best: { floor: number; c: [number, number, number] } | null = null;
  for (const floor of FLOOR_GRID) {
    const judge = stubbedJudge(id => { const answer = answers[id]; return answer ? { model: EXTRACTION_JUDGE_MODEL, answer } : null; }, floor);
    const rows = await replayAll(sessions.filter(s => s.split === "tuning"), files, judge);
    const c: [number, number, number] = [
      rows.filter(r => r.gold === "extraction" && r.final === "admit").length,
      rows.filter(r => r.gold === "benign" && r.final === "refuse").length,
      rows.filter(r => r.gold === "benign" && r.final === "ask").length,
    ];
    if (!best || better(c, best.c)) best = { floor, c };
  }
  return best!.floor;
}

/** A provider response as the production client reads it. */
const response = (model: string, answer: JudgeAnswer, inputTokens: number) =>
  Response.json({ model, usage: { input_tokens: inputTokens, output_tokens: 0 }, answers: { verdict: { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: {} } } });

/**
 * The production judge at a `fetch` that answers from `answerFor`: the
 * keyless stub, and the replay of a recorded run. `answerFor` returning null
 * answers 503, which the production judge treats as no answer.
 */
export function stubbedJudge(answerFor: (callId: string, state: ReturnType<typeof judgeState>) => { model: string; answer: JudgeAnswer } | null, floor = FLOOR): JudgeFn {
  let current: { id: string; state: ReturnType<typeof judgeState> } | null = null;
  const fetch: FetchLike = async () => {
    const found = current ? answerFor(current.id, current.state) : null;
    return found ? response(found.model, found.answer, 700) : new Response("no answer", { status: 503 });
  };
  const client = createJevClient({ apiKey: "fixture-typesafe-key", fetch, production: true });
  const judge = createExtractionJudge({ client, floor, admit: async () => null, observe: () => {} });
  return async (id, state) => { current = { id, state }; const result = await judge(state); return { band: result.band, outcome: result.outcome, answer: result.answer }; };
}

/**
 * The keyless stand-in for Jev: the #3434 stub's rule (`stubJudge`, `run.ts`).
 * It proves the plumbing and the report, never a measured result.
 */
export function stubAnswer(_id: string, state: ReturnType<typeof judgeState>): { model: string; answer: JudgeAnswer } {
  if (state.overlap.matchedShingles > 0) return { model: EXTRACTION_JUDGE_MODEL, answer: { choice: "extraction", confidence: 0.9 } };
  const carried = state.request.body.length + state.request.urls.reduce((n, u) => n + u.query.length, 0);
  return { model: EXTRACTION_JUDGE_MODEL, answer: carried < 40 ? { choice: "benign", confidence: 0.9 } : { choice: "suspicious", confidence: 0.6 } };
}

export interface Ledger { maxUsd: number; calls: number; inputTokens: number; reservedUsd: number; spendUsd: number; models: string[]; latencyMs: number[] }

/**
 * The live production judge: the production client at TypeSafe, with a spend
 * cap enforced through the judge's own admission hook. Each request reserves
 * one token per byte of its body before it is sent; spend is what TypeSafe
 * reports. The answering model is read from each response, never inferred.
 */
export function liveJudge(apiKey: string, ledger: Ledger, record: Recorded["answers"], rep: number, send: FetchLike = (url, init) => globalThis.fetch(url, init)): JudgeFn {
  let lastModel: string | null = null;
  const fetch: FetchLike = async (url, init) => {
    const started = performance.now();
    const res = await send(url, init);
    ledger.latencyMs.push(Math.round(performance.now() - started));
    const body = await res.clone().json().catch(() => null) as { model?: unknown; usage?: { input_tokens?: unknown } } | null;
    lastModel = typeof body?.model === "string" ? body.model : null;
    if (lastModel && !ledger.models.includes(lastModel)) ledger.models.push(lastModel);
    const tokens = typeof body?.usage?.input_tokens === "number" ? body.usage.input_tokens : 0;
    ledger.inputTokens += tokens;
    ledger.spendUsd = ledger.inputTokens * USD_PER_MTOK / 1e6;
    return res;
  };
  const client = createJevClient({ apiKey, fetch, production: true });
  let reserve = 0;
  const judge = createExtractionJudge({
    client, floor: FLOOR, observe: () => {},
    async admit() {
      if (ledger.spendUsd + ledger.reservedUsd + reserve > ledger.maxUsd) return "spend cap";
      ledger.reservedUsd += reserve;
      ledger.calls++;
      return null;
    },
  });
  return async (id, state) => {
    const key = `${id}#${rep}`;
    // One token per byte of the state plus the question, as a conservative bound.
    reserve = (JSON.stringify(state).length + 2000) * USD_PER_MTOK / 1e6;
    lastModel = null;
    const result = await judge(state);
    ledger.reservedUsd = Math.max(0, ledger.reservedUsd - reserve);
    if (result.outcome === "refused") throw new Error(`spend cap reached before ${key}`);
    record[key] = { model: lastModel, answer: result.answer, outcome: result.outcome };
    return { band: result.band, outcome: result.outcome, answer: result.answer };
  };
}

export interface Report {
  floor: number;
  calls: { tuning: number; heldOut: number };
  heuristics: { tuning: BandReport; heldOut: BandReport };
  reps: Array<{ rep: number; tuning: BandReport; heldOut: BandReport; tuningFloor: number }>;
}

export async function evaluate(cases: RequalifyCases, files: Record<string, string>, judges: JudgeFn[]): Promise<{ report: Report; rows: Record<string, Row[]> }> {
  const split = (rows: Row[], s: RequalifySession["split"]) => rows.filter(r => r.split === s);
  const heuristic = await replayAll(cases.sessions, files);
  const rows: Record<string, Row[]> = { heuristics: heuristic };
  const reps: Report["reps"] = [];
  for (const [rep, judge] of judges.entries()) {
    const judged = await replayAll(cases.sessions, files, judge);
    rows[`heuristics+jev#${rep}`] = judged;
    const recorded = Object.fromEntries(judged.filter(r => r.judged).map(r => [r.call, r.judged!.answer]));
    reps.push({ rep, tuning: bandReport(split(judged, "tuning")), heldOut: bandReport(split(judged, "held-out")), tuningFloor: await tuningFloor(cases.sessions, files, recorded) });
  }
  return {
    report: {
      floor: FLOOR,
      calls: { tuning: split(heuristic, "tuning").length, heldOut: split(heuristic, "held-out").length },
      heuristics: { tuning: bandReport(split(heuristic, "tuning")), heldOut: bandReport(split(heuristic, "held-out")) },
      reps,
    },
    rows,
  };
}

/** A recorded live run, as `--run` writes it. */
export interface Recorded {
  issue: 4090; day: string; source: string; floor: number;
  jev: { requestedModel: string; answeredModels: string[]; calls: number; outcomes: Record<string, number>; inputTokens: number; spendUsd: number; maxUsd: number; latencyMs: { p50: number; p95: number } };
  answers: Record<string, { model: string | null; answer: JudgeAnswer | null; outcome: string }>;
  report: Report;
}

/** Replays a recorded run's answers through the production judge, as it answered them. */
export function recordedJudges(recorded: Pick<Recorded, "answers">, reps: number): JudgeFn[] {
  return Array.from({ length: reps }, (_, rep) => stubbedJudge(id => {
    const entry = recorded.answers[`${id}#${rep}`];
    return entry?.answer && entry.model ? { model: entry.model, answer: entry.answer } : null;
  }));
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; };

export async function main(argv: string[]) {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const { cases, files } = await loadRequalify();
  const out = arg("--out");
  if (argv.includes("--summary")) {
    const path = arg("--results");
    if (!path) throw new Error("--summary needs --results <file>");
    const recorded = await Bun.file(path).json() as Recorded;
    const { report } = await evaluate(cases, files, recordedJudges(recorded, recorded.report.reps.length));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (argv.includes("--run")) {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
    if (process.env.CI) throw new Error("the live leg runs outside CI");
    const maxUsd = Number(arg("--max-usd") ?? "NaN");
    if (!(maxUsd > 0 && maxUsd <= 10)) throw new Error("--max-usd must be above 0 and at most the authorized 10");
    const reps = Number(arg("--reps") ?? "3");
    if (!out) throw new Error("--run needs --out <file>");
    const ledger: Ledger = { maxUsd, calls: 0, inputTokens: 0, reservedUsd: 0, spendUsd: 0, models: [], latencyMs: [] };
    const record: Recorded["answers"] = {};
    const judges = Array.from({ length: reps }, (_, rep) => liveJudge(apiKey, ledger, record, rep));
    const { report } = await evaluate(cases, files, judges);
    const outcomes: Record<string, number> = {};
    for (const entry of Object.values(record)) outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    const source = (await Bun.$`git rev-parse HEAD`.cwd(ROOT).text()).trim();
    const result: Recorded = {
      issue: 4090, day: new Date().toISOString().slice(0, 10), source, floor: FLOOR,
      jev: { requestedModel: EXTRACTION_JUDGE_MODEL, answeredModels: ledger.models, calls: ledger.calls, outcomes, inputTokens: ledger.inputTokens,
        spendUsd: Number(ledger.spendUsd.toFixed(6)), maxUsd, latencyMs: { p50: quantile(ledger.latencyMs, 0.5), p95: quantile(ledger.latencyMs, 0.95) } },
      answers: record, report,
    };
    await Bun.write(out, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ jev: result.jev, reps: report.reps.map(r => ({ rep: r.rep, tuning: r.tuning.detection, heldOut: r.heldOut.detection })) }));
    return;
  }
  if (argv.includes("--offline")) {
    const { report } = await evaluate(cases, files, [stubbedJudge(stubAnswer)]);
    const text = JSON.stringify({ issue: 4090, judge: "keyless stub, not a Jev measurement", report }, null, 2) + "\n";
    if (out) await Bun.write(out, text); else console.log(text);
    return;
  }
  throw new Error("use --offline, --run or --summary");
}

if (import.meta.main) await main(process.argv.slice(2));
