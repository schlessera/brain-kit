/**
 * The subscription billing guard both Claude runners share: core's CLI runner
 * (`packages/core/src/providers/agents/claude-subscription.ts`) and the chat
 * backend (`packages/ui-backend-claude/src/subscription.ts`). A Claude run
 * without a credential of its own runs on the subscription or not at all
 * (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * With `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` both in its
 * environment the CLI sends only the API key, and nothing warns. Clearing the
 * variables is not enough either: it also takes a key from an `apiKeyHelper`
 * in settings, from a settings file's `env` block, from
 * `ANTHROPIC_CUSTOM_HEADERS`, or from a stored Console login. So a run:
 *
 * 1. clears the credential variables ({@link CLEARED_API_CREDENTIALS});
 * 2. overrides the project and user settings files with flag settings: an
 *    empty `apiKeyHelper`, and the same variables cleared in `env`
 *    ({@link NEUTRALISED_SETTINGS});
 * 3. checks the account the CLI selected, read from the `initialize`
 *    handshake ({@link subscriptionVerdict});
 * 4. checks the settings the CLI merged — including the policy tiers that
 *    outrank flag settings — for a helper or a credential
 *    ({@link settingsRefusal}).
 *
 * The prompt is released only after 3 and 4 pass. A helper that has not
 * produced its key yet is invisible to 3, so 4 refuses a configured helper
 * outright. Messages, error types and runtime-specific readings stay with
 * each caller.
 */

/**
 * Set over the run's environment: an empty value is how the CLI reads "none".
 * `ANTHROPIC_CUSTOM_HEADERS` is merged after the CLI's own auth headers, so an
 * `x-api-key` or `Authorization` line in it replaces the subscription's.
 */
export const CLEARED_API_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
  // A host credential file is loaded back into the environment, custom
  // headers included, after the variables above were cleared.
  CLAUDE_CODE_HOST_CREDS_FILE: "",
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "",
  // The subscription is first-party Anthropic. Each of these routes inference
  // somewhere else, billed by someone else — and a settings file the agent
  // can write is re-read mid-session, so they are pinned off in flag settings
  // too, not only here.
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_USE_GATEWAY: "",
  CLAUDE_CODE_USE_MANTLE: "",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
  ANTHROPIC_UNIX_SOCKET: "",
});

/**
 * Flag settings, which outrank the project and user settings files: an empty
 * helper is no helper, and a settings file's `env` block cannot put a
 * credential back.
 */
export const NEUTRALISED_SETTINGS: Readonly<{
  apiKeyHelper: string;
  env: Readonly<Record<string, string>>;
}> = Object.freeze({
  apiKeyHelper: "",
  env: CLEARED_API_CREDENTIALS,
});

/** The part of the CLI's `get_settings` answer the check reads. */
export interface CliSettingsReport {
  effective?: SettingsLike;
  /** Raw settings per source, low to high precedence. */
  sources?: Array<{ source?: string; settings?: SettingsLike }>;
}

interface SettingsLike {
  apiKeyHelper?: unknown;
  policyHelper?: unknown;
  policyHelpers?: unknown;
  env?: Record<string, unknown>;
}

/**
 * Why the settings the CLI itself reports would put an API credential under a
 * run, or null. Read from the CLI (`get_settings`) rather than from files,
 * because only the CLI knows every tier it merged: managed files, MDM, an
 * organisation's remote settings cached in the config directory — all of
 * which outrank the flag settings a run can pass.
 *
 * Any source that configures an `apiKeyHelper` refuses the run, even one the
 * flag settings switched off: a configured helper is a request to bill a key,
 * and the operator should see it refused, not silently ignored.
 */
export function settingsRefusal(
  report: CliSettingsReport | undefined,
  /** Exact values the host itself pinned in flag settings (the autonomous relay route). */
  pinned: Readonly<Record<string, string>> = {}
): string | null {
  if (!report) return "the CLI did not report its settings";
  const layers: Array<[string, SettingsLike | undefined]> = [
    ["effective settings", report.effective],
    ...(report.sources ?? []).map((entry): [string, SettingsLike | undefined] => [
      entry.source ?? "a settings source",
      entry.settings,
    ]),
  ];
  for (const [name, settings] of layers) {
    if (typeof settings?.apiKeyHelper === "string" && settings.apiKeyHelper.trim() !== "") {
      return `${name} configure an apiKeyHelper`;
    }
    // A policy helper can replace the policy tier while the run runs, after
    // this check has passed, so its presence is refused rather than trusted.
    // What a root-owned policy does once it is running is the machine owner's
    // choice and outside what this check can see.
    if (settings?.policyHelper != null || settings?.policyHelpers != null) {
      return `${name} configure a policyHelper`;
    }
    for (const key of Object.keys(CLEARED_API_CREDENTIALS)) {
      const value = settings?.env?.[key];
      if (typeof value === "string" && value.trim() !== "" && pinned[key] !== value) return `${name} set ${key}`;
    }
  }
  return null;
}

/**
 * The account fields the CLI's `initialize` handshake reports. The Agent
 * SDK's `AccountInfo` is assignable to it.
 */
export interface ClaudeAccount {
  tokenSource?: string;
  apiKeySource?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

/** Env-supplied OAuth tokens, as the account's `tokenSource` names them. */
export const OAUTH_TOKEN_SOURCES: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]);

/**
 * The tiers a stored claude.ai login reports as `subscriptionType`. The CLI
 * falls back to "Claude API" when it does not know the tier, so presence alone
 * proves nothing.
 */
export const SUBSCRIPTION_TIERS: ReadonlySet<string> = new Set([
  "Claude Pro",
  "Claude Max",
  "Claude Team",
  "Claude Enterprise",
]);

export type SubscriptionVerdict =
  | { ok: true; via: "oauth-token" | "subscription-login" }
  | { ok: false; reason: string };

/**
 * Whether the account the CLI selected for this run is a subscription.
 * Anything it cannot recognise as one is refused.
 */
export function subscriptionVerdict(account: ClaudeAccount | undefined): SubscriptionVerdict {
  if (!account) return { ok: false, reason: "the CLI reported no account" };
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return { ok: false, reason: `the CLI is set to the ${account.apiProvider} provider` };
  }
  // Omitted on the handshake when no key is in use; "none" on the init event.
  if (account.apiKeySource !== undefined && account.apiKeySource !== "none") {
    return { ok: false, reason: `the CLI selected an API key (${account.apiKeySource})` };
  }
  if (account.tokenSource !== undefined && OAUTH_TOKEN_SOURCES.has(account.tokenSource)) {
    return { ok: true, via: "oauth-token" };
  }
  if (account.subscriptionType !== undefined && SUBSCRIPTION_TIERS.has(account.subscriptionType)) {
    return { ok: true, via: "subscription-login" };
  }
  return { ok: false, reason: "no Claude subscription is logged in" };
}
