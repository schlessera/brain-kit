/** Diagnostic admission receipts for the subscription-only research driver. */
import { priceSonnet55Usage } from "./measure-sonnet55-cost";
import type { TurnObservation } from "./turn-surface-observation";
export function successfulSurfaceReceipt(raw: Parameters<typeof priceSonnet55Usage>[0] & { subtype?: string } | undefined, observation: TurnObservation) {
  if (!raw || raw.subtype !== "success" || !observation.completed || observation.observationError || !observation.roundTrips.size) {
    throw Error(observation.observationError ?? "missing_success_result_or_roundtrip_usage");
  }
  const price = priceSonnet55Usage(raw);
  if (!observation.finalUsageComplete) throw Error("missing_final_streamed_roundtrip_usage");
  const models = Object.values(raw.modelUsage!);
  for (const [roundTripField, resultField] of [["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"],
    ["cacheReadTokens", "cacheReadInputTokens"], ["cacheWriteTokens", "cacheCreationInputTokens"]] as const) {
    const observed = [...observation.roundTrips.values()].reduce((sum, usage) => sum + usage[roundTripField], 0);
    const total = models.reduce((sum, usage) => sum + (usage[resultField] as number), 0);
    if (observed !== total) throw Error(`roundtrip_usage_mismatch:${resultField}`);
  }
  return price;
}
export class SurfaceAdmission {
  init: { model: string; apiKeySource: string; cliVersion: string } | null = null;
  account: { tokenSource: string; apiKeySource: string | null; apiProvider: string } | null = null;
  rateLimitEvents: Array<Record<string, unknown>> = [];
  stopped: string | null = null;
  constructor(private readonly abort: AbortController, private readonly expectedModel: string, private readonly expectedCli: string) {}
  observe(frame: Record<string, any>): void {
    if (frame.type === "system" && frame.subtype === "init") {
      this.init = { model: frame.model, apiKeySource: frame.apiKeySource, cliVersion: frame.claude_code_version };
      if (frame.model !== this.expectedModel || frame.apiKeySource !== "none" || frame.claude_code_version !== this.expectedCli) this.stop("model_auth_or_runtime_mismatch");
    }
    const account = frame.type === "control_response" ? frame.response?.response?.account : undefined;
    if (account) {
      this.account = { tokenSource: account.tokenSource, apiKeySource: account.apiKeySource ?? null, apiProvider: account.apiProvider };
      if (account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || ![undefined, null, "none"].includes(account.apiKeySource)
        || account.apiProvider !== "firstParty") this.stop("account_route_mismatch");
    }
    if (frame.type === "rate_limit_event") {
      const info = frame.rate_limit_info ?? {};
      // Retain machine flags/status, never account or credential identities.
      this.rateLimitEvents.push({ status: info.status ?? null, isUsingOverage: info.isUsingOverage ?? null,
        overageInUse: info.overageInUse ?? null, overageDisabledReason: info.overageDisabledReason ?? null });
      if (info.isUsingOverage === true || info.overageInUse === true) this.stop("subscription_overage_reported");
    }
  }
  stop(reason: string) { this.stopped ??= reason; this.abort.abort(); }
  requireIdentity() {
    if (!this.init || !this.account) this.stop("missing_native_auth_identity");
    if (this.stopped) throw Error(this.stopped);
  }
}
