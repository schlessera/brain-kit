/**
 * What the server knows about the agent runtime it drives (#211,
 * docs/decisions/claude-code-runtime.md, "The server knows the version").
 *
 * Three sources, kept apart because they answer different questions: what the
 * boot probe found (the binary a turn WOULD spawn), what the last turn
 * reported (the binary that DID run, the credential it selected, the billing
 * mode that implies), and the last authentication failure, so an operator is
 * told to log in again before the next turn fails the same way. Served behind
 * the auth guard on `/api/status`; the per-run half is also on each run's
 * root span.
 */
import type { BackendActivityEvent, BackendRuntimeReport } from "@schlessera/brain-ui-sdk/server";

type RuntimeObserved = Extract<BackendActivityEvent, { kind: "runtime_observed" }>;
type AuthFailure = Extract<BackendActivityEvent, { kind: "auth_failure" }>;

export interface RuntimeStatusSnapshot {
  /** One entry per backend whose runtime was probed at boot. */
  boot: Array<{ backendId: string } & BackendRuntimeReport>;
  /** The last turn's own report. */
  lastObserved?: Omit<RuntimeObserved, "kind"> & { runId: string; at: string };
  /** The last turn that failed to authenticate. */
  lastAuthFailure?: Omit<AuthFailure, "kind"> & { runId: string; at: string };
}

export interface RuntimeStatus {
  setBoot(probes: Array<{ backendId: string; report: BackendRuntimeReport }>): void;
  observe(event: RuntimeObserved, runId: string): void;
  authFailure(event: AuthFailure, runId: string): void;
  snapshot(): RuntimeStatusSnapshot;
}

export function createRuntimeStatus(now: () => Date = () => new Date()): RuntimeStatus {
  let boot: RuntimeStatusSnapshot["boot"] = [];
  let lastObserved: RuntimeStatusSnapshot["lastObserved"];
  let lastAuthFailure: RuntimeStatusSnapshot["lastAuthFailure"];
  return {
    setBoot(probes) {
      boot = probes.map(({ backendId, report }) => ({ backendId, ...report }));
    },
    observe({ kind: _kind, ...event }, runId) {
      lastObserved = { ...event, runId, at: now().toISOString() };
    },
    authFailure({ kind: _kind, ...event }, runId) {
      lastAuthFailure = { ...event, runId, at: now().toISOString() };
    },
    snapshot() {
      return {
        boot,
        ...(lastObserved ? { lastObserved } : {}),
        ...(lastAuthFailure ? { lastAuthFailure } : {}),
      };
    },
  };
}
