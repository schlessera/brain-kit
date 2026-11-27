/**
 * How a gog process's end becomes a coded error (plan §8; gog's
 * `automation.exit_codes`, which the pin checks against the snapshot).
 *
 * stderr and gog's JSON error envelope never reach the model: only a code, a
 * short machine reason and a fixed message. A write that may have reached
 * Google before it failed is `outcome_unknown` and is never retried; a write
 * that gog says Google refused retains its final refusal code here. A send
 * factory must account for gog-internal retries before inferring non-delivery.
 */
import type { GoogleError, GoogleErrorCode } from "../catalog.js";

/** gog v0.48.1's exit codes, by the class name gog gives each. */
export const GOG_EXIT_CODES = Object.freeze({
  ok: 0, error: 1, usage: 2, empty_results: 3, auth_required: 4, not_found: 5, permission_denied: 6,
  rate_limited: 7, retryable: 8, config: 10, orphaned: 11, cancelled: 130,
} as const);
export type GogExitClass = keyof typeof GOG_EXIT_CODES;

const MESSAGES: Readonly<Record<GoogleErrorCode, string>> = Object.freeze({
  invalid_input: "The input was refused.",
  unavailable: "Google is not available on this host right now.",
  policy_denied: "The governance policy does not allow this.",
  approval_declined: "The owner declined this.",
  not_found: "Google has no such item, or it is not visible.",
  forbidden: "Google refused this for the connected account.",
  rate_limited: "Google is rate limiting the connected account; try again later.",
  upstream_error: "Google did not answer this read; try again later.",
  draft_not_displayable: "This draft cannot be shown in full, so it cannot be sent from here.",
  already_sent: "These exact draft bytes have already been sent.",
  draft_locked: "This draft is waiting on an open send card.",
  recording_unavailable: "The decision could not be recorded, so nothing ran.",
  transport_incompatible: "The Google transport is not the pinned gog release or answered in a shape brain-kit does not read.",
  outcome_unknown: "The write may or may not have happened at Google; check before trying again.",
});

export function gogError(code: GoogleErrorCode, reason: string | null): GoogleError {
  return { code, reason, message: MESSAGES[code] };
}

/**
 * The code/reason pairs proven to end gog before any request reached Google.
 * `spawn_failed` is caught before a child exists (`runGogProcess`,
 * `packages/common/src/google/gog/runner.ts:94-108`). At gog 44364d31 a
 * missing credentials file is exit 10 before any HTTP (`GmailSendCmd.runRaw`,
 * `internal/cmd/gmail_send.go:259-292`; `stableExitCode`,
 * `internal/cmd/exit_codes.go:54-126`). Exit 2 is not here: gog's usage
 * errors are pre-request, but the Go runtime also exits 2 on an unrecovered
 * panic or fatal error, which can follow a request (gog re-panics,
 * `executeWithRuntime`, `internal/cmd/root.go:125-175`).
 */
export const GOG_PRE_REQUEST_FAILURES: readonly string[] = Object.freeze(["transport_incompatible/spawn_failed", "unavailable/config"]);

/** Whether this error is one of `GOG_PRE_REQUEST_FAILURES`: nothing reached Google. */
export function isGogPreRequestFailure(error: Pick<GoogleError, "code" | "reason">): boolean {
  return GOG_PRE_REQUEST_FAILURES.includes(`${error.code}/${error.reason}`);
}

export type GogEffect = "read" | "write";

/** How one process ended, as the runner observed it. */
export type GogProcessEnd =
  | { kind: "exit"; exitCode: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout" }
  | { kind: "output_too_large" }
  | { kind: "spawn_failed" };

/**
 * The error for a process that did not end with exit 0, or null for exit 0.
 * Exit `8` on a read is `upstream_error`; the transport retries a read once
 * before answering it. Nothing here retries.
 */
export function gogProcessError(end: GogProcessEnd, effect: GogEffect): GoogleError | null {
  const write = effect === "write";
  switch (end.kind) {
    case "spawn_failed": return gogError("transport_incompatible", "spawn_failed");
    case "timeout": return write ? gogError("outcome_unknown", "timeout") : gogError("upstream_error", "timeout");
    case "output_too_large": return write ? gogError("outcome_unknown", "output_too_large") : gogError("transport_incompatible", "output_too_large");
    case "signal": return write ? gogError("outcome_unknown", "signal") : gogError("upstream_error", "signal");
    case "exit": break;
  }
  switch (end.exitCode) {
    case GOG_EXIT_CODES.ok: return null;
    case GOG_EXIT_CODES.error: return write ? gogError("outcome_unknown", "error") : gogError("upstream_error", "error");
    // A usage error is argv this gog does not accept, including a --readonly,
    // --gmail-no-send or --enable-commands-exact refusal: a transport bug.
    case GOG_EXIT_CODES.usage: return gogError("transport_incompatible", "usage");
    // Never asked for (no --fail-empty), so unexpected.
    case GOG_EXIT_CODES.empty_results: return gogError("transport_incompatible", "empty_results");
    case GOG_EXIT_CODES.auth_required: return gogError("unavailable", "auth_required");
    case GOG_EXIT_CODES.not_found: return gogError("not_found", null);
    case GOG_EXIT_CODES.permission_denied: return gogError("forbidden", null);
    case GOG_EXIT_CODES.rate_limited: return gogError("rate_limited", null);
    case GOG_EXIT_CODES.retryable: return write ? gogError("outcome_unknown", "retryable") : gogError("upstream_error", "retryable");
    case GOG_EXIT_CODES.config: return gogError("unavailable", "config");
    // gog uses it for orphaned Docs anchors only; no Gmail command should.
    case GOG_EXIT_CODES.orphaned: return gogError("transport_incompatible", "orphaned");
    case GOG_EXIT_CODES.cancelled: return write ? gogError("outcome_unknown", "cancelled") : gogError("upstream_error", "cancelled");
    default: return write ? gogError("outcome_unknown", "unknown_exit") : gogError("transport_incompatible", "unknown_exit");
  }
}
