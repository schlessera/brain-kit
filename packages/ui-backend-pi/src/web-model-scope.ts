/**
 * The model the trusted web executor may use for one call (#3688): the
 * calling turn's admitted model, relayed by the host, and nothing else.
 *
 * The pinned extension finds Pi models, their auth and the current model
 * through its session's `ModelRegistry`, which reads the executor's own
 * `ModelRuntime`. While a call runs with a host grant, that runtime knows
 * exactly one model, the admitted one from Pi's built-in catalog, with a
 * placeholder of the host credential's kind; without a grant it knows none.
 * The session's current model is the same model, so current-model search and
 * subscription search both select it, and the runtime runs no model itself.
 *
 * A request to that model's official endpoint is handed to the host relay
 * over the executor's egress directory. The relay strips the placeholder,
 * resolves and refreshes the real credential with Pi on the host, and sends
 * only the routes of that model's API; the executor never holds the
 * credential. A request that names any other model is refused before it is
 * sent: the executor's model always matches the admitted one.
 */
import { INFERENCE_PLACEHOLDER, WORKER_EGRESS_DIR } from "@schlessera/brain-ui-sdk/internal";
import type { WebModelGrant } from "@schlessera/brain-ui-sdk/tool-contracts";

export type { WebModelGrant };

/** The relay socket every grant must name: the executor's own egress directory. */
export const WEB_MODEL_SOCKET = `${WORKER_EGRESS_DIR}/inference.sock`;

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
/** A Codex token's shape: the extension reads the account from it; the relay replaces bearer and account. */
const CODEX_PLACEHOLDER = ["{\"alg\":\"none\",\"typ\":\"JWT\"}", JSON.stringify({ [JWT_CLAIM_PATH]: { chatgpt_account_id: INFERENCE_PLACEHOLDER } })]
  .map(part => Buffer.from(part).toString("base64").replace(/=+$/, "")).join(".") + `.${INFERENCE_PLACEHOLDER}`;

/** Parse a grant from the host's call frame; anything malformed is refused, not repaired. */
export function parseWebModelGrant(value: unknown): WebModelGrant | undefined {
  if (value === undefined) return undefined;
  const grant = value as Partial<WebModelGrant> | null;
  const text = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= 200;
  if (!grant || typeof grant !== "object" || !text(grant.provider) || !text(grant.model)
    || (grant.credential !== "api_key" && grant.credential !== "oauth") || typeof grant.basePath !== "string"
    || (grant.basePath !== "" && !grant.basePath.startsWith("/")) || grant.socket !== WEB_MODEL_SOCKET) {
    throw new Error("The host sent a malformed model grant.");
  }
  return { provider: grant.provider!, model: grant.model!, credential: grant.credential, basePath: grant.basePath, socket: grant.socket };
}

interface ScopedModel { provider: string; id: string; baseUrl: string }
/** The slice of Pi's `ModelRuntime` the extension's registry reads, by method name. */
type Runtime = Record<string, unknown> & { getModel(provider: string, id: string): ScopedModel | undefined };

const MODEL_RUNS = ["stream", "streamSimple", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "generateImages", "classify"] as const;
const AUTH_WRITES = ["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey", "registerProvider", "registerNativeProvider", "unregisterProvider",
  "registerVirtualModel", "unregisterVirtualModel", "refresh"] as const;

export interface WebModelScope {
  /** The model a call holds, or undefined between calls. */
  readonly current: { grant: WebModelGrant; model: ScopedModel } | undefined;
  /** Enter a call's grant; refused when another grant is held or the model is not in Pi's catalog. */
  enter(grant: WebModelGrant | undefined): () => void;
  /** Route one request: undefined when it is not for the held model's endpoint. */
  route(input: string | URL | Request, init?: RequestInit): { url: string; init: RequestInit } | undefined;
}

/**
 * Narrow the executor's runtime to the held grant. `setCurrent` makes the
 * session's current model the held one; the catalog lookup is the runtime's
 * own, taken before narrowing.
 */
