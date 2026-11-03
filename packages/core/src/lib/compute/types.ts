/**
 * Host-owned external compute types: callers, the durable job record and the
 * service surface. First-party only (exported through `./internal` for the
 * CLI, MCP and hosted layers); the public seam is in ../seams.ts.
 */

import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";

import type { BrainConfig } from "../config.js";
import type { ComputeBuiltin } from "../registry.js";
import type {
  CommandHandle,
  ComputeExitReason,
  ComputeLogger,
  ComputeRefusalCode,
  JobCost,
  SandboxRef,
} from "../seams.js";

/**
 * Who asked. Supplied by the host, never by tool arguments. Jobs are
 * addressable only by the caller that started them.
 */
export type ComputeCaller =
  | { kind: "cli"; principal: string }
  | { kind: "mcp"; principal: string }
  | { kind: "hosted"; principal: string; session: string; turn: string };

export type ComputeActiveState = "admitted" | "allocating" | "staging" | "running" | "collecting" | "releasing" | "uncertain";
export type ComputeTerminalState = "succeeded" | "failed" | "cancelled" | "expired" | "abandoned";
export type ComputeJobState = ComputeActiveState | ComputeTerminalState;

export const COMPUTE_TERMINAL_STATES: readonly ComputeTerminalState[] = ["succeeded", "failed", "cancelled", "expired", "abandoned"];

