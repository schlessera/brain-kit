/**
 * The hosted server's Apify operations (#3162,
 * [the contract](../../../../docs/decisions/apify-capability.md#selected-architecture)).
 *
 * Both chat backends reach Apify through one bridge member, `apify`, which
 * lands here with the turn the host authenticated. This module builds the
 * call context from that turn and nothing the worker said: the principal,
 * the session (or, before the conversation is named, the turn alone), the
 * turn, its posture, the turn's own approval surface, the session's recorded
 * provider-folder exposures, and a G6 hook that records the session's taint
 * before any remote text is returned. It then calls the same core operation
 * `brain apify --json` and the core MCP tools call, so no transport has a
 * second consent, account or billing path. The worker never holds the token.
 *
 * Apify belongs to interactive conversations only. Voice and autonomous turns
 * keep their existing memberships: neither roster lists these tools, and a
 * call that arrives anyway is refused here before anything is read or sent.
 * The contract forbids expanding either authority, and an exact standing
 * grant is a policy fact, not a reason to let an unattended turn spend.
 *
 * The ledger is one host-owned file, `BRAIN_APIFY_LEDGER` or
 * `DB_PATH.apify-ledger.sqlite`; a standalone CLI or MCP process pointed at
 * the same file shares the account's day limit and concurrency bound. An
 * unopenable ledger refuses as `accounting_unavailable`.
 */
import { existsSync } from "node:fs";
import { apifyOperationOf, type ApifyEnvelope, type ApifyToolName } from "@schlessera/brain-common/internal/apify-operations";
import {
  apifyBrainId, callApifyOperation, createApifyConsent, createApifyRequestMeter, createApifyRuns, governanceApifyConsentPolicy,
  governanceApifyRunPolicy, openApifyLedger,
  type ApifyAbortView, type ApifyApprovalSurface, type ApifyAuthority, type ApifyCallContext, type ApifyConsent, type ApifyInferenceSpend,
  type ApifyLedger, type ApifyQualifiedProfile, type ApifyRuns,
} from "@schlessera/brain-common/internal/apify";
import type { ProviderExposure } from "../brain/governance-policy.js";
import { APIFY_PROVIDER_ROUTING } from "./routing.js";

export { APIFY_PROVIDER_ROUTING } from "./routing.js";

/** How often open runs are settled, timed out and cleaned up while the server runs. */
export const APIFY_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** The authenticated turn a call arrived on, as the host knows it. */
export interface ApifyHostTurn {
  readonly turnId: string;
  readonly principalId: string;
  /** Read at call time: a new conversation is named during its first turn. */
  sessionId(): string | null;
  readonly posture: "interactive" | "voice" | "autonomous";
  /** The turn's own approval surface, or null when it has none. */
  readonly approvals: ApifyApprovalSurface | null;
  readonly signal: AbortSignal;
}

export interface ApifyHostOptions {
  brainPath: string;
  /** The shared ledger file, outside every brain. */
  ledgerPath: string;
  /** The opened ledger, when the host shares one opener with its turn budgets; default one of its own. */
  ledger?: () => ApifyLedger;
  authority: ApifyAuthority;
  /** Inference already spent in the turn, session and UTC day, from the turn budgets. */
  inference?: ApifyInferenceSpend;
  /** What earlier turns of these sessions showed their recipients (G2). Without it, a provider policy refuses as unproven. */
  exposures?: (sessionIds: readonly string[]) => Promise<ProviderExposure[]>;
  /**
   * G6: record that remote text is about to reach this turn. Awaited before
   * the result returns; a failure returns nothing.
   */
  untrusted?: (turn: ApifyHostTurn, event: { operation: "discover" | "inspect" | "results"; detail: string }) => Promise<void>;
  report?: (message: string) => void;
  /** @internal Test seams. */
  profiles?: readonly ApifyQualifiedProfile[];
  waitSeconds?: number;
  pollMs?: number;
  now?: () => number;
}

export interface ApifyHost {
  readonly brain_id: string;
  /** For the owner's UI (#3163): per-run accounting and coverage, never model-facing. */
  readonly consent: ApifyConsent;
  readonly runs: ApifyRuns;
  /** One bridge call, on the turn the host authenticated. */
  call(turn: ApifyHostTurn, call: { tool: ApifyToolName; input: unknown }): Promise<ApifyEnvelope>;
  /** A turn was cancelled, timed out or exhausted its budget: abort the runs it started. */
  stop(turn: { turnId: string; sessionId: string | null }, reason: "cancelled" | "timeout" | "budget_exhausted"): Promise<ApifyAbortView[]>;
  /** Settle, time out and clean up this brain's open runs; a no-op before any run was ever recorded. */
  reconcile(): Promise<void>;
  /** Reconcile now and then every `intervalMs`; returns the stop function. */
  startReconciler(intervalMs?: number): () => void;
  close(): void;
}

