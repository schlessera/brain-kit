/**
 * The restricted envelope of an autonomous Claude turn (#676, R28/R29).
 *
 * The worker gets a private network namespace with only loopback and an
 * explicit read envelope (the launcher's `restricted` mode). Its one route
 * out is the server-owned inference relay, reached over the Unix socket the
 * CLI supports as `ANTHROPIC_UNIX_SOCKET`. The worker's environment carries
 * only minimum runtime variables and a placeholder where the credential would
 * be; the relay injects the server-held credential for the selected profile.
 */
import { ANTHROPIC_INFERENCE_ROUTES, INFERENCE_PLACEHOLDER, WORKER_INFERENCE_SOCKET, startInferenceRelay,
  type InferenceRelay, type InferenceRelayEvent } from "@schlessera/brain-ui-sdk/internal";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { InferenceProfile } from "./profiles.js";
import { CLEARED_API_CREDENTIALS } from "./subscription.js";

export interface ClaudeAutonomousEnvelope {
  /** The complete Claude Code environment inside the worker. */
  env: Record<string, string>;
  /** Flag-settings env the host pins, so no settings tier can reroute inference. */
  pinned: Record<string, string>;
  relay: InferenceRelay;
}

/** The plain-HTTP origin the CLI addresses over the relay socket. */
const SOCKET_ORIGIN = "http://localhost";

export function claudeAutonomousEnvelope(
  profile: InferenceProfile,
  turnEnvironment: Readonly<Record<string, string | undefined>>,
  observe?: (event: InferenceRelayEvent) => void
): ClaudeAutonomousEnvelope {
  const value = (name: string): string | undefined => turnEnvironment[name]?.trim() || undefined;
  let credentials: Record<string, string>;
  let placeholder: Record<string, string>;
  if (profile.billing !== "api") {
    const token = value("CLAUDE_CODE_OAUTH_TOKEN");
    if (!token) {
      throw new BackendRequestError(
        "Autonomous Claude turns on the subscription need CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`). " +
        "A stored login is never copied into the restricted envelope; set the token or declare an API-billed profile."
      );
    }
    credentials = { authorization: `Bearer ${token}` };
    placeholder = { CLAUDE_CODE_OAUTH_TOKEN: INFERENCE_PLACEHOLDER };
  } else if (value("ANTHROPIC_API_KEY")) {
    credentials = { "x-api-key": value("ANTHROPIC_API_KEY")! };
    placeholder = { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER };
  } else if (value("ANTHROPIC_AUTH_TOKEN")) {
    credentials = { authorization: `Bearer ${value("ANTHROPIC_AUTH_TOKEN")!}` };
    placeholder = { ANTHROPIC_AUTH_TOKEN: INFERENCE_PLACEHOLDER };
  } else {
    throw new BackendRequestError(`Autonomous Claude profile ${profile.id} has no inference credential for the restricted relay.`);
  }
  const pinned = { ...CLEARED_API_CREDENTIALS, ...placeholder,
    ANTHROPIC_UNIX_SOCKET: WORKER_INFERENCE_SOCKET, ANTHROPIC_BASE_URL: SOCKET_ORIGIN };
  const relay = startInferenceRelay({ upstream: value("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com",
    routes: ANTHROPIC_INFERENCE_ROUTES, credentials, ...(observe ? { observe } : {}) });
  return {
    relay,
    pinned,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1", ...pinned },
  };
}
