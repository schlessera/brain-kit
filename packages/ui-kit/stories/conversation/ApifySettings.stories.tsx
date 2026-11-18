import preview from "#.storybook/preview";
import { atWidth, viewportAt } from "../_viewports.js";
import { useEffect, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import type { ApifyPolicyChange, ApifySettingsRead } from "../../../ui-sdk/src/protocol.js";
import type { PolicyChangeReview } from "../../../ui-sdk/src/tool-contracts/policy.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { AccountsTab } from "../../../ui-react/src/components/settings/accounts-tab.js";
import { ConsumerDocument, consumerViewport, painted, bounds, targets, accessible } from "./_consumer-parity.js";

/*
 * Settings › Accounts › External services › Apify (#3163), against a fake
 * host in the story's request
 * function. Odysseus fixtures, pinned to 2026-07-12; the amounts are
 * fictional examples, not vendor prices. The fake host records every
 * request, so "nothing was applied early" and "the answer was never sent
 * twice" are assertions about what the UI actually sent.
 */

const PATH = "context/policies/governance.md" as const;
const HASH = "a".repeat(64), NEXT = "b".repeat(64);
const GRANT = { account_id: "OdysseusOps7c2f", actor_id: "HarborNotices01", build_number: "1.4.12", profile_id: "ithaca.harbor-notices@3",
  origins: ["https://harbor.ithaca.example"], expires_at: "2026-08-12T00:00:00.000Z", max_run_usd: 0.8, status: "active" as const };
const LIMITS = { run_usd: 1, turn_usd: 2, session_usd: 5, day_usd: 5, max_runs_per_turn: 2, max_requests_per_turn: 40, max_concurrent_runs: 1,
  max_runtime_seconds: 600, max_result_items: 200, max_result_bytes: 5_242_880, max_retention_seconds: 604_800 };
const UNKNOWN_RUN = { key: "run-harbor-0001", actor_id: "HarborNotices01", build_number: "1.4.12", state: "unknown" as const, abort: null,
  cost_basis: "reserved" as const, reserved_usd: 1.15, charged_usd: null, liability_usd: 1.15, remote_outcome_unknown: true,
  session_id: "s-ithaca", turn_id: "t-harbor", started_at: "2026-07-12T10:40:00.000Z", updated_at: "2026-07-12T10:47:00.000Z" };

function fixture(over: Partial<ApifySettingsRead> = {}, policy: Partial<ApifySettingsRead["policy"]> = {}): ApifySettingsRead {
  return {
    state: "configured", reason: null, account: { id: "OdysseusOps7c2f", username: "odysseus-ops" }, pending_account: null,
    checked_at: "2026-07-12T09:00:00.000Z",
    policy: { path: PATH, hash: HASH, valid: true, enabled: true, discovery: "ask", actors: "ask", grants: [GRANT], limits: LIMITS,
      budgets: { turn_usd: 4, session_usd: 20, day_usd: 40 }, ...policy },
    spend: { ledger: "read", observed_at: "2026-07-12T10:47:00.000Z", coverage: "Apify runs this host admitted",
      day: { scope: "day", liability_usd: 4.55, charged_usd: 3.4, reserved_usd: 1.15, residual_usd: 0, runs: 3, open_runs: 1, unknown_runs: 1, operator_resolved: 0, limit_usd: 5 },
      brain_day: { scope: "brain_day", liability_usd: 4.55, charged_usd: 3.4, reserved_usd: 1.15, residual_usd: 0, runs: 3, open_runs: 1, unknown_runs: 1, operator_resolved: 0, limit_usd: null },
      unresolved: [UNKNOWN_RUN] },
    ...over,
  };
}

function reviewOf(change: ApifyPolicyChange, state: PolicyChangeReview["state"] = "pending", message = "Policy change proposed. Review before approving."): PolicyChangeReview {
  const [key, value] = Object.entries(change)[0]!;
  return { requestId: "apify-1", turnId: "settings-apify-1", path: PATH, state, rationale: `Settings: change apify.${key}.`, baseHash: HASH, proposedHash: NEXT,
    frontmatterDiff: key === "remove_grant" ? "-     - account_id: \"OdysseusOps7c2f\"\n-       actor_id: \"HarborNotices01\"" : `-   ${key}: ask\n+   ${key}: ${String(value)}`,
    bodyChanged: false, bodyDiff: "", sections: [key === "remove_grant" ? "apify.actor_grants" : `apify.${key}`], message, warnings: [] };
}

type Plan = { decide: "apply" | "decline" | "lose"; receiptFailures?: number };
/** A fake host: the read, propose, answer and receipt routes, recording what the UI sent. */
function fakeHost(initial: ApifySettingsRead, plan: Plan) {
  const log = { proposals: [] as ApifyPolicyChange[], decisions: [] as boolean[], receipts: 0,
    /** Set to hold the next read until `release` answers it with this read. */
    hold: null as null | Promise<ApifySettingsRead> };
  let read = structuredClone(initial), change: ApifyPolicyChange | null = null, receipt: PolicyChangeReview["state"] = "pending";
  let failures = plan.receiptFailures ?? 0;
  const apply = () => {
    if (!change) return;
    const policy = { ...read.policy, hash: NEXT };
    if ("enabled" in change) policy.enabled = change.enabled;
    else if ("discovery" in change) policy.discovery = change.discovery;
    else if ("actors" in change) policy.actors = change.actors;
    else policy.grants = policy.grants.filter(grant => grant.actor_id !== (change as { remove_grant: { actor_id: string } }).remove_grant.actor_id);
    read = { ...read, policy };
  };
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.href), method = init?.method ?? "GET";
    if (url.pathname === "/api/apify" && method === "GET") {
      if (log.hold) { const held = log.hold; log.hold = null; return Response.json(await held); }
      return Response.json(read);
    }
    if (url.pathname === "/api/apify/policy" && method === "POST") {
      change = (JSON.parse(String(init!.body)) as { change: ApifyPolicyChange }).change; log.proposals.push(change); receipt = "pending";
      return Response.json({ turn_id: "settings-apify-1", request_id: "apify-1", review: reviewOf(change) });
    }
    if (url.pathname === "/api/apify/policy/settings-apify-1/apify-1" && method === "POST") {
      const approve = (JSON.parse(String(init!.body)) as { approve: boolean }).approve; log.decisions.push(approve);
      if (plan.decide === "lose") { if (approve) { apply(); receipt = "updated"; } throw new TypeError("Failed to fetch"); }
      if (approve && plan.decide === "apply") { apply(); return Response.json(reviewOf(change!, "updated", "Policy updated. Applies from the next turn.")); }
      return Response.json(reviewOf(change!, "declined", "Policy change declined. Nothing was written."));
    }
    if (url.pathname === "/api/policy-proposals/settings-apify-1/apify-1") {
      log.receipts++;
      if (failures-- > 0) throw new TypeError("Failed to fetch");
      return Response.json(reviewOf(change!, receipt, receipt === "updated" ? "Policy updated. Applies from the next turn." : "Policy change proposed. Review before approving."));
    }
    // Pi accounts and web search are not configured on this fixture host.
    if (url.pathname === "/api/web-search") return Response.json({ configured: false, overriddenBy: null, appliesTo: [], providers: [] });
    if (url.pathname === "/api/pi-auth/providers") return Response.json({ providers: [] });
    return Response.json({ error: "Not on this fixture host." }, { status: 404 });
  };
  return { request, log };
}

