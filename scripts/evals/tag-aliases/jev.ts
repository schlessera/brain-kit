/** Injected transport controls around the actual core client. No live entry point. */
import { createJevClient, type FetchLike, type JevChoiceAnswer } from "../../../packages/core/src/lib/jev";
import { hash, question, type Candidate } from "./prototype";

// Verified primary sources on 2026-10-08: https://docs.typesafe.ai/api and
// https://docs.typesafe.ai/models. Input.042/M, outputfree; cache undocumented.
export interface PhysicalCall {
  requestBytes: string; responseBytes: string | null; requestSha: string; responseSha: string | null;
  requestedModel: string; servedModel: string | null; status: number | null;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: null; cacheWriteTokens: null;
  rawUsage: unknown; priceDerivedUsd: number | null; actualBilledUsd: null;
  outcome: string; durationMs: number;
}
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function observedClient(fetch: FetchLike, save: (calls: PhysicalCall[]) => void = () => {}) {
  const calls: PhysicalCall[] = [];
  let stopped = false;
  const client = createJevClient({ apiKey: "offline-sentinel", endpoint: "http://127.0.0.1/jev-control", timeoutMs: 1000,
    retryDelayMs: 0, async fetch(url, init) {
      if (stopped || calls.length >= 24) throw Error("Unknown receipt or exhausted physical control bound");
      const start = performance.now(), body = String(init.body);
      const call: PhysicalCall = { requestBytes: body, responseBytes: null, requestSha: hash(body), responseSha: null,
        requestedModel: "jev-1.13.0", servedModel: null, status: null, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, rawUsage: null, priceDerivedUsd: null, actualBilledUsd: null,
        outcome: "network_error", durationMs: 0 };
      try {
        const response = await fetch(url, init); call.status = response.status;
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Preserve literal bytes before JSON decoding, including invalid UTF8/errors.
        call.responseBytes = Buffer.from(bytes).toString("base64"); call.responseSha = hash(bytes); save([...calls, call]);
        try {
          const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
            { model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
          call.servedModel = typeof raw.model === "string" ? raw.model : null;
          call.rawUsage = raw.usage ?? null; call.inputTokens = count(raw.usage?.input_tokens); call.outputTokens = count(raw.usage?.output_tokens);
          if (response.ok && call.servedModel === "jev-1.13.0" && call.inputTokens !== null && call.outputTokens !== null) {
            call.priceDerivedUsd = call.inputTokens * .042 / 1e6; call.outcome = "received";
          } else call.outcome = response.ok ? "model_or_usage_mismatch" : "http_error";
        } catch { call.outcome = response.ok ? "bad_body" : "http_error"; }
        return new Response(bytes, { status: response.status, headers: response.headers });
      } finally {
        call.durationMs = performance.now() - start; calls.push(call);
        if (call.priceDerivedUsd === null) stopped = true;
        save(calls);
      }
    } });
  return { calls, client, get stopped() { return stopped; }, async judge(pair: Candidate) {
    const result = await client.ask(question(pair));
    if (stopped) throw Error("Raw physical response has unknown usage/model/charged failure; no further judgment");
    return { result, answer: result.outcome === "answered" && result.model === "jev-1.13.0" && result.answers?.sameConcept?.type === "choice"
      ? result.answers.sameConcept as JevChoiceAnswer : null };
  } };
}
