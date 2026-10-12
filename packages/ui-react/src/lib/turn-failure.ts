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
  // #1660: the host's per-worker limit, named in the message, ended the agent.
  worker_resource_limit: "The agent hit this server's resource limit and was stopped.",
};

/** Class-driven copy; a class never establishes whether tools already ran. */
export function failurePresentation(failure: TurnFailure) {
  if (failure.errorClass === "journal_capacity" || failure.errorClass === "journal_unavailable") return {
    headline: failure.errorClass === "journal_capacity" ? "The change journal ran out of room." : "The change journal became unavailable.",
    explanation: "The turn stopped. Partial work remains, and some changes could not be retained. Review the incomplete journal before continuing.",
    operator: false, tone: "gold" as const, retry: false, report: true,
  };
  if (failure.authAction) {
    const instruction = SUBSCRIPTION_AUTH_INSTRUCTIONS[failure.authAction];
    const headline = failure.authAction === "check_config" ? "The Claude subscription configuration was refused."
      : failure.authAction === "check_account" ? "The Claude account itself was refused."
      : "The Claude subscription token was rejected.";
    return { headline, explanation: instruction, operator: true, tone: "red" as const, retry: false, report: false };
  }
  // The host, not the provider (#1632): the message names what it lacks, and
  // retrying cannot help until the host is fixed.
  if (failure.errorClass === "worker_host_unsupported") return {
    headline: "This server can't run agent turns.",
    explanation: "Its host lacks what the agent sandbox needs, named below. Retrying won't help until the host is fixed.",
    operator: true, tone: "red" as const, retry: false, report: false,
  };
  if (failure.errorClass === "session_too_large") return {
    headline: "This conversation is too long to continue here.",
    explanation: "Your conversation is saved. Continue in a new conversation with a reviewed handoff summary.",
    operator: false, tone: "gold" as const, retry: false, report: true,
  };
  // Temporary capacity, not the conversation's size and not a bug (#1625).
  if (failure.errorClass === "worker_state_busy") return {
    headline: "Other conversations are using this server's capacity right now.",
    explanation: "Nothing was sent. Retry when one of them finishes.",
    operator: false, tone: "gold" as const, retry: true, report: false,
  };
  if (failure.errorClass === "worker_state_exceeded") return {
    headline: "This turn ran out of room to save its work.",
    explanation: "Part of this turn wasn't saved; the details below say what was. Retry, or continue in a new conversation if this keeps happening.",
    operator: false, tone: "gold" as const, retry: true, report: true,
  };
  if (failure.errorClass === "worker_state_save_refused") return {
    headline: "This turn wasn't saved in full.",
    explanation: "Its transcript or agent memory could not be saved in full; some files may have been saved. The details below say why. Retry if needed; retrying won't recover the unsaved state.",
    operator: false, tone: "gold" as const, retry: true, report: true,
  };
  if (AUTH.has(failure.errorClass)) return {
    headline: "The backend's credential was refused.",
    explanation: "Check the credential configured for this provider. The provider's message is available below.",
    operator: true, tone: "red" as const, retry: false, report: false,
  };
  return {
    headline: HEADLINES[failure.errorClass] ?? "This turn failed.",
    explanation: failure.errorClass === "max_output_tokens" ? "The partial answer above is kept."
      : failure.errorClass === "worker_resource_limit" ? "Any partial answer and tool activity above are kept. The limit it hit is named below; a smaller request may fit."
      : "Any partial answer and tool activity above are kept. The provider's message is available below.",
    operator: false, tone: TRANSIENT.has(failure.errorClass) ? "gold" as const : "red" as const,
    retry: ["rate_limit", "overloaded", "server_error", "worker_resource_limit", "unknown"].includes(failure.errorClass),
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