let storyRoot: ReturnType<typeof createBrainUiRoot> | null = null;
function Settings({ read, plan, onHost }: { width: number; read: ApifySettingsRead; plan: Plan; onHost: (log: ReturnType<typeof fakeHost>["log"]) => void }) {
  const [root] = useState(() => {
    const host = fakeHost(read, plan); onHost(host.log);
    const root = createBrainUiRoot({ storage: null, request: host.request });
    root.stores.connection.setState({ accountKey: "odysseus" });
    storyRoot = root;
    return root;
  });
  useEffect(() => () => root.dispose(), [root]);
  return <ConsumerDocument><BrainUiProvider root={root}><div style={{ display: "flex", flexDirection: "column", minHeight: 600 }}><AccountsTab active /></div></BrainUiProvider></ConsumerDocument>;
}

let hostLog: ReturnType<typeof fakeHost>["log"] = { proposals: [], decisions: [], receipts: 0, hold: null };
const meta = preview.meta({
  title: "Conversation/Apify settings", component: Settings,
  parameters: { layout: "fullscreen" }, beforeEach: consumerViewport,
  args: { width: 320, read: fixture(), plan: { decide: "apply" } as Plan, onHost: (log: typeof hostLog) => { hostLog = log; } },
  globals: viewportAt(320),
});

