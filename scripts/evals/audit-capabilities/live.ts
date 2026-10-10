/** Explicitly authorized measurement only; tests replace the lowest HTTP boundary. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cases, commandOutput, detect, capabilityArm, prepareBenchmark, DETECTION_DAY } from "./benchmark";
import { MODEL, protocol } from "./protocol";
import { runtimeFreeze, sha } from "./freeze";
import { parserDiagnostic } from "./parser-diagnostics";
import { buildReviewPacket, buildReviewPlan, combinedReview } from "./review-packets";
import { validPaidPolicy, type RootPaidPolicy } from "./review-policy";
import { assertSourceEffect, sourceSnapshot } from "./effects";
import { SONNET55_USD_PER_MTOK as RATE } from "../../measure-sonnet55-cost";
import type { CompletionProvider } from "../../../packages/core/src/lib/seams";
import { anthropicCompletions } from "../../../packages/core/src/providers/completions/anthropic";
export type Http = (url: string, init: RequestInit) => Promise<Response>;
export interface PhysicalCall {
  fixture: string; repetition: number; request: unknown; response: unknown;
  completionText?: string; parserDiagnostic?: ReturnType<typeof parserDiagnostic>; providerCompletionFailure?: string;
  status: number | null; outcome: string; elapsedMs: number;
  cost: { lowerUsd: number; upperUsd: number } | null;
  requestedTier: "standard_only"; requestedGeo: "global"; servedModel: string | null;
  returnedTier: unknown; returnedGeo: unknown; error: string | null; headers: Record<string, string>; freezeCheckMs: number; reservedUpperUsd: number;
  requestBytes: number; inputTokenUpperBound: number; outputTokenUpperBound: number;
  chargeDebitUpperUsd: number | null; retainedReservationUpperUsd: number; actualInvoiceUsd: null;
}
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// Sonnet5.5's documented supported context, not a byte/token estimate:
// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
// These conservative rates cover this frozen Standard/global, text-only baseline.
const INPUT_TOKEN_UPPER = 1_000_000;
const INPUT_USD_PER_MILLION_UPPER = 8;
const OUTPUT_USD_PER_MILLION_UPPER = 20;
/** Raw-usage pricing at the Sonnet 5.5 list rates (`SONNET55_USD_PER_MTOK`); incomplete TTL is a bounded interval. */
export function priceUsage(u: any): PhysicalCall["cost"] {
  if (!u || ![u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].every(count)) return null;
  if (u.cache_creation != null && (typeof u.cache_creation !== "object" || Array.isArray(u.cache_creation))) return null;
  const base = (u.input_tokens * RATE.input + u.output_tokens * RATE.output + u.cache_read_input_tokens * RATE.cacheRead) / 1e6;
  const write = u.cache_creation_input_tokens;
  const short = u.cache_creation?.ephemeral_5m_input_tokens, long = u.cache_creation?.ephemeral_1h_input_tokens;
  // Missing TTL permits the documented interval; malformed or contradictory
  // supplied counters cannot settle a reservation.
  if ((short !== undefined && (!count(short) || short > write)) ||
    (long !== undefined && (!count(long) || long > write)) ||
    (count(short) && count(long) && short + long !== write)) return null;
  if (!write) return { lowerUsd: base, upperUsd: base };
  if (count(short) && count(long) && short + long === write) {
    const exact = base + (short * RATE.cacheWrite5m + long * RATE.cacheWrite1h) / 1e6; return { lowerUsd: exact, upperUsd: exact };
  }
  return { lowerUsd: base + write * RATE.cacheWrite5m / 1e6, upperUsd: base + write * RATE.cacheWrite1h / 1e6 };
}
export class Spend {
  usedUpper = 0; stopped = false; unknownCostAttempts = 0;
  reservedUpperUsd = 0; knownChargeDebitUpperUsd = 0;
  get aggregateUpperUsd() { return this.unknownCostAttempts ? null : this.usedUpper; }
  constructor(readonly cap: number, readonly calls: PhysicalCall[], readonly save: () => void) {
    if (!Number.isFinite(cap) || cap <= 0 || cap > 15) throw Error("Invalid actual-charge allowance");
  }
  admit(maximum: number) {
    if (this.stopped || this.reservedUpperUsd > 0 || !Number.isFinite(maximum) || maximum <= 0 || this.knownChargeDebitUpperUsd + maximum > this.cap) throw Error("Budget/unknown-usage stop before physical dispatch");
    this.reservedUpperUsd = maximum;
  }
  settle(call: PhysicalCall) {
    if (call.cost) this.usedUpper += call.cost.upperUsd;
    if (call.outcome === "answered" && call.cost && call.chargeDebitUpperUsd !== null &&
      Number.isFinite(call.chargeDebitUpperUsd) && call.chargeDebitUpperUsd >= 0 && call.chargeDebitUpperUsd <= this.reservedUpperUsd) {
      this.knownChargeDebitUpperUsd += call.chargeDebitUpperUsd;
      this.reservedUpperUsd = 0;
    } else { this.stopped = true; this.unknownCostAttempts++; }
    call.retainedReservationUpperUsd = this.reservedUpperUsd;
    this.save();
  }
}
export function completion(spend: Spend, fixture: string, repetition: number, key: string, http: Http = fetch, verifyFreeze: () => void = () => {}) : CompletionProvider {
  // Real built-in request construction, text parsing and retry behavior remain intact.
  // A task-local env alias supplies the explicitly declared instrument credential.
  const provider = anthropicCompletions({ model: MODEL, apiKeyEnv: "BRAIN_841_INSTRUMENT_KEY" });
  return { ...provider, async complete(input) {
    const invocationStart = spend.calls.length;
    const verifyStart = performance.now();
    try { verifyFreeze(); } catch (error) { spend.stopped = true; throw error; }
    const freezeCheckMs = performance.now() - verifyStart;
    if (!key.trim()) { spend.stopped = true; throw Error("No declared API instrument credential"); }
    if (input.maxTokens !== 2000 || input.system || input.parts) { spend.stopped = true; throw Error("Actual baseline provider request drift"); }
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.BRAIN_841_INSTRUMENT_KEY;
    process.env.BRAIN_841_INSTRUMENT_KEY = key;
    const observed: Http = async (url, init) => {
      if (url !== "https://api.anthropic.com/v1/messages" || init.method !== "POST") { spend.stopped = true; throw Error("Unexpected provider transport boundary"); }
      const request = JSON.parse(String(init.body));
      if (request.model !== MODEL || request.max_tokens !== 2000 || request.messages?.length !== 1 || request.messages[0]?.content?.length !== 1 || request.messages[0].content[0]?.type !== "text") { spend.stopped = true; throw Error("Shipped provider request differs from frozen baseline"); }
      // Only explicit billing route selectors are added to the real provider body.
      const body = JSON.stringify({ ...request, service_tier: "standard_only", inference_geo: "global" });
      const reservedUpperUsd = (INPUT_TOKEN_UPPER * INPUT_USD_PER_MILLION_UPPER + request.max_tokens * OUTPUT_USD_PER_MILLION_UPPER) / 1e6;
      try { spend.admit(reservedUpperUsd); } catch (error) { spend.stopped = true; throw error; }
      const call: PhysicalCall = { fixture, repetition, request: JSON.parse(body), response: null, status: null, outcome: "pending", elapsedMs: 0, cost: null, requestedTier: "standard_only", requestedGeo: "global", servedModel: null, returnedTier: null, returnedGeo: null, error: null, headers: {}, freezeCheckMs, reservedUpperUsd,
        requestBytes: Buffer.byteLength(body), inputTokenUpperBound: INPUT_TOKEN_UPPER, outputTokenUpperBound: request.max_tokens,
        chargeDebitUpperUsd: null, retainedReservationUpperUsd: reservedUpperUsd, actualInvoiceUsd: null };
      spend.calls.push(call); spend.save();
      const started = performance.now();
      try {
        const response = await http(url, { ...init, body, signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
        call.status = response.status;
        call.headers = Object.fromEntries([...response.headers].filter(([name]) => name === "request-id" || name.startsWith("anthropic-ratelimit-") || name.startsWith("anthropic-priority-")));
        const j = await response.clone().json() as any; call.response = j;
        call.servedModel = typeof j.model === "string" ? j.model : null;
        call.returnedTier = j.usage?.service_tier ?? null; call.returnedGeo = j.usage?.inference_geo ?? j.inference_geo ?? null;
        call.cost = priceUsage(j.usage); call.outcome = response.ok ? "answered" : "http_error";
        if (response.ok && j.model !== MODEL) { call.cost = null; call.outcome = "unapproved_model"; throw Error("Unapproved served model"); }
        if ((call.returnedTier !== null && call.returnedTier !== "standard") || (call.returnedGeo !== null && call.returnedGeo !== "global")) { call.cost = null; call.outcome = "unexpected_rate_metadata"; throw Error("Returned billing tier/geography differs from requested bounded route"); }
        if (response.ok && !call.cost) { call.outcome = "unknown_usage"; throw Error("Raw usage missing or invalid"); }
        if (call.cost) {
          const inputTotal = j.usage.input_tokens + j.usage.cache_read_input_tokens + j.usage.cache_creation_input_tokens;
          if (!count(inputTotal) || inputTotal > call.inputTokenUpperBound || j.usage.output_tokens > call.outputTokenUpperBound) {
            call.cost = null; call.outcome = "over_bound_usage"; throw Error("Raw usage exceeds admitted input/output bounds");
          }
          call.chargeDebitUpperUsd = (inputTotal * INPUT_USD_PER_MILLION_UPPER + j.usage.output_tokens * OUTPUT_USD_PER_MILLION_UPPER) / 1e6;
        }
        // The shipped provider returns text on max_tokens as well as end_turn.
        // Retain that native behavior and record raw stop_reason; never silently
        // upgrade the baseline by requesting more output or adding instructions.
        return response;
      } catch (error) {
        call.error = String(error); if (call.outcome === "pending") call.outcome = "lost_response";
        throw error;
      } finally { call.elapsedMs = performance.now() - started; spend.settle(call); }
    };
    globalThis.fetch = observed as typeof fetch;
    try {
      const text = await provider.complete(input);
      const last = spend.calls.at(-1);
      if (spend.calls.length > invocationStart && last?.fixture === fixture && last.repetition === repetition) { last.completionText = text; last.parserDiagnostic = parserDiagnostic(text); spend.save(); }
      return text;
    } catch (error) {
      spend.stopped = true;
      const last = spend.calls.at(-1);
      if (spend.calls.length > invocationStart && last?.fixture === fixture && last.repetition === repetition) { last.providerCompletionFailure = String(error); spend.save(); }
      throw error;
    }
    finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.BRAIN_841_INSTRUMENT_KEY; else process.env.BRAIN_841_INSTRUMENT_KEY = previousKey;
    }
  } };
}
export function currentProposalStats(output: unknown, f: typeof cases[number]) {
  if (!Array.isArray(output)) return { invalidShape: true, rows: [] };
  return { invalidShape: false, rows: output.map((s: any) => {
    const safePath = typeof s.path === "string" && Object.hasOwn(f.files, s.path);
    const claimed = Boolean(s.canAutoFix); // same truthy flag the current human CLI prints
    const supportedShape = typeof s.path === "string" && typeof s.issue === "string" && typeof s.suggestion === "string" && typeof s.canAutoFix === "boolean";
    const replacement = typeof s.fix === "string" ? s.fix : null;
    const projected = safePath && replacement !== null ? { ...f.files, [s.path]: replacement } : null;
    return { safePath, claimed, supportedShape, hasReplacement: replacement !== null, proposedNoOp: claimed && safePath && replacement === f.files[s.path], exactAuthoredPreview: projected !== null && isDeepStrictEqual(projected, f.expectedPreviewFiles), output: s };
  }) };
}
/** Same physical command boundary for all arms; any source deviation stops the caller. */
export async function observeArm(p: Awaited<ReturnType<typeof prepareBenchmark>>, f: typeof cases[number], arm: typeof protocol.arms[number], detected: Awaited<ReturnType<typeof detect>>, completions?: CompletionProvider) {
  const before = sourceSnapshot(p.root);
  try {
    assertSourceEffect(before, before, f.files);
    const output = arm === "capability-backed-registry" ? await capabilityArm(p, f, detected.report.issues) : await commandOutput(p, true, completions);
    const afterCommand = sourceSnapshot(p.root);
    assertSourceEffect(before, afterCommand, arm === "capability-backed-registry" ? f.expectedEffectFiles : f.files);
    const ordinaryAfter = arm === "capability-backed-registry" ? null : (await detect(p)).report;
    const afterDetection = sourceSnapshot(p.root);
    assertSourceEffect(afterCommand, afterDetection, arm === "capability-backed-registry" ? f.expectedEffectFiles : f.files);
    const fileBytes = (snapshot: typeof before) => Object.fromEntries(Object.entries(snapshot).filter(([, e]) => e.kind === "file").map(([path, e]) => [path, e.bytes]));
    return { output, sourceEffects: { before, afterCommand, afterDetection }, sourceFilesUnchanged: isDeepStrictEqual(fileBytes(afterCommand), fileBytes(before)), ordinaryTotalsUnchanged: ordinaryAfter === null ? null : isDeepStrictEqual(ordinaryAfter, detected.report) };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { sourceEffects: { before, afterFailure: sourceSnapshot(p.root) } });
  }
}
export async function main() {
  if (process.env.BRAIN_LIVE_EVAL !== "841") throw Error("Only explicitly authorized #841 dispatch");
  if (new Date().toISOString().slice(0, 10) !== DETECTION_DAY) throw Error("Real audit detection date differs from frozen protocol");
  const out = process.argv[2], reviewPath = process.argv[3], expectedPath = process.argv[4], proofPath = process.argv[5], policiesPath = process.argv[6];
  if (!out || existsSync(out) || !reviewPath || !expectedPath || !proofPath || !policiesPath) throw Error("Fresh protected output, exact review/detected/proof inputs and independent policy map required");
  const policies: Record<string, RootPaidPolicy> = JSON.parse(readFileSync(policiesPath, "utf8"));
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) throw Error("Independent packet paid policy map must name all planned packets");
  const frozen = runtimeFreeze(); const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  if (review.freezeSha !== frozen.freezeSha || review.approval !== "APPROVED" || review.model !== MODEL || review.packetCaseIds?.length !== cases.length) throw Error("No complete exact-frozen complementary semantic approval");
  const expectedRaw = readFileSync(expectedPath, "utf8"), expected = JSON.parse(expectedRaw);
  const proofRaw = readFileSync(proofPath, "utf8");
  const { reviewPlan } = buildReviewPlan(frozen, expectedRaw, proofRaw);
  if (Object.keys(policies).length !== reviewPlan.length || Object.keys(policies).some(key => !reviewPlan.some(packet => packet.key === key))) throw Error("Independent packet paid policy map must name exactly all planned packets");
  const runtime = { sdk: frozen.binaries.claude.sdkVersion, nativeSha: frozen.binaries.claude.sha256, nativeMode: frozen.binaries.claude.mode, bunSha: frozen.binaries.bun.sha256, bunVersion: frozen.binaries.bun.version, bunMode: frozen.binaries.bun.mode };
  for (const packet of reviewPlan) {
    const p = Object.hasOwn(policies, packet.key) ? policies[packet.key] : undefined;
    // Validate shape/bindings at issuance; completed policies may be expired now.
    // The original raw replay still verifies the literal recorded admission time.
    if (!p || typeof p.issuedAt !== "string" || typeof p.expiresAt !== "string" || !validPaidPolicy(p, { freezeSha: frozen.freezeSha, promptSha: buildReviewPacket(frozen, expectedRaw, proofRaw, packet.key).promptSha, runtime, proofSha: sha(proofRaw), detectedSha: sha(expectedRaw), protocolSha: sha(JSON.stringify(frozen.protocol)), dispatchedAt: p.issuedAt })) throw Error(`Independent packet paid policy differs from exact bindings: ${packet.key}`);
  }
  combinedReview(review.nativeReceipts ?? [], frozen, expectedRaw, proofRaw, policies);
  if (review.verificationSha !== sha(proofRaw)) throw Error("Verification receipt differs from exact approval");
  if (review.detectedSha !== sha(expectedRaw)) throw Error("Detected inputs are not independently reviewed");
  const cap = Number(process.env.BRAIN_EVAL_REMAINING_USD);
  mkdirSync(out, { mode: 0o700 });
  const calls: PhysicalCall[] = [], observations: unknown[] = [];
  const save = () => { writeFileSync(join(out, "physical-calls.json"), JSON.stringify(calls, null, 2), { mode: 0o600 }); writeFileSync(join(out, "observations.json"), JSON.stringify(observations, null, 2), { mode: 0o600 }); };
  const spend = new Spend(cap, calls, save);
  writeFileSync(join(out, "freeze.json"), JSON.stringify(frozen, null, 2), { mode: 0o600 }); save();
  try {
    for (const f of cases) for (let repetition = 0; repetition < protocol.repetitions; repetition++) {
      for (const arm of protocol.arms) {
        const start = performance.now(); const p = await prepareBenchmark(f);
        try {
          const detected = await detect(p);
          if (!isDeepStrictEqual(detected, expected.find((r: any) => r.id === f.id)?.detected)) throw Error(`${f.id}: actual detection/input drift`);
          const armStart = performance.now(); const firstCall = calls.length;
          const observed = await observeArm(p, f, arm, detected, arm === "actual-current-message-only" ? completion(spend, f.id, repetition, process.env.ANTHROPIC_API_KEY ?? "", fetch, () => { if (runtimeFreeze().freezeSha !== frozen.freezeSha) throw Error("Runtime changed after review before physical dispatch"); }) : undefined).catch(error => { observations.push({ fixture: f.id, repetition, arm, error: String(error), sourceEffects: error.sourceEffects ?? null, physicalCallIndices: calls.slice(firstCall).map((_, n) => firstCall + n) }); save(); throw error; });
          const { output } = observed;
          const excludedFreezeCheckMs = calls.slice(firstCall).reduce((s, c) => s + c.freezeCheckMs, 0);
          const durationMs = performance.now() - armStart - excludedFreezeCheckMs;
          const rawTaskDurationMs = performance.now() - start;
          observations.push({ fixture: f.id, split: f.split, repetition, arm, detected, durationMs, rawTaskDurationMs, taskDurationMs: rawTaskDurationMs - excludedFreezeCheckMs, excludedFreezeCheckMs, physicalCallIndices: calls.slice(firstCall).map((_, n) => firstCall + n), ...observed, projection: arm === "actual-current-message-only" ? currentProposalStats(output, f) : null });
          save();
          if (spend.stopped) throw Error("Stop after failed/unknown physical attempt, even if actual audit fell back to manual output");
          if (new Date().toISOString().slice(0, 10) !== DETECTION_DAY) throw Error("Audit date crossed frozen day");
        } finally { p.close(); }
      }
    }
  } finally { writeFileSync(join(out, "billing.json"), JSON.stringify({ reservationUsd: cap, usageDerivedStandardCostUpperUsd: spend.aggregateUpperUsd, knownUsageDerivedStandardCostUpperSubtotalUsd: spend.usedUpper,
    conservativeKnownChargeDebitUpperUsd: spend.knownChargeDebitUpperUsd, retainedReservationUpperUsd: spend.reservedUpperUsd,
    unknownCostAttempts: spend.unknownCostAttempts, missingUsageStop: spend.stopped, actualInvoiceUsd: null, actualInvoice: "not supplied", physicalAttempts: calls.length }, null, 2), { mode: 0o600 }); save(); }
}
if (import.meta.main) await main();