export function createApifyHost(options: ApifyHostOptions): ApifyHost {
  const brainId = apifyBrainId(options.brainPath);
  const report = options.report ?? (() => undefined);
  let ledger: ApifyLedger | undefined;
  /** Opened on first use and kept; a failure is retried on the next call and refuses this one. */
  const openLedger = (): ApifyLedger => ledger ??= (options.ledger ?? (() => openApifyLedger(options.ledgerPath)))();
  const runPolicy = governanceApifyRunPolicy(options.brainPath);
  const meter = createApifyRequestMeter({ ledger: openLedger, policy: runPolicy, brain_id: brainId });
  const consent = createApifyConsent({ authority: options.authority, policy: governanceApifyConsentPolicy(options.brainPath), meter,
    routing: APIFY_PROVIDER_ROUTING, ...(options.profiles ? { profiles: options.profiles } : {}), ...(options.now ? { now: options.now } : {}) });
  const runs = createApifyRuns({ authority: options.authority, consent, ledger: openLedger, policy: runPolicy, brain_id: brainId,
    ...(options.inference ? { inference: options.inference } : {}), ...(options.profiles ? { profiles: options.profiles } : {}),
    ...(options.waitSeconds !== undefined ? { waitSeconds: options.waitSeconds } : {}), ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.now ? { now: options.now } : {}) });

  async function reconcile(): Promise<void> {
    // Nothing was ever admitted: do not create the ledger just to find that out.
    if (!ledger && !existsSync(options.ledgerPath)) return;
    try {
      const outcome = await runs.reconcile();
      if (outcome.aborted || outcome.unknown) report(`apify reconcile: ${outcome.settled} settled, ${outcome.aborted} aborted, ${outcome.unknown} unknown, ${outcome.open} open`);
    } catch (error) {
      report(`apify reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    brain_id: brainId,
    consent,
    runs,
    async call(turn, call) {
      const operation = apifyOperationOf(call.tool);
      if (!operation) throw new TypeError("Unknown Apify tool.");
      // Existing memberships do not expand: only an interactive turn reaches Apify.
      if (turn.posture !== "interactive") {
        return { ok: false, operation, error: { code: "policy_denied", reason: `${turn.posture}_posture`,
          message: turn.posture === "voice" ? "Apify is not available by voice. Ask for it in a typed conversation."
            : "Apify is not available to unattended work. Ask for it in an interactive conversation." } };
      }
      const named = turn.sessionId();
      // A run's turn and session liability is counted in the turn budgets under the bound session (#3307):
      // until the conversation is named, nothing could attribute it there, so nothing is started.
      if (operation === "run" && named === null) {
        return { ok: false, operation, error: { code: "accounting_unavailable", reason: "session_unbound",
          message: "This conversation is not named yet, so a run could not be counted against its budgets. Nothing was started; try again in a moment." } };
      }
      // Before the conversation is named, references stay with this turn: nothing later inherits them.
      const session = named ?? `turn:${turn.turnId}`;
      const shown = options.exposures && named ? await options.exposures([named]) : undefined;
      const context: ApifyCallContext = {
        principal_id: turn.principalId, session_id: session, turn_id: turn.turnId, posture: "interactive", approvals: turn.approvals,
        ...(shown ? { exposures: () => shown } : {}),
        untrusted: event => options.untrusted ? options.untrusted(turn, event) : undefined,
        signal: turn.signal,
      };
      return callApifyOperation({ consent, runs }, context, operation, call.input);
    },
    async stop(turn, reason) {
      if (!ledger && !existsSync(options.ledgerPath)) return [];
      const stopped: ApifyAbortView[] = [];
      // A run started before the conversation was named is held under the turn alone.
      for (const session_id of new Set([turn.sessionId ?? `turn:${turn.turnId}`, `turn:${turn.turnId}`])) {
        try { stopped.push(...await runs.stop({ session_id, turn_id: turn.turnId }, reason)); }
        catch (error) { report(`apify stop failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return stopped;
    },
    reconcile,
    startReconciler(intervalMs = APIFY_RECONCILE_INTERVAL_MS) {
      void reconcile();
      const timer = setInterval(() => void reconcile(), intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    // A ledger the caller supplied is the caller's to close.
    close() { if (!options.ledger) ledger?.close(); ledger = undefined; },
  };
}