/** Phones drill in from Accounts; desktop shows the section inline. Returns the section. */
async function openApify(width: number, userEvent: { click(element: Element): Promise<void> }): Promise<HTMLElement> {
  const screen = within(document.body);
  if (width < 900) {
    const row = await waitFor(() => { const found = document.querySelector<HTMLElement>("[data-apify-drill] [role=\"button\"]"); if (!found) throw new Error("drill-in row"); return found; });
    await expect(document.querySelector("[data-apify-settings]"), "phones show a drill-in row, not the inline section").toBeNull();
    await userEvent.click(row);
    await screen.findByRole("button", { name: "Back to accounts" });
  }
  return waitFor(() => { const section = document.querySelector<HTMLElement>("[data-apify-settings]"); if (!section) throw new Error("Apify section"); return section; });
}
const status = () => document.querySelector("[data-apify-settings] > [role=\"status\"]")?.textContent ?? "";
const radio = (section: HTMLElement, group: "discovery" | "actors", name: string) =>
  within(section.querySelector<HTMLElement>(`[data-apify-mode="${group}"]`)!).getByRole("radio", { name });

/** Case 12 + revoke: off keeps grants and liabilities; one approval revokes. */
export const OffKeepsGrants320 = meta.story({
  args: { read: fixture({ state: "disabled", reason: "not_enabled" }, { enabled: false }) },
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const section = await openApify(args.width, userEvent);
    const view = within(section);
    await expect(section.dataset.apifyView).toBe("off");
    await expect(section.querySelectorAll("[role=\"radiogroup\"]"), "Off hides the policy segments").toHaveLength(0);
    // APIFY_OFF_GRANTS_VISIBLE: hiding grants while off must fail here.
    const grant = await view.findByText("HarborNotices01", { selector: "p" });
    await expect(grant, "APIFY_OFF_GRANTS_VISIBLE").toBeVisible();
    await expect(view.getByText(/inactive while Apify is off/)).toBeVisible();
    // An unknown start is a reservation, never $0.
    const value = section.querySelector("[data-apify-run-value]")!;
    await expect(value.textContent, "APIFY_UNKNOWN_NOT_ZERO").toBe("$1.15 held estimate");
    await expect(section.textContent).not.toContain("$0.00");
    await expect(view.getByText(/Start not confirmed/)).toBeVisible();
    await bounds(section, "apify off"); await targets(section, "apify off"); await accessible(section);

    const revoke = view.getByRole("button", { name: "Revoke HarborNotices01 build 1.4.12" });
    await userEvent.click(revoke);
    const review = await waitFor(() => { const found = section.querySelector<HTMLElement>("[data-apify-review]"); if (!found) throw new Error("review"); return found; });
    await waitFor(() => expect(document.activeElement).toBe(review));
    // One confirmation: the review is the only dialog, and the grant is still listed until the host writes.
    await expect(document.querySelectorAll("[role=\"dialog\"]")).toHaveLength(0);
    await expect(view.getByText("HarborNotices01", { selector: "p" })).toBeVisible();
    await expect(hostLog.decisions).toEqual([]);
    await userEvent.click(within(review).getByRole("button", { name: /Approve and write/ }));
    await waitFor(() => expect(status()).toContain("Changed: HarborNotices01 build 1.4.12 revoked."));
    await waitFor(() => expect(view.queryByText("HarborNotices01", { selector: "p" })).toBeNull());
    await expect(hostLog.proposals).toEqual([{ remove_grant: { account_id: GRANT.account_id, actor_id: GRANT.actor_id, build_number: GRANT.build_number, profile_id: GRANT.profile_id, expires_at: GRANT.expires_at } }]);
    await expect(hostLog.decisions).toEqual([true]);
    await waitFor(() => expect(document.activeElement).toBe(section.querySelector("#apify-grants-heading")));
  },
});
export const OffKeepsGrants1280 = OffKeepsGrants320.extend(atWidth(1280));