export function createWebModelScope(runtime: Runtime, setCurrent: (model: ScopedModel | undefined) => void): WebModelScope {
  const catalog = runtime.getModel.bind(runtime);
  let current: { grant: WebModelGrant; model: ScopedModel; key: string } | undefined;
  let holders = 0;
  const own = (provider: unknown) => current !== undefined && provider === current.grant.provider;
  const ownModel = (model: unknown) => typeof model === "string" ? own(model)
    : !!model && typeof model === "object" && own((model as ScopedModel).provider) && (model as ScopedModel).id === current!.model.id;
  const models = (provider?: string) => current && (provider === undefined || own(provider)) ? [current.model] : [];
  const placeholder = () => current!.grant.provider === "openai-codex" && current!.grant.credential === "oauth" ? CODEX_PLACEHOLDER : INFERENCE_PLACEHOLDER;
  const narrowed: Record<string, unknown> = {
    getModels: models, getAllModels: models, getAvailableSnapshot: () => models(),
    getAvailable: async (provider?: string) => models(provider), getAllAvailable: async (provider?: string) => models(provider),
    getModel: (provider: string, id: string) => own(provider) && id === current!.model.id ? current!.model : undefined,
    getPhysicalModel: (provider: string, id: string) => own(provider) && id === current!.model.id ? current!.model : undefined,
    hasConfiguredAuth: own,
    checkAuth: async (provider: string) => own(provider) ? { type: current!.grant.credential } : undefined,
    isUsingOAuth: (provider: string) => own(provider) && current!.grant.credential === "oauth",
    isUsingSubscription: (provider: string) => own(provider) && current!.grant.credential === "oauth",
    getProviderAuthStatus: (provider: string) => own(provider) ? { configured: true, source: "host" } : { configured: false },
    // Only the held model's placeholder: the extension never sees another credential, real or not.
    getAuth: async (model: unknown) => ownModel(model) ? { auth: { apiKey: placeholder() } } : undefined,
    listCredentials: async () => [],
  };
  for (const name of MODEL_RUNS) narrowed[name] = () => { throw new Error("The web executor runs no model of its own."); };
  for (const name of AUTH_WRITES) narrowed[name] = () => { throw new Error("The web executor cannot change models or credentials."); };
  Object.assign(runtime, narrowed);

  return {
    get current() { return current; },
    enter(grant) {
      const key = grant ? `${grant.provider}/${grant.model}\0${grant.credential}\0${grant.basePath}` : "";
      if (holders > 0 && (current?.key ?? "") !== key) throw new Error("The web executor is serving another turn's model; retry once that call has finished.");
      if (holders === 0 && grant) {
        const model = catalog(grant.provider, grant.model);
        if (!model) throw new Error(`${grant.provider}/${grant.model} is not in Pi's built-in catalog, so web search cannot use it.`);
        current = { grant, model, key };
        setCurrent(model);
      }
      holders++;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        if (--holders === 0 && current) { current = undefined; setCurrent(undefined); }
      };
    },
    route(input, init) {
      if (!current) return undefined;
      const url = new URL(input instanceof Request ? input.url : String(input));
      const official = new URL(current.model.baseUrl);
      const base = official.pathname.replace(/\/+$/, "");
      if (url.origin !== official.origin || !(url.pathname === base || url.pathname.startsWith(`${base}/`))) return undefined;
      // The extension sends a URL and a body string; anything else is not what it sends a model.
      if (input instanceof Request) throw new Error("A model request must not arrive as a Request object.");
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "POST" || typeof init?.body !== "string") throw new Error("Only the extension's model requests reach the relayed model.");
      let named: unknown;
      try { named = (JSON.parse(init.body) as { model?: unknown }).model; } catch { throw new Error("A model request body must be JSON."); }
      if (named !== current.model.id) {
        throw new Error(`The web search asked for model ${String(named)}, but this turn was admitted for ${current.grant.provider}/${current.model.id} only, so nothing was sent.`);
      }
      return { url: `http://relay${current.grant.basePath}${url.pathname.slice(base.length)}${url.search}`,
        init: { ...init, unix: current.grant.socket, keepalive: false, redirect: "manual" } as RequestInit };
    },
  };
}
