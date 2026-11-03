/**
 * Apify presentation rules shared by Settings, Activity, approvals and turn
 * cost details (#3163). Pure: every caller renders these strings as plain
 * text. The rules that matter most:
 *
 * - An unknown charge, an unread ledger or an unconfirmed abort is never
 *   shown as `$0.00`.
 * - A reservation is an upper bound ("up to"), not a charge.
 * - Local cancellation never reads as a confirmed remote stop.
 * - Enablement, catalog search and Actor consent are separate facts.
 */
import type {
  ApifyGrantRead, ApifyPolicyMode, ApifySettingsRead, ApifySpendRead, ApifySpendScopeRead, ApifyUnresolvedRunRead, BudgetObservation, TurnBudgetReceipt,
} from "@schlessera/brain-ui-sdk/protocol";

/** Dollars with cents, or four places below a cent so a small charge never rounds to zero. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "an unknown time";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(11, 16)} UTC` : "an unknown time";
}
export function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : iso;
}

/** The account as the owner knows it: name and the id's last four characters. */
export function accountLabel(account: { id: string; username: string | null } | null): string {
  if (!account) return "an unknown account";
  return `${account.username ?? "account"} (…${account.id.slice(-4)})`;
}

export type ApifyProviderView =
  | "off" | "policy_invalid" | "token_needed" | "token_removed" | "ready" | "unavailable" | "account_changed";

export interface ApifyProviderCard {
  view: ApifyProviderView;
  label: string;
  text: string;
  tone: "neutral" | "teal" | "gold" | "red";
}

/** Unresolved work stays a liability in every provider state. */
function unresolvedClause(count: number): string {
  return count ? ` ${count} ${count === 1 ? "run is" : "runs are"} still unresolved; the host keeps checking ${count === 1 ? "it" : "them"} while it can.` : "";
}

/** Rev 1 §2 as corrected by rev 3: one provider card per state, with the actual evidence. */
export function providerCard(read: ApifySettingsRead): ApifyProviderCard {
  const unresolved = read.spend.unresolved.length;
  const others = read.policy.grants.filter(grant => grant.status === "other_account").length;
  switch (read.reason) {
    case "not_enabled":
      return { view: "off", label: "Off", tone: "neutral", text: `Agents can't search or run Actors. Turning on doesn't approve any run.${unresolvedClause(unresolved)}` };
    case "policy_invalid":
      return { view: "policy_invalid", label: "Off · policy invalid", tone: "red",
        text: `The policy file doesn't validate, so Apify is off and Settings can't change it. Repair it in the policy file.${unresolvedClause(unresolved)}` };
    case "token_missing":
    case "token_rejected":
      return read.account
        ? { view: "token_removed", label: read.reason === "token_rejected" ? "Token rejected" : "Token removed", tone: "gold",
          text: `${read.reason === "token_rejected" ? "Apify rejected this host's token." : "This host no longer has an APIFY_TOKEN."} No new runs start.${unresolvedClause(unresolved)} Removing the token doesn't confirm that remote work stopped.` }
        : { view: "token_needed", label: "Token needed", tone: "gold",
          text: read.reason === "token_rejected"
            ? "Apify is on, but Apify rejected this host's APIFY_TOKEN. Replace it where the server runs, then check again. Tokens are never entered here."
            : "Apify is on, but this host has no APIFY_TOKEN. Set it where the server runs, then check again. Tokens are never entered here." };
    case "upstream_unreachable":
    case "upstream_incompatible":
      return { view: "unavailable", label: "Unavailable", tone: "gold",
        text: `Apify didn't answer as expected at ${shortTime(read.checked_at ?? read.spend.observed_at)}. New runs wait; approved Actors are kept.${unresolvedClause(unresolved)}` };
    case "account_changed":
      return { view: "account_changed", label: "Account changed", tone: "gold",
        text: `The token now belongs to ${accountLabel(read.pending_account)}, not ${accountLabel(read.account)}. ${others} approved ${others === 1 ? "Actor was" : "Actors were"} for the old account and no longer ${others === 1 ? "applies" : "apply"}. Nothing runs until you confirm the account.` };
    default:
      return read.state === "configured"
        ? { view: "ready", label: "Ready", tone: "teal", text: `Charges go to ${accountLabel(read.account)}. Checked ${shortTime(read.checked_at)}.` }
        : { view: "unavailable", label: "Unavailable", tone: "gold", text: "Apify's state is unknown right now. New runs wait; approved Actors are kept." };
  }
}