/** Cases 11 + 13: token needed keeps policy editable; a declined review leaves the value. */
export const TokenNeededRefusedEdit320 = meta.story({
  args: { read: fixture({ state: "authentication_required", reason: "token_missing", account: null, checked_at: null, spend: { ledger: "absent", observed_at: "2026-07-12T09:00:00.000Z", coverage: null, day: null, brain_day: null, unresolved: [] } }), plan: { decide: "decline" } },
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const section = await openApify(args.width, userEvent);
    const view = within(section);
    await expect(section.dataset.apifyView).toBe("token_needed");
    await expect(view.getByText(/Tokens are never entered here/)).toBeVisible();
    await expect(section.querySelector("input"), "no token field").toBeNull();
    await expect(view.getByText("No Apify runs recorded on this host.")).toBeVisible();
    const ask = radio(section, "discovery", "Ask"), allow = radio(section, "discovery", "Allow");
    await expect(allow, "APIFY_TOKEN_NEEDED_EDITABLE").not.toBeDisabled();
    // Arrow keys move focus only; Enter proposes.
    ask.focus(); await userEvent.keyboard("{ArrowRight}");
    await expect(document.activeElement).toBe(allow);
    await expect(hostLog.proposals).toEqual([]);
    await userEvent.keyboard("{Enter}");
    const review = await waitFor(() => { const found = section.querySelector<HTMLElement>("[data-apify-review]"); if (!found) throw new Error("review"); return found; });
    await expect(within(review).getByText("Settings: change apify.discovery.")).toBeVisible();
    // APIFY_NO_EARLY_APPLY: the control keeps the host's value while the review is open.
    await expect(ask.getAttribute("aria-checked"), "APIFY_NO_EARLY_APPLY").toBe("true");
    await expect(allow).toHaveAttribute("aria-checked", "false");
    await bounds(section, "apify review"); await targets(review, "apify review");
    await userEvent.click(within(review).getByRole("button", { name: /Decline/ }));
    await waitFor(() => expect(status()).toBe("Unchanged: Policy change declined. Nothing was written."));
    await expect(radio(section, "discovery", "Ask")).toHaveAttribute("aria-checked", "true");
    await expect(section.querySelector("[data-apify-review]")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(radio(section, "discovery", "Ask")));
    await expect(hostLog.decisions).toEqual([false]);
  },
});
export const TokenNeededRefusedEdit1280 = TokenNeededRefusedEdit320.extend(atWidth(1280));

