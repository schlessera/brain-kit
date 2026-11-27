/** A leaf with no value imports: a worker bootstrap names failure classes without loading the protocol module. */
type FirstPartyFailureClass =
  | "authentication_failed" | "oauth_org_not_allowed" | "account_on_hold"
  | "verification_required" | "billing_error" | "subscription_required"
  | "host_refused" | "auth_failure" | "settings_conflict" | "session_roster_incompatible" | "rate_limit" | "overloaded" | "server_error"
  | "invalid_request" | "model_not_found" | "max_output_tokens"
  | "cloud_credential_error" | "worker_host_unsupported" | "session_too_large" | "worker_resource_limit"
  | "worker_state_busy" | "worker_state_exceeded" | "worker_state_save_refused" | "journal_capacity" | "journal_unavailable" | "code_receipt_malformed" | "private_state_unverified" | "OperationalStateAliasVerificationUnavailable" | "budget_exceeded" | "budget_unavailable" | "input_safety_unavailable" | "safety_recording_unavailable" | "safety_recording_paused" | "safety_recording_chat_full" | "safety_recording_brain_full" | "unknown";

/**
 * First-party failure classes, shared by emitters and reviewed diagnostics.
 * Keys and values match so emitters can name a class without a separate literal
 * list. TurnFailure.errorClass remains free-form; unregistered classes must not
 * enter the default outgoing diagnostic text.
 */
export const FIRST_PARTY_FAILURE_CLASSES: Readonly<{ [Class in FirstPartyFailureClass]: Class }> = Object.freeze({
  authentication_failed: "authentication_failed",
  oauth_org_not_allowed: "oauth_org_not_allowed",
  account_on_hold: "account_on_hold",
  verification_required: "verification_required",
  billing_error: "billing_error",
  subscription_required: "subscription_required",
  host_refused: "host_refused",
  auth_failure: "auth_failure",
  settings_conflict: "settings_conflict",
  session_roster_incompatible: "session_roster_incompatible",
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  server_error: "server_error",
  invalid_request: "invalid_request",
  model_not_found: "model_not_found",
  max_output_tokens: "max_output_tokens",
  cloud_credential_error: "cloud_credential_error",
  worker_host_unsupported: "worker_host_unsupported",
  session_too_large: "session_too_large",
  worker_resource_limit: "worker_resource_limit",
  worker_state_busy: "worker_state_busy",
  worker_state_exceeded: "worker_state_exceeded",
  worker_state_save_refused: "worker_state_save_refused",
  budget_exceeded: "budget_exceeded",
  budget_unavailable:"budget_unavailable",
  journal_capacity: "journal_capacity",
  journal_unavailable: "journal_unavailable",
  code_receipt_malformed: "code_receipt_malformed",
  private_state_unverified: "private_state_unverified",
  OperationalStateAliasVerificationUnavailable: "OperationalStateAliasVerificationUnavailable",
  input_safety_unavailable: "input_safety_unavailable",
  safety_recording_unavailable: "safety_recording_unavailable",
  safety_recording_paused: "safety_recording_paused",
  safety_recording_chat_full: "safety_recording_chat_full",
  safety_recording_brain_full: "safety_recording_brain_full",
  unknown: "unknown",
});
