/**
 * The trusted Apify run service (#3161,
 * [the contract](../../../../docs/decisions/apify-capability.md#selected-execution-eligibility-and-monetary-enforcement)):
 * reservation, dispatch, bounded waiting, results, abort, settlement and
 * reconciliation of user-approved Actor runs.
 *
 * Every paid step is admitted the same way. {@link ApifyConsent.admitRun}
 * re-reads the proposal's facts and consumes it; the dispatch here then
 * scans input for credential extraction, intersects `apify.limits` with global
 * `budgets` (less inference already spent) and reserves the run cap plus its
 * estimated lifecycle (status, result and abort requests, and the remote storage
 * it can leave behind) in the shared ledger, atomically and before the start
 * request. The start is sent once, never retried, with the build number,
 * timeout, memory and `maxTotalChargeUsd` as run options rather than input.
 *
 * A start whose outcome is not known (a timeout, a lost or unreadable
 * response) is `remote_outcome_unknown`: its reservation is kept and nothing
 * starts it again. Only the run's own identity, or an operator's evidence,
 * resolves it ({@link ApifyRuns.resolveUnknown}); an empty run listing never
 * does. Results become available only after the returned run proves the
 * account, Actor, build and options it was asked for.
 *
 * Cancellation, timeout, budget exhaustion and disablement stop new work and
 * send an owned abort through {@link ApifyAuthority.cleanupRequest}. A
 * requested or even confirmed abort never asserts that nothing was charged:
 * the run's liability settles only from observed run charges, and an
 * unpriced or missing report keeps the reservation.
 *
 * Exposure through CLI, MCP and both chat backends is #3162; presentation is
 * #3163. Detailed accounting is internal side-channel data: callers pass
 * models only the facts in {@link ApifyRunView}.
 */
import { checkGovernancePolicy, type ApifyLimits } from "../governance-policy.js";
import { ApifyAuthorityError, type ApifyAuthority, type ApifyBinding } from "./authority.js";
import { sha256 } from "./canonical.js";
import { APIFY_DISCOVERY_LIMITS, ApifyInputError, type ApifyCallContext, type ApifyConsent, type ApifyRequestMeter, type ApifyRunTicket } from "./consent.js";
import {
  ApifyLedgerRefusal, APIFY_TERMINAL_STATES, liability, type ApifyLedger, type ApifyRunRow, type ApifyRunState, type ApifyScopeTotals,
} from "./ledger.js";
import {
  APIFY_QUALIFIED_PROFILES, eventMicros, lifecycleMicros, micros, profileFor, type ApifyQualifiedProfile,
} from "./profiles.js";

/** The contract's machine refusal codes this service raises. */
export type ApifyRunCode =
  | "provider_disabled" | "authentication_required" | "policy_denied" | "approval_required" | "proposal_stale" | "actor_unsupported"
  | "budget_exceeded" | "accounting_unavailable" | "result_expired" | "remote_outcome_unknown" | "upstream_incompatible";

/** A refusal whose message is fixed and actionable; it never carries remote text or a secret. */
export class ApifyRunError extends Error {
  constructor(readonly code: ApifyRunCode, readonly reason: string, message: string) {
    super(message);
    this.name = "ApifyRunError";
  }
}

/** Host bounds a caller cannot enlarge. */
export const APIFY_RUN_LIMITS = Object.freeze({
  default_result_page: 25,
  max_result_page: 100,
  /** How long the run operation waits for a finished run before returning a running handle. */
  wait_seconds: 30,
  poll_ms: 5_000,
  /** Status reads kept back from the bounded wait for settlement after it. */
  settlement_reads: 3,
  /** Provider completion figures can be preliminary; require a later observation. */
  settlement_delay_ms: 10_000,
  /** A start older than this without a recorded answer was interrupted: its outcome is unknown. */
  dispatch_grace_ms: 120_000,
  /** How long past its timeout a run may stay open before it is aborted. */
  deadline_grace_ms: 120_000,
});

/** What the coverage of these numbers is, stated beside inference spend. */
export const APIFY_COVERAGE =
  "BrainKit-admitted Apify work across Actors: observed run charges plus estimated platform requests, transfer and storage. Pending costs and later charges may change the total; run caps are not an all-cost guarantee. Independent account activity is not attributed to these turns." as const;

/** The governance facts a dispatch reads live. */
export interface ApifyRunPolicy {
  valid: boolean;
  enabled: boolean;
  limits: ApifyLimits | null;
  /** The global `budgets.*.block_usd`; Apify spend counts against them and can never enlarge them. */
  budgets: { turn_usd: number; session_usd: number; day_usd: number };
}

export function governanceApifyRunPolicy(brainPath: string): () => ApifyRunPolicy {
  return () => {
    const checked = checkGovernancePolicy(brainPath);
    const budgets = checked.effective.budgets;
    return { valid: checked.ok, enabled: checked.ok && checked.effective.apify.enabled === true, limits: checked.ok ? checked.effective.apify.limits : null,
      budgets: { turn_usd: budgets.turn.block_usd, session_usd: budgets.session.block_usd, day_usd: budgets.day.block_usd } };
  };
}

/**
 * Inference already spent in the caller's turn, session and UTC day, in USD
 * (known list prices; null where unknown, which never blocks by itself, as
 * for inference). Supplied by the host from its turn budgets (#3162); throwing
 * makes accounting unavailable and refuses paid admission.
 */
export type ApifyInferenceSpend = (scope: { session_id: string; turn_id: string }) => Promise<{ turn_usd: number | null; session_usd: number | null; day_usd: number | null }>;

