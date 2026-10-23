/**
 * Host-held credentials for an ordinary governed or strict pi turn (#1665).
 *
 * The worker's pi talks to a loopback forwarder inside the worker and holds a
 * placeholder shaped like its credential type. On every dispatch the host
 * runs pi's own `ModelRuntime.getAuth(model)` over the server-selected agent
 * directory, so refresh and writeback, changed credentials and the native
 * credential precedence stay pi's. The relay replaces the credential headers
 * and sends the request only to an origin the provider's built-in catalog
 * names or `BRAIN_UI_PI_CREDENTIAL_ORIGINS` lists for that provider.
 *
 * Maintainer rulings 2026-10-23 (docs/decisions/pi-endpoint-routing.md): the
 * qualified matrix is API keys on anthropic-messages, openai-completions and
 * openai-responses, and OAuth for openai-codex and anthropic. A command-sourced
 * key or header, or anything outside the matrix, is refused before launch. The
 * host never runs a credential command.
 */
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { INFERENCE_PLACEHOLDER, startInferenceRelay, WORKER_EGRESS_DIR, type InferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { readEnvVar } from "./config/env.js";

/** What the worker's trusted entry needs to reach the relay. Never a credential. */
export interface PiRelayedInference {
  provider: string;
  /** The configured endpoint's path, which the worker keeps after its loopback origin. */
  basePath: string;
  /** The relay socket inside the worker. */
  socket: string;
  /** The provider's auth.json entry: a placeholder of the host credential's shape. */
  credential: Record<string, unknown>;
  /** The provider's models.json entry without its key, headers or endpoints. */
  providerConfig: Record<string, unknown>;
  /** Codex SSE only: the relay carries no WebSocket upgrade. */
  transport?: "sse";
}

export interface PiHostInference {
  worker: PiRelayedInference;
  /** Environment variables naming this provider's key; the worker must not inherit them. */
  credentialEnv: readonly string[];
  /** pi's host credential files, masked in the worker wherever the host masks do not already hide them. */
  maskPaths: readonly string[];
  stop(): void;
}

type Shape = "api_key" | "anthropic_oauth" | "codex_oauth";
const API_ROUTES: Partial<Record<Api, readonly string[]>> = {
  "anthropic-messages": ["/v1/messages", "/v1/messages/count_tokens"],
  "openai-completions": ["/chat/completions"],
  "openai-responses": ["/responses"],
};
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const ANTHROPIC_OAUTH_PLACEHOLDER = `sk-ant-oat01-${INFERENCE_PLACEHOLDER}`;
/** A Codex token's shape: pi reads the account from it before dispatch; the relay replaces both. */
const CODEX_PLACEHOLDER = ["{\"alg\":\"none\",\"typ\":\"JWT\"}",
  JSON.stringify({ [JWT_CLAIM_PATH]: { chatgpt_account_id: INFERENCE_PLACEHOLDER } })]
  .map(part => Buffer.from(part).toString("base64").replace(/=+$/, "")).join(".") + `.${INFERENCE_PLACEHOLDER}`;

function refuse(reason: string): never {
  throw new BackendRequestError(`This pi turn cannot run on the host inference relay: ${reason}`);
}
const isCommand = (value: unknown): boolean => typeof value === "string" && value.trimStart().startsWith("!");
/** Environment variables a `$NAME` or `${NAME}` template reads. */
const templateNames = (value: unknown): string[] => typeof value === "string"
  ? [...value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map(match => match[1]!) : [];
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Exact canonical origin: scheme, host and port, nothing else. */
export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search
    || url.hash || url.hostname.includes("*") || value.trim() !== value || !/^https?:\/\/[^/?#\s]+\/?$/i.test(value)) {
    throw new Error("Not an exact origin");
  }
  return url.origin;
}

/**
 * `BRAIN_UI_PI_CREDENTIAL_ORIGINS`: `provider=origin[,origin];...`. The
 * trusted host list of non-first-party origins each provider's credential may
 * reach. A malformed entry refuses every relayed turn rather than guessing.
 */
export function piCredentialOrigins(value = readEnvVar("BRAIN_UI_PI_CREDENTIAL_ORIGINS")): ReadonlyMap<string, readonly string[]> {
  const origins = new Map<string, string[]>();
  for (const entry of (value ?? "").split(";").map(part => part.trim()).filter(Boolean)) {
    const at = entry.indexOf("=");
    const provider = entry.slice(0, at).trim();
    if (at < 1 || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) refuse("BRAIN_UI_PI_CREDENTIAL_ORIGINS has an entry without a provider id");
    const list = entry.slice(at + 1).split(",").map(origin => origin.trim()).filter(Boolean);
    if (!list.length) refuse(`BRAIN_UI_PI_CREDENTIAL_ORIGINS lists no origin for ${provider}`);
    try { origins.set(provider, [...origins.get(provider) ?? [], ...list.map(canonicalOrigin)]); }
    catch { refuse(`BRAIN_UI_PI_CREDENTIAL_ORIGINS lists something other than an exact origin for ${provider}`); }
  }
  return origins;
}

/** The provider's built-in catalog origins: the only implicit recipients. */
function firstPartyOrigins(provider: string): ReadonlySet<string> {
  try { return new Set(getBuiltinModels(provider as never).map(model => new URL(model.baseUrl).origin)); }
  catch { return new Set(); }
}

/** Same algorithm as pi's Codex transport. */
function codexAccount(token: string): string {
  const parts = token.split(".");
  const account = parts.length === 3 ? (JSON.parse(atob(parts[1]!)) as Record<string, { chatgpt_account_id?: unknown }>)[JWT_CLAIM_PATH]?.chatgpt_account_id : undefined;
  if (typeof account !== "string" || !account) throw new Error("No account in the Codex credential");
  return account;
}

/** The request path the relay must accept, relative to the configured endpoint. */
function routesFor(model: Model<Api>): readonly string[] | undefined {
  if (model.api !== "openai-codex-responses") return API_ROUTES[model.api];
  // pi's resolveCodexUrl: an endpoint may already end in /codex or /codex/responses.
  const base = model.baseUrl.replace(/\/+$/, "");
  return [base.endsWith("/codex/responses") ? "" : base.endsWith("/codex") ? "/responses" : "/codex/responses"];
}

function shapeOf(model: Model<Api>, type: "api_key" | "oauth", key: string | undefined): Shape {
  if (model.api === "openai-codex-responses") {
    if (type === "oauth" && model.provider === "openai-codex") return "codex_oauth";
  } else if (model.api === "anthropic-messages") {
    if (model.provider === "anthropic" && (type === "oauth" || key?.includes("sk-ant-oat"))) return "anthropic_oauth";
    if (type === "api_key" && !key?.includes("sk-ant-oat")) return "api_key";
  } else if (API_ROUTES[model.api] && type === "api_key") return "api_key";
  return refuse(`${model.provider}/${model.id} uses ${type === "oauth" ? "an OAuth login" : "an API key"} on the ${model.api} API, `
    + "which the relay does not carry. Use an API key on an Anthropic Messages or OpenAI-compatible model, or the openai-codex or anthropic login.");
}

/**
 * pi's own file-locked credential store, limited to the selected provider and
 * refusing a command-sourced key before pi could run it. The store is not a
 * public export; the backend pins the installed pi version.
 */
async function guardedCredentials(authPath: string, provider: string): Promise<CredentialStore> {
  const entry = Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir);
  const { AuthStorage } = await import(join(dirname(entry), "core", "auth-storage.js")) as
    { AuthStorage: { create(path: string): CredentialStore } };
  const inner = AuthStorage.create(authPath);
  const ownProvider = (id: string) => { if (id !== provider) throw new Error("Only the turn's provider is resolved on the host"); };
  return {
    async read(id, options) {
      if (id !== provider) return undefined;
      const raw = readStoredCredential(id, authPath) as { type?: string; key?: unknown } | undefined;
      if (raw?.type === "api_key" && isCommand(raw.key)) refuse("its stored key runs a command, which the host never runs");
      return inner.read(id, options);
    },
    async list(options) { return (await inner.list(options)).filter(info => info.providerId === provider); },
    async modify(id, fn, options) { ownProvider(id); return inner.modify(id, fn, options); },
    async delete(id) { ownProvider(id); throw new Error("A turn never logs out"); },
  };
}

