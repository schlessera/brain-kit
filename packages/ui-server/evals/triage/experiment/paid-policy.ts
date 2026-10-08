/** Private root allocation; conservative reservations are not request invoices. */
import { sha } from "./adapter";
import { assertGrantPath, validGrantTime, type GrantPolicy } from "./grant";

export const EXTRA_USAGE_AUTHORIZATION = "https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737";
export const MODEL = "claude-sonnet-5-5";
export interface ReviewBinding {
  freezeSha: string; inputSha: string; protocolSha: string; runtimeSha: string; proofSha: string; promptSha: string;
}
export interface RootPaidPolicy extends ReviewBinding,GrantPolicy {
  version: 1; issue: 848; authorizationUrl: string; allowOverage: true; basis: "actual additional billed charges";
  perIssueCapUsd: 15; aggregateCapUsd: 150; remainingUpperUsd: number; expiresAt: string;
  canonicalModel: typeof MODEL; maxPhysicalRequests: 24; maxInputBytes: number; maxInputTokens: 1_000_000;
  contextWindowTokens: 1_000_000; maxOutputTokens: 128000; inputUsdPerMillionUpper: 8; outputUsdPerMillionUpper: 20; invoiceUsd: null;
}
export interface RawTokens { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const keys = ["freezeSha", "inputSha", "protocolSha", "runtimeSha", "proofSha", "promptSha"] as const;
export function validatePaidPolicy(policy: RootPaidPolicy, expected: ReviewBinding, now = Date.now()) {
  assertGrantPath(policy);
  if (!policy || policy.version !== 1 || policy.issue !== 848 || policy.authorizationUrl !== EXTRA_USAGE_AUTHORIZATION || policy.allowOverage !== true ||
    policy.basis !== "actual additional billed charges" || policy.perIssueCapUsd !== 15 || policy.aggregateCapUsd !== 150 || policy.invoiceUsd !== null ||
    policy.canonicalModel !== MODEL || policy.maxPhysicalRequests !== 24 || policy.maxInputTokens !== 1_000_000 || policy.contextWindowTokens !== 1_000_000 ||
    policy.maxOutputTokens !== 128000 || policy.inputUsdPerMillionUpper !== 8 || policy.outputUsdPerMillionUpper !== 20 ||
    !count(policy.maxInputBytes) || policy.maxInputBytes === 0 || !finite(policy.remainingUpperUsd) || policy.remainingUpperUsd > 15 ||
    !validGrantTime(policy,now) ||
    keys.some(k => !/^[a-f0-9]{64}$/.test(expected[k]) || policy[k] !== expected[k])) throw Error("Missing, expired, invalid or mismatched root paid policy");
  return policy;
}
export function acceptedRate(info: any, paid = false): boolean {
  if (!info || !["allowed", "allowed_warning", "rejected"].includes(info.status) || info.overageStatus === "rejected" || info.overageDisabledReason) return false;
  // Native293 NEe reports included quota as rejected even when paid overage is permitted.
  // Preserve that literal status; full HTTP/usage/EOF evidence is independently required.
  if (info.status === "rejected") return paid && info.isUsingOverage === true && ["allowed", "allowed_warning"].includes(info.overageStatus);
  if (info.isUsingOverage === true || info.overageInUse === true) return paid && ["allowed", "allowed_warning"].includes(info.overageStatus);
  return info.isUsingOverage === false || info.overageInUse === false;
}
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
export interface Reservation {
  index: number; at: number; requestSha: string; inputBound: number; outputBound: number; reservedUpperUsd: number;
  status: "reserved" | "complete" | "unknown"; pricedUpperUsd: number | null; rawUsage: RawTokens | null; invoiceUsd: null;
}
export class ReviewBudget {
  private readonly records: Reservation[] = [];
  get entries(): Reservation[] { return structuredClone(this.records); }
  private blocked = false;
  constructor(readonly policy: RootPaidPolicy, readonly binding: ReviewBinding, private readonly persist: (entries: Reservation[]) => void, private readonly clock = Date.now) {
    validatePaidPolicy(policy, binding, clock());
    this.policy = Object.freeze(structuredClone(policy));
    this.binding = Object.freeze(structuredClone(binding));
  }
  usedUpper() { return this.records.reduce((sum, r) => sum + (r.status === "complete" ? r.pricedUpperUsd! : r.reservedUpperUsd), 0); }
  reserve(bytes: Uint8Array, headers?: Headers) {
    validatePaidPolicy(this.policy, this.binding, this.clock());
    if (this.blocked || this.records.some(r => r.status === "reserved") || this.records.length >= this.policy.maxPhysicalRequests)
      throw Error("Prior unknown/inflight request or physical request bound");
    if (!bytes.byteLength || bytes.byteLength > this.policy.maxInputBytes) throw Error("Physical request byte bound");
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (request.model !== MODEL || !count(request.max_tokens) || request.max_tokens === 0 || request.max_tokens > this.policy.maxOutputTokens ||
      request.tools?.length || request.output_config?.effort !== "low") throw Error("Wrong model/output/tools/effort before physical dispatch");
    rejectPriceModifiers(request, headers);
    const texts = (request.messages ?? []).filter((m: any) => m.role === "user").flatMap((m: any) => typeof m.content === "string" ? [m.content] :
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text) : []);
    if (!texts.some((s: any) => typeof s === "string" && sha(s) === this.binding.promptSha)) throw Error("Exact frozen prompt absent before dispatch");
    const inputBound = Math.min(bytes.byteLength, this.policy.contextWindowTokens), outputBound = request.max_tokens;
    const reservedUpperUsd = (inputBound * this.policy.inputUsdPerMillionUpper + outputBound * this.policy.outputUsdPerMillionUpper) / 1e6;
    if (!finite(reservedUpperUsd) || this.usedUpper() + reservedUpperUsd > this.policy.remainingUpperUsd) throw Error("Next physical reservation exceeds remaining allocation");
    const entry: Reservation = { index: this.records.length, at: this.clock(), requestSha: sha(Buffer.from(bytes)), inputBound, outputBound, reservedUpperUsd,
      status: "reserved", pricedUpperUsd: null, rawUsage: null, invoiceUsd: null };
    this.records.push(entry); try { this.persist(structuredClone(this.records)); } catch (error) { this.blocked = true; throw error; } return entry.index;
  }
  settle(index: number, tokens: RawTokens) {
    const entry = this.records[index]; if (!entry || entry.status !== "reserved") throw Error("Unknown or already settled physical reservation");
    try {
      const priced = usageUpper(tokens, entry.inputBound, entry.outputBound, this.policy.inputUsdPerMillionUpper, this.policy.outputUsdPerMillionUpper);
      const completed: Reservation = { ...entry, rawUsage: structuredClone(tokens), pricedUpperUsd: priced, status: "complete" };
      this.persist(this.records.map(r => structuredClone(r.index === index ? completed : r)));
      Object.assign(entry, completed);
    } catch (error) { this.unknown(index); throw error; }
  }
  unknown(index: number) {
    const entry = this.records[index]; if (!entry || entry.status !== "reserved") throw Error("Unknown or already settled physical reservation");
    entry.status = "unknown"; this.blocked = true; this.persist(structuredClone(this.records));
  }
}
/** Rebuild reservations from literal physical requests and reconciled terminal usage. */
export function reparseBudget(policy: RootPaidPolicy, binding: ReviewBinding, entries: Reservation[], calls: any[]) {
  if (!Array.isArray(entries) || entries.length !== calls.length || !entries.length) return false;
  try {
    let at = entries[0]!.at; const budget = new ReviewBudget(policy, binding, () => {}, () => at);
    for (let i = 0; i < calls.length; i++) {
      const entry = entries[i]!; if (!Number.isFinite(entry.at) || entry.at > Date.now() || (i && entry.at < entries[i-1]!.at)) return false;
      at = entry.at;
      rejectResponseModifiers(calls[i].usage);
      const index = budget.reserve(Buffer.from(calls[i].rawRequestBase64, "base64")); budget.settle(index, calls[i].usage);
    }
    return JSON.stringify(budget.entries) === JSON.stringify(entries);
  } catch { return false; }
}
