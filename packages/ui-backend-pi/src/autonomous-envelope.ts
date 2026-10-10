/**
 * The restricted envelope of an autonomous pi turn (#676, R28/R29).
 *
 * pi runs its SDK, tools and any in-process code inside the worker, so the
 * whole worker gets a private network namespace with only loopback and an
 * explicit read envelope. Its one route out is the server-owned inference
 * relay. The worker's trusted entry forwards a loopback port to the relay
 * socket before pi initializes, and pi's provider is pointed at that port
 * with a placeholder key; the relay injects the server-held API key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_INFERENCE_ROUTES, INFERENCE_PLACEHOLDER, startInferenceRelay,
  type InferenceRelay, type InferenceRelayEvent } from "@schlessera/brain-ui-sdk/internal";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { readEnvVar } from "./config/env.js";

/** What the worker's trusted entry needs to point pi at the relay. Never a credential. */
export interface PiWorkerInference {
  provider: string;
  /** Base path the provider appends its routes to, e.g. `/v1` for OpenAI. */
  basePath: string;
  placeholder: string;
}

/** The provider APIs whose inference routes and credential header are known exactly. */
const APIS: Record<string, { routes: readonly string[]; header(key: string): Record<string, string> }> = {
  "anthropic-messages": { routes: ANTHROPIC_INFERENCE_ROUTES, header: key => ({ "x-api-key": key }) },
  "openai-completions": { routes: ["/chat/completions"], header: key => ({ authorization: `Bearer ${key}` }) },
  "openai-responses": { routes: ["/responses"], header: key => ({ authorization: `Bearer ${key}` }) },
};

/**
 * A configured key: a literal, or `$NAME` / `${NAME}` read from the server's
 * environment. A `!command` key would run a host command per turn; it is
 * refused rather than executed for an unattended turn.
 */
function configuredKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("!")) throw new BackendRequestError("Autonomous pi turns do not run command-sourced API keys.");
  const name = value.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/)?.[1];
  return name ? readEnvVar(name) || undefined : value;
}

export function piAutonomousEnvelope(model: Model<any> | undefined, agentDir: string,
  observe?: (event: InferenceRelayEvent) => void): { relay: InferenceRelay; inference: PiWorkerInference } {
  if (!model) throw new BackendRequestError("Autonomous pi turns need a declared vendor/model profile.");
  const api = APIS[model.api];
  if (!api) {
    throw new BackendRequestError(`Autonomous pi turns do not support the ${model.api} provider API inside the restricted envelope.`);
  }
  let override: { baseUrl?: unknown; apiKey?: unknown } | undefined;
  const modelsPath = join(agentDir, "models.json");
  if (existsSync(modelsPath)) {
    override = (JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, typeof override> }).providers?.[model.provider];
  }
  const stored = readStoredCredential(model.provider, join(agentDir, "auth.json"));
  if (stored?.type === "oauth") {
    throw new BackendRequestError(`Autonomous pi turns need an API key for ${model.provider}; a stored OAuth login cannot cross the restricted envelope.`);
  }
  const key = (stored?.type === "api_key" ? configuredKey(stored.key) : undefined)
    ?? getEnvApiKey(model.provider)
    ?? (typeof override?.apiKey === "string" ? configuredKey(override.apiKey) : undefined);
  if (!key) throw new BackendRequestError(`Autonomous pi profile ${model.provider}/${model.id} has no API key for the restricted relay.`);
  // pi treats an Anthropic OAuth token as a login with its own request shape.
  if (key.startsWith("sk-ant-oat")) {
    throw new BackendRequestError(`Autonomous pi turns need an API key for ${model.provider}; an OAuth token cannot cross the restricted envelope.`);
  }
  const upstream = typeof override?.baseUrl === "string" ? override.baseUrl : model.baseUrl;
  const relay = startInferenceRelay({ upstream, routes: api.routes, credentials: api.header(key), ...(observe ? { observe } : {}) });
  return { relay, inference: { provider: model.provider, basePath: new URL(upstream).pathname.replace(/\/+$/, ""), placeholder: INFERENCE_PLACEHOLDER } };
}