/** Whether the site's robots.txt lets this exact URL be fetched, checked by the host before dispatch. */
export type ApifySitePermission = (url: string, signal?: AbortSignal) => Promise<boolean>;

/** Thrown by a {@link ApifySitePermission} that has no robots.txt checker to consult, such as a host without core (#3330). */
export class ApifySitePermissionUnavailable extends Error {
  constructor(message = "This host cannot check robots.txt.") { super(message); this.name = "ApifySitePermissionUnavailable"; }
}

export interface ApifyRunsOptions {
  authority: ApifyAuthority;
  consent: ApifyConsent;
  /** Opens the shared ledger; throwing refuses paid admission as `accounting_unavailable`. */
  ledger: () => ApifyLedger;
  policy: () => ApifyRunPolicy;
  /** The brain's stable identity; handles, scopes and the global day budget belong to it. */
  brain_id: string;
  /** @internal Test seam; production uses {@link APIFY_QUALIFIED_PROFILES}. */
  profiles?: readonly ApifyQualifiedProfile[];
  inference?: ApifyInferenceSpend;
  /** Legacy optional checker; Actor approval delegates remote collection methods to the Actor. */
  sitePermission?: ApifySitePermission;
  waitSeconds?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What a model may be told about a run. Accounting stays in {@link ApifyRuns.accounting}. */
export interface ApifyRunView {
  /** Opaque, bound to this brain, principal and session. */
  run: string;
  state: ApifyRunState;
  results: { available: boolean; partial: boolean; expires_at: string | null };
  abort: "requested" | "confirmed" | "unresolved" | null;
  /** True while BrainKit cannot tell whether the start reached Apify. */
  remote_outcome_unknown: boolean;
  warnings: string[];
}
export interface ApifyResultsPage {
  run: string;
  items: unknown[];
  next_cursor: string | null;
  truncated: boolean;
  partial: boolean;
  warnings: string[];
  /** Always true: every item came from a remote Actor. */
  untrusted: true;
}
export interface ApifyAbortView extends ApifyRunView {
  /** `not_needed`: the run had already finished. Never a statement that nothing was charged. */
  outcome: "requested" | "confirmed" | "unresolved" | "not_needed";
}

/** One run's accounting for the owner's UI (#3163); never routinely sent to a model. */
export interface ApifyRunAccounting {
  run: string;
  ledger_id: string;
  account_id: string;
  principal_id: string; session_id: string; turn_id: string;
  actor_id: string; build_id: string; build_number: string; profile_id: string;
  remote_run_id: string | null;
  state: ApifyRunState;
  cost_basis: ApifyRunRow["cost_basis"];
  reserved_usd: number;
  charged_usd: number | null;
  liability_usd: number;
  settled: boolean;
  price_changed: boolean;
  requests: { status: number; result: number; abort: number };
  abort: ApifyRunRow["abort_state"];
  note: string | null;
}
export interface ApifyCoverageScope {
  scope: "turn" | "session" | "day" | "brain_day";
  liability_usd: number; charged_usd: number; reserved_usd: number; residual_usd: number;
  runs: number; open_runs: number; unknown_runs: number; operator_resolved: number;
  /** The Apify limit for this scope, or null when the policy sets none. */
  limit_usd: number | null;
}
export interface ApifyCoverage {
  ledger_id: string;
  coverage: typeof APIFY_COVERAGE;
  scopes: ApifyCoverageScope[];
}

export interface ApifyRuns {
  budgetAvailability(context: ApifyCallContext, account_id: string): Promise<string | null>;
  /** Admit, reserve and start one consented run, then wait a bounded time. */
  run(context: ApifyCallContext, input: { proposal: string }): Promise<ApifyRunView>;
  status(context: ApifyCallContext, input: { run: string }): Promise<ApifyRunView>;
  results(context: ApifyCallContext, input: { run: string; cursor?: string; limit?: number }): Promise<ApifyResultsPage>;
  abort(context: ApifyCallContext, input: { run: string }): Promise<ApifyAbortView>;
  /** Host: local cancellation, timeout or budget exhaustion of a session or turn aborts its open runs. */
  stop(scope: { session_id: string; turn_id?: string }, reason: "cancelled" | "timeout" | "budget_exhausted" | "disabled"): Promise<ApifyAbortView[]>;
  /** Host: after a restart and periodically, settle, time out and clean up this brain's open runs. */
  reconcile(): Promise<{ settled: number; aborted: number; unknown: number; open: number }>;
  /**
   * Operator: resolve an unknown start from evidence outside BrainKit, either
   * the run it did start (validated like any start) or an attestation that
   * none started. The attestation stays visible in coverage.
   */
  resolveUnknown(run: string, evidence: { remote_run: string } | { not_started: { attested_by: string } }): Promise<ApifyRunAccounting>;
  accounting(run: string): ApifyRunAccounting;
  coverage(scope: { account_id: string; session_id: string; turn_id: string }): ApifyCoverage;
}

/** The validated parts of an Apify run object the service relies on. */
interface RemoteRun {
  total_micro: number | null;
  id: string; actId: string; userId: string; buildId: string; buildNumber: string | null; status: string;
  defaultDatasetId: string;
  options: { build: unknown; timeoutSecs: unknown; memoryMbytes: unknown; maxTotalChargeUsd: unknown; restartOnError: unknown };
  counts: Record<string, number> | null;
  prices: Record<string, number> | null;
  pricingModel: string | null;
  metamorphs: number;
}

const REMOTE_ID = /^[A-Za-z0-9]{1,64}$/u;
const HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const STATES: Record<string, ApifyRunState> = {
  READY: "running", RUNNING: "running", "TIMING-OUT": "aborting", ABORTING: "aborting",
  SUCCEEDED: "succeeded", FAILED: "failed", "TIMED-OUT": "timed_out", ABORTED: "aborted",
};
const NOT_ZERO = "An abort, even a confirmed one, does not mean nothing was charged; the run settles from its charge report.";
const refuse = (code: ApifyRunCode, reason: string, message: string) => new ApifyRunError(code, reason, message);
const UNKNOWN_RUN = () => refuse("proposal_stale", "unknown_run", "That Apify run is unknown, or belongs to another conversation.");
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const usd = (micro: number) => micro / 1e6;
const floorMicros = (value: number) => Math.max(0, Math.floor(Math.round(value * 1e9) / 1e3));
const terminal = (state: ApifyRunState) => (APIFY_TERMINAL_STATES as readonly string[]).includes(state);

function remoteRun(data: unknown): RemoteRun | null {
  const run = record(record(data)?.data);
  const options = record(run?.options);
  if (!run || !options || typeof run.id !== "string" || !REMOTE_ID.test(run.id) || typeof run.actId !== "string" || typeof run.userId !== "string"
    || typeof run.buildId !== "string" || typeof run.status !== "string" || typeof run.defaultDatasetId !== "string" || !REMOTE_ID.test(run.defaultDatasetId))
    return null;
  let counts: Record<string, number> | null = null;
  const rawCounts = record(run.chargedEventCounts);
  if (rawCounts) {
    counts = {};
    for (const [event, value] of Object.entries(rawCounts)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
      counts[event] = value;
    }
  }
  const pricing = record(run.pricingInfo);
  let prices: Record<string, number> | null = null;
  const events = record(record(pricing?.pricingPerEvent)?.actorChargeEvents);
  if (events) {
    prices = {};
    for (const [event, raw] of Object.entries(events)) {
      const price = record(raw)?.eventPriceUsd;
      if (typeof price === "number" && Number.isFinite(price) && price >= 0) prices[event] = price;
    }
  }
  return {
    id: run.id, actId: run.actId, userId: run.userId, buildId: run.buildId,
    buildNumber: typeof run.buildNumber === "string" ? run.buildNumber : null, status: run.status, defaultDatasetId: run.defaultDatasetId,
    options: { build: options.build, timeoutSecs: options.timeoutSecs, memoryMbytes: options.memoryMbytes, maxTotalChargeUsd: options.maxTotalChargeUsd,
      restartOnError: options.restartOnError },
    total_micro: typeof run.usageTotalUsd === "number" && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 && Number.isSafeInteger(micros(run.usageTotalUsd)) ? micros(run.usageTotalUsd) : null,
    counts, prices, pricingModel: typeof pricing?.pricingModel === "string" ? pricing.pricingModel : null,
    metamorphs: Array.isArray(run.metamorphs) ? run.metamorphs.length : 0,
  };
}

/** The first way a returned run differs from the one requested, or null. */
function mismatch(row: ApifyRunRow, run: RemoteRun): string | null {
  if (run.userId !== row.account_id) return "account";
  if (run.actId !== row.actor_id) return "actor";
  if (run.buildId !== row.build_id || (run.buildNumber !== null && run.buildNumber !== row.build_number)) return "build";
  if (run.options.build !== row.build_number) return "build_option";
  if (run.options.timeoutSecs !== row.timeout_secs) return "timeout_option";
  if (run.options.memoryMbytes !== row.memory_mbytes) return "memory_option";
  if (typeof run.options.maxTotalChargeUsd !== "number" || micros(run.options.maxTotalChargeUsd) !== row.run_cap_micro) return "charge_cap_option";
  if (run.options.restartOnError === true) return "restart_option";
  // A metamorph hands the run to other code: nested work this profile never qualified.
  if (run.metamorphs) return "metamorph";
  if (!STATES[run.status]) return "status";
  return null;
}

/**
 * The durable per-turn request meter consent and runs share: every Apify
 * request a turn makes counts once, across processes.
 */
export function createApifyRequestMeter(options: {
  ledger: () => ApifyLedger; policy: () => ApifyRunPolicy; brain_id: string;
  account?: () => Promise<string | null>; inference?: ApifyInferenceSpend; now?: () => number;
}): ApifyRequestMeter {
  return async (scope, requests) => {
    const policy = options.policy(), limits = policy.limits;
    const bound = limits?.max_requests_per_turn ?? APIFY_DISCOVERY_LIMITS.requests_per_turn;
    try {
      const account_id = await options.account?.();
      const inference = account_id ? await options.inference?.(scope) : undefined;
      const headroom = (cap: number, spent?: number | null) => floorMicros(Math.max(0, cap - (spent ?? 0)));
      options.ledger().countRequests({ brain_id: options.brain_id, session_id: scope.session_id, turn_id: scope.turn_id }, requests, bound,
        account_id ? { account_id, micro: micros(requests * 0.001), now: (options.now ?? Date.now)(), limits: {
          turn_micro: Math.min(headroom(policy.budgets.turn_usd, inference?.turn_usd), floorMicros(limits?.turn_usd ?? 1_000_000)),
          session_micro: Math.min(headroom(policy.budgets.session_usd, inference?.session_usd), floorMicros(limits?.session_usd ?? 1_000_000)),
          day_micro: floorMicros(limits?.day_usd ?? 1_000_000), brain_day_micro: headroom(policy.budgets.day_usd, inference?.day_usd),
        } } : undefined);
    } catch (error) { throw translate(error); }
  };
}

/** Every failure of the ledger itself is `accounting_unavailable`; its refusals keep their codes. */
function translate(error: unknown): unknown {
  if (error instanceof ApifyLedgerRefusal) return refuse(error.code, error.reason, error.message);
  if (error instanceof ApifyRunError) return error;
  return refuse("accounting_unavailable", "ledger", "Apify accounting is unavailable, so no further paid Apify work was admitted.");
}

export function createApifyRuns(options: ApifyRunsOptions): ApifyRuns {
  const profiles = options.profiles ?? APIFY_QUALIFIED_PROFILES;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  const waitMs = Math.max(0, Math.min(options.waitSeconds ?? APIFY_RUN_LIMITS.wait_seconds, APIFY_RUN_LIMITS.wait_seconds)) * 1000;
  const pollMs = Math.max(1, options.pollMs ?? APIFY_RUN_LIMITS.poll_ms);

  function ledger(): ApifyLedger {
    try { return options.ledger(); } catch (error) { throw translate(error); }
  }
  /** A ledger call; a refusal or an unavailable store becomes the contract's code. */
  function book<T>(work: (store: ApifyLedger) => T): T {
    try { return work(ledger()); } catch (error) { throw translate(error); }
  }
  const binding = (row: ApifyRunRow): ApifyBinding => ({ account_id: row.account_id, generation: row.generation });
  const profileOf = (row: ApifyRunRow) => profiles.find(entry => entry.id === row.profile_id) ?? null;

  function owned(context: ApifyCallContext, handle: unknown): ApifyRunRow {
    if (typeof handle !== "string" || !HANDLE.test(handle)) throw UNKNOWN_RUN();
    const row = book(store => store.get(handle));
    // A copied handle in another brain, principal or session (a fork, a resume) is not an ownership transfer.
    if (!row || row.brain_id !== options.brain_id || row.principal_id !== context.principal_id || row.session_id !== context.session_id) throw UNKNOWN_RUN();
    return row;
  }

  function view(row: ApifyRunRow, warnings: string[] = []): ApifyRunView {
    const expires = row.finished_at !== null ? row.finished_at + row.retention_seconds * 1000 : null;
    const readable = row.validated === 1 && row.dataset_id !== null && row.state !== "unknown" && row.state !== "dispatching" && row.state !== "refused"
      && (expires === null || now() <= expires);
    const notes = [...warnings];
    if (row.state === "unknown") notes.push("BrainKit cannot tell whether this run started. Its reserved cost is kept until an operator resolves it; it will not be started again.");
    if (row.abort_state) notes.push(NOT_ZERO);
    return { run: row.handle, state: row.state, abort: row.abort_state, remote_outcome_unknown: row.state === "unknown",
      results: { available: readable, partial: readable && row.state !== "succeeded", expires_at: expires === null ? null : new Date(expires).toISOString() },
      warnings: notes };
  }

  /** Validate a run object against its row and record what it reports, settling a finished run with a priced report. */
  function observe(row: ApifyRunRow, run: RemoteRun): ApifyRunRow {
    if (row.remote_run_id !== null && run.id !== row.remote_run_id) throw refuse("upstream_incompatible", "run_substituted", "Apify answered for a different run.");
    const differs = mismatch(row, run);
    if (differs) {
      book(store => store.update(row.handle, () => ({ validated: 0, note: `mismatch:${differs}` }), now()));
      throw refuse("upstream_incompatible", `run_${differs}`, "The run Apify reports is not the one requested, so its results stay unavailable. Its reserved cost is kept.");
    }
    const profile = profileOf(row);
    const state = STATES[run.status]!;
    let price_changed = false;
    let micro: number | null = run.total_micro;
    if (micro === null && run.counts) {
      if (run.pricingModel !== null && run.pricingModel !== "PAY_PER_EVENT") micro = null;
      else {
        price_changed = run.prices !== null && Object.entries(run.prices).some(([event, price]) => profile?.billing.events[event] !== price);
        micro = profile ? eventMicros(profile, run.counts, run.prices) : run.prices && Object.keys(run.counts).every(event => run.counts![event] === 0 || event in run.prices!)
          ? micros(Object.entries(run.counts).reduce((sum, [event, count]) => sum + count * (run.prices![event] ?? 0), 0)) : null;
      }
    }
    let current = book(store => store.update(row.handle, current => ({
      state: current.settled ? current.state : state, validated: 1, dataset_id: run.defaultDatasetId,
      finished_at: terminal(state) ? current.finished_at ?? now() : current.finished_at,
    }), now()));
    if (run.counts || micro !== null) current = book(store => store.charge(row.handle, { counts: run.counts ?? {}, status: run.status, micro, price_changed }, now())).row;
    else if (terminal(state)) current = book(store => store.update(row.handle, () => ({ cost_basis: "unknown" }), now()));
    // Settle once: a finished run with a fully priced report. Late reports raise the settled amount in the ledger.
    if (terminal(state) && !current.settled && micro !== null && current.cost_basis !== "unknown"
      && current.finished_at !== null && now() - current.finished_at >= APIFY_RUN_LIMITS.settlement_delay_ms) {
      current = book(store => store.update(row.handle, latest => latest.settled ? null : ({
        settled: 1, cost_basis: "events",
        final_micro: (latest.charged_micro ?? micro!) + latest.request_micro + latest.storage_micro,
      }), now()));
    }
    return current;
  }

  /** One owned status read: within the run's reserved allowance, through the cleanup path that survives disablement. */
  async function readStatus(row: ApifyRunRow): Promise<ApifyRunRow> {
    if (!row.remote_run_id) return row;
    try { book(store => store.lifecycleRequest(row.handle, "status", now())); }
    catch (error) { if (error instanceof ApifyRunError && error.code === "budget_exceeded") return row; throw error; }
    const response = await options.authority.cleanupRequest(binding(row), { method: "GET", path: `/v2/actor-runs/${row.remote_run_id}` });
    const run = response.status === 200 ? remoteRun(response.data) : null;
    if (!run) throw refuse("upstream_incompatible", "run_status", "Apify returned a run status this host does not recognise. The run's reserved cost is kept.");
    return observe(book(store => store.get(row.handle))!, run);
  }

  /** An owned abort and one status read after it. Never a claim of zero spend. */
  async function abortRun(row: ApifyRunRow, why?: string): Promise<ApifyAbortView> {
    if (terminal(row.state) || row.state === "refused") return { ...view(row), outcome: "not_needed" };
    if (!row.remote_run_id) {
      // No run identity to abort: an unknown start stays unknown.
      const marked = book(store => store.update(row.handle, current => ({ abort_state: "unresolved", state: current.state === "dispatching" ? "unknown" : current.state }), now()));
      return { ...view(marked), outcome: "unresolved" };
    }
    let outcome: ApifyAbortView["outcome"] = "unresolved";
    try {
      book(store => store.lifecycleRequest(row.handle, "abort", now()));
      const response = await options.authority.cleanupRequest(binding(row), { method: "POST", path: `/v2/actor-runs/${row.remote_run_id}/abort` });
      const run = response.status === 200 ? remoteRun(response.data) : null;
      if (run) {
        const observed = observe(row, run);
        outcome = observed.state === "aborted" || terminal(observed.state) ? "confirmed" : "requested";
      }
    } catch {
      // The abort may not have reached Apify: unresolved, and visibly so.
      outcome = "unresolved";
    }
    let current = book(store => store.update(row.handle, current => ({ abort_state: outcome,
      ...(why ? { note: current.note ? `${current.note};${why}` : why } : {}) }), now()));
    if (outcome !== "unresolved" && !current.settled) {
      try { current = await readStatus(current); } catch { /* the abort stands; settlement waits for reconciliation */ }
    }
    return { ...view(current), outcome };
  }

  /** New work under a binding that no longer holds: stop the run, then refuse. */
  async function liveOrCleanup(row: ApifyRunRow): Promise<void> {
    try { await options.authority.check(binding(row)); }
    catch (error) {
      if (!terminal(row.state)) await abortRun(row, "stopped:disabled").catch(() => undefined);
      throw error;
    }
  }

  async function dispatch(context: ApifyCallContext, ticket: ApifyRunTicket): Promise<ApifyRunView> {
    const policy = options.policy();
    if (!policy.valid || !policy.enabled) throw refuse("provider_disabled", policy.valid ? "not_enabled" : "policy_invalid", "Apify is disabled, so nothing was started.");
    const limits = policy.limits;
    if (!limits) throw refuse("budget_exceeded", "limits_unset", "The governance policy sets no apify.limits, so no Apify spending is allowed. Nothing was started.");
    const profile = profileFor(profiles, ticket);
    if (options.authority.credentialRisk(ticket.input)) throw refuse("policy_denied", "credential_extraction", "Actor input attempts to extract or disclose credentials; nothing was sent.");
    const requestedMemory = ticket.memory_mbytes ?? profile?.run.memory_mbytes ?? 256;
    const memory = Number.isInteger(requestedMemory) && requestedMemory >= 128 && requestedMemory <= 32768 && (requestedMemory & (requestedMemory - 1)) === 0 ? requestedMemory : 256;
    const timeout = limits.max_runtime_seconds;
    if (timeout <= 0) throw refuse("budget_exceeded", "max_runtime_seconds", "The configured runtime allowance is exhausted.");
    // Estimates are held beside the run cap, not presented as guaranteed tariff coverage.
    const statusBudget = 20, resultBudget = Math.max(1, limits.max_requests_per_turn), abortBudget = 2;
    const life = profile ? lifecycleMicros(profile, limits.max_result_items) : {
      requests: micros(0.001 * (statusBudget + resultBudget + abortBudget)),
      storage: micros(0.01 * Math.max(1, Math.ceil(limits.max_retention_seconds / 86_400))),
    };
    let spent = { turn_usd: null as number | null, session_usd: null as number | null, day_usd: null as number | null };
    if (options.inference) {
      try { spent = await options.inference({ session_id: context.session_id, turn_id: context.turn_id }); }
      catch { throw refuse("accounting_unavailable", "inference_budget", "Inference accounting is unavailable, so the global budget cannot be checked. Nothing was started."); }
    }
    // Apify limits intersect the global budgets less inference already spent; they never enlarge them.
    const headroom = (block: number, inference: number | null) => floorMicros(Math.max(0, block - (inference ?? 0)));
    const admission = {
      run_micro: floorMicros(limits.run_usd),
      turn_micro: Math.min(floorMicros(limits.turn_usd), headroom(policy.budgets.turn_usd, spent.turn_usd)),
      session_micro: Math.min(floorMicros(limits.session_usd), headroom(policy.budgets.session_usd, spent.session_usd)),
      day_micro: floorMicros(limits.day_usd),
      brain_day_micro: headroom(policy.budgets.day_usd, spent.day_usd),
      max_runs_per_turn: limits.max_runs_per_turn, max_concurrent_runs: limits.max_concurrent_runs,
    };
    const at = now();
    // The durable dispatch intent: once this commits, the reservation exists whatever happens to the start.
    let row = book(store => store.reserve({
        account_id: ticket.binding.account_id, generation: ticket.binding.generation, brain_id: options.brain_id,
        principal_id: context.principal_id, session_id: context.session_id, turn_id: context.turn_id, proposal_digest: sha256(ticket.proposal),
        require_actor_approval: ticket.consent.source === "grant", actor_id: ticket.actor_id, build_id: ticket.build_id, build_number: ticket.build_number, profile_id: profile?.id ?? "actor-approved", input_sha256: ticket.input_sha256,
        run_cap_micro: ticket.max_charge_microusd, request_micro: life.requests, storage_micro: life.storage, request_unit_micro: profile ? micros(profile.lifecycle.request_usd) : micros(0.001),
        deadline_at: at + timeout * 1000 + APIFY_RUN_LIMITS.deadline_grace_ms, retention_seconds: limits.max_retention_seconds,
        timeout_secs: timeout, memory_mbytes: memory, items_bound: Number.MAX_SAFE_INTEGER,
        max_result_items: Number.MAX_SAFE_INTEGER, max_result_bytes: Number.MAX_SAFE_INTEGER,
        status_budget: profile?.lifecycle.status_requests ?? statusBudget, result_budget: profile?.lifecycle.result_requests ?? resultBudget, abort_budget: profile?.lifecycle.abort_requests ?? abortBudget,
      }, admission, at, limits.max_requests_per_turn));

    let response;
    try {
      // Sent once, never retried. Not tied to the turn's signal: an answer is better evidence than a cut connection.
      response = await options.authority.request(ticket.binding, { method: "POST", path: `/v2/acts/${ticket.actor_id}/runs`,
        query: { build: ticket.build_number, timeout, memory, maxTotalChargeUsd: ticket.max_charge_usd,
          waitForFinish: 0, restartOnError: false },
        body: ticket.input });
    } catch (error) {
      const before = error instanceof TypeError || (error instanceof ApifyAuthorityError
        && (error.code === "provider_disabled" || error.code === "proposal_stale" || error.reason === "token_missing" || error.reason === "account_changed" || error.reason === "token_rejected"));
      if (before) {
        // Refused before or by Apify's authentication: nothing started, nothing is owed.
        book(store => store.update(row.handle, () => ({ state: "refused", settled: 1, final_micro: 0, cost_basis: "none", note: "start_refused" }), now()));
        throw error;
      }
      book(store => store.update(row.handle, () => ({ state: "unknown", note: "start_unconfirmed" }), now()));
      throw refuse("remote_outcome_unknown", "start_unconfirmed",
        "The start request may or may not have reached Apify. Its reserved cost is kept and it will not be sent again; an operator can resolve it.");
    }
    if (response.status >= 400 && response.status < 500) {
      book(store => store.update(row.handle, () => ({ state: "refused", settled: 1, final_micro: 0, cost_basis: "none", note: `start_rejected:${response.status}` }), now()));
      throw refuse(response.status === 402 ? "budget_exceeded" : "upstream_incompatible", `start_rejected_${response.status}`, "Apify refused to start the run; nothing was started.");
    }
    const run = response.status === 200 || response.status === 201 ? remoteRun(response.data) : null;
    if (!run) {
      book(store => store.update(row.handle, () => ({ state: "unknown", note: "start_unreadable" }), now()));
      throw refuse("remote_outcome_unknown", "start_unreadable", "Apify's answer to the start did not identify a run. Its reserved cost is kept and it will not be sent again.");
    }
    try {
      row = book(store => store.update(row.handle, () => ({ remote_run_id: run.id, dispatched_at: now(), state: "running" }), now()));
    } catch (error) {
      // The run exists but could not be recorded: stop it, and leave the intent as unknown liability.
      await options.authority.cleanupRequest(ticket.binding, { method: "POST", path: `/v2/actor-runs/${run.id}/abort` }).catch(() => undefined);
      throw error;
    }
    try { row = observe(row, run); }
    catch (error) {
      await abortRun(book(store => store.get(row.handle))!).catch(() => undefined);
      throw error;
    }
    return await settle(context, row);
  }

  /** The bounded wait after a start: polls within the run's status allowance, aborting on cancellation or disablement. */
  async function settle(context: ApifyCallContext, start: ApifyRunRow): Promise<ApifyRunView> {
    let row = start;
    const until = now() + waitMs;
    while ((!terminal(row.state) || !row.settled) && now() < until && row.status_requests < row.status_budget - APIFY_RUN_LIMITS.settlement_reads) {
      if (context.signal?.aborted) return abortRun(row, "stopped:cancelled");
      await sleep(Math.min(pollMs, Math.max(0, until - now())), context.signal);
      if (context.signal?.aborted) return abortRun(row, "stopped:cancelled");
      try { await options.authority.check(binding(row)); }
      catch { return abortRun(row, "stopped:disabled"); }
      row = await readStatus(row);
    }
    return view(row, terminal(row.state) ? [] : ["The run is still going. Check its status later; its reserved cost is held until it settles."]);
  }

  function accounting(handle: string): ApifyRunAccounting {
    const row = book(store => store.get(handle));
    if (!row || row.brain_id !== options.brain_id) throw UNKNOWN_RUN();
    return { run: row.handle, ledger_id: row.ledger_id, account_id: row.account_id, principal_id: row.principal_id, session_id: row.session_id, turn_id: row.turn_id,
      actor_id: row.actor_id, build_id: row.build_id, build_number: row.build_number, profile_id: row.profile_id, remote_run_id: row.remote_run_id,
      state: row.state, cost_basis: row.cost_basis, reserved_usd: usd(row.reserved_micro), charged_usd: row.charged_micro === null ? null : usd(row.charged_micro),
      liability_usd: usd(liability(row)), settled: row.settled === 1, price_changed: row.price_changed === 1,
      requests: { status: row.status_requests, result: row.result_requests, abort: row.abort_requests }, abort: row.abort_state, note: row.note };
  }

  return {
    async budgetAvailability(context, account_id) {
      const policy = options.policy();
      if (!policy.valid || !policy.enabled) return "not_enabled";
      if (!policy.limits) return "limits_unset";
      const totals = book(store => store.totals({ brain_id: options.brain_id, account_id, session_id: context.session_id, turn_id: context.turn_id }, now()));
      const inference = options.inference ? await options.inference(context) : { turn_usd: 0, session_usd: 0, day_usd: 0 };
      const limits = policy.limits;
      if (limits.run_usd <= 0 || totals.turn.liability_micro >= micros(Math.min(limits.turn_usd, Math.max(0, policy.budgets.turn_usd - (inference.turn_usd ?? 0))))
        || totals.session.liability_micro >= micros(Math.min(limits.session_usd, Math.max(0, policy.budgets.session_usd - (inference.session_usd ?? 0))))
        || totals.day.liability_micro >= micros(limits.day_usd)
        || totals.brain_day.liability_micro >= micros(Math.max(0, policy.budgets.day_usd - (inference.day_usd ?? 0)))) return "budget_exhausted";
      if (totals.day.open_runs >= limits.max_concurrent_runs) return "max_concurrent_runs";
      if (totals.turn.runs >= limits.max_runs_per_turn) return "max_runs_per_turn";
      return null;
    },
    async run(context, input) {
      return options.consent.admitRun(context, input, ticket => dispatch(context, ticket));
    },

    async status(context, input) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => key !== "run")) throw new ApifyInputError("Expected { run }.");
      let row = owned(context, raw.run);
      if (row.state === "unknown" || row.state === "refused" || row.settled) return view(row);
      await liveOrCleanup(row);
      const limits = options.policy().limits;
      book(store => store.countRequests({ brain_id: options.brain_id, session_id: context.session_id, turn_id: context.turn_id }, 1,
        limits?.max_requests_per_turn ?? APIFY_DISCOVERY_LIMITS.requests_per_turn));
      row = await readStatus(row);
      return view(row);
    },

    async results(context, input) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => !["run", "cursor", "limit"].includes(key))) throw new ApifyInputError("Expected { run, cursor?, limit? }.");
      const limit = raw.limit === undefined ? APIFY_RUN_LIMITS.default_result_page : raw.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > APIFY_RUN_LIMITS.max_result_page)
        throw new ApifyInputError(`limit is an integer from 1 to ${APIFY_RUN_LIMITS.max_result_page}.`);
      let row = owned(context, raw.run);
      let offset = 0;
      if (raw.cursor !== undefined) {
        const parsed = typeof raw.cursor === "string" ? book(store => store.offset(row.handle, raw.cursor as string)) : null;
        if (parsed === null) throw new ApifyInputError("That cursor does not belong to this run.");
        offset = parsed;
      }
      if (row.state === "unknown" || row.state === "dispatching")
        throw refuse("remote_outcome_unknown", "start_unconfirmed", "BrainKit cannot tell whether this run started, so it has no results.");
      if (row.state === "refused" || row.validated !== 1 || !row.dataset_id)
        throw refuse("upstream_incompatible", "results_unavailable", "This run's results are not available: the run was never confirmed as the one requested.");
      if (row.finished_at !== null && now() > row.finished_at + row.retention_seconds * 1000)
        throw refuse("result_expired", "retention", "This run's results are past the retention the policy allows here. Apify may still hold, and bill for, its storage.");
      await liveOrCleanup(row);
      const limits = options.policy().limits;
      const itemsLeft = row.max_result_items - offset;
      const bytesLeft = row.max_result_bytes - row.result_bytes;
      if (itemsLeft <= 0 || bytesLeft <= 0)
        return { run: row.handle, items: [], next_cursor: null, truncated: true, partial: row.state !== "succeeded", untrusted: true,
          warnings: ["The policy's result limit for this run is reached; no more items are read."] };
      book(store => store.countRequests({ brain_id: options.brain_id, session_id: context.session_id, turn_id: context.turn_id }, 1,
        limits?.max_requests_per_turn ?? APIFY_DISCOVERY_LIMITS.requests_per_turn));
      row = book(store => store.lifecycleRequest(row.handle, "result", now()));
      const asked = Math.min(limit, itemsLeft);
      // A JSON body from the fixed API origin; a redirect or signed download URL is refused, never followed.
      const response = await options.authority.request(binding(row), { method: "GET", path: `/v2/datasets/${row.dataset_id}/items`,
        query: { offset, limit: asked, clean: true, format: "json" }, ...(context.signal ? { signal: context.signal } : {}) });
      if (response.status !== 200 || !Array.isArray(response.data))
        throw refuse("upstream_incompatible", "dataset_items", "Apify returned dataset items this host does not recognise.");
      if (options.authority.credentialRisk(response.data)) throw refuse("policy_denied", "credential_extraction", "Actor output attempts to extract or disclose credentials; no result content was returned.");
      const items: unknown[] = [];
      let bytes = 0;
      let truncated = false;
      const warnings: string[] = [];
      for (const item of response.data.slice(0, asked)) {
        const size = Buffer.byteLength(JSON.stringify(item) ?? "null");
        if (bytes + size > bytesLeft) { truncated = true; break; }
        bytes += size;
        items.push(item);
      }
      const read = items.length;
      book(store => store.update(row.handle, current => ({ result_items: Math.max(current.result_items, offset + read), result_bytes: current.result_bytes + bytes }), now()));
      const more = !truncated && response.data.length >= asked && offset + read < row.max_result_items;
      if (truncated) warnings.push("Results were cut at the policy's byte limit for this run.");
      if (row.state !== "succeeded") warnings.push("The run has not succeeded; these results may be incomplete.");
      await context.untrusted({ operation: "results", detail: `apify run results: ${read} items` });
      // Reaching the run's item bound with a full page means more items may exist than the policy lets this host read.
      const capped = offset + read >= row.max_result_items && response.data.length >= asked;
      return { run: row.handle, items: items.filter(item => item !== null), next_cursor: more ? book(store => store.cursor(row.handle, offset + read)) : null,
        truncated: truncated || capped, partial: row.state !== "succeeded",
        warnings: [...new Set(warnings)], untrusted: true };
    },

    async abort(context, input) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => key !== "run")) throw new ApifyInputError("Expected { run }.");
      return abortRun(owned(context, raw.run));
    },

    async stop(scope, reason) {
      const rows = book(store => store.unsettled(options.brain_id)).filter(row => row.session_id === scope.session_id
        && (scope.turn_id === undefined || row.turn_id === scope.turn_id) && !terminal(row.state));
      const results: ApifyAbortView[] = [];
      for (const row of rows) results.push(await abortRun(row, `stopped:${reason}`).catch(() => ({ ...view(row), outcome: "unresolved" as const })));
      return results;
    },

    async reconcile() {
      const summary = { settled: 0, aborted: 0, unknown: 0, open: 0 };
      for (const original of book(store => store.unsettled(options.brain_id))) {
        let row = original;
        try {
          if (row.state === "dispatching" && now() - row.created_at > APIFY_RUN_LIMITS.dispatch_grace_ms)
            row = book(store => store.update(row.handle, current => current.state === "dispatching" ? { state: "unknown", note: "start_interrupted" } : null, now()));
          if (row.state === "unknown" || row.state === "dispatching" || !row.remote_run_id) { summary.unknown += row.state === "unknown" ? 1 : 0; continue; }
          if (!terminal(row.state)) {
            let live = true;
            try { await options.authority.check(binding(row)); } catch { live = false; }
            if (!live || now() > row.deadline_at) { await abortRun(row, live ? "stopped:timeout" : "stopped:disabled"); summary.aborted += 1; row = book(store => store.get(row.handle))!; }
          }
          if (!row.settled) row = await readStatus(row);
        } catch { /* reconciliation retries on its next pass */ }
        row = book(store => store.get(row.handle))!;
        if (row.settled) summary.settled += 1;
        else if (!terminal(row.state)) summary.open += 1;
      }
      return summary;
    },

    async resolveUnknown(handle, evidence) {
      if (typeof handle !== "string" || !HANDLE.test(handle)) throw UNKNOWN_RUN();
      const row = book(store => store.get(handle));
      if (!row || row.brain_id !== options.brain_id) throw UNKNOWN_RUN();
      if (row.state !== "unknown") throw refuse("proposal_stale", "not_unknown", "Only a run whose start is unknown can be resolved this way.");
      if ("not_started" in evidence) {
        const who = String(evidence.not_started.attested_by ?? "").slice(0, 128);
        if (!who.trim()) throw new ApifyInputError("An attestation names who made it.");
        book(store => store.update(handle, () => ({ state: "refused", settled: 1, final_micro: 0, cost_basis: "operator", note: `operator_not_started:${who}` }), now()));
        return accounting(handle);
      }
      if (!REMOTE_ID.test(evidence.remote_run)) throw new ApifyInputError("A run id is letters and digits.");
      const response = await options.authority.cleanupRequest(binding(row), { method: "GET", path: `/v2/actor-runs/${evidence.remote_run}` });
      const run = response.status === 200 ? remoteRun(response.data) : null;
      if (!run || run.id !== evidence.remote_run) throw refuse("upstream_incompatible", "run_status", "Apify did not confirm that run.");
      const attached = book(store => store.update(handle, () => ({ remote_run_id: run.id, state: "running", note: "operator_attached" }), now()));
      observe(attached, run);
      return accounting(handle);
    },

    accounting,

    coverage(scope) {
      const store = ledger();
      const totals = book(inner => inner.totals({ ...scope, brain_id: options.brain_id }, now()));
      const limits = options.policy().limits;
      const limit = { turn: limits?.turn_usd, session: limits?.session_usd, day: limits?.day_usd, brain_day: undefined } as const;
      const scoped = (name: keyof typeof totals, entry: ApifyScopeTotals): ApifyCoverageScope => ({ scope: name,
        liability_usd: usd(entry.liability_micro), charged_usd: usd(entry.charged_micro), reserved_usd: usd(entry.reserved_micro), residual_usd: usd(entry.residual_micro),
        runs: entry.runs, open_runs: entry.open_runs, unknown_runs: entry.unknown_runs, operator_resolved: entry.operator_resolved, limit_usd: limit[name] ?? null });
      return { ledger_id: store.id, coverage: APIFY_COVERAGE, scopes: (Object.keys(totals) as Array<keyof typeof totals>).map(name => scoped(name, totals[name])) };
    },
  };
}
