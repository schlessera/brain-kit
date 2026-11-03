/**
 * The one dispatcher behind every Apify front door (#3162): `brain apify`,
 * the core MCP server's `brain_apify_*` tools and both chat backends' bridge
 * tools. Each validates against the shared strict schema
 * (`@schlessera/brain-common/internal/apify-operations`) and reaches the same
 * consent, reservation and request functions here, so no transport carries a
 * second billing, consent or account path.
 *
 * What comes back is the model view only: candidate summaries, inspected
 * facts marked untrusted, a proposal and its review, a run's lifecycle state,
 * one bounded page of results, an abort outcome. Accounting, grants and
 * provenance stay with the host ({@link ApifyRuns.accounting},
 * {@link ApifyRuns.coverage}). A refusal keeps its stable code and its fixed
 * message; nothing upstream-written or secret-bearing reaches an envelope.
 */
import {
  APIFY_INPUT_SCHEMAS, type ApifyEnvelope, type ApifyErrorCode, type ApifyOperation,
} from "../apify-operations.js";
import { ApifyAuthorityError } from "./authority.js";
import { ApifyConsentError, ApifyInputError, type ApifyCallContext, type ApifyConsent } from "./consent.js";
import { ApifyLedgerRefusal, ApifyLedgerUnavailable } from "./ledger.js";
import { ApifyRunError, type ApifyRuns } from "./runs.js";

/** The consent and run services one host built for its callers. */
export interface ApifyServices {
  consent: ApifyConsent;
  runs: ApifyRuns;
}

/** A refusal raised outside the services themselves, with a contract code. */
export class ApifyOperationRefusal extends Error {
  constructor(readonly code: ApifyErrorCode, readonly reason: string | null, message: string) {
    super(message);
    this.name = "ApifyOperationRefusal";
  }
}

/** The envelope a refusal becomes, or null for an error no contract code covers. */
export function apifyRefusal(operation: ApifyOperation, error: unknown): Extract<ApifyEnvelope, { ok: false }> | null {
  const refused = (code: ApifyErrorCode, reason: string | null, message: string) => ({ ok: false as const, operation, error: { code, reason, message } });
  if (error instanceof ApifyOperationRefusal || error instanceof ApifyConsentError || error instanceof ApifyRunError || error instanceof ApifyLedgerRefusal)
    return refused(error.code, error.reason, error.message);
  // `provider_unavailable` is the additive code for an API that could not be reached or verified.
  if (error instanceof ApifyAuthorityError) return refused(error.code, error.reason, error.message);
  if (error instanceof ApifyLedgerUnavailable)
    return refused("accounting_unavailable", "ledger", "Apify accounting is unavailable, so no paid Apify work was admitted.");
  // Our own schema checks: fixed text naming the field, never upstream text.
  if (error instanceof ApifyInputError) return refused("invalid_input", null, error.message);
  return null;
}

/**
 * Validate one operation's input and run it. Every refusal becomes an
 * envelope; anything else is a host failure and is thrown with a fixed
 * message, the original kept only as its cause.
 */
export async function callApifyOperation(services: ApifyServices, context: ApifyCallContext, operation: ApifyOperation, input: unknown): Promise<ApifyEnvelope> {
  const schema = APIFY_INPUT_SCHEMAS[operation];
  if (!schema) throw new TypeError("Unknown Apify operation.");
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ").slice(0, 500);
    return { ok: false, operation, error: { code: "invalid_input", reason: null, message } };
  }
  const value = parsed.data as Record<string, unknown>;
  try {
    const data = await dispatch(services, context, operation, value);
    return { ok: true, operation, data };
  } catch (error) {
    const refusal = apifyRefusal(operation, error);
    if (refusal) return refusal;
    throw new Error("The Apify operation failed unexpectedly; nothing further was done.", { cause: error });
  }
}

function dispatch(services: ApifyServices, context: ApifyCallContext, operation: ApifyOperation, input: Record<string, unknown>): Promise<unknown> {
  switch (operation) {
    case "discover": return services.consent.discover(context, input as { query: string; limit?: number });
    case "inspect": return services.consent.inspect(context, input as { candidate: string });
    case "prepare": return services.consent.prepare(context, input as { candidate: string; input: unknown; max_charge_usd: number });
    case "run": return services.runs.run(context, input as { proposal: string });
    case "status": return services.runs.status(context, input as { run: string });
    case "results": return services.runs.results(context, input as { run: string; cursor?: string; limit?: number });
    case "abort": return services.runs.abort(context, input as { run: string });
  }
}
