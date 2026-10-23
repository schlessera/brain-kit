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
import { AGENT_INFERENCE_CREDENTIAL_ENV, INFERENCE_PLACEHOLDER, startInferenceRelay, WORKER_EGRESS_DIR,
  type InferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { operatorAdmittedEnvNames, readEnvVar } from "./config/env.js";

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
type Entry = Record<string, unknown>;
const record = (value: unknown): Entry | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Entry : undefined;
/** The objects pi reads a key, headers or an endpoint from: the provider, its model definitions and its model overrides. */
function credentialSites(provider: Entry | undefined): Entry[] {
  if (!provider) return [];
  const models = Array.isArray(provider.models) ? provider.models.map(record) : [];
  const overrides = Object.values(record(provider.modelOverrides) ?? {}).map(record);
  return [provider, ...models, ...overrides].filter((site): site is Entry => site !== undefined);
}
/** The values pi resolves as configuration values, where a command or a credential can live. */
const credentialValues = (site: Entry): unknown[] => [site.apiKey, ...Object.values(record(site.headers) ?? {})];
/** Fields that carry a credential or select where it goes; the worker never receives them. */
const PROVIDER_DROPPED = ["apiKey", "headers", "baseUrl", "authHeader", "oauth"], MODEL_DROPPED = ["headers", "baseUrl"];
const without = (entry: Entry, names: readonly string[]): Entry => Object.fromEntries(Object.entries(entry).filter(([name]) => !names.includes(name)));
export function sanitized(provider: Entry | undefined): Entry {
  if (!provider) return {};
  const result = without(provider, PROVIDER_DROPPED);
  if (Array.isArray(provider.models)) result.models = provider.models.map(model => record(model) ? without(model as Entry, MODEL_DROPPED) : model);
  const overrides = record(provider.modelOverrides);
  if (overrides) result.modelOverrides = Object.fromEntries(Object.entries(overrides).map(([id, entry]) => [id, record(entry) ? without(entry as Entry, MODEL_DROPPED) : entry]));
  return result;
}
const ENV_REFERENCE = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g;
/**
 * Whether a configuration value carries literal secret material. Only pi's
 * own environment references are safe; an escape (`$$`, `$!`) or an invalid
 * reference stays literal in pi, so it counts as literal here. An
 * authorization scheme word alone is not a secret.
 */
export function literalValue(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  if (value.includes("$$") || value.includes("$!")) return true;
  const rest = value.replace(ENV_REFERENCE, "");
  return rest.includes("$") || !/^\s*(?:Bearer|Basic|Token)?\s*$/i.test(rest);
}
/** A literal key, or a literal value in a credential-like header, anywhere a provider's credential can live. */
const literalCredential = (provider: unknown): boolean => credentialSites(record(provider)).some(site =>
  literalValue(site.apiKey) || Object.entries(record(site.headers) ?? {}).some(([name, value]) => /auth|key|token|secret|cookie/i.test(name) && literalValue(value)));
/** Environment variables a `$NAME` or `${NAME}` template reads. */
const templateNames = (value: unknown): string[] => typeof value === "string"
  ? [...value.matchAll(ENV_REFERENCE)].map(match => match[0].replace(/^\$\{?|\}$/g, "")) : [];
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

/**
 * The pi model a relayed turn would use, resolved as the relay resolves it:
 * from a private snapshot of the provider's own `models.json` entry over
 * pi's built-in catalog. No credential is read.
 */
async function relayModel(provider: string, modelId: string, configured: Record<string, unknown> | undefined, scratch: string,
  credentials: CredentialStore | undefined, signal: AbortSignal | undefined): Promise<{ runtime: ModelRuntime; model: Model<Api> | undefined }> {
  writeFileSync(join(scratch, "models.json"), JSON.stringify({ providers: configured ? { [provider]: configured } : {} }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({ ...(credentials ? { credentials } : { authPath: join(scratch, "auth.json") }),
    modelsPath: join(scratch, "models.json"), modelsStorePath: join(scratch, "models-store.json"),
    refreshOnCreate: false, allowModelNetwork: false, ...(signal ? { signal } : {}) });
  return { runtime, model: runtime.getModel(provider, modelId) };
}

/**
 * The exact origin a relayed turn on this provider and model would reach
 * (#2695): what turn admission names the recipient from. Undefined when it
 * cannot be resolved, which leaves the turn's provider folders masked.
 */
export async function piRelayOrigin(options: { provider: string; modelId: string; agentDir: string; signal?: AbortSignal }): Promise<string | undefined> {
  const scratch = mkdtempSync(join(tmpdir(), "brain-pi-origin-"));
  chmodSync(scratch, 0o700);
  try {
    const modelsPath = join(options.agentDir, "models.json");
    const models = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, Record<string, unknown>> } : {};
    const { model } = await relayModel(options.provider, options.modelId, models.providers?.[options.provider], scratch, undefined, options.signal);
    return model ? new URL(model.baseUrl).origin : undefined;
  } catch { return undefined; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function preparePiHostInference(options: {
  provider: string; modelId: string; agentDir: string; brainPath: string;
  /** The origin turn admission proved the recipient from (#2695); any other endpoint refuses before a credential is read. */
  recipientOrigin?: string;
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
  if (credentialSites(configured).flatMap(credentialValues).some(isCommand)) {
    refuse(`pi's models.json runs a command for ${provider}, which the host never runs. Use a literal, an environment variable or a stored key`);
  }
  if (configured?.oauth !== undefined) refuse(`pi's models.json gives ${provider} its own login implementation, which the relay does not carry`);
  const modelsInBrain = existsSync(modelsPath) && inside(brain, realpathSync(modelsPath));
  // The whole file is the worker's to read, so every provider's entry counts.
  if (modelsInBrain && Object.values(models.providers ?? {}).some(literalCredential)) {
    refuse("pi's models.json is linked into the brain and holds a credential; reference it as $NAME or store it with pi instead");
  }
  const authorized = new Set([...firstPartyOrigins(provider), ...piCredentialOrigins().get(provider) ?? []]);

  // A private snapshot: only this provider, so the host runtime can never
  // reach another provider's command, and no edit during the turn reroutes it.
  const scratch = mkdtempSync(join(tmpdir(), "brain-pi-host-"));
  chmodSync(scratch, 0o700);
  let relay: InferenceRelay | undefined;
  const link = join(options.egress.dir, "inference.sock");
  try {
    const { runtime, model } = await relayModel(provider, options.modelId, configured, scratch, await guardedCredentials(authPath, provider), options.signal);
    if (!model) refuse(`${provider}/${options.modelId} is not a configured pi model`);
    const routes = routesFor(model);
    if (!routes) refuse(`${provider}/${model.id} uses the ${model.api} API, which the relay does not carry`);
    const endpoint = new URL(model.baseUrl);
    // Refused before any credential is read: the configured route must be authorized.
    if (!authorized.has(endpoint.origin)) {
      refuse(`${endpoint.origin} may not receive ${provider}'s credential; list it as ${provider}=${endpoint.origin} in BRAIN_UI_PI_CREDENTIAL_ORIGINS`);
    }
    // Provider folders were admitted for the recipient at one origin (#2695).
    if (options.recipientOrigin !== undefined && endpoint.origin !== options.recipientOrigin) {
      refuse(`${provider}/${model.id} now reaches ${endpoint.origin}, not ${options.recipientOrigin}, the recipient this turn's provider folders were admitted for; retry the turn`);
    }
    const stored = readStoredCredential(provider, authPath) as { type?: string; key?: unknown } | undefined;
    if (stored?.type === "api_key" && isCommand(stored.key)) refuse(`pi's stored key for ${provider} runs a command, which the host never runs`);
    const check = await runtime.checkAuth(provider, options.signal ? { signal: options.signal } : undefined);
    if (!check) refuse(`pi has no credential for ${provider}`);
    const first = await runtime.getAuth(model, options.signal ? { signal: options.signal } : {});
    const shape = shapeOf(model, check.type, first?.auth.apiKey);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    relay = startInferenceRelay({ upstream: model.baseUrl, routes, egress: options.egress,
      ...(options.recipientOrigin !== undefined ? { recipientOrigin: options.recipientOrigin } : {}),
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
    const providerConfig = sanitized(configured);
    const stoppable = relay;
    // Every variable that names or feeds this provider's credential stays on
    // the host, and so does any agent-only inference key. Keys the brain
    // CLI's own providers read stay until those are relayed (#1673).
    const credentialEnv = new Set([...findEnvKeys(provider, options.environment as Record<string, string>) ?? [],
      ...credentialSites(configured).flatMap(credentialValues).flatMap(templateNames), ...templateNames(stored?.key),
      // An operator who admits one of these to tools explicitly keeps it.
      ...AGENT_INFERENCE_CREDENTIAL_ENV.filter(name => !operatorAdmittedEnvNames().includes(name))]);
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