/** A lost answer is unconfirmed, reconciled by reading, and never sent twice. */
export const LostAnswer320 = meta.story({
  args: { plan: { decide: "lose", receiptFailures: 1 } },
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const section = await openApify(args.width, userEvent);
    await expect(section.dataset.apifyView).toBe("ready");
    await userEvent.click(radio(section, "actors", "Deny"));
    const review = await waitFor(() => { const found = section.querySelector<HTMLElement>("[data-apify-review]"); if (!found) throw new Error("review"); return found; });
    await userEvent.click(within(review).getByRole("button", { name: /Approve and write/ }));
    const unconfirmed = await waitFor(() => { const found = section.querySelector<HTMLElement>("[data-apify-unconfirmed]"); if (!found) throw new Error("unconfirmed"); return found; });
    await expect(status()).toContain("Not confirmed yet");
    // The control shows what the host reports, never a local guess: here the host already applied it.
    await waitFor(() => expect(radio(section, "actors", "Deny")).toHaveAttribute("aria-checked", "true"));
    await expect(section.querySelector("[data-apify-unconfirmed]"), "still unconfirmed until the receipt is read").not.toBeNull();
    await userEvent.click(within(unconfirmed).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(status()).toBe("Changed: Running Actors is Deny."));
    await waitFor(() => expect(radio(section, "actors", "Deny")).toHaveAttribute("aria-checked", "true"));
    await expect(hostLog.decisions, "APIFY_LOST_ANSWER_NOT_REPEATED").toEqual([true]);
    await expect(hostLog.receipts).toBe(2);
  },
});
export const LostAnswer1280 = LostAnswer320.extend(atWidth(1280));

/** Case 10 + C4: an account change marks old grants and Review focuses the grants heading. */
export const AccountChanged320 = meta.story({
  args: { read: fixture({ state: "authentication_required", reason: "account_changed", pending_account: { id: "SuitorsHall02", username: "antinous" } },
    { grants: [{ ...GRANT, status: "other_account" }] }) },
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const section = await openApify(args.width, userEvent);
    const view = within(section);
    await expect(section.dataset.apifyView).toBe("account_changed");
    await expect(section.querySelector("[data-apify-provider-text]")!.textContent).toContain("antinous (…ll02), not odysseus-ops (…7c2f). 1 approved Actor was for the old account");
    await expect(view.getByText("other account · doesn't apply")).toBeVisible();
    await expect(view.getByRole("button", { name: "Remove HarborNotices01 build 1.4.12" })).toBeVisible();
    await userEvent.click(view.getByRole("button", { name: "Review approved Actors" }));
    await expect(document.activeElement).toBe(section.querySelector("#apify-grants-heading"));
    await bounds(section, "account changed"); await targets(section, "account changed"); await accessible(section);
  },
});
export const AccountChanged1280 = AccountChanged320.extend(atWidth(1280));

/** Phones: Back returns to Accounts and focus to the Apify row. */
export const PhoneBack320 = meta.story({
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    await openApify(args.width, userEvent);
    await userEvent.click(within(document.body).getByRole("button", { name: "Back to accounts" }));
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-apify-drill] [role=\"button\"]")));
    await expect(document.querySelector("[data-apify-drill]")!.textContent).toContain("Ready");
  },
});


/** An owner change clears the old owner's private display, and a late reply never renders. */
export const OwnerSwitch1280 = meta.story({
  args: { width: 1280 },
  globals: viewportAt(1280),
  play: async ({ args, userEvent, globals }) => {
    await painted(args.width, globals.theme);
    const section = await openApify(args.width, userEvent);
    await expect(section.textContent).toContain("odysseus-ops (…7c2f)");
    let release!: (read: ApifySettingsRead) => void;
    hostLog.hold = new Promise(resolve => { release = resolve; });
    await userEvent.click(within(section).getByRole("button", { name: "Check again" }));
    // The account locks (sign-out or another owner) while that read is in flight.
    storyRoot!.authLock.state.setState({ phase: "locked" });
    await waitFor(() => expect(document.querySelector("[data-apify-settings]"), "APIFY_OWNER_SWITCH_CLEARS").toBeNull());
    release(fixture({ account: { id: "SuitorsHall02", username: "antinous" } }));
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(document.body.textContent, "APIFY_LATE_REPLY_DROPPED").not.toContain("antinous");
    await expect(document.body.textContent).not.toContain("odysseus-ops");
  },
});
