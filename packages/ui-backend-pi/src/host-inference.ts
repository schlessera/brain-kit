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
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { AGENT_INFERENCE_CREDENTIAL_ENV, INFERENCE_PLACEHOLDER, startInferenceRelay, SUBPROCESS_ENV, WORKER_EGRESS_DIR,
  type InferenceRelay } from "@schlessera/brain-ui-sdk/internal";
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
/** Every string in a configuration value, at any depth. */
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : typeof value === "object" && value !== null ? Object.values(value).flatMap(strings) : [];
/** Configuration fields that carry a credential or select where it goes: the worker never receives them. */
const WORKER_DROPPED = new Set(["apiKey", "headers", "baseUrl", "authHeader", "oauth"]);
const sanitized = (value: unknown): unknown => Array.isArray(value) ? value.map(sanitized)
  : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)
    .filter(([name]) => !WORKER_DROPPED.has(name)).map(([name, entry]) => [name, sanitized(entry)])) : value;
/** A literal key, or a literal credential-like header, anywhere in a provider's configuration. */
function literalCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(literalCredential);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([name, entry]) => name === "apiKey" ? typeof entry === "string" && !entry.includes("$")
    : name === "headers" && typeof entry === "object" && entry !== null
      ? Object.entries(entry).some(([header, text]) => /auth|key|token|secret|cookie/i.test(header) && typeof text === "string" && !text.includes("$"))
      : literalCredential(entry));
}
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
  // Copilot derives its endpoint and request shape from its own token.
  if (model.provider === "github-copilot") {
    // Refused below.
  } else if (model.api === "openai-codex-responses") {
    if (type === "oauth" && model.provider === "openai-codex") return "codex_oauth";
  } else if (model.api === "anthropic-messages") {
    // Native Anthropic Messages treats any sk-ant-oat key as a login, whatever the provider.
    if (type === "oauth" ? model.provider === "anthropic" : key?.includes("sk-ant-oat")) return "anthropic_oauth";
    if (type === "api_key") return "api_key";
  } else if (API_ROUTES[model.api] && type === "api_key") return "api_key";
  return refuse(`${model.provider}/${model.id} uses ${type === "oauth" ? "an OAuth login" : "an API key"} on the ${model.api} API, `
    + "which the relay does not carry. Use an API key on an Anthropic Messages or OpenAI-compatible model, or the openai-codex or anthropic login.");
}

/**
 * pi's own file-locked credential store, limited to the selected provider and
 * refusing a command-sourced key before pi could run it. The check and the
 * read are one locked operation, so no edit can slip a command in between.
 * Neither module is a public export; the backend pins the installed pi version.
 */
