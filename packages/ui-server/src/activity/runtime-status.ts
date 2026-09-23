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
import {
  SUBSCRIPTION_AUTH_INSTRUCTIONS,
  subscriptionAuthAction,
  type BackendActivityEvent,
  type BackendRuntimeReport,
  type BillingMode,
  type SubscriptionAuthAction,
} from "@schlessera/brain-ui-sdk/server";

import type { Logger } from "@opentelemetry/api-logs";

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

export interface RuntimeStatusSnapshot {
  /** One entry per backend whose runtime was probed at boot. */
  boot: Array<{ backendId: string } & BackendRuntimeReport>;
  /** The last turn's own report. */
  lastObserved?: Omit<RuntimeObserved, "kind"> & { runId: string; at: string };
  /** The last turn that failed to authenticate. */
  lastAuthFailure?: RecordedAuthFailure;
}

export interface RuntimeStatus {
  setBoot(probes: Array<{ backendId: string; report: BackendRuntimeReport }>): void;
  observe(event: RuntimeObserved, runId: string): void;
  /** `policy` is what the run's profile requires, when the runtime reported it. */
  authFailure(event: AuthFailure, runId: string, policy?: BillingMode): void;
  /** The last auth failure of a turn that ran on the subscription. */
  subscriptionAuthFailure(): (RecordedAuthFailure & { action: SubscriptionAuthAction }) | undefined;
  snapshot(): RuntimeStatusSnapshot;
}

// Tokens and keys look like this; a runtime message that quotes one must not
// carry it onto /api/status or into the log.
const CREDENTIAL = /\bsk-ant-[A-Za-z0-9_-]+|\bBearer\s+\S+/gi;

/** `text` with anything shaped like a credential replaced. */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL, "[redacted]");
}

/**
 * `log`, when given, receives one WARN per auth failure carrying the
 * instruction for it, so the log says what `/api/status` says.
 */
export function createRuntimeStatus(now: () => Date = () => new Date(), log?: Logger): RuntimeStatus {
  let boot: RuntimeStatusSnapshot["boot"] = [];
  let lastObserved: RuntimeStatusSnapshot["lastObserved"];
  let lastAuthFailure: RecordedAuthFailure | undefined;
  let lastSubscriptionFailure: (RecordedAuthFailure & { action: SubscriptionAuthAction }) | undefined;
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
    snapshot() {
      return {
        boot,
        ...(lastObserved ? { lastObserved } : {}),
        ...(lastAuthFailure ? { lastAuthFailure } : {}),
      };
    },
  };
}
