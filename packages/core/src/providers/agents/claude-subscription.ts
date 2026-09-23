/**
 * The Claude runner runs on the subscription or not at all
 * (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * With `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` both in its
 * environment the CLI sends only the API key, and nothing warns; it also takes
 * a key from an `apiKeyHelper` or an `env` block in settings, from
 * `ANTHROPIC_CUSTOM_HEADERS`, or from a stored Console login. So a run clears
 * the credential variables, overrides the project and user settings files with
 * flag settings that switch the helper off and clear the same variables, and
 * before the prompt is written checks both the account the CLI selected and
 * the settings it merged — including the policy tiers that outrank flag
 * settings.
 *
 * The chat backend holds the same rule
 * (`packages/ui-backend-claude/src/subscription.ts`); the two packages share no
 * dependency to put it in, so a change to one is a change to both.
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
 * Flag settings outrank the project and user settings files: an empty helper
 * is no helper, and no settings `env` block can put a credential back.
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
 * run, or null. Asked of the CLI rather than read from files, because only the
 * CLI knows every tier it merged — managed files, MDM, an organisation's remote
 * settings cached in the config directory — and those outrank the flag
 * settings a run passes. Any source that configures an `apiKeyHelper` refuses
 * the run, even one the flag settings switched off.
 */
export function settingsRefusal(report: CliSettingsReport | undefined): string | null {
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
      if (typeof value === "string" && value.trim() !== "") return `${name} set ${key}`;
    }
  }
  return null;
}

/** The account fields the CLI's `initialize` handshake reports. */
export interface ClaudeAccount {
  tokenSource?: string;
  apiKeySource?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

const OAUTH_TOKEN_SOURCES = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]);

/** The CLI falls back to "Claude API" when it does not know the tier. */
const SUBSCRIPTION_TIERS = new Set(["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"]);

/** Why the account is not a subscription, or null when it is. */
export function subscriptionRefusal(account: ClaudeAccount | undefined): string | null {
  if (!account) return "the CLI reported no account";
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return `the CLI is set to the ${account.apiProvider} provider`;
  }
  if (account.apiKeySource !== undefined && account.apiKeySource !== "none") {
    return `the CLI selected an API key (${account.apiKeySource})`;
  }
  if (account.tokenSource !== undefined && OAUTH_TOKEN_SOURCES.has(account.tokenSource)) return null;
  if (account.subscriptionType !== undefined && SUBSCRIPTION_TIERS.has(account.subscriptionType)) {
    return null;
  }
  return "no Claude subscription is logged in";
}

/** Thrown when a run is refused before its prompt is written. */
export class ClaudeSubscriptionError extends Error {
  constructor(reason: string) {
    super(
      `Claude subscription authentication required: ${reason}. ` +
        "Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`); the Claude runner never bills an API key."
    );
    this.name = "ClaudeSubscriptionError";
  }
}
