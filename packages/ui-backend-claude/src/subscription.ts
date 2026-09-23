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
 * subscription turn has four parts, all here:
 *
 * 1. the credential variables are cleared ({@link CLEARED_API_CREDENTIALS});
 * 2. flag settings override every project and user settings file: an empty
 *    `apiKeyHelper`, and the same variables cleared in `env`
 *    ({@link NEUTRALISED_SETTINGS}). A helper that has not produced its key yet
 *    is invisible to the account check below, so it cannot be caught after the
 *    fact, only switched off;
 * 3. managed (policy) settings outrank flag settings, so a managed file that
 *    configures an API credential refuses the turn
 *    ({@link managedSettingsConflict});
 * 4. the account the CLI selected, read from the `initialize` handshake, is
 *    checked before the prompt is released ({@link subscriptionVerdict}).
 *
 * Not inspected: managed settings the CLI reads from outside the managed
 * directory (the Windows registry chain under WSL, an organisation's remote
 * managed settings).
 *
 * The core CLI's Claude runner holds the same rule
 * (`packages/core/src/providers/agents/claude-subscription.ts`); the two
 * packages share no dependency to put it in, so a change to one is a change to
 * both.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Set over the turn's environment: an empty value is how the CLI reads "none".
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

/** Where Claude Code reads managed (policy) settings on this platform. */
export function defaultManagedSettingsDir(): string {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * Why the managed settings in `dir` would put an API credential under a
 * subscription turn, or null. Reads `managed-settings.json` and the
 * `managed-settings.d/*.json` drop-ins the way the CLI does; a file that does
 * not exist is no conflict, one that cannot be parsed is.
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
