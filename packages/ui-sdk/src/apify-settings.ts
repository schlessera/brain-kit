/**
 * The owner's Apify settings and spend facts (#3163), read from internal
 * `GET /api/apify`. Live human owners only; agents never receive them and
 * none of it enters a model's conversation. No field ever carries a token.
 *
 * Every amount is USD. A missing figure is `null` or absent, never `0`: an
 * unknown charge, an unread ledger or an unconfirmed abort is reported as
 * what it is.
 */

/** The provider state `ApifyAuthority.status` reports (#3159). */
export type ApifyProviderState = "disabled" | "authentication_required" | "configured" | "unavailable";
export type ApifyProviderReason =
  | "not_enabled" | "policy_invalid"
  | "token_missing" | "token_rejected" | "account_changed"
  | "upstream_unreachable" | "upstream_incompatible";
export interface ApifyAccountRead { id: string; username: string | null }
export type ApifyPolicyMode = "deny" | "ask" | "allow";

/** One standing grant from `apify.actor_grants`, with whether it can admit a run now. */
export interface ApifyGrantRead {
  account_id: string;
  actor_id: string;
  build_number: string;
  profile_id: string;
  origins: string[];
  expires_at: string;
  max_run_usd: number;
  /** `other_account`: written for a different account than the token now belongs to. */
  status: "active" | "expired" | "other_account";
}

/** The effective `apify.limits`, or null when the policy sets none (no run is admitted). */
export interface ApifyLimitsRead {
  run_usd: number; turn_usd: number; session_usd: number; day_usd: number;
  max_runs_per_turn: number; max_requests_per_turn: number; max_concurrent_runs: number;
  max_runtime_seconds: number; max_result_items: number; max_result_bytes: number; max_retention_seconds: number;
}

export interface ApifyPolicyRead {
  path: "context/policies/governance.md";
  /** SHA-256 of the policy bytes read, or null when no file exists. An edit names it as its base. */
  hash: string | null;
  valid: boolean;
  enabled: boolean;
  discovery: ApifyPolicyMode;
  actors: ApifyPolicyMode;
  grants: ApifyGrantRead[];
  limits: ApifyLimitsRead | null;
  /** The global `budgets.*.block_usd`; Apify spend counts against them and never enlarges them. */
  budgets: { turn_usd: number; session_usd: number; day_usd: number };
}

/** One ledger scope's totals (`ApifyRuns.coverage`). */
export interface ApifySpendScopeRead {
  scope: "turn" | "session" | "day" | "brain_day";
  /** Upper bound of what this scope may owe: known charges plus held reservations. */
  liability_usd: number;
  /** Known charges, settled or reported so far. */
  charged_usd: number;
  /** Held for work whose charges are not yet, or never, known. */
  reserved_usd: number;
  /** Lifecycle requests and remote storage still owed after settlement. */
  residual_usd: number;
  runs: number;
  open_runs: number;
  /** Starts whose outcome is unknown; their reservations are kept. */
  unknown_runs: number;
  operator_resolved: number;
  limit_usd: number | null;
}

/** One run whose charge is not final yet, from this brain's ledger. */
export interface ApifyUnresolvedRunRead {
  /** A display key, not the run handle. */
  key: string;
  actor_id: string;
  build_number: string;
  state: "dispatching" | "unknown" | "running" | "aborting" | "succeeded" | "failed" | "timed_out" | "aborted" | "refused";
  abort: "requested" | "confirmed" | "unresolved" | null;
  cost_basis: "reserved" | "events" | "unknown" | "operator" | "none";
  reserved_usd: number;
  /** Known charges so far; null until a charge report arrived. */
  charged_usd: number | null;
  liability_usd: number;
  /** True while BrainKit cannot tell whether the start reached Apify. */
  remote_outcome_unknown: boolean;
  session_id: string;
  turn_id: string;
  started_at: string;
  updated_at: string;
}

export interface ApifySpendRead {
  /**
   * `absent`: this host never recorded a run, so there is no ledger to read.
   * `unavailable`: the ledger could not be read; spend is unknown, not zero.
   */
  ledger: "absent" | "read" | "unavailable";
  observed_at: string;
  coverage: string | null;
  /** The account-wide UTC day, when an account is known. */
  day: ApifySpendScopeRead | null;
  /** This brain's share of the UTC day. */
  brain_day: ApifySpendScopeRead | null;
  /** Present when the read named a session and turn. */
  turn?: ApifySpendScopeRead | null;
  unresolved: ApifyUnresolvedRunRead[];
}

export interface ApifySettingsRead {
  state: ApifyProviderState;
  reason: ApifyProviderReason | null;
  account: ApifyAccountRead | null;
  pending_account: ApifyAccountRead | null;
  checked_at: string | null;
  /** Additive since #3163. */
  policy: ApifyPolicyRead;
  /** Additive since #3163. */
  spend: ApifySpendRead;
}

/** One Settings edit, proposed through the existing policy-change review. */
export type ApifyPolicyChange =
  | { enabled: boolean }
  | { discovery: ApifyPolicyMode }
  | { actors: ApifyPolicyMode }
  | { remove_grant: { account_id: string; actor_id: string; build_number: string; profile_id: string; expires_at: string } };

export interface ApifyPolicyProposalRead {
  turn_id: string;
  request_id: string;
  review: import("./tool-contracts/policy.js").PolicyChangeReview;
}
