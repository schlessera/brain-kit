/**
 * The Claude runner runs on the subscription or not at all
 * (docs/decisions/claude-code-runtime.md, "Subscription billing and
 * authentication").
 *
 * A run clears the credential variables, overrides the project and user
 * settings files with flag settings that switch the helper off and clear the
 * same variables, and before the prompt is written checks both the account
 * the CLI selected and the settings it merged — including the policy tiers
 * that outrank flag settings.
 *
 * The rule itself — the cleared variables, the neutralised settings and both
 * checks — lives once in `@schlessera/brain-common/internal/claude-subscription`,
 * which the chat backend (`packages/ui-backend-claude/src/subscription.ts`)
 * imports too. This module only adapts it to the runner: a refusal reason
 * string and the error a refused run throws.
 */
import {
  type ClaudeAccount,
  subscriptionVerdict,
} from "@schlessera/brain-common/internal/claude-subscription";

export {
  CLEARED_API_CREDENTIALS,
  type ClaudeAccount,
  type CliSettingsReport,
  NEUTRALISED_SETTINGS,
  settingsRefusal,
} from "@schlessera/brain-common/internal/claude-subscription";

/** Why the account is not a subscription, or null when it is. */
export function subscriptionRefusal(account: ClaudeAccount | undefined): string | null {
  const verdict = subscriptionVerdict(account);
  return verdict.ok ? null : verdict.reason;
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
