/** Private native reservation primitives; no invoice or experiment-specific allocation. */
export interface ReviewBinding {
  freezeSha: string; inputSha: string; protocolSha: string; runtimeSha: string; proofSha: string; promptSha: string;
}
export interface RawTokens { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
// Primary model/service-tier docs exclude Sonnet5.5 from Priority. Literal auto/omission
// therefore stays Standard. Omitted geography inherits workspace settings, not proof of
// global routing; Standard US-only1.1x is covered by8/20 versus2/10 and cache-write<=4.
// https://platform.claude.com/docs/en/api/service-tiers
// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
export function rejectPriceModifiers(request: any, headers?: Headers) {
  if (!request || (request.service_tier != null && !["auto", "standard_only"].includes(request.service_tier)) ||
    (request.inference_geo != null && !["global", "us"].includes(request.inference_geo)) || request.speed != null || request.fast_mode != null ||
    /fast|priority/i.test(headers?.get("anthropic-beta") ?? "")) throw Error("Unsupported pricing modifier");
}
// SDK Usage.inference_geo is string|null. Preserved839 native canonical55 usage reports
// not_available: retain that unavailable measurement; never infer global from it.
export function rejectResponseModifiers(usage: any) {
  if (!usage || (usage.service_tier != null && usage.service_tier !== "standard") ||
    (usage.inference_geo != null && !["global", "us", "not_available"].includes(usage.inference_geo)) || usage.speed != null || usage.fast_mode != null)
    throw Error("Unsupported observed pricing modifier");
}
export function usageUpper(tokens: RawTokens, maxInput: number, maxOutput: number, inputRate = 8, outputRate = 20) {
  if (!tokens || [tokens.input_tokens, tokens.output_tokens, tokens.cache_read_input_tokens, tokens.cache_creation_input_tokens].some(n => !count(n)))
    throw Error("Missing or invalid final raw usage");
  const input = tokens.input_tokens + tokens.cache_read_input_tokens + tokens.cache_creation_input_tokens;
  if (!Number.isSafeInteger(input) || input > maxInput || tokens.output_tokens > maxOutput) throw Error("Usage exceeds reserved input/output bound");
  return (input * inputRate + tokens.output_tokens * outputRate) / 1e6;
}
