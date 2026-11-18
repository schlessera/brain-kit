import preview from "#.storybook/preview";
import { atWidth, viewportAt } from "../_viewports.js";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { ToolPermissionCard } from "../../../ui-react/src/components/chat/tool-permission-card.js";
import { ApifyResult } from "../../../ui-react/src/components/chat/renderers/apify-tools.js";
import type { ToolCall } from "../../../ui-react/src/stores/chat-store.js";
import { ConsumerDocument, consumerViewport, painted, bounds, targets, accessible } from "./_consumer-parity.js";

/*
 * The exact-run Apify approval and its refusals (#3163): the kit
 * ApprovalCard through ToolPermissionCard with the host's review as input.
 * Odysseus fixtures; the amounts are fictional examples, not vendor prices.
 */

const REVIEW = {
  actor: { id: "HarborNotices01", name: "ithaca/harbor-notices", title: "Harbor notices [read more](https://harbor.ithaca.example/x) ".repeat(3).trim(), purpose: null, untrusted: true },
  build: { id: "BuildHarbor1412", number: "1.4.12", tag: "latest" }, account_id: "OdysseusOps7c2f", permission_level: "LIMITED_PERMISSIONS",
  pricing: { model: "PAY_PER_EVENT", events: [{ name: "notice", title: "Notice", price_usd: 0.004, tiered: false }], platform_usage_paid_by_user: false, minimal_max_total_charge_usd: 0.1, uncertainty: [] },
  schema_sha256: "c".repeat(64), pricing_sha256: "d".repeat(64), profile_id: "ithaca.harbor-notices@3", recipient: "https://api.apify.com",
  input: { startUrls: [{ url: "https://harbor.ithaca.example/notices" }], since: "2026-07-01", maxItems: 200, note: "x".repeat(4000) },
  input_sha256: "e".repeat(64), origins: ["https://harbor.ithaca.example"], max_charge_usd: 0.8, eligibility: { executable: true, reasons: [] }, consent: "one-use",
};
function Approval({ onApproval }: { width: number; onApproval: (id: string, approved: boolean, always?: boolean) => void }) {
  const [root] = useState(() => createBrainUiRoot({ storage: null, request: async input => new URL(String(input), location.href).pathname === "/api/apify"
    ? Response.json({ state: "configured", reason: null, account: { id: "OdysseusOps7c2f", username: "odysseus-ops" }, pending_account: null, checked_at: "2026-07-12T09:00:00.000Z",
      policy: { path: "context/policies/governance.md", hash: "a".repeat(64), valid: true, enabled: true, discovery: "ask", actors: "ask", grants: [], budgets: { turn_usd: 4, session_usd: 20, day_usd: 40 },
        limits: { run_usd: 1, turn_usd: 2, session_usd: 5, day_usd: 5, max_runs_per_turn: 2, max_requests_per_turn: 40, max_concurrent_runs: 1,
          max_runtime_seconds: 600, max_result_items: 200, max_result_bytes: 5_242_880, max_retention_seconds: 604_800 } },
      spend: { ledger: "absent", observed_at: "2026-07-12T09:00:00.000Z", coverage: null, day: null, brain_day: null, unresolved: [] } })
    : Response.json({ error: "none" }, { status: 404 }) }));
  useEffect(() => () => root.dispose(), [root]);
  const tool: ToolCall = { id: "apify-run-1", name: "Apify Actor run", input: REVIEW, inputJson: JSON.stringify(REVIEW), status: "pending_approval", approvalKind: "actor",
    approvalDescription: "Run ithaca/harbor-notices build 1.4.12 once, with the input shown, charging at most $0.8. Approving does not allow any later run." };
  const refusal: ToolCall = { id: "apify-run-2", name: "mcp__brain-ui__brain_apify_run", input: { proposal: "p" }, inputJson: "{}", status: "complete", isError: true,
    output: JSON.stringify({ ok: false, operation: "run", error: { code: "budget_exceeded", reason: "day_usd", message: "This run would reserve $1.15, but only $0.35 remains in the account's UTC day allowance (pending runs count as spent)." } }) };
  const unknown: ToolCall = { id: "apify-run-3", name: "brain_apify_status", input: { run: "r" }, inputJson: "{}", status: "complete",
    output: JSON.stringify({ ok: true, operation: "status", data: { run: "r", state: "unknown", results: { available: false, partial: false, expires_at: null }, abort: null, remote_outcome_unknown: true, warnings: [] } }) };
  const result = (id: string, error: Record<string, string>): ToolCall => ({ id, name: "brain_apify_run", input: {}, inputJson: "{}", status: "complete", isError: true,
    output: JSON.stringify({ ok: false, operation: "run", error }) });
  const restored: ToolCall = { ...tool, id: "apify-run-restored", restored: true };
  return <ConsumerDocument><BrainUiProvider root={root}>
    <ToolPermissionCard toolCall={tool} onApproval={onApproval} backendId="claude" />
    <div data-restored><ToolPermissionCard toolCall={restored} onApproval={onApproval} backendId="claude" /></div>
    <div data-stale><ApifyResult tool={result("apify-run-4", { code: "proposal_stale", reason: "pricing_changed", message: "The Actor's build, input schema, price, permissions or qualification changed after review. Inspect and prepare it again." })} /></div>
    <div data-no-surface><ApifyResult tool={result("apify-run-5", { code: "approval_required", reason: "no_grant_surface", message: "This needs a person's approval, and nobody can be asked from here." })} /></div>
    <div data-refusal><ApifyResult tool={refusal} /></div>
    <div data-unknown><ApifyResult tool={unknown} /></div>
  </BrainUiProvider></ConsumerDocument>;
}
const approvalMeta = preview.meta({
  title: "Conversation/Apify run approval", component: Approval,
  parameters: { layout: "fullscreen" }, beforeEach: consumerViewport,
  args: { width: 320, onApproval: fn() },
  globals: viewportAt(320),
});

