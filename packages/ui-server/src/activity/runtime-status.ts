/**
 * What the server knows about the agent runtime it drives (#211,
 * docs/decisions/claude-code-runtime.md, "The server knows the version").
 *
 * The worker host entry (#1632) is a fourth: whether the latest real probe
 * could establish the agent worker boundary.
 *
 * Three sources, kept apart because they answer different questions: what the
 * boot probe found (the binary a turn WOULD spawn), what the last turn
 * reported (the binary that DID run, the credential it selected, the billing
 * mode that implies), and the last authentication failure, so an operator is
 * told to log in again before the next turn fails the same way. Served behind
 * the auth guard on `/api/status`; the per-run half is also on each run's
 * root span.
 */
import {
  SUBSCRIPTION_AUTH_INSTRUCTIONS,
  subscriptionAuthAction,
  type BackendActivityEvent,
  type BackendRuntimeReport,
  type BillingMode,
  type SubscriptionAuthAction,
} from "@schlessera/brain-ui-sdk/server";
import type { WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";
import type { WorkerHostCheck, WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";

import type { Logger } from "@opentelemetry/api-logs";

import type { SyncRuntimeStatus } from "./sync-runtime.js";

type RuntimeObserved = Extract<BackendActivityEvent, { kind: "runtime_observed" }>;
type AuthFailure = Extract<BackendActivityEvent, { kind: "auth_failure" }>;

/** An auth failure as the status reports it: the runtime's text, with any credential redacted. */
export type RecordedAuthFailure = Omit<AuthFailure, "kind"> & {
  runId: string;
  at: string;
  /**
   * What the operator does about it (#254). Only a turn that ran on the
   * subscription has one: a profile with its own credential is not fixed by
   * a new subscription token.
   */
  action?: SubscriptionAuthAction;
  /** Set when the turn's profile declares its own API credential. */
  policy?: BillingMode;
};

/**
 * Which envelope a worker host probe established (#1632): the ordinary one
 * every chat, voice and handoff turn needs, or the restricted one an
 * autonomous turn needs.
 */
export type WorkerHostMode = "ordinary" | "restricted";

export interface RuntimeStatusSnapshot {
  /** One entry per backend whose runtime was probed at boot. */
  boot: Array<{ backendId: string } & BackendRuntimeReport>;
  /**
   * Whether this host can run the agent worker boundary (#1632): probed at
   * boot, then re-recorded by every turn's own probe and every explicit
   * check, so it is always the latest real probe. Absent until one has run.
   */
  workerHost?: WorkerHostStatus;
  /** The last turn's own report. */
  lastObserved?: Omit<RuntimeObserved, "kind"> & { runId: string; at: string };
  /** The last turn that failed to authenticate. */
  lastAuthFailure?: RecordedAuthFailure;
  /**
   * What scheduled `brain sync` runs recorded (#290), read from the activity
   * store because the container cron wrapper is another process. Set by the
   * status route, not by this module.
   */
  sync?: SyncRuntimeStatus;
}

export interface RuntimeStatus {
  setBoot(probes: Array<{ backendId: string; report: BackendRuntimeReport }>): void;
  observe(event: RuntimeObserved, runId: string): void;
  /** `policy` is what the run's profile requires, when the runtime reported it. */
  authFailure(event: AuthFailure, runId: string, policy?: BillingMode): void;
  /** The last auth failure of a turn that ran on the subscription. */
  subscriptionAuthFailure(): (RecordedAuthFailure & { action: SubscriptionAuthAction }) | undefined;
  /** A turn that ran on the subscription succeeded, and ended at `at`. */
  subscriptionProven(at: number): void;
  /**
   * Records a real worker host probe's outcome (#1632). Logs the first
   * outcome per mode and each change after it, never a repeat.
   */
  recordWorkerHost(mode: WorkerHostMode, probe: WorkerHostProbe, trigger: WorkerHostCheck["trigger"]): void;
  /**
   * The server runs as uid 0 (#1638): logs `warning` once and keeps it on
   * the worker host status for as long as the process lives.
   */
  recordRootServer(warning: string): void;
  snapshot(): RuntimeStatusSnapshot;
}

// Tokens and keys look like this — any `sk-` key (Anthropic, OpenRouter,
// OpenAI), a bearer or key header, or any long opaque run of token
// characters; a runtime message that quotes one must not carry it onto
// /api/status or into the log. Over-redacting a request id costs nothing.
const CREDENTIAL = /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|\bx-api-key:\s*\S+|[A-Za-z0-9_-]{32,}/gi;

/** `text` with anything shaped like a credential replaced. */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL, "[redacted]");
}

