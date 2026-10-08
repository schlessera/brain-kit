/** Private blind label-panel preparation. No entry point, credential discovery or live admission. */
import { callModel, type ModelSpec } from "../providers";
import { parseRows, type Row } from "../score";
import { recordVotes, judgeItem, type Votes } from "../judge";
import { type HardItem } from "../dataset";
import { sha, ROUTES } from "./adapter";

export const LABEL_PANEL = Object.freeze({
  models: [
    { id: "claude-sonnet-5-5", label: "sonnet-5.5", provider: "anthropic" },
    { id: "gpt-6.1-sol", label: "gpt-6.1-sol", provider: "openai" },
    { id: "gemini-3.8-flash", label: "gemini-3.8-flash", provider: "gemini" },
  ] as const,
  effort: "high", repetitions: 3, batchSize: 4, maxAttempts: 2, responseDeadlineMs: 180000,
  pricing: "unavailable in this collector; raw native counters retained, no invented zero or invoice",
  selection: "https://github.com/schlessera/brain-kit/issues/848#issuecomment-6064579891",
  method: "unchanged donor callModel, rubric, projection, parseRows, recordVotes and unanimous modal judgeItem; raw APIs only",
  sources: ["https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    "https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create",
    "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash", "https://ai.google.dev/api/generate-content"],
  measured: false, dispatchAllowed: false,
});
type Judge = typeof LABEL_PANEL.models[number];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const optionalCount = (v: unknown) => count(v) ? v : null;
export const blindProjection = (items: HardItem[]) => items.map(({ id, source, title, body }) => ({ id, source, title, body }));
export function labelRequests(items: HardItem[]) {
  if (items.length !== 40 || new Set(items.map(i => i.id)).size !== 40) throw Error("Require all forty unique inputs");
  return Array.from({ length: 10 }, (_, i) => JSON.stringify(blindProjection(items.slice(i * 4, i * 4 + 4)), null, 1));
}
export interface PanelPhysical {
  judge: string; repetition: number; batch: number; attempt: number;
  endpoint: string | null; requestBody: string | null; requestSha: string | null;
  responseBase64: string | null; responseSha: string | null; responseComplete: boolean;
  status: number | null; headers: Record<string, string>; servedModel: string | null; rawUsage: unknown;
  readerCleanup: "natural-eof" | "cancelled" | "cancel-failed" | null;
  transportDispatched: boolean;
  tokens: { input: number | null; output: number | null; thinking: number | null; cacheRead: number | null; cacheWrite: number | null };
  terminal: boolean; usageComplete: boolean; error: string | null; durationMs: number;
  listPriceUsd: null; invoiceUsd: null;
}
function nativeFields(judge: Judge, j: any, r: PanelPhysical) {
  if (!object(j)) return;
  r.servedModel = typeof (judge.provider === "gemini" ? j.modelVersion : j.model) === "string"
    ? (judge.provider === "gemini" ? j.modelVersion : j.model) : null;
  const u = judge.provider === "gemini" ? j.usageMetadata : j.usage;
  r.rawUsage = u ?? null;
  if (!object(u)) return;
  if (judge.provider === "anthropic") {
    r.tokens = { input: optionalCount(u.input_tokens), output: optionalCount(u.output_tokens), thinking: null,
      cacheRead: optionalCount(u.cache_read_input_tokens), cacheWrite: optionalCount(u.cache_creation_input_tokens) };
    r.terminal = j.stop_reason === "end_turn" && Array.isArray(j.content);
  } else if (judge.provider === "openai") {
    r.tokens = { input: optionalCount(u.prompt_tokens), output: optionalCount(u.completion_tokens),
      thinking: optionalCount(u.completion_tokens_details?.reasoning_tokens), cacheRead: optionalCount(u.prompt_tokens_details?.cached_tokens),
      cacheWrite: optionalCount(u.prompt_tokens_details?.cache_write_tokens) };
    r.terminal = j.choices?.length === 1 && j.choices[0]?.finish_reason === "stop" && !j.choices[0]?.message?.refusal;
  } else {
    const candidate = optionalCount(u.candidatesTokenCount), thoughts = optionalCount(u.thoughtsTokenCount);
    r.tokens = { input: optionalCount(u.promptTokenCount), output: candidate !== null && thoughts !== null ? candidate + thoughts : null,
      thinking: thoughts, cacheRead: optionalCount(u.cachedContentTokenCount), cacheWrite: null };
    r.terminal = j.candidates?.length === 1 && j.candidates[0]?.finishReason === "STOP" && !j.promptFeedback?.blockReason &&
      !j.candidates[0]?.content?.parts?.some((p: any) => p.thought && p.text);
    if (count(u.totalTokenCount) && r.tokens.input !== null && r.tokens.output !== null &&
      u.totalTokenCount !== r.tokens.input + r.tokens.output) r.error = "inconsistent native token total";
  }
  r.usageComplete = r.tokens.input !== null && r.tokens.output !== null &&
    Object.values(r.tokens).every(v => v === null || count(v)) &&
    (r.tokens.thinking === null || r.tokens.thinking <= r.tokens.output) &&
    (judge.provider === "anthropic" || ((r.tokens.cacheRead === null || r.tokens.cacheRead <= r.tokens.input) &&
    (r.tokens.cacheWrite === null || r.tokens.cacheWrite <= r.tokens.input)));
  const optional = judge.provider === "anthropic" ? [u.cache_read_input_tokens,u.cache_creation_input_tokens] : judge.provider === "openai"
    ? [u.prompt_tokens_details?.cached_tokens,u.prompt_tokens_details?.cache_write_tokens,u.completion_tokens_details?.reasoning_tokens,u.total_tokens]
    : [u.cachedContentTokenCount,u.totalTokenCount];
  if(optional.some(v=>v !== undefined && !count(v))) r.usageComplete=false;
  if(judge.provider === "openai" && count(u.total_tokens) && r.tokens.input !== null && r.tokens.output !== null &&
    u.total_tokens !== r.tokens.input+r.tokens.output) {r.error="inconsistent native token total";r.usageComplete=false;}
}
/** This guard runs before the donor's deliberately permissive parser/tally can accept a batch. */
export function admittedRows(text: string, items: HardItem[]): Row[] | null {
  const rows = parseRows(text);
  if (!rows || rows.length !== items.length || new Set(rows.map(r => r?.id)).size !== items.length ||
    !rows.every((r, i) => object(r) && items[i]?.id === r.id && ROUTES.includes(r.route as any) &&
      count(r.stakes) && r.stakes >= 1 && r.stakes <= 3 && typeof r.summary === "string" && r.summary.length <= 140)) return null;
  return rows;
}
let observerOwned = false;
/** Serialized lowest-fetch wrapper, restored on all paths. Caller supplies an admitted transport; no executable live entry exists. */
export async function collectLabelPanel(items: HardItem[], rubric: string, transport: typeof fetch,
  options: { onPhysical?: (receipt: PanelPhysical) => void; retryDelay?: () => Promise<void>; beforePhysical?: (receipt: PanelPhysical, headers: Headers) => Promise<void> | void; afterPhysical?: (receipt: PanelPhysical) => void } = {}) {
  const requests = labelRequests(items);
  if (!rubric.trim()) throw Error("Require populated unchanged rubric");
  if (observerOwned) throw Error("Label observer already owned; parallel global-fetch use forbidden");
  observerOwned = true;
  const original = globalThis.fetch, physical: PanelPhysical[] = [], judgments: { judge: string; repetition: number; batch: number; rows: Row[] }[] = [];
  const observedSecrets = new Set<string>();
  const votes: Votes = {}; let stopReason: string | null = null;
  let active: PanelPhysical | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = active;
    if (!r || r.endpoint !== null) throw Error("Unexpected extra physical dispatch");
    const url = new URL(String(input)), headers = new Headers(init?.headers), secrets = [...observedSecrets];
    for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) {
      const value = headers.get(name); if (value) secrets.push(value.replace(/^Bearer /i, ""));
    }
    if (url.searchParams.has("key")) { const key = url.searchParams.get("key")!; secrets.push(key); url.searchParams.delete("key"); headers.set("x-goog-api-key", key); }
    for(const secret of secrets)observedSecrets.add(secret);
    r.endpoint = url.toString(); r.requestBody = String(init?.body ?? ""); r.requestSha = sha(r.requestBody);
    const judge = LABEL_PANEL.models.find(m => m.id === r.judge)!;
    const expected = judge.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : judge.provider === "openai"
      ? "https://api.openai.com/v1/chat/completions" : `https://generativelanguage.googleapis.com/v1beta/models/${judge.id}:generateContent`;
    if(secrets.some(s => s && r.requestBody!.includes(s))) {r.requestBody=null;r.error="sensitive request withheld";throw Error(r.error);}
    if (r.endpoint !== expected || init?.method !== "POST") throw Error("Unexpected request endpoint or method");
    let request: unknown;
    try {request=JSON.parse(r.requestBody);} catch {r.error="malformed requested body";throw Error(r.error);}
    if(judge.provider !== "gemini" && (!object(request) || request.model !== judge.id)) {
      r.error="unexpected requested model";throw Error(r.error);
    }
    const start = performance.now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LABEL_PANEL.responseDeadlineMs), chunks: Buffer[] = [];
    try {
      await options.beforePhysical?.(structuredClone(r), headers);
      r.transportDispatched=true;
      const response = await transport(url, { ...init, headers, signal: controller.signal });
      r.status = response.status;
      r.headers = Object.fromEntries([...response.headers].filter(([key, value]) =>
        /^(?:request-id|x-request-id|retry-after|anthropic-ratelimit-|x-ratelimit-|service-tier|x-goog-)/i.test(key) &&
        !secrets.some(s => s && (key.includes(s.toLowerCase()) || value.includes(s)))));
      const reader = response.body?.getReader();
      try { if (reader) while (true) { const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value)); }
        r.responseComplete = true; r.readerCleanup = "natural-eof";
      } catch(error) {
        try { await reader?.cancel(); r.readerCleanup = "cancelled"; } catch { r.readerCleanup = "cancel-failed"; }
        throw error;
      } finally { reader?.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (secrets.some(s => s && bytes.includes(Buffer.from(s)))) { r.error = "sensitive response withheld"; throw Error(r.error); }
      r.responseBase64 = bytes.toString("base64"); r.responseSha = sha(bytes);
      try { nativeFields(judge, JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), r); }
      catch { r.error = "malformed native response"; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    } catch {
      r.error ??= "physical transport failed";
      const bytes = Buffer.concat(chunks); r.responseSha = sha(bytes);
      if (!secrets.some(s => s && bytes.includes(Buffer.from(s)))) r.responseBase64 = bytes.toString("base64");
      throw Error(r.error);
    } finally { clearTimeout(timer); r.durationMs = performance.now() - start; }
  }) as typeof fetch;
  try {
    outer: for (const judge of LABEL_PANEL.models) for (let repetition = 0; repetition < 3; repetition++) for (let batch = 0; batch < 10; batch++) {
      const slice = items.slice(batch * 4, batch * 4 + 4);
      for (let attempt = 1; attempt <= LABEL_PANEL.maxAttempts; attempt++) {
        const r: PanelPhysical = { judge: judge.id, repetition, batch, attempt, endpoint: null, requestBody: null, requestSha: null,
          responseBase64: null, responseSha: null, responseComplete: false, status: null, headers: {}, servedModel: null, rawUsage: null,
          tokens: { input: null, output: null, thinking: null, cacheRead: null, cacheWrite: null }, terminal: false, usageComplete: false,
          transportDispatched:false, readerCleanup: null, error: null, durationMs: 0, listPriceUsd: null, invoiceUsd: null };
        physical.push(r); active = r;
        let text: string | null = null;
        try {
          // Rates deliberately unused: this donor type historically couples transport to list prices.
          const spec: ModelSpec = { ...judge, inPerMTok: Number.NaN, outPerMTok: Number.NaN, efforts: ["high"] };
          text = (await callModel(spec, "high", rubric, requests[batch]!)).text;
        } catch { r.error ??= "donor call rejected"; }
        finally { active = null; options.onPhysical?.(structuredClone(r)); options.afterPhysical?.(structuredClone(r)); }
        if (!r.responseComplete || !r.usageComplete || r.servedModel !== judge.id || r.error === "inconsistent native token total") {
          stopReason = "unknown or mismatched required physical receipt"; break outer;
        }
        if ((r.status === 429 || r.status === 503) && attempt < LABEL_PANEL.maxAttempts) {
          await (options.retryDelay?.() ?? new Promise<void>(resolve => setTimeout(resolve, 1000))); continue;
        }
        if (r.status !== 200 || !r.terminal || r.error || text === null) { stopReason = "failed or nonterminal judge call"; break outer; }
        const rows = admittedRows(text, slice);
        if (!rows) { stopReason = "invalid blind label batch"; break outer; }
        recordVotes(votes, slice, judge.id, rows); judgments.push({ judge: judge.id, repetition, batch, rows }); break;
      }
    }
  } finally { globalThis.fetch = original; observerOwned = false; }
  const coverageComplete = stopReason === null && judgments.length === 90 && items.every(item => LABEL_PANEL.models.every(judge =>
    Object.values(votes[item.id]?.[judge.id] ?? {}).reduce((sum, n) => sum + n, 0) === 3));
  const verdicts = items.map(item => ({ id: item.id, ...judgeItem(item, votes, LABEL_PANEL.models.map(m => m.id)),
    unstable: LABEL_PANEL.models.filter(judge => Object.keys(votes[item.id]?.[judge.id] ?? {}).length > 1).map(m => m.id),
    tied: LABEL_PANEL.models.filter(judge => {const counts=Object.values(votes[item.id]?.[judge.id] ?? {});
      return counts.length>0 && counts.filter(n=>n===Math.max(...counts)).length>1;}).map(m=>m.id) }));
  return { measured: false, evidenceKind: "caller-supplied transport; no live admission inferred", stopReason, physical, judgments, votes,
    coverageComplete, transportDispatches:physical.filter(r=>r.transportDispatched).length,
    itemJudgments: judgments.reduce((sum, j) => sum + j.rows.length, 0),
    endorsed: coverageComplete && verdicts.every(v => v.endorsed) && verdicts.every(v=>v.tied.length===0), verdicts, listPriceUsd: null, invoiceUsd: null };
}
