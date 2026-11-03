import { FIRST_PARTY_FAILURE_CLASSES } from "@schlessera/brain-ui-sdk/protocol";
import type { AccountInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionAuthAction } from "@schlessera/brain-ui-sdk/server";
import { VERSION_PROBE_TIMEOUT_MS } from "@schlessera/brain-ui-sdk/internal";

import type { BackendLogFn } from "./options.js";
import type { ClaudeSdkTurn } from "./sdk-options.js";
import {
  settingsRefusal,
  subscriptionRefusalMessage,
  subscriptionVerdict,
  type CliSettingsReport,
} from "./subscription.js";
import type { ReportActivity } from "./turn-reporting.js";
import type { TurnInferenceRelay } from "./turn-inference-relay.js";
import type { TurnTerminal } from "./turn-terminal.js";
import type { claudeRuntimeRequirements } from "./version-requirements.js";

export interface PromptGateInputs {
  /** The SDK query, once `query()` has been called. */
  queryHandle: Promise<Query>;
  /** The CLI's one initialization handshake, shared with the per-turn report. */
  initialize(cli: Query): ReturnType<Query["initializationResult"]>;
  sdkTurn: Pick<ClaudeSdkTurn, "subscriptionOnly" | "pinnedSettingsEnv">;
  /** The turn's relay, when its host prepared egress for it. */
  relay: TurnInferenceRelay | undefined;
  terminal: TurnTerminal;
  runtimeRequirements: ReturnType<typeof claudeRuntimeRequirements>;
  phase: string;
  abortController: AbortController;
  profileId: string;
  log: BackendLogFn;
  reportActivity: ReportActivity;
  reportRuntime(claudeCodeVersion: string | undefined, apiKeySource: string | undefined, selected: AccountInfo | undefined): void;
}

/**
 * The check the gated prompt runs exactly when the SDK asks for the first
 * message: subscription policy, constrained runtime startup and the prepared
 * inference transport. The earlier version probe identifies the selected
 * executable; this gate waits for initialization before any user input can
 * reach the model. A refusal records why on the terminal and withholds the
 * prompt.
 */
export function promptGateCheck(inputs: PromptGateInputs): () => Promise<boolean> {
  const { sdkTurn, relay, terminal, runtimeRequirements, abortController } = inputs;
  const refuseSubscription = (reason: string): false => {
    const message = subscriptionRefusalMessage(reason);
    terminal.refused = {
      code: "CLAUDE_AUTH",
      message,
      failure: {
        errorClass: FIRST_PARTY_FAILURE_CLASSES.subscription_required,
        message,
        authAction: subscriptionAuthAction("subscription_required"),
      },
    };
    inputs.reportActivity({ kind: "auth_failure", errorClass: FIRST_PARTY_FAILURE_CLASSES.subscription_required, message: reason });
    inputs.log("warn", "subscription check refused the turn", {
      "profile.id": inputs.profileId,
      reason,
    });
    return terminal.withhold();
  };
  const refuseTransport = (reason: string): false => {
    const message = `Claude inference transport refused: ${reason}.`;
    terminal.refused = { code: "CLAUDE_ERROR", message, failure: { errorClass: FIRST_PARTY_FAILURE_CLASSES.auth_failure, message } };
    inputs.reportActivity({ kind: "auth_failure", errorClass: FIRST_PARTY_FAILURE_CLASSES.auth_failure, message: reason });
    inputs.log("warn", "inference transport check refused the turn", { "profile.id": inputs.profileId, reason });
    return terminal.withhold();
  };
  return async () => {
    const cli = await inputs.queryHandle;
    let account: AccountInfo | undefined;
    let settings: CliSettingsReport | undefined;
    try {
      const check = async () => {
        account = (await inputs.initialize(cli)).account;
        if (!sdkTurn.subscriptionOnly && !relay?.egress) return;
        // Not on the public Query type; the SDK sends the CLI's own
        // `get_settings` control request. Absent means unreadable,
        // which refuses below.
        const getSettings = (cli as { getSettings?: () => Promise<CliSettingsReport> }).getSettings;
        settings = getSettings ? await getSettings.call(cli) : undefined;
      };
      if (runtimeRequirements.length) await startupDeadline(check(), abortController.signal);
      else await check();
    } catch (error) {
      // A handshake the host cancelled is a cancelled turn, not a failed one.
      if (abortController.signal.aborted) return terminal.withhold();
      terminal.refused = {
        code: "CLAUDE_ERROR",
        message: `@schlessera/brain-backend-claude runtime (claude-code) during ${inputs.phase}; requirements: ${runtimeRequirements.map(req => `${req.owner} minimum ${req.declaration}`).join("; ") || "subscription handshake"}; detected startup unknown. Claude Code did not complete its handshake: ${error instanceof Error ? error.message : String(error)}. Install/select a compatible executable that completes SDK initialization.`,
      };
      return terminal.withhold();
    }
    if (abortController.signal.aborted) return terminal.withhold();
    if (sdkTurn.subscriptionOnly) {
      const verdict = subscriptionVerdict(account);
      const conflict = verdict.ok ? settingsRefusal(settings, sdkTurn.pinnedSettingsEnv) : null;
      if (!verdict.ok || conflict) {
        // The CLI never reaches init, so this is the only report the
        // refused turn gets: what the handshake said it would bill.
        inputs.reportRuntime(undefined, account?.apiKeySource, account);
        return refuseSubscription(verdict.ok ? conflict! : verdict.reason);
      }
    }
    if (relay?.egress) {
      // An API-billed turn is not a subscription refusal: name the transport instead.
      const refuse = sdkTurn.subscriptionOnly ? refuseSubscription : refuseTransport;
      const reason = relay.qualify(settings, sdkTurn.subscriptionOnly, sdkTurn.pinnedSettingsEnv);
      if (reason !== undefined) return refuse(reason);
    }
    return true;
  };
}

/** Startup settlement is bounded even if an injected/older SDK ignores abort. */
export async function startupDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`SDK startup timed out after ${VERSION_PROBE_TIMEOUT_MS / 1000} s`)), VERSION_PROBE_TIMEOUT_MS);
        onAbort = () => reject(signal.reason ?? new Error("SDK startup cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The turn's prompt as a stream the SDK pulls from, released only if `check`
 * passes. A string prompt becomes the single user message the SDK would have
 * built from it.
 */
export async function* gatedPrompt(
  prompt: string | AsyncIterable<SDKUserMessage>,
  check: () => Promise<boolean>
): AsyncIterable<SDKUserMessage> {
  if (!(await check())) return;
  if (typeof prompt !== "string") {
    yield* prompt;
    return;
  }
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: prompt },
    session_id: "",
  };
}