/**
 * `log`, when given, receives one WARN per auth failure carrying the
 * instruction for it, so the log says what `/api/status` says. `keepProof`,
 * when given, keeps a successful subscription turn's end the moment it is
 * committed, before detail retention can prune the span it came from.
 */
export function createRuntimeStatus(
  now: () => Date = () => new Date(),
  log?: Logger,
  keepProof?: (at: number) => void
): RuntimeStatus {
  let boot: RuntimeStatusSnapshot["boot"] = [];
  let lastObserved: RuntimeStatusSnapshot["lastObserved"];
  let lastAuthFailure: RecordedAuthFailure | undefined;
  let lastSubscriptionFailure: (RecordedAuthFailure & { action: SubscriptionAuthAction }) | undefined;
  const workerHost: WorkerHostStatus = {};
  return {
    setBoot(probes) {
      boot = probes.map(({ backendId, report }) => ({ backendId, ...report }));
    },
    observe({ kind: _kind, ...event }, runId) {
      lastObserved = { ...event, runId, at: now().toISOString() };
    },
    authFailure({ kind: _kind, message, ...event }, runId, policy) {
      const recorded: RecordedAuthFailure = {
        ...event,
        ...(message ? { message: redactCredentials(message) } : {}),
        runId,
        at: now().toISOString(),
      };
      // A profile that declares its own API credential: its own key or token
      // failed, and nothing about the subscription follows from that.
      if (policy === "api") {
        lastAuthFailure = { ...recorded, policy };
        log?.emit({
          severityText: "WARN",
          body:
            `a turn on a profile with its own credential failed to authenticate (${event.errorClass}). ` +
            "Check that profile's credential; the subscription token is not involved.",
          attributes: { "run.id": runId, "failure.class": event.errorClass, "billing.policy": policy },
        });
        return;
      }
      const action = subscriptionAuthAction(event.errorClass);
      lastSubscriptionFailure = { ...recorded, action };
      lastAuthFailure = lastSubscriptionFailure;
      log?.emit({
        severityText: "WARN",
        body: `a turn failed to authenticate (${event.errorClass}). ${SUBSCRIPTION_AUTH_INSTRUCTIONS[action]}`,
        attributes: { "run.id": runId, "failure.class": event.errorClass, "auth.action": action },
      });
    },
    subscriptionAuthFailure: () => lastSubscriptionFailure,
    subscriptionProven(at) {
      keepProof?.(at);
    },
    recordWorkerHost(mode, probe, trigger) {
      const previous = workerHost[mode];
      const checkedAt = now().toISOString();
      const check: WorkerHostCheck = probe.ok
        ? { available: true, checkedAt, trigger }
        : { available: false, requirement: probe.requirement, checkedAt, trigger };
      workerHost[mode] = check;
      // Every turn re-probes; only a first answer or a changed one is news.
      const repeat = previous !== undefined && (previous.available
        ? check.available
        : !check.available && previous.requirement === check.requirement);
      if (repeat) return;
      const attributes = { "worker_host.mode": mode, "worker_host.trigger": trigger };
      log?.emit(check.available
        ? { severityText: "INFO", body: `the ${mode} agent worker boundary is available on this host`, attributes }
        : {
          severityText: "WARN",
          body: `agent turns that need the ${mode} worker boundary cannot run on this host: ${check.requirement}. ` +
            "The server keeps running and every turn checks again (docs/hosting/agent-workers.md).",
          attributes: { ...attributes, "worker_host.requirement": check.requirement },
        });
    },
    recordRootServer(warning) {
      if (workerHost.rootServer) return;
      workerHost.rootServer = { warning };
      log?.emit({ severityText: "WARN", body: warning, attributes: { "worker_host.root_server": true } });
    },
    snapshot() {
      return {
        boot,
        ...(workerHost.ordinary || workerHost.restricted || workerHost.rootServer ? { workerHost: { ...workerHost } } : {}),
        ...(lastObserved ? { lastObserved } : {}),
        ...(lastAuthFailure ? { lastAuthFailure } : {}),
      };
    },
  };
}
