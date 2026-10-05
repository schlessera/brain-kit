import type { TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { SUBSCRIPTION_AUTH_INSTRUCTIONS } from "@schlessera/brain-ui-sdk/protocol";

const AUTH = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "subscription_required"]);
const TRANSIENT = new Set(["rate_limit", "overloaded", "server_error", "max_output_tokens"]);
const HEADLINES: Record<string, string> = {
  rate_limit: "The provider rate limited this request.",
  overloaded: "The provider is overloaded.",
  server_error: "The provider failed to complete this request.",
  invalid_request: "The provider rejected this request.",
  model_not_found: "This model is unavailable on the backend.",
  max_output_tokens: "The answer reached its length limit and stopped.",
};

/** Class-driven copy; a class never establishes whether tools already ran. */
export function failurePresentation(failure: TurnFailure) {
  if (failure.authAction) {
    const instruction = SUBSCRIPTION_AUTH_INSTRUCTIONS[failure.authAction];
    const headline = failure.authAction === "check_config" ? "The Claude subscription configuration was refused."
      : failure.authAction === "check_account" ? "The Claude account itself was refused."
      : "The Claude subscription token was rejected.";
    return { headline, explanation: instruction, operator: true, tone: "red" as const, retry: false, report: false };
  }
  if (AUTH.has(failure.errorClass)) return {
    headline: "The backend's credential was refused.",
    explanation: "Check the credential configured for this provider. The provider's message is available below.",
    operator: true, tone: "red" as const, retry: false, report: false,
  };
  return {
    headline: HEADLINES[failure.errorClass] ?? "This turn failed.",
    explanation: failure.errorClass === "max_output_tokens" ? "The partial answer above is kept."
      : "Any partial answer and tool activity above are kept. The provider's message is available below.",
    operator: false, tone: TRANSIENT.has(failure.errorClass) ? "gold" as const : "red" as const,
    retry: ["rate_limit", "overloaded", "server_error", "unknown"].includes(failure.errorClass),
    report: failure.errorClass === "invalid_request" || !HEADLINES[failure.errorClass],
  };
}

/** Optional provider text only; this heuristic is followed by explicit editable review. */
export function redactProviderMessage(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer\s+|sk-[\w-]*|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "[redacted credential]")
    .replace(/\b(?:cookie|authorization)\s*[:=]\s*[^\n]+/gi, "[redacted credential]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted host]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:[a-z]{2,63})\b/gi, "[redacted host]")

    .replace(/(?:\/[\w.-]+){2,}/g, "[redacted path]")
    .replace(/\b[A-Z]:\\[^\s<>]+/gi, "[redacted path]");
}

/** How much redacted failure text one explicit inclusion appends. */
export const INCLUDED_TEXT_CAP = 1500;

/**
 * A labelled, redacted and visibly capped block of untrusted failure text,
 * appended to a review only on an explicit tap. Null when there is none.
 */
export function providerMessageInclusion(label: string, text: string | null | undefined): string | null {
  if (!text || !text.trim()) return null;
  const redacted = redactProviderMessage(text);
  const shown = redacted.slice(0, INCLUDED_TEXT_CAP);
  return `${label} (review before sharing):\n${shown}${redacted.length > shown.length ? `\n[${redacted.length - shown.length} characters not included]` : ""}`;
}
