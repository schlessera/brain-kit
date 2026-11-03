/**
 * Apify presentation rules (#3163). The browser stories prove the rendered
 * screens; these pin the rules every surface shares: unknown is never zero,
 * a reservation is an upper bound, a local abort is not a confirmed stop and
 * a refusal names the limit that bound.
 */
import { describe, expect, test } from "bun:test";
import type { ApifySettingsRead, ApifyUnresolvedRunRead, TurnBudgetReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { providerCard, receiptApify, refusalCopy, runLine, spendSummary, usd } from "../src/lib/apify.js";
import { apifyApprovalTarget, apifyEnvelope, apifyToolName } from "../src/components/chat/renderers/apify-tools.js";

const read = (over: Partial<ApifySettingsRead> = {}): ApifySettingsRead => ({
  state: "configured", reason: null, account: { id: "OdysseusOps7c2f", username: "odysseus-ops" }, pending_account: null, checked_at: "2026-07-12T09:00:00.000Z",
  policy: { path: "context/policies/governance.md", hash: null, valid: true, enabled: true, discovery: "ask", actors: "ask", grants: [], limits: null, budgets: { turn_usd: 4, session_usd: 20, day_usd: 40 } },
  spend: { ledger: "absent", observed_at: "2026-07-12T09:00:00.000Z", coverage: null, day: null, brain_day: null, unresolved: [] },
  ...over,
});
const run = (over: Partial<ApifyUnresolvedRunRead> = {}): ApifyUnresolvedRunRead => ({
  key: "k", actor_id: "HarborNotices01", build_number: "1.4.12", state: "running", abort: null, cost_basis: "reserved", reserved_usd: 1.15, charged_usd: null,
  liability_usd: 1.15, remote_outcome_unknown: false, session_id: "s", turn_id: "t", started_at: "2026-07-12T10:40:00.000Z", updated_at: "2026-07-12T10:47:00.000Z", ...over,
});

describe("provider states", () => {
  test("each state says what it is, and a removed token keeps the liability visible", () => {
    expect(providerCard(read()).view).toBe("ready");
    expect(providerCard(read()).text).toContain("odysseus-ops (…7c2f)");
    expect(providerCard(read({ state: "disabled", reason: "not_enabled" })).view).toBe("off");
    expect(providerCard(read({ state: "authentication_required", reason: "token_missing", account: null })).view).toBe("token_needed");
    const removed = providerCard(read({ state: "authentication_required", reason: "token_missing",
      spend: { ...read().spend, unresolved: [run()] } }));
    expect(removed.view).toBe("token_removed");
    expect(removed.text).toContain("1 run is still unresolved");
    expect(removed.text).toContain("doesn't confirm that remote work stopped");
    expect(providerCard(read({ state: "unavailable", reason: "upstream_unreachable" })).text).toContain("09:00 UTC");
  });
});

describe("amounts", () => {
  test("an unknown start, an unconfirmed abort and an unsettled finish are upper bounds, never $0 (APIFY_UNKNOWN_NOT_ZERO)", () => {
    for (const line of [runLine(run({ state: "unknown", remote_outcome_unknown: true })), runLine(run({ abort: "unresolved", state: "aborting" })),
      runLine(run({ state: "succeeded" })), runLine(run({ abort: "requested" }))]) {
      expect(line.value, "APIFY_UNKNOWN_NOT_ZERO").toBe("up to $1.15");
      expect(line.value).not.toContain("$0.00");
    }
    expect(runLine(run({ abort: "unresolved", state: "aborting" })).note).toContain("not confirmed");
    expect(usd(0.004)).toBe("$0.0040");
    expect(spendSummary({ ...read().spend, ledger: "unavailable" }).text).toContain("the Apify ledger couldn't be read");
  });

  test("a receipt without readable Apify accounting is unknown, not zero", () => {
    const receipt = (coverage: TurnBudgetReceipt["coverage"], apifyUsd?: number): TurnBudgetReceipt => ({ listPriceCostUsd: 0.5, tokens: 10, observedAt: 0, coverage,
      scopes: [{ scope: "turn", costUsd: 2, ...(apifyUsd === undefined ? {} : { apifyUsd }), tokens: 10, unknownRuns: 0, warnUsd: 1, blockUsd: 4, blockTokens: 1, warning: false, blocked: false }] });
    expect(receiptApify(receipt("Built-in inference and relayed brain CLI providers; Apify accounting is unavailable, so Apify spend is not counted; other provider and tool spend is not metered"))).toEqual({ state: "unknown" });
    expect(receiptApify(receipt("Built-in inference, relayed brain CLI providers and Apify runs this host admitted; other provider and tool spend is not metered", 1.15)))
      .toEqual({ state: "known", apifyUsd: 1.15, inferenceUsd: 0.85 });
    expect(receiptApify(receipt("Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered"))).toEqual({ state: "none" });
  });
});

describe("refusals and approvals", () => {
  test("a budget refusal names the limit that refused (C6)", () => {
    expect(refusalCopy({ code: "budget_exceeded", reason: "day_usd" }).text).toContain("the Apify day limit for this account");
    expect(refusalCopy({ code: "budget_exceeded", reason: "day_budget" }).text).toContain("today's overall budget");
    expect(refusalCopy({ code: "budget_exceeded", reason: "turn_usd" }).text).toContain("this turn's overall budget");
    expect(refusalCopy({ code: "policy_denied", reason: "actors_denied" }).setting).toBe("actors");
    expect(refusalCopy({ code: "approval_required", reason: "no_grant_surface" }).text).toBe("This run needs your approval, and there was nowhere to ask. Nothing started.");
  });

  test("names, targets and envelopes are recognised without trusting their shape", () => {
    expect(apifyToolName("mcp__brain-ui__brain_apify_run")).toBe("brain_apify_run");
    expect(apifyToolName("brain_apify_unknown")).toBeNull();
    expect(apifyApprovalTarget({ name: "Apify Actor run", input: { actor: { name: "ithaca/harbor-notices" } } })).toBe("ithaca/harbor-notices");
    expect(apifyApprovalTarget({ name: "Bash", input: { command: "ls" } })).toBeNull();
    expect(apifyEnvelope('{"ok":false,"operation":"run","error":{"code":"budget_exceeded","reason":"day_usd","message":"m"}}')?.error?.reason).toBe("day_usd");
    expect(apifyEnvelope("not json")).toBeNull();
  });
});