/** The exact-run card: rows, bounded untrusted input, Allow once, Always allow and Deny; refusals name the limit. */
export const RunApproval320 = approvalMeta.story({
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const card = await waitFor(() => { const found = document.querySelector<HTMLElement>("[data-approval-card]"); if (!found) throw new Error("card"); return found; });
    const view = within(card);
    await expect(view.getByText("Approval needed · paid run")).toBeVisible();
    for (const row of ["Actor", "Sends to Apify", "Charged to", "Cost", "Limits"]) await expect(card.querySelector(`[data-apify-row="${row}"]`), row).not.toBeNull();
    await expect(card.querySelector("[data-apify-row=\"Charged to\"]")!.textContent).toContain("…7c2f");
    await expect(card.querySelector("[data-apify-row=\"Cost\"]")!.textContent).toContain("Run cap $0.80");
    await waitFor(() => expect(card.querySelector("[data-apify-effective-limits]")?.textContent).toBe("≤ $1.00 a run · 10 min · results kept 7 days"));
    await expect(view.getByRole("button", { name: /Always allow/ }), "APIFY_ACTOR_ALWAYS_ALLOW").toBeVisible();
    await expect(view.getByRole("button", { name: /Allow once/ })).toBeVisible();
    // Untrusted Actor text is plain text: no link, no markdown.
    await expect(card.querySelectorAll("a"), "APIFY_UNTRUSTED_PLAIN_TEXT").toHaveLength(0);
    await expect(card.textContent).toContain("[read more](https://harbor.ithaca.example/x)");
    await userEvent.click(view.getByRole("button", { name: /^Full input/ }));
    const pre = await waitFor(() => { const found = card.querySelector<HTMLElement>("[data-apify-full-input]"); if (!found) throw new Error("input"); return found; });
    await expect(pre.getBoundingClientRect().height, "full input is bounded").toBeLessThanOrEqual(241);
    await expect(pre.scrollHeight).toBeGreaterThan(pre.clientHeight);
    await bounds(card, "apify approval"); await accessible(card);

    const refusal = document.querySelector<HTMLElement>("[data-refusal]")!;
    await expect(refusal.textContent, "APIFY_REFUSAL_NAMES_LIMIT").toContain("the Apify day limit for this account");
    await expect(within(refusal).getByRole("button", { name: "Why: open Apify limits settings" })).toBeVisible();
    const unknown = document.querySelector<HTMLElement>("[data-unknown]")!;
    await expect(unknown.textContent).toContain("hasn't confirmed whether this run started");
    await expect(unknown.textContent).not.toContain("$0");
    await targets(refusal, "apify refusal");

    // A reloaded card says so, and still offers Actor-scoped choices.
    const again = document.querySelector<HTMLElement>("[data-restored] [data-approval-card]")!;
    await expect(within(again).getByText("Approval needed · paid run · restored")).toBeVisible();
    await expect(within(again).getByRole("button", { name: /Always allow/ })).toBeVisible();
    // A changed proposal and a turn with nowhere to ask refuse with what happened, and nothing started.
    await expect(document.querySelector("[data-stale]")!.textContent, "APIFY_CHANGED_REVIEW_AGAIN").toContain("Changed · review again");
    await expect(document.querySelector("[data-stale]")!.textContent).toContain("Nothing started");
    await expect(document.querySelector("[data-no-surface]")!.textContent).toContain("This run needs your approval, and there was nowhere to ask. Nothing started.");
    await userEvent.click(view.getByRole("button", { name: /^Deny/ }));
    await expect(args.onApproval).toHaveBeenCalledWith("apify-run-1", false, undefined);
  },
});
export const RunApproval1280 = RunApproval320.extend(atWidth(1280));