async function guardedCredentials(authPath: string, provider: string): Promise<CredentialStore> {
  const core = join(dirname(Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir)), "core");
  const { AuthStorage } = await import(join(core, "auth-storage.js")) as { AuthStorage: { create(path: string): CredentialStore } };
  const { resolveConfigValue } = await import(join(core, "resolve-config-value.js")) as
    { resolveConfigValue(value: string, env?: Record<string, string>): string | undefined };
  const inner = AuthStorage.create(authPath);
  const ownProvider = (id: string) => { if (id !== provider) throw new Error("Only the turn's provider is resolved on the host"); };
  return {
    async read(id, options) {
      if (id !== provider || !existsSync(authPath)) return undefined;
      // Returning nothing leaves the store unchanged and yields the locked credential.
      const credential = await inner.modify(id, async current => {
        if (current?.type === "api_key" && isCommand(current.key)) refuse("its stored key runs a command, which the host never runs");
        return undefined;
      }, options);
      return credential?.type === "api_key" && credential.key !== undefined
        ? { ...credential, key: resolveConfigValue(credential.key, credential.env as Record<string, string> | undefined) } : credential;
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
  // Anywhere in the provider's entry: its key, headers, models and model overrides.
  if (strings(configured).some(isCommand)) {
    refuse(`pi's models.json runs a command for ${provider}, which the host never runs. Use a literal, an environment variable or a stored key`);
  }
  if (configured?.oauth !== undefined) refuse(`pi's models.json gives ${provider} its own login implementation, which the relay does not carry`);
  const modelsInBrain = existsSync(modelsPath) && inside(brain, realpathSync(modelsPath));
  if (modelsInBrain && literalCredential(configured)) {
    refuse(`pi's models.json is linked into the brain and holds a credential for ${provider}; reference it as $NAME or store it with pi instead`);
  }
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
    // Refused before any credential is read: the configured route must be authorized.
    if (!authorized.has(endpoint.origin)) {
      refuse(`${endpoint.origin} may not receive ${provider}'s credential; list it as ${provider}=${endpoint.origin} in BRAIN_UI_PI_CREDENTIAL_ORIGINS`);
    }
    const stored = readStoredCredential(provider, authPath) as { type?: string; key?: unknown } | undefined;
    if (stored?.type === "api_key" && isCommand(stored.key)) refuse(`pi's stored key for ${provider} runs a command, which the host never runs`);
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
        // Native precedence: configured headers override the key's own header,
        // and a null removes it; Codex sets its bearer and account last.
        const headers: Record<string, string> = {};
        const configured = (into: Record<string, string>) => {
          for (const [name, value] of Object.entries(auth.headers ?? {})) {
            if (typeof value === "string") into[name.toLowerCase()] = value; else delete into[name.toLowerCase()];
          }
        };
        if (shape === "codex_oauth") {
          configured(headers);
          if (key) { headers.authorization = `Bearer ${key}`; headers["chatgpt-account-id"] = codexAccount(key); }
        } else {
          if (key && shape === "api_key" && model.api === "anthropic-messages") headers["x-api-key"] = key;
          else if (key) headers.authorization = `Bearer ${key}`;
          configured(headers);
        }
        return headers;
      } });
    linkSync(relay.socketPath, link);
    const placeholder = shape === "codex_oauth" ? CODEX_PLACEHOLDER : shape === "anthropic_oauth" ? ANTHROPIC_OAUTH_PLACEHOLDER : INFERENCE_PLACEHOLDER;
    const credential = check.type === "oauth"
      // Far from expiry, so the worker never tries to refresh a placeholder.
      ? { type: "oauth", access: placeholder, refresh: INFERENCE_PLACEHOLDER, expires: Date.now() + 365 * 86_400_000 }
      : { type: "api_key", key: placeholder };
    // The worker keeps native model settings but no key, headers, endpoints or
    // login implementation, at any depth (models and model overrides included).
    const providerConfig = (sanitized(configured ?? {}) ?? {}) as Record<string, unknown>;
    const stoppable = relay;
    // Every variable that names or feeds this provider's credential stays on
    // the host, and so does any agent-only inference key. Keys the brain
    // CLI's own providers read stay until those are relayed (#1673).
    const credentialEnv = new Set([...findEnvKeys(provider, options.environment as Record<string, string>) ?? [],
      ...strings(configured).flatMap(templateNames), ...templateNames(stored?.key), ...AGENT_INFERENCE_CREDENTIAL_ENV,
      ...getBuiltinProviders().flatMap(other => findEnvKeys(other, options.environment as Record<string, string>) ?? [])
        .filter(name => !SUBPROCESS_ENV[name as keyof typeof SUBPROCESS_ENV]?.includes("brainCli"))]);
    return {
      worker: { provider, basePath, socket: `${WORKER_EGRESS_DIR}/inference.sock`, credential, providerConfig,
        ...(shape === "codex_oauth" ? { transport: "sse" as const } : {}) },
      credentialEnv: [...credentialEnv],
      // A models.json linked into the brain stays visible: the brain is the worker's to read.
      maskPaths: [authPath, modelsPath].filter(path => existsSync(path)).map(path => realpathSync(path)).filter(path => !inside(brain, path)),
      stop() { cleanup(link, stoppable, scratch); },
    };
  } catch (error) {
    cleanup(link, relay, scratch);
    throw error;
  }
}

/** Every step runs even when an earlier one fails; the first failure is rethrown. */
function cleanup(link: string, relay: InferenceRelay | undefined, scratch: string): void {
  const failures: unknown[] = [];
  for (const step of [() => rmSync(link, { force: true }), () => relay?.stop(), () => rmSync(scratch, { recursive: true, force: true })]) {
    try { step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}
