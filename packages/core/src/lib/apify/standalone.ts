/**
 * Apify for a standalone `brain apify` or `brain mcp` process (#3162,
 * [the contract](../../../../../docs/decisions/apify-capability.md#selected-architecture)).
 *
 * The same operations the hosted server runs, under the operator's explicit
 * configuration and nothing ambient:
 *
 * - The governance policy must enable Apify, exactly as for the server.
 * - The token is the process's own `APIFY_TOKEN`. The hosted server never
 *   hands it to a worker, so a shell command inside a chat turn has none.
 * - Accounting is the shared ledger file named by `BRAIN_APIFY_LEDGER`, the
 *   same file the server opens, so the account's day limit and concurrency
 *   bound every process at once. Without it, or when it cannot be opened,
 *   every operation refuses as `accounting_unavailable` before anything is
 *   sent. A governed worker can open neither the variable nor the file.
 * - There is nobody to ask. A call that needs an approval refuses as
 *   `approval_required` without prompting; only an exact standing grant in
 *   the policy admits a run.
 *
 * Identity: the principal is the local operator (`local`), the session is a
 * name the caller chooses (default `default`), and the turn is that session's
 * UTC day, so turn-scoped limits renew daily. Candidates and proposals live in
 * the ledger, so one invocation can inspect what an earlier one discovered.
 */
import { resolveEnv } from "../../config/env.js";
import { isAbsolute } from "node:path";
import type { ApifyEnvelope, ApifyOperation } from "@schlessera/brain-common/internal/apify-operations";
import {
  apifyBrainId, apifyRefusal, ApifyLedgerUnavailable, ApifyOperationRefusal, callApifyOperation, createApifyAuthority, createApifyConsent,
  createApifyRequestMeter, createApifyRuns, governanceApifyConsentPolicy, governanceApifyPolicy, governanceApifyRunPolicy, ledgerConsentState,
  openApifyLedger, utcDay, type ApifyAuthority, type ApifyCallContext, type ApifyLedger, type ApifyRuns, type ApifyStatus,
} from "@schlessera/brain-common/internal/apify";

/** The environment variable naming the shared ledger file. */
export const APIFY_LEDGER_ENV = "BRAIN_APIFY_LEDGER";
/** The standalone principal: whoever runs the process on this machine. */
export const APIFY_LOCAL_PRINCIPAL = "local";
/** The ledger setting holding a standalone process's account binding. */
export const APIFY_STANDALONE_AUTHORITY_SETTING = "authority:standalone";
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface StandaloneApifyOptions {
  root: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** @internal Test seams for a loopback fake. */
  origin?: string;
  mcpOrigin?: string;
  fetch?: typeof fetch;
  profiles?: Parameters<typeof createApifyConsent>[0]["profiles"];
  waitSeconds?: number;
  pollMs?: number;
  now?: () => number;
}

export interface StandaloneApify {
  call(operation: ApifyOperation, input: unknown, options?: { session?: string; signal?: AbortSignal }): Promise<ApifyEnvelope>;
  /** The account binding, for an operator: never a token. */
  status(): Promise<ApifyStatus>;
  /** An operator accepts the token's changed account. */
  confirmAccount(accountId: string): Promise<ApifyStatus>;
  close(): void;
}

export { apifyBrainId };

export function createStandaloneApify(options: StandaloneApifyOptions): StandaloneApify {
  // The process environment is read in core's one chokepoint; tests pass their own.
  const { apifyToken, apifyLedger } = options.env ? resolveEnv(options.env as NodeJS.ProcessEnv) : resolveEnv();
  const now = options.now ?? Date.now;
  const brainId = apifyBrainId(options.root);
  const enablement = governanceApifyPolicy(options.root);
  let ledger: ApifyLedger | undefined;
  let built: { authority: ApifyAuthority; runs: ApifyRuns; consent: ReturnType<typeof createApifyConsent> } | undefined;

  function openLedger(): ApifyLedger {
    if (ledger) return ledger;
    const path = apifyLedger;
    if (!path || !isAbsolute(path))
      throw new ApifyOperationRefusal("accounting_unavailable", "ledger_unset",
        `Apify accounting is unavailable here: set ${APIFY_LEDGER_ENV} to the absolute path of the shared Apify ledger (the file the server uses) to use Apify from this process.`);
    ledger = openApifyLedger(path);
    return ledger;
  }

  function services() {
    if (built) return built;
    const store = openLedger();
    const authority = createApifyAuthority({ policy: enablement, token: () => apifyToken,
      store: { read: () => store.setting(APIFY_STANDALONE_AUTHORITY_SETTING), write: record => store.setSetting(APIFY_STANDALONE_AUTHORITY_SETTING, record) },
      ...(options.origin ? { origin: options.origin } : {}), ...(options.mcpOrigin ? { mcpOrigin: options.mcpOrigin } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}), now });
    const runPolicy = governanceApifyRunPolicy(options.root);
    const meter = createApifyRequestMeter({ ledger: () => store, policy: runPolicy, brain_id: brainId });
    // No routing rules: a provider-folder policy refuses as unproven, since nothing here knows what a conversation was shown.
    const consent = createApifyConsent({ authority, policy: governanceApifyConsentPolicy(options.root), meter, state: ledgerConsentState(() => store),
      ...(options.profiles ? { profiles: options.profiles } : {}), now });
    const runs = createApifyRuns({ authority, consent, ledger: () => store, policy: runPolicy, brain_id: brainId,
      ...(options.profiles ? { profiles: options.profiles } : {}),
      ...(options.waitSeconds !== undefined ? { waitSeconds: options.waitSeconds } : {}), ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}), now });
    built = { authority, runs, consent };
    return built;
  }

  return {
    async call(operation, input, callOptions = {}) {
      const session = callOptions.session ?? "default";
      if (!SESSION.test(session)) throw new TypeError("A session name is 1 to 64 letters, digits, dots, dashes or underscores.");
      // Provider enablement is decided first, as on the server: a disabled provider opens nothing.
      const policy = enablement();
      if (!policy.valid || !policy.enabled) {
        return { ok: false, operation, error: { code: "provider_disabled", reason: policy.valid ? "not_enabled" : "policy_invalid",
          message: policy.valid ? "Apify is disabled. Set apify.enabled: true in context/policies/governance.md to enable it."
            : "Apify is disabled because context/policies/governance.md is invalid. Repair it (brain policy check) before using Apify." } };
      }
      let service: ReturnType<typeof services>;
      try { service = services(); }
      catch (error) {
        const refusal = apifyRefusal(operation, error instanceof ApifyLedgerUnavailable || error instanceof ApifyOperationRefusal ? error : new ApifyLedgerUnavailable());
        return refusal!;
      }
      const day = new Date(utcDay(now())).toISOString().slice(0, 10);
      const context: ApifyCallContext = {
        principal_id: APIFY_LOCAL_PRINCIPAL, session_id: `standalone:${session}`, turn_id: `standalone:${session}:${day}`,
        posture: "interactive", approvals: null, untrusted: () => undefined,
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      };
      return callApifyOperation(service, context, operation, input);
    },
    status: () => services().authority.status({ refresh: true }),
    confirmAccount: accountId => services().authority.confirmAccount(accountId),
    close() { ledger?.close(); ledger = undefined; built = undefined; },
  };
}
