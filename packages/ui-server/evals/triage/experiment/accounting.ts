/**
 * Cost and latency from the retained physical calls. The cost is a list-price
 * estimate recomputed from each response's own usage counters; a call whose
 * bytes, model or counters cannot be verified is reported as unknown rather
 * than priced at zero. The baseline arm's cost comes from the donor runner's
 * own `costPer1kUsd` on the same corpus.
 */
import { sha, type PhysicalCall } from "./adapter";
import { protocol } from "./protocol";

const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function classificationAccounting(calls: PhysicalCall[]) {
  const unknown: string[] = [];
  let inputTokens = 0, outputTokens = 0;
  for (const [index, call] of calls.entries()) {
    const usage = call.usage as Record<string, unknown> | null;
    let raw: any = null, request: any = null;
    try {
      const bytes = Buffer.from(call.responseBase64 ?? "", "base64");
      if (sha(bytes) !== call.responseSha || sha(call.requestBody) !== call.requestSha) throw Error("Changed raw evidence");
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      request = JSON.parse(call.requestBody);
    } catch { /* Stays unknown below. */ }
    if (call.model !== protocol.models.classification || request?.model !== protocol.models.classification || raw?.model !== call.model ||
      JSON.stringify(raw?.usage) !== JSON.stringify(usage) || !usage || !counter(usage.input_tokens) || !counter(usage.output_tokens) ||
      call.responseBase64 === null || !call.responseComplete) {
      unknown.push(`call:${index}`);
      continue;
    }
    inputTokens += usage.input_tokens; outputTokens += usage.output_tokens;
  }
  const { inputUsdPerMTok, outputUsdPerMTok } = protocol.pricing;
  return {
    physicalRequests: calls.length, unknown, receiptComplete: calls.length > 0 && unknown.length === 0,
    inputTokens, outputTokens,
    /** Over the verified calls only; unknown calls add nothing, so this is a floor when `unknown` is nonempty. */
    knownListEstimateUsd: (inputTokens * inputUsdPerMTok + outputTokens * outputUsdPerMTok) / 1e6,
    pricingScope: "list rate, not an invoice; cache, tier and geography adjustments unobserved",
  };
}

/** USD per 1000 items at the list rate, the donor matrix's unit. */
export const costPer1kItems = (listUsd: number, items: number) => (items === 0 ? 0 : (listUsd / items) * 1000);

export function latencySummary(values: number[]) {
  if (!values.length || values.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b), p = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  const totalMs = values.reduce((a, b) => a + b, 0);
  return { observations: values.length, p50Ms: p(0.5), p95Ms: p(0.95), totalMs, throughputPerSecond: totalMs > 0 ? (values.length * 1000) / totalMs : null };
}
