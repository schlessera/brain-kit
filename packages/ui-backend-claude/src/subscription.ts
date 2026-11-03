/**
 * A Claude profile with no credential of its own runs on the subscription or
 * not at all (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * The CLI does not make that easy. With `CLAUDE_CODE_OAUTH_TOKEN` and
 * `ANTHROPIC_API_KEY` both in its environment it sends only the API key, and
 * nothing warns. Clearing the variables is not enough either: it also takes a
 * key from an `apiKeyHelper` in settings, from a settings file's `env` block,
 * from `ANTHROPIC_CUSTOM_HEADERS`, or from a stored Console login. So a
 * subscription turn has four parts:
 *
 * 1. the credential variables are cleared ({@link CLEARED_API_CREDENTIALS});
 * 2. flag settings override the project and user settings files: an empty
 *    `apiKeyHelper`, and the same variables cleared in `env`
 *    ({@link NEUTRALISED_SETTINGS});
 * 3. the account the CLI selected, read from the `initialize` handshake, is
 *    checked ({@link subscriptionVerdict});
 * 4. the settings the CLI merged — including the policy tiers that outrank
 *    flag settings — are checked for a helper or a credential
 *    ({@link settingsRefusal}).
 *
 * The prompt is released only after 3 and 4 pass. A helper that has not
 * produced its key yet is invisible to 3, so 4 refuses a configured helper
 * outright.
 */
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  OAUTH_TOKEN_SOURCES,
  SUBSCRIPTION_TIERS,
} from "@schlessera/brain-common/internal/claude-subscription";

// The guard itself — parts 1 to 4 above — lives once in brain-common, shared
// with core's CLI runner. What stays here is the backend's own reading of the
// account: the operator message, the SDK error classes and observed billing.
export {
  CLEARED_API_CREDENTIALS,
  type CliSettingsReport,
  NEUTRALISED_SETTINGS,
  settingsRefusal,
  type SubscriptionVerdict,
  subscriptionVerdict,
} from "@schlessera/brain-common/internal/claude-subscription";

/** What an operator is told when a subscription turn is refused. */
export function subscriptionRefusalMessage(reason: string): string {
  return (
    `Claude subscription authentication required: ${reason}. ` +
    "Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and restart, " +
    "or declare a profile with its own apiKeyEnv to bill an API key on purpose."
  );
}

/** The SDK's assistant-error classes that mean the account could not be used. */
export const AUTH_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
]);

/** API-key sources, as `apiKeySource` names them. */
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

/**
 * The billing mode the credential the CLI selected implies (#211).
 *
 * Observed, not classified: this reads what the runtime reported, and it is
 * compared with the profile's policy, not with `classifyBilling` — both of
 * those can regress together. `apiKeySource` alone is not enough, because it
 * also reads `none` when nothing is logged in.
 */
export function observedBilling(
  account: AccountInfo | undefined,
  apiKeySource?: string
): "subscription" | "api" | "unknown" {
  const keySource = apiKeySource ?? account?.apiKeySource;
  if (account?.apiProvider !== undefined && account.apiProvider !== "firstParty") return "api";
  if (keySource !== undefined && keySource !== "none") {
    return API_KEY_SOURCES.has(keySource) ? "api" : "unknown";
  }
  if (account?.tokenSource !== undefined && OAUTH_TOKEN_SOURCES.has(account.tokenSource)) return "subscription";
  // A declared bearer profile: billed through the route it declares, whatever
  // stored login also exists.
  if (account?.tokenSource === "ANTHROPIC_AUTH_TOKEN") return "api";
  if (account?.subscriptionType !== undefined && SUBSCRIPTION_TIERS.has(account.subscriptionType)) {
    return "subscription";
  }
  return "unknown";
}

/** The account fields worth keeping on a run, in the runtime's own names. */
export function credentialFields(account: AccountInfo | undefined, apiKeySource?: string): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    apiKeySource: apiKeySource ?? account?.apiKeySource,
    tokenSource: account?.tokenSource,
    subscriptionType: account?.subscriptionType,
    apiProvider: account?.apiProvider,
  };
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}
