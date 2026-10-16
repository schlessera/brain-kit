import type { ActivityCacheDiagnostics, FirstRequestCacheUsage, PromptPrefixFingerprint } from "@schlessera/brain-ui-sdk/protocol";

const components = ["tools", "system", "model", "thinking", "gitStatusIncluded"] as const;
const digest = (v: unknown) => v === null || typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validPrefix(p: PromptPrefixFingerprint): boolean {
  return p?.coverage === "assembled_inputs" && [p.tools, p.system, p.model, p.thinking].every(digest)
    && (p.gitStatusIncluded === null || typeof p.gitStatusIncluded === "boolean");
}
export function validFirstRequest(u: FirstRequestCacheUsage): boolean {
  return u && ["claude_root_stream", "pi_main_message"].includes(u.source)
    && [u.inputTokens, u.cacheReadTokens, u.cacheCreationTokens].every(v => v === null || Number.isSafeInteger(v) && v! >= 0);
}

export function cacheDiagnostics(attrs: Record<string, unknown>): ActivityCacheDiagnostics | undefined {
  const firstRequest = attrs["brain.cache.first_request"] as FirstRequestCacheUsage | undefined;
  const prefix = attrs["brain.cache.prefix"] as PromptPrefixFingerprint | undefined;
  if (!firstRequest && !prefix) return undefined;
  const resumed = typeof attrs["brain.cache.resumed"] === "boolean" ? attrs["brain.cache.resumed"] as boolean : null;
  const suspectedBreak = resumed === false ? false : resumed === null || !firstRequest
    || firstRequest.cacheReadTokens === null || firstRequest.cacheCreationTokens === null ? null
    : firstRequest.cacheReadTokens === 0 && firstRequest.cacheCreationTokens > 0;
  return { firstRequest: firstRequest ?? null, prefix: prefix ?? null, resumed, suspectedBreak,
    changed: attrs["brain.cache.changed"] as ActivityCacheDiagnostics["changed"] ?? "unknown" };
}

export function changedPrefix(current: PromptPrefixFingerprint, prior?: PromptPrefixFingerprint): ActivityCacheDiagnostics["changed"] {
  if (!prior || !validPrefix(prior)) return "unknown";
  const changed = components.filter(key => current[key] !== null && prior[key] !== null && current[key] !== prior[key]);
  if (changed.length) return changed;
  return components.some(key => key !== "gitStatusIncluded" && (current[key] === null || prior[key] === null)) ? "unknown" : "unchanged";
}
