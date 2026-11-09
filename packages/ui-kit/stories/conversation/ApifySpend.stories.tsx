import preview from "#.storybook/preview";
import { atWidth, viewportAt } from "../_viewports.js";
import { useEffect, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import type { ApifySettingsRead, TurnJournalSummary } from "../../../ui-sdk/src/protocol.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { TurnJournal } from "../../../ui-react/src/components/chat/turn-journal.js";
import { ApifyActivity } from "../../../ui-react/src/components/activity/apify-activity.js";
import { ConsumerDocument, consumerViewport, painted, bounds, targets, accessible } from "./_consumer-parity.js";

/*
 * Apify spend beside inference in turn cost details and in Activity (#3163,
 * R3 A). After a local Stop the remote run's abort is not confirmed: the
 * notice stays above the turn with Check again and Details, and nothing
 * reads $0. Odysseus fixtures; amounts are fictional examples.
 */

const ABORTED = { key: "run-harbor-0002", actor_id: "HarborNotices01", build_number: "1.4.12", state: "aborting" as const, abort: "unresolved" as const,
  cost_basis: "reserved" as const, reserved_usd: 1.15, charged_usd: 0.2, liability_usd: 1.15, remote_outcome_unknown: false,
  session_id: "s-ithaca", turn_id: "t-harbor", started_at: "2026-07-12T10:40:00.000Z", updated_at: "2026-07-12T10:47:00.000Z" };
const SCOPE = { liability_usd: 1.15, charged_usd: 0.2, reserved_usd: 0.95, residual_usd: 0, runs: 1, open_runs: 1, unknown_runs: 0, operator_resolved: 0, limit_usd: 2 };
const read = (settled: boolean): ApifySettingsRead => ({
  state: "configured", reason: null, account: { id: "OdysseusOps7c2f", username: "odysseus-ops" }, pending_account: null, checked_at: "2026-07-12T09:00:00.000Z",
  policy: { path: "context/policies/governance.md", hash: "a".repeat(64), valid: true, enabled: true, discovery: "ask", actors: "ask", grants: [], limits: null,
    budgets: { turn_usd: 4, session_usd: 20, day_usd: 40 } },
  spend: { ledger: "read", observed_at: "2026-07-12T10:47:00.000Z", coverage: "Apify runs this host admitted",
    day: { scope: "day", ...SCOPE }, brain_day: { scope: "brain_day", ...SCOPE }, turn: { scope: "turn", ...SCOPE }, unresolved: settled ? [] : [ABORTED] },
});
const summary = (coverage: "known" | "unknown"): TurnJournalSummary => ({
  state: "complete", changedFiles: 0, steeringFiles: 0, costUsd: 0.89, costIsEstimate: false, profile: "governed", actor: "interactive", model: "fixture",
  policyHash: null, sharedAttribution: false, observedAt: Date.parse("2026-07-12T10:48:00Z"),
  budget: { listPriceCostUsd: 0.89, tokens: 4200, observedAt: Date.parse("2026-07-12T10:48:00Z"),
    coverage: coverage === "known" ? "Built-in inference, relayed brain CLI providers and Apify runs this host admitted; other provider and tool spend is not metered"
      : "Built-in inference and relayed brain CLI providers; Apify accounting is unavailable, so Apify spend is not counted; other provider and tool spend is not metered",
    scopes: [{ scope: "turn", costUsd: coverage === "known" ? 2.04 : 0.89, ...(coverage === "known" ? { apifyUsd: 1.15 } : {}), tokens: 4200, unknownRuns: 0, warnUsd: 2, blockUsd: 4, blockTokens: 1_000_000, warning: true, blocked: false }] },
});

let reads: string[] = [];
function Spend({ coverage }: { width: number; coverage: "known" | "unknown" }) {
  const [root] = useState(() => {
    let checked = false;
    const root = createBrainUiRoot({ storage: null, request: async input => {
      const url = new URL(String(input), location.href);
      if (url.pathname === "/api/apify") { reads.push(url.search); if (url.searchParams.get("refresh") === "1") checked = true; return Response.json(read(checked)); }
      return Response.json({ error: "Not on this fixture host." }, { status: 404 });
    } });
    root.stores.chat.setState({ activeSessionId: "s-ithaca" });
    return root;
  });
  useEffect(() => () => root.dispose(), [root]);
  return <ConsumerDocument><BrainUiProvider root={root}>
    <TurnJournal turnId="t-harbor" summary={summary(coverage)} />
    <ApifyActivity only="unresolved" />
  </BrainUiProvider></ConsumerDocument>;
}
const meta = preview.meta({
  title: "Conversation/Apify spend", component: Spend,
  parameters: { layout: "fullscreen" }, beforeEach: [consumerViewport, () => { reads = []; }],
  args: { width: 320, coverage: "known" as "known" | "unknown" },
  globals: viewportAt(320),
});

/** Case 9: an unconfirmed abort keeps its notice and bound until the host settles it. */
export const StoppedUnconfirmed320 = meta.story({
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const body = within(document.body);
    const notice = await waitFor(() => { const found = document.querySelector<HTMLElement>("[data-apify-turn-notice]"); if (!found) throw new Error("notice"); return found; });
    await expect(notice.textContent, "APIFY_STOP_NOT_CONFIRMED").toContain("Apify hasn't confirmed the run stopped. $1.15 is held as an estimate; final charges may differ.");
    await expect(reads).toContain("?session=s-ithaca&turn=t-harbor");
    // Inference and Apify stay two figures in the header, never one exact sum.
    const header = body.getByRole("button", { name: /\$0\.8900 \+ Apify estimate \$1\.15/ });
    await userEvent.click(header);
    await userEvent.click(body.getByRole("button", { name: "Turn facts" }));
    const cost = await waitFor(() => { const found = document.querySelector<HTMLElement>("[data-apify-turn-cost=\"known\"]"); if (!found) throw new Error("cost"); return found; });
    await expect(cost.textContent).toContain("Estimated Apify liability this turn: $1.15");
    await expect(cost.textContent).toContain("Model inference: $0.89 observed lower bound");
    await expect(cost.textContent).toContain("Abort sent · not confirmed");
    const activity = document.querySelector<HTMLElement>("[data-apify-activity=\"unresolved\"]")!;
    await expect(activity.textContent).toContain("$1.15 held estimate");
    await expect(document.body.textContent).not.toContain("$0.00");
    await bounds(notice, "stop notice"); await targets(notice, "stop notice"); await accessible(document.querySelector("main")!);
    await userEvent.click(within(notice).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(document.querySelector("[data-apify-turn-notice]"), "settled by the host, not by the click").toBeNull());
    await expect(reads.some(query => query.includes("refresh=1"))).toBe(true);
  },
});
export const StoppedUnconfirmed1280 = StoppedUnconfirmed320.extend(atWidth(1280));

/** An unread ledger is unknown in the receipt, never zero. */
export const LedgerUnavailable320 = meta.story({
  args: { coverage: "unknown" },
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const body = within(document.body);
    const header = await body.findByRole("button", { name: /\+ Apify unknown/ });
    await userEvent.click(header);
    await userEvent.click(body.getByRole("button", { name: "Turn facts" }));
    const cost = await waitFor(() => { const found = document.querySelector<HTMLElement>("[data-apify-turn-cost=\"unknown\"]"); if (!found) throw new Error("cost"); return found; });
    await expect(cost.textContent, "APIFY_RECEIPT_UNKNOWN_NOT_ZERO").toContain("Apify spend: unknown");
    await expect(cost.textContent).toContain("it isn't $0");
  },
});