export const MODE_LABELS: Record<ApifyPolicyMode, string> = { deny: "Deny", ask: "Ask", allow: "Allow" };

export function grantNote(grant: ApifyGrantRead, off: boolean): string {
  if (grant.status === "expired") return `expired ${shortDate(grant.expires_at)} · no longer applies`;
  if (grant.status === "other_account") return "other account · doesn't apply";
  return off ? `until ${shortDate(grant.expires_at)} · inactive while Apify is off` : `until ${shortDate(grant.expires_at)}`;
}

/** One run's value and note. Unknown and unsettled amounts are upper bounds, never zero. */
export function runLine(run: ApifyUnresolvedRunRead): { value: string; note: string; warn: boolean } {
  const bound = `up to ${usd(run.liability_usd)}`;
  if (run.remote_outcome_unknown) return { value: bound, warn: true, note: `Start not confirmed since ${shortTime(run.started_at)} · the reservation is kept until Apify reports.` };
  if (run.abort === "unresolved") return { value: bound, warn: true, note: `Abort sent · not confirmed (${shortTime(run.updated_at)}). It may still be charged.` };
  if (run.abort === "requested" || run.state === "aborting") return { value: bound, warn: true, note: `Abort sent ${shortTime(run.updated_at)} · not confirmed.` };
  if (run.state === "dispatching") return { value: bound, warn: false, note: `Starting since ${shortTime(run.started_at)}.` };
  if (run.state === "running") return { value: bound, warn: false, note: `Running since ${shortTime(run.started_at)}.` };
  const known = run.charged_usd === null ? "charge not yet reported" : `${usd(run.charged_usd)} reported so far`;
  return { value: bound, warn: false, note: `Finished · ${known}; held at the reservation until Apify settles it.` };
}

/** Today's totals line, from the account-wide day, or this brain's share without an account. */
export function spendSummary(spend: ApifySpendRead): { text: string; known: boolean } {
  if (spend.ledger === "absent") return { known: true, text: "No Apify runs recorded on this host." };
  if (spend.ledger === "unavailable") return { known: false, text: "Spend unknown: the Apify ledger couldn't be read. Nothing here is shown as $0." };
  const scope = spend.day ?? spend.brain_day;
  if (!scope) return { known: false, text: "Spend unknown for today." };
  return { known: true, text: scopeSummary(scope) };
}
export function scopeSummary(scope: ApifySpendScopeRead): string {
  const parts = [`${usd(scope.charged_usd)} settled`];
  if (scope.reserved_usd > 0) parts.push(`up to ${usd(scope.reserved_usd)} reserved`);
  if (scope.residual_usd > 0) parts.push(`${usd(scope.residual_usd)} still owed for storage and requests`);
  if (scope.unknown_runs) parts.push(`${scope.unknown_runs} ${scope.unknown_runs === 1 ? "start" : "starts"} unknown`);
  if (scope.open_runs) parts.push(`${scope.open_runs} ${scope.open_runs === 1 ? "run" : "runs"} open`);
  return parts.join(" · ");
}

export const COVERAGE_NOTE = "Free credits may cover some of this; it is shown at full price.";

/**
 * The Apify share of a turn receipt (#3307). `apifyUsd` is already inside
 * `costUsd`; without it a receipt that names Apify accounting as unavailable
 * means unknown spend, not zero.
 */
export function receiptApify(receipt: TurnBudgetReceipt | undefined, scope: BudgetObservation["scope"] = "turn"):
  { state: "none" } | { state: "unknown" } | { state: "known"; apifyUsd: number; inferenceUsd: number | null } {
  if (!receipt) return { state: "none" };
  if (receipt.coverage.includes("Apify accounting is unavailable")) return { state: "unknown" };
  const entry = receipt.scopes.find(item => item.scope === scope);
  if (!entry || entry.apifyUsd === undefined) return { state: "none" };
  return { state: "known", apifyUsd: entry.apifyUsd, inferenceUsd: entry.costUsd === null ? null : Math.max(0, Math.round((entry.costUsd - entry.apifyUsd) * 1e6) / 1e6) };
}

