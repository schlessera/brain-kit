import { FIRST_PARTY_FAILURE_CLASSES } from "@schlessera/brain-ui-sdk/protocol";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import type { BackendActivityEvent, StartTurnRequest, TurnFailure } from "@schlessera/brain-ui-sdk/server";
import { createLimitTracker, limitFailureMessage, type WorkerLimitReport } from "@schlessera/brain-ui-sdk/internal";

import type { BackendLogFn } from "./options.js";
import type { InferenceProfile } from "./profiles.js";
import { installedAgentSdkVersion, isMeasuredRuntime } from "./runtime-probe.js";
import { credentialFields, observedBilling } from "./subscription.js";
import type { TurnRefusal } from "./turn-terminal.js";

export type ReportActivity = (event: BackendActivityEvent) => void;

/** The turn's activity sink: observability must not break the observed turn. */
export function turnActivityReporter(bridge: StartTurnRequest["bridge"]): ReportActivity {
  return (event) => {
    try {
      bridge.activity?.(event);
    } catch {
      // Observability must not break the observed turn.
    }
  };
}

/**
 * What ran, the credential it selected, and whether that honours the
 * profile (#211). Checked against the profile's POLICY — a profile without
 * its own credential requires the subscription — not against
 * `classifyBilling`, since the two could regress together.
 */
export function reportTurnRuntime(
  inputs: { profile: Pick<InferenceProfile, "id" | "billing">; log: BackendLogFn; reportActivity: ReportActivity },
  claudeCodeVersion: string | undefined,
  apiKeySource: string | undefined,
  selected: AccountInfo | undefined
): void {
  const { profile } = inputs;
  const billing = observedBilling(selected, apiKeySource);
  const policy = profile.billing === "api" ? "api" : "subscription";
  const agentSdk = installedAgentSdkVersion();
  // Any disagreement: a declared API profile that ran on something else
  // lost its own credential, and the CLI picked another one.
  const policyViolation =
    billing === policy
      ? undefined
      : `${policy === "api" ? "a profile declared as API-billed" : "a profile without its own credential"} ran on ${
          billing === "api"
            ? "an API credential"
            : billing === "subscription"
              ? "a subscription"
              : "a credential that is not a recognised subscription"
        }`;
  if (policyViolation) {
    inputs.log("warn", "billing policy violated", {
      "profile.id": profile.id,
      "billing.observed": billing,
      reason: policyViolation,
    });
  }
  inputs.reportActivity({
    kind: "runtime_observed",
    ...(claudeCodeVersion ? { runtime: { name: "claude-code", version: claudeCodeVersion } } : {}),
    sdk: { name: "@anthropic-ai/claude-agent-sdk", version: agentSdk },
    credential: credentialFields(selected, apiKeySource),
    billing,
    policy,
    ...(policyViolation ? { policyViolation } : {}),
    measured: isMeasuredRuntime(claudeCodeVersion, agentSdk),
  });
}

/**
 * The host resource limits the turn's worker hit (#1660). Each new hit is
 * reported next to the tool step that caused it; a limit that ended the
 * worker becomes the turn's failure, with the limit named.
 */
export class WorkerLimitReporter {
  /** Bound once the SDK turn is built. */
  limits: { current(): WorkerLimitReport; settled(): Promise<WorkerLimitReport> } | undefined;
  readonly #fresh = createLimitTracker();
  readonly #reportActivity: ReportActivity;

  constructor(reportActivity: ReportActivity) {
    this.#reportActivity = reportActivity;
  }

  report(report: WorkerLimitReport): void {
    const fresh = this.#fresh(report);
    if (fresh.length) this.#reportActivity({ kind: "resource_limit", limits: fresh, fatal: false });
  }

  /** Report the hits so far, when the worker reports any. */
  reportCurrent(): void {
    if (this.limits) this.report(this.limits.current());
  }

  /** The turn's failure when a limit ended its worker, once the worker has exited. */
  async failure(): Promise<(TurnRefusal & { failure: TurnFailure }) | null> {
    if (!this.limits) return null;
    const report = await this.limits.settled();
    if (!report.fatal) { this.report(report); return null; }
    this.#reportActivity({ kind: "resource_limit", limits: report.hits, fatal: true });
    const message = limitFailureMessage(report.hits);
    return { code: "WORKER_RESOURCE_LIMIT", message,
      failure: { errorClass: FIRST_PARTY_FAILURE_CLASSES.worker_resource_limit, message } };
  }
}
