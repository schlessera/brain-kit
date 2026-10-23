/**
 * The credential an API-billed Claude profile sends, held by the host
 * inference relay (#1665). The worker keeps a placeholder under the same
 * variable, so the CLI still chooses the same header and reports the same
 * key source; the relay injects the profile's value on every request. The
 * key's route is the profile's own declaration (its `baseUrl`, else the
 * host's `ANTHROPIC_BASE_URL`), so no further origin authorization applies.
 */
import { INFERENCE_PLACEHOLDER } from "@schlessera/brain-ui-sdk/internal";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";

export interface ApiKeyRelayCredential {
  /** Headers the relay injects. Never logged or sent to the worker. */
  headers: Readonly<Record<string, string>>;
  /** The worker's environment in place of the credential, including a cleared host login. */
  placeholders: Readonly<Record<string, string>>;
}

export function apiKeyRelayCredential(profileId: string,
  environment: Readonly<Record<string, string | undefined>>): ApiKeyRelayCredential {
  const headers: Record<string, string> = {};
  // A host login must not ride along in an API-billed worker either.
  const placeholders: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "" };
  const key = environment.ANTHROPIC_API_KEY, token = environment.ANTHROPIC_AUTH_TOKEN;
  if (key?.trim()) { headers["x-api-key"] = key; placeholders.ANTHROPIC_API_KEY = INFERENCE_PLACEHOLDER; }
  if (token?.trim()) { headers.authorization = `Bearer ${token}`; placeholders.ANTHROPIC_AUTH_TOKEN = INFERENCE_PLACEHOLDER; }
  if (!Object.keys(headers).length) {
    throw new BackendRequestError(`Claude profile ${profileId} has no API credential for the host inference relay.`);
  }
  return { headers, placeholders };
}