export async function preparePiHostInference(options: {
  provider: string; modelId: string; agentDir: string; brainPath: string;
  /** The turn proxy's private directory; the relay socket is linked into it. */
  egress: { dir: string; inference: NonNullable<Parameters<typeof startInferenceRelay>[0]["egress"]>["inference"] };
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}): Promise<PiHostInference> {
  const { provider, agentDir } = options;
  const brain = realpathSync(options.brainPath);
  const authPath = join(agentDir, "auth.json"), modelsPath = join(agentDir, "models.json");
  // The host reads and refreshes this file; the brain must not be able to supply it.
  if (existsSync(authPath) && inside(brain, realpathSync(authPath))) refuse("pi's auth.json is linked into the brain; keep it outside");
  let models: { providers?: Record<string, Record<string, unknown>> } = {};
  try { if (existsSync(modelsPath)) models = JSON.parse(readFileSync(modelsPath, "utf8")); }
  catch { refuse("pi's models.json is not valid JSON"); }
  const configured = models.providers?.[provider];
  const headerCommands = (headers: unknown) => typeof headers === "object" && headers !== null && Object.values(headers).some(isCommand);
  if (isCommand(configured?.apiKey) || headerCommands(configured?.headers)
    || (Array.isArray(configured?.models) && configured.models.some(model => headerCommands((model as { headers?: unknown })?.headers)))) {
    refuse(`pi's models.json runs a command for ${provider}'s key or a header, which the host never runs. Use a literal, an environment variable or a stored key`);
  }
  const stored = readStoredCredential(provider, authPath) as { type?: string; key?: unknown } | undefined;
  if (stored?.type === "api_key" && isCommand(stored.key)) refuse(`pi's stored key for ${provider} runs a command, which the host never runs`);
  const authorized = new Set([...firstPartyOrigins(provider), ...piCredentialOrigins().get(provider) ?? []]);

  // A private snapshot: only this provider, so the host runtime can never
  // reach another provider's command, and no edit during the turn reroutes it.
  const scratch = mkdtempSync(join(tmpdir(), "brain-pi-host-"));
  chmodSync(scratch, 0o700);
  let relay: InferenceRelay | undefined;
  const link = join(options.egress.dir, "inference.sock");
  try {
    writeFileSync(join(scratch, "models.json"), JSON.stringify({ providers: configured ? { [provider]: configured } : {} }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ credentials: await guardedCredentials(authPath, provider),
      modelsPath: join(scratch, "models.json"), modelsStorePath: join(scratch, "models-store.json"),
      refreshOnCreate: false, allowModelNetwork: false, ...(options.signal ? { signal: options.signal } : {}) });
    const model = runtime.getModel(provider, options.modelId);
    if (!model) refuse(`${provider}/${options.modelId} is not a configured pi model`);
    const routes = routesFor(model);
    if (!routes) refuse(`${provider}/${model.id} uses the ${model.api} API, which the relay does not carry`);
    const endpoint = new URL(model.baseUrl);
    // Refused before the credential is read: the configured route must be authorized.
    if (!authorized.has(endpoint.origin)) {
      refuse(`${endpoint.origin} may not receive ${provider}'s credential; list it as ${provider}=${endpoint.origin} in BRAIN_UI_PI_CREDENTIAL_ORIGINS`);
    }
    const check = await runtime.checkAuth(provider, options.signal ? { signal: options.signal } : undefined);
    if (!check) refuse(`pi has no credential for ${provider}`);
    const first = await runtime.getAuth(model, options.signal ? { signal: options.signal } : {});
    const shape = shapeOf(model, check.type, first?.auth.apiKey);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    relay = startInferenceRelay({ upstream: model.baseUrl, routes, egress: options.egress,
      credentials: async (signal, target) => {
        const resolved = await runtime.getAuth(model, { signal });
        const auth = resolved?.auth;
        if (!auth?.apiKey && !auth?.headers) throw new Error("No credential");
        // Native precedence: an auth-supplied endpoint wins, and the matrix has none.
        if (auth.baseUrl && new URL(auth.baseUrl).href.replace(/\/+$/, "") !== new URL(model.baseUrl).href.replace(/\/+$/, "")) {
          throw new Error("The credential selects another endpoint");
        }
        if (!authorized.has(target.origin)) throw new Error("Unauthorized recipient");
        const key = auth.apiKey;
        if (shapeOf(model, check.type, key) !== shape) throw new Error("The credential changed shape during the turn");
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(auth.headers ?? {})) if (typeof value === "string") headers[name.toLowerCase()] = value;
        if (key) {
          if (shape === "codex_oauth") { headers.authorization = `Bearer ${key}`; headers["chatgpt-account-id"] = codexAccount(key); }
          else if (shape === "anthropic_oauth" || model.api !== "anthropic-messages") headers.authorization = `Bearer ${key}`;
          else headers["x-api-key"] = key;
        }
        return headers;
      } });
    linkSync(relay.socketPath, link);
    const placeholder = shape === "codex_oauth" ? CODEX_PLACEHOLDER : shape === "anthropic_oauth" ? ANTHROPIC_OAUTH_PLACEHOLDER : INFERENCE_PLACEHOLDER;
    const credential = check.type === "oauth"
      // Far from expiry, so the worker never tries to refresh a placeholder.
      ? { type: "oauth", access: placeholder, refresh: INFERENCE_PLACEHOLDER, expires: Date.now() + 365 * 86_400_000 }
      : { type: "api_key", key: placeholder };
    // The worker keeps native model settings but no key, headers or endpoints.
    const providerConfig: Record<string, unknown> = Object.fromEntries(Object.entries(configured ?? {})
      .filter(([name]) => !["apiKey", "headers", "baseUrl", "authHeader"].includes(name)));
    if (Array.isArray(configured?.models)) providerConfig.models = configured.models.map(entry => typeof entry === "object" && entry !== null
      ? Object.fromEntries(Object.entries(entry).filter(([name]) => !["headers", "baseUrl"].includes(name))) : entry);
    const stoppable = relay;
    // Every variable that names or feeds this provider's credential stays on the host.
    const credentialEnv = new Set([...findEnvKeys(provider, options.environment as Record<string, string>) ?? [],
      ...templateNames(configured?.apiKey), ...templateNames(stored?.key),
      ...[configured?.headers, ...(Array.isArray(configured?.models) ? configured.models.map(entry => (entry as { headers?: unknown })?.headers) : [])]
        .flatMap(headers => typeof headers === "object" && headers !== null ? Object.values(headers).flatMap(templateNames) : [])]);
    return {
      worker: { provider, basePath, socket: `${WORKER_EGRESS_DIR}/inference.sock`, credential, providerConfig,
        ...(shape === "codex_oauth" ? { transport: "sse" as const } : {}) },
      credentialEnv: [...credentialEnv],
      // A models.json linked into the brain stays visible: the brain is the worker's to read.
      maskPaths: [authPath, modelsPath].filter(path => existsSync(path)).map(path => realpathSync(path)).filter(path => !inside(brain, path)),
      stop() { rmSync(link, { force: true }); stoppable.stop(); rmSync(scratch, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(link, { force: true });
    relay?.stop();
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
