/**
 * A Claude profile with no credential of its own runs on the subscription or
 * not at all (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * The CLI does not make that easy. With `CLAUDE_CODE_OAUTH_TOKEN` and
 * `ANTHROPIC_API_KEY` both in its environment it sends only the API key, and
 * nothing warns. Clearing the variables is not enough either: it also takes a
 * key from an `apiKeyHelper` in settings, or from a stored Console login. So a
 * subscription turn has three parts, all here:
 *
 * 1. the API credential variables are cleared ({@link CLEARED_API_CREDENTIALS});
 * 2. an `apiKeyHelper` from any settings file is overridden with an empty one
 *    ({@link NEUTRALISED_SETTINGS}) — a helper that has not produced its key
 *    yet is invisible to the account check below, so it cannot be caught
 *    after the fact, only switched off;
 * 3. the account the CLI selected, read from the `initialize` handshake, is
 *    checked before the prompt is released ({@link subscriptionVerdict}).
 *
 * The core CLI's Claude runner holds the same rule
 * (`packages/core/src/providers/agents/claude-subscription.ts`); the two
 * packages share no dependency to put it in, so a change to one is a change to
 * both.
 */
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";

/** Set over the turn's environment: an empty value is how the CLI reads "none". */
export const CLEARED_API_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
});

/**
 * Flag settings, which outrank the project and user settings files: an empty
 * helper is no helper.
 */
export const NEUTRALISED_SETTINGS: Readonly<{ apiKeyHelper: string }> = Object.freeze({
  apiKeyHelper: "",
});

/** Env-supplied OAuth tokens, as `AccountInfo.tokenSource` names them. */
const OAUTH_TOKEN_SOURCES = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]);

/**
 * The tiers a stored claude.ai login reports as `subscriptionType`. The CLI
 * falls back to "Claude API" when it does not know the tier, so presence alone
 * proves nothing.
 */
const SUBSCRIPTION_TIERS = new Set(["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"]);

export type SubscriptionVerdict =
  | { ok: true; via: "oauth-token" | "subscription-login" }
  | { ok: false; reason: string };

/**
 * Whether the account the CLI selected for this turn is a subscription.
 * Anything it cannot recognise as one is refused.
 */
export function subscriptionVerdict(account: AccountInfo | undefined): SubscriptionVerdict {
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

/** What an operator is told when a subscription turn is refused. */
export function subscriptionRefusalMessage(reason: string): string {
  return (
    `Claude subscription authentication required: ${reason}. ` +
    "Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and restart, " +
    "or declare a profile with its own apiKeyEnv to bill an API key on purpose."
  );
}
