import type { TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { SUBSCRIPTION_AUTH_INSTRUCTIONS } from "@schlessera/brain-ui-sdk/protocol";

/**
 * A failed turn as the transcript draws it (#575): the `**Error:**` line the
 * client has always drawn for an error, then, for a subscription auth
 * failure, what the operator does about it — the #254 split, word for word.
 * One function, so the live turn and its replay cannot differ.
 */
export function failureMarkdown(failure: TurnFailure): string {
  const lines = [`**Error:** ${failure.message}`];
  if (failure.authAction) lines.push(SUBSCRIPTION_AUTH_INSTRUCTIONS[failure.authAction]);
  return lines.join("\n\n");
}
