/**
 * The Claude runner runs on the subscription or not at all
 * (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * With `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` both in its
 * environment the CLI sends only the API key, and nothing warns; it also takes
 * a key from an `apiKeyHelper` or an `env` block in settings, from
 * `ANTHROPIC_CUSTOM_HEADERS`, or from a stored Console login. So a run clears
 * the credential variables, overrides every settings file with flag settings
 * that switch the helper off and clear the same variables, refuses when
 * managed settings (which outrank flag settings) configure a credential, and
 * checks the account the CLI selected before the prompt is written.
 *
 * The chat backend holds the same rule
 * (`packages/ui-backend-claude/src/subscription.ts`); the two packages share no
 * dependency to put it in, so a change to one is a change to both.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Where Claude Code reads managed (policy) settings on this platform. */
export function defaultManagedSettingsDir(): string {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * Why the managed settings in `dir` would put an API credential under a run,
 * or null. Reads `managed-settings.json` and the `managed-settings.d/*.json`
 * drop-ins the way the CLI does; a missing file is no conflict, an unparseable
 * one is.
 */
export function managedSettingsConflict(dir: string): string | null {
  const files = [join(dir, "managed-settings.json")];
  try {
    for (const name of readdirSync(join(dir, "managed-settings.d")).sort()) {
      if (name.endsWith(".json") && !name.startsWith(".")) {
        files.push(join(dir, "managed-settings.d", name));
      }
    }
  } catch {
    // No drop-in directory.
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let settings: { apiKeyHelper?: unknown; env?: Record<string, unknown> };
    try {
      settings = JSON.parse(text) ?? {};
    } catch {
      return `managed settings ${file} cannot be read as JSON`;
    }
    if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim() !== "") {
      return `managed settings ${file} configure an apiKeyHelper`;
    }
    for (const name of Object.keys(CLEARED_API_CREDENTIALS)) {
      const value = settings.env?.[name];
      if (typeof value === "string" && value.trim() !== "") {
        return `managed settings ${file} set ${name}`;
      }
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
