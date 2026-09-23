/**
 * The Claude runner runs on the subscription or not at all
 * (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * With `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` both in its
 * environment the CLI sends only the API key, and nothing warns; it also takes
 * a key from an `apiKeyHelper` in settings or a stored Console login. So a run
 * clears the API credential variables, switches any helper off with flag
 * settings, and checks the account the CLI selected before the prompt is
 * written.
 *
 * The chat backend holds the same rule
 * (`packages/ui-backend-claude/src/subscription.ts`); the two packages share no
 * dependency to put it in, so a change to one is a change to both.
 */

/** Set over the run's environment: an empty value is how the CLI reads "none". */
export const CLEARED_API_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
});

/** Flag settings outrank every settings file: an empty helper is no helper. */
export const NEUTRALISED_SETTINGS: Readonly<{ apiKeyHelper: string }> = Object.freeze({
  apiKeyHelper: "",
});

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