export function isTerminal(state: ComputeJobState): state is ComputeTerminalState {
  return (COMPUTE_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The cleanup fact every record keeps apart from its state, so a failed
 * cleanup never reads as success. `none`: nothing was ever allocated.
 * `unknown`: an allocation may exist that the host could not locate.
 */
export type ComputeCleanupState = "none" | "pending" | "released" | "release_failed" | "retained" | "unknown";

/** Exit as reported, or `unknown` when the job ended without a known exit. */
export type ComputeJobExitReason = ComputeExitReason | "unknown";

export interface ComputeReceipt {
  at: number;
  step: "admit" | "allocate" | "find" | "stage" | "exec" | "poll" | "kill" | "collect" | "release" | "usage" | "settle" | "cancel" | "abandon" | "expire" | "reconcile";
  phase: "intent" | "outcome";
  outcome?: string;
  detail?: string;
}

export interface ComputeArtifactRecord {
  path: string;
  maxBytes: number;
  status: "pending" | "collected" | "missing" | "too_large" | "not_collected";
  bytes: number | null;
  sha256: string | null;
}

export interface ComputeOutputRecord {
  bytes: number;
  sha256: string;
}

/** Schema 1 of `jobs/<id>/job.json`. Written atomically, mode 0600. */
export interface ComputeJobRecord {
  schema: 1;
  id: string;
  brain: string;
  caller: ComputeCaller;
  instance: string;
  provider: string;
  configHash: string;
  state: ComputeJobState;
  createdAt: number;
  updatedAt: number;
  lease: { seconds: number; deadline: number; releaseAllowanceSeconds: number };
  request: {
    argv: string[];
    cwd: string | null;
    env: Record<string, string>;
    retain: boolean;
  };
  source: { files: { path: string; sha256: string; bytes: number }[]; hash: string };
  allocation: { key: string; attempts: number; sandbox: SandboxRef | null };
  command: { intentAt: number | null; handle: CommandHandle | null; startedAt: number | null };
  stageAttempts: number;
  collectAttempts: number;
  exit: { code: number | null; signal: string | null; reason: ComputeJobExitReason } | null;
  output: { stdout: ComputeOutputRecord | null; stderr: ComputeOutputRecord | null; truncated: boolean } | null;
  artifacts: ComputeArtifactRecord[];
  /** The terminal state decided before release; applied once release has an outcome. */
  outcome: { state: ComputeTerminalState; reason: string } | null;
  cleanup: {
    state: ComputeCleanupState;
    mode: "discard" | "retain";
    retainedUntil: number | null;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: number | null;
  };
  cost: JobCost;
  reservation: { usd: number | null; enforced: boolean; settled: boolean };
  cancelRequested: boolean;
  uncertain: { step: "allocate" | "exec"; reason: string } | null;
  terminal: { state: ComputeTerminalState; at: number; reason: string } | null;
  receipts: ComputeReceipt[];
}

/** What a caller sees: no sandbox or command ids, no environment values. */
export interface ComputeJobView {
  id: string;
  instance: string;
  provider: string;
  state: ComputeJobState;
  createdAt: number;
  updatedAt: number;
  lease: { seconds: number; deadline: number };
  source: { hash: string; files: number };
  exit: ComputeJobRecord["exit"];
  artifacts: { path: string; status: ComputeArtifactRecord["status"]; bytes: number | null; sha256: string | null }[];
  cleanup: { state: ComputeCleanupState; retainedUntil: number | null; lastError: string | null };
  cost: JobCost;
  cancelRequested: boolean;
  uncertain: ComputeJobRecord["uncertain"];
  terminal: ComputeJobRecord["terminal"];
  /**
   * Why this visit could not advance the job although no live process holds
   * it: its instance is unavailable, names another provider, or was
   * reconfigured since the job started. Not stored; `null` otherwise.
   */
  blocked: string | null;
  /**
   * Nothing will change the job any more (#3108): it is terminal, its
   * cleanup is final and its cost has settled against the caller's budget.
   * A job that ended but whose reservation has not settled is not settled.
   */
  settled: boolean;
}

export interface ComputeRefusal {
  ok: false;
  code: ComputeRefusalCode;
  reason: string;
}

export type ComputeJobResult = { ok: true; job: ComputeJobView } | ComputeRefusal;

export interface ComputeRunRequest {
  /** The configured instance id. No instance is a default target. */
  instance: string;
  argv: string[];
  /** Relative to the staged source root. */
  cwd?: string;
  /** Non-secret values only; credentials are refused. */
  env?: Record<string, string>;
  /** Repository-relative files to upload. Nothing else is uploaded. */
  source?: string[];
  artifacts?: { path: string; maxBytes: number }[];
  /** Defaults to the instance's `lease.maxSeconds`. */
  leaseSeconds?: number;
  /**
   * Keep the sandbox's data on release. Defaults to the instance's
   * `retainOnRelease`; `true` is refused unless the instance sets it.
   */
  retain?: boolean;
}

export interface ComputePlan {
  instance: string;
  provider: string;
  lease: { seconds: number; releaseAllowanceSeconds: number };
  source: { files: { path: string; sha256: string; bytes: number }[]; hash: string };
  artifacts: { path: string; maxBytes: number }[];
  estimate: JobCost["estimate"];
  retain: boolean;
  /** Free slots for the instance when planned; admission rechecks under its lock. */
  slots: { used: number; max: number };
}

/**
 * The host's budget ledger. `reserve` runs under the admission lock with the
 * estimate (`null` when no ceiling is configured, so only existing budget
 * blocks apply); a throw refuses with `accounting_unavailable`. `settle` runs
 * once cleanup has settled, with the actual cost or `null` when unknown.
 * Standalone has no ledger: the reservation is recorded, not enforced.
 */
export interface ComputeBudget {
  reserve(jobId: string, usd: number | null, caller: ComputeCaller): Promise<"ok" | "exceeded"> | "ok" | "exceeded";
  settle(jobId: string, actualUsd: number | null): Promise<void> | void;
}

export interface ComputeClock {
  /** Epoch milliseconds. */
  now(): number;
}

export type ComputeApproval = "approved" | "required" | "denied";

export interface ComputeServiceOptions {
  root: string;
  config?: BrainConfig | null;
  /** Host operational directory; else BRAIN_COMPUTE_STATE_DIR, else the user's state home. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  clock?: ComputeClock;
  fetch?: typeof fetch;
  budget?: ComputeBudget;
  /** The data-to-provider rules (`providers` of the effective governance policy). */
  sourcePolicy?: { providers: EffectiveGovernancePolicy["providers"] };
  /** Host approval; absent means none is required. */
  approve?: (plan: ComputePlan, caller: ComputeCaller) => Promise<ComputeApproval> | ComputeApproval;
  /**
   * The host's last word on its caller, asked under the admission lock just
   * before the slot count and budget reservation: false (or a throw) refuses
   * with `policy_denied` and nothing is reserved or recorded. A hosted turn
   * revoked or cancelled while its approval card was open is refused here.
   */
  recheck?: (caller: ComputeCaller) => Promise<boolean> | boolean;
  /** Time after the lease deadline allowed for release. Default 300. */
  releaseAllowanceSeconds?: number;
  /** Ceiling for one provider call. Default 120 000. */
  callTimeoutMs?: number;
  /** Bounded wait for the admission lock. Default 5 000. */
  lockWaitMs?: number;
  /** Cap on stored stdout and stderr each. Default 1 MiB. */
  maxOutputBytes?: number;
  log?: ComputeLogger;
  /** Built-in registry override, for tests. */
  registry?: Record<string, ComputeBuiltin>;
  /** Store fault injection, for tests. */
  storeHooks?: { beforePublish?: (path: string) => void };
}
