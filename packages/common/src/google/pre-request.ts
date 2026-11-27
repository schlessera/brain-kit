/**
 * The code/reason pairs proven to end gog before any request reached Google
 * (#4214). It lives outside `gog/` so the approvals ledger can release a send
 * reservation on it without importing the transport; the transport exposes
 * it as `GOG_PRE_REQUEST_FAILURES` (`gog/errors.ts`).
 *
 * `spawn_failed` is caught before a child exists (`runGogProcess`,
 * `packages/common/src/google/gog/runner.ts:94-108`). At gog 44364d31 a
 * missing credentials file is exit 10 before any HTTP (`GmailSendCmd.runRaw`,
 * `internal/cmd/gmail_send.go:259-292`; `stableExitCode`,
 * `internal/cmd/exit_codes.go:54-126`). Exit 2 is not here: gog's usage
 * errors are pre-request, but the Go runtime also exits 2 on an unrecovered
 * panic or fatal error, which can follow a request (gog re-panics,
 * `executeWithRuntime`, `internal/cmd/root.go:125-175`).
 */
export const PRE_REQUEST_FAILURES: readonly string[] = Object.freeze(["transport_incompatible/spawn_failed", "unavailable/config"]);