/** Machine refusal codes from the Apify envelope, mapped to owner copy that names the limiting fact. */
export interface ApifyRefusal { title: string; text: string; setting: "provider" | "discovery" | "actors" | "grants" | "limits" | "today" | null }
export function refusalCopy(error: { code: string; reason?: string | null; message?: string }): ApifyRefusal {
  const reason = error.reason ?? "";
  switch (error.code) {
    case "provider_disabled": return { title: "Apify is off", text: "Apify is off for this brain. Nothing was sent.", setting: "provider" };
    case "authentication_required": return { title: "Apify needs a token on the host", text: "This host has no usable APIFY_TOKEN, or the account changed. Nothing was sent.", setting: "provider" };
    case "provider_unavailable": return { title: "Apify didn't answer", text: "Apify couldn't be reached or verified. Nothing new was started.", setting: "provider" };
    case "policy_denied":
      if (reason === "declined") return { title: "Denied", text: "You denied this request. Nothing was sent to Apify.", setting: null };
      if (reason === "discovery_denied") return { title: "Catalog search is set to Deny", text: "Catalog search is set to Deny in Settings › Accounts › Apify. Nothing was sent.", setting: "discovery" };
      if (reason === "actors_denied") return { title: "Running Actors is set to Deny", text: "Running Actors is set to Deny in Settings › Accounts › Apify. Nothing ran.", setting: "actors" };
      return { title: "Not allowed here", text: "This conversation can't use Apify. Nothing was sent.", setting: null };
    case "approval_required":
      if (reason === "cancelled") return { title: "Not approved in time", text: "The turn ended before an answer was given. Nothing ran.", setting: null };
      return { title: "Nowhere to ask", text: "This run needs your approval, and there was nowhere to ask. Nothing started.", setting: "grants" };
    case "proposal_stale":
      if (reason === "edited") return { title: "Changed · review again", text: "The approval came back with a different request than the one reviewed. Nothing was sent. Your agent can prepare it again.", setting: null };
      if (reason === "policy_changed" || reason === "grant_changed") return { title: "Changed · review again", text: "The policy changed after this was prepared. Nothing started. Your agent can prepare it again under the current policy.", setting: null };
      return { title: "Changed · review again", text: "The Actor's build, input schema, price, permissions or account changed after this was prepared, so this approval no longer matches what would run. Nothing started. Your agent can prepare it again.", setting: null };
    case "actor_unsupported": return { title: "Can't run here", text: "This Actor build isn't qualified for bounded execution here: Apify doesn't report a price and limits this brain can bound. Paid runs need a known upper limit. It can still be inspected.", setting: null };
    case "budget_exceeded": return { title: "Over a spending limit", text: `Not run: it could cost more than ${budgetName(reason)} allows. Nothing started.`, setting: "limits" };
    case "accounting_unavailable": return { title: "Spend couldn't be checked", text: reason === "session_unbound" ? "This conversation isn't named yet, so a run couldn't be counted. Nothing started; try again in a moment." : "Apify accounting is unavailable, so no paid work was admitted. Nothing started.", setting: "today" };
    case "remote_outcome_unknown": return { title: "Start not confirmed", text: "Apify didn't confirm whether the run started. Its reservation is kept until Apify reports; it is never started again automatically.", setting: "today" };
    case "result_expired": return { title: "Results expired", text: "This run's results are no longer kept here. Apify may still bill storage until its retention ends.", setting: "today" };
    case "upstream_incompatible": return { title: "Unrecognised answer from Apify", text: "Apify answered in a way this host doesn't recognise, so nothing was done with it.", setting: null };
    case "invalid_input": return { title: "Request refused", text: "The request didn't pass this operation's input checks. Nothing was sent.", setting: null };
    default: return { title: "Refused", text: "Apify refused this request. Nothing was sent.", setting: null };
  }
}

/**
 * Which limit refused, named for the owner (C6). The turn and conversation
 * reasons are the lower of the Apify limit and the overall budget less
 * inference, so the copy names both rather than guessing which one bound.
 */
export function budgetName(reason: string): string {
  const names: Record<string, string> = {
    run_usd: "the Apify per-run limit", turn_usd: "the lower of the Apify turn limit and this turn's overall budget",
    session_usd: "the lower of the Apify conversation limit and this conversation's overall budget", day_usd: "the Apify day limit for this account",
    day_budget: "today's overall budget", max_runs_per_turn: "this turn's Apify run count", max_concurrent_runs: "the concurrent Apify run limit",
    requests_per_turn: "this turn's Apify request count", limits_unset: "the Apify limits (none are set)", max_runtime_seconds: "the Apify runtime limit (zero)",
    start_rejected_402: "the Apify account's own balance",
  };
  return names[reason] ?? "a spending limit";
}
