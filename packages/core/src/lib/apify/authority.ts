/**
 * Host-owned Apify enablement, token authentication and account binding
 * (#3159, [the contract](../../../../../docs/decisions/apify-capability.md)).
 *
 * Four facts decide whether the host may make a new Apify request, and none
 * implies another: the governance policy enables the provider
 * (`apify.enabled: true`), the host holds `APIFY_TOKEN`, the fixed Apify API
 * confirms which account that token belongs to, and that account is the one
 * this host bound. While the policy leaves the provider disabled, nothing here
 * contacts Apify, however a token was supplied.
 *
 * The token stays inside this module. It is read from a closure, placed on the
 * `Authorization` header of a request to a fixed Apify origin (the REST API,
 * or the hosted MCP server for catalog calls), and compared only
 * through a keyed digest whose key never leaves the process. No status, error,
 * record or URL carries it. Callers choose neither the origin, the headers nor
 * a redirect target: a redirect is refused rather than followed.
 *
 * Authority is a generation: an opaque value that changes whenever the bound
 * account stops being usable (disablement, a missing or rejected token, a
 * different account). A {@link ApifyBinding} issued under one generation is
 * stale under every later one, so grants, reservations and result handles that
 * carry it lose their authority when the account does. Re-enabling the same
 * account starts a new generation rather than reviving the old one. A token
 * rotated to the same account keeps the generation; a token for a different
 * account needs an owner's confirmation first.
 *
 * Owned cleanup is the one exception to enablement (contract: "Disablement/
 * revocation still permits narrowly owned cleanup"): {@link ApifyAuthority.cleanupRequest}
 * reaches only a run's status or abort path, and only while the current token
 * still belongs to the binding's account. Without that, the run stays unresolved.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { checkGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";

/** The host settings key holding {@link ApifyAuthorityRecord}. */
export const APIFY_AUTHORITY_SETTING = "apify.authority";
/** The REST origin the host sends an Apify token to; {@link APIFY_MCP_ORIGIN} is the only other. */
export const APIFY_API_ORIGIN = "https://api.apify.com";
/**
 * The hosted Apify MCP server, used only for catalog discovery and formatted
 * inspection (#3160). The host loads exactly {@link APIFY_CATALOG_TOOLS} and
 * turns its telemetry off; no execution tool ever connects.
 */
export const APIFY_MCP_ORIGIN = "https://mcp.apify.com";
/** The only MCP tools the host requests. Neither starts a run or spends. */
export const APIFY_CATALOG_TOOLS = ["search-actors", "fetch-actor-details"] as const;
export type ApifyCatalogTool = typeof APIFY_CATALOG_TOOLS[number];
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);
const MCP_SESSION_ID = /^[\x21-\x7e]{1,256}$/;
/** The account the token belongs to (`GET /v2/users/me`). */
const IDENTITY_PATH = "/v2/users/me";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/** How long a verified account answers a status read without asking again. */
const STATUS_TTL_MS = 5 * 60_000;
const PATH = /^\/v2(?:\/[A-Za-z0-9~._-]+)+$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ACCOUNT_ID = /^[A-Za-z0-9]{1,64}$/;
/** Owned cleanup reaches one run's status or abort, nothing else. */
const CLEANUP_PATH = /^\/v2\/actor-runs\/[A-Za-z0-9]{1,64}(\/abort)?$/;

export type ApifyState = "disabled" | "authentication_required" | "configured" | "unavailable";
export type ApifyStateReason =
  | "not_enabled" | "policy_invalid"
  | "token_missing" | "token_rejected" | "account_changed"
  | "upstream_unreachable" | "upstream_incompatible";

/** The account identity the fixed API reported. Never an email or plan. */
export interface ApifyAccount { readonly id: string; readonly username: string | null }

export interface ApifyStatus {
  state: ApifyState;
  reason: ApifyStateReason | null;
  /** The account this host is bound to, when one is. */
  account: ApifyAccount | null;
  /** The token's different account awaiting an owner's confirmation (`account_changed`). */
  pending_account: ApifyAccount | null;
  /** When the token's account was last verified, ISO 8601. */
  checked_at: string | null;
}

/** Stable refusal codes; the first four are the contract's machine codes. */
export type ApifyRefusalCode = "provider_disabled" | "authentication_required" | "proposal_stale" | "upstream_incompatible" | "provider_unavailable";

/** A refusal whose message is fixed, actionable and never carries a secret or upstream text. */
export class ApifyAuthorityError extends Error {
  constructor(readonly code: ApifyRefusalCode, readonly reason: ApifyStateReason | null, message: string) {
    super(message);
    this.name = "ApifyAuthorityError";
  }
}

/** The account and authority generation a later grant, reservation or handle binds to. */
export interface ApifyBinding { readonly account_id: string; readonly generation: string }

export interface ApifyAdmission { readonly account: ApifyAccount; readonly binding: ApifyBinding }

/** Durable private host state; never Markdown, never `brain.db`, never a worker file. */
export interface ApifyAuthorityRecord {
  version: 1;
  generation: string;
  /** Whether `generation` currently authorizes new requests for `account`. */
  live: boolean;
  account: ApifyAccount | null;
  /** The next verified account must be confirmed by an owner, even the first. */
  confirm_required: boolean;
}

export interface ApifyAuthorityStore {
  read(): unknown;
  write(record: ApifyAuthorityRecord): void | Promise<void>;
}

/** What the governance policy says, read anew on every decision. */
export interface ApifyPolicyView { valid: boolean; enabled: boolean }

export interface ApifyRequest {
  method: "GET" | "POST";
  /** A path on the fixed origin, such as `/v2/actor-runs/abc`. No query, no host. */
  path: string;
  query?: Readonly<Record<string, string | number | boolean>>;
  body?: unknown;
  signal?: AbortSignal;
}
export interface ApifyResponse { readonly status: number; readonly data: unknown }

/** One catalog tool call on the hosted MCP server. */
export interface ApifyCatalogCall {
  tool: ApifyCatalogTool;
  arguments: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}
/** A catalog tool's result envelope, unvalidated beyond its shape: remote, untrusted text and data. */
export interface ApifyCatalogResult {
  readonly structured: unknown;
  readonly text: string | null;
  /** The tool reported an error (an unknown Actor, say); nothing was searched or found. */
  readonly isError: boolean;
}

export interface ApifyAuthorityOptions {
  policy: () => ApifyPolicyView;
  token: () => string | undefined;
  store: ApifyAuthorityStore;
  /** @internal Test seam for a loopback fake; production always uses {@link APIFY_API_ORIGIN}. */
  origin?: string;
  /** @internal Test seam for a loopback fake; production always uses {@link APIFY_MCP_ORIGIN}. */
  mcpOrigin?: string;
  /** @internal Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** The brain's governance policy, read as data on every call. An invalid policy disables Apify. */
export function governanceApifyPolicy(brainPath: string): () => ApifyPolicyView {
  return () => {
    const checked = checkGovernancePolicy(brainPath);
    return { valid: checked.ok, enabled: checked.ok && checked.effective.apify.enabled === true };
  };
}

const MESSAGES: Record<ApifyStateReason, string> = {
  not_enabled: "Apify is disabled. Set apify.enabled: true in context/policies/governance.md to enable it.",
  policy_invalid: "Apify is disabled because context/policies/governance.md is invalid. Repair it (brain policy check) before using Apify.",
  token_missing: "Apify is enabled but the host has no APIFY_TOKEN. Set it in the server environment and restart the server.",
  token_rejected: "Apify rejected the host's APIFY_TOKEN as invalid, expired or revoked. Replace it in the server environment and restart the server.",
  account_changed: "The host's APIFY_TOKEN belongs to a different Apify account than the one this host is bound to. An owner must confirm the new account in Settings before Apify can be used.",
  upstream_unreachable: "The Apify API could not be reached to verify the account. Try again later.",
  upstream_incompatible: "The Apify API returned a response this host does not recognise, so nothing was done with it.",
};
const STATE: Record<ApifyStateReason, ApifyState> = {
  not_enabled: "disabled", policy_invalid: "disabled",
  token_missing: "authentication_required", token_rejected: "authentication_required", account_changed: "authentication_required",
  upstream_unreachable: "unavailable", upstream_incompatible: "unavailable",
};
const CODE: Record<ApifyState, ApifyRefusalCode> = {
  disabled: "provider_disabled", authentication_required: "authentication_required", unavailable: "provider_unavailable", configured: "provider_unavailable",
};

const refusal = (reason: ApifyStateReason) =>
  new ApifyAuthorityError(reason === "upstream_incompatible" ? "upstream_incompatible" : CODE[STATE[reason]], reason, MESSAGES[reason]);
const stale = () => new ApifyAuthorityError("proposal_stale", null,
  "The Apify authority this operation was bound to no longer holds: the provider was disabled, its credential changed or the account changed. Start again.");

function parseRecord(value: unknown): ApifyAuthorityRecord | "unreadable" | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") return "unreadable";
  const record = value as Partial<ApifyAuthorityRecord>;
  const account = record.account;
  const accountOk = account === null || (!!account && typeof account === "object" && typeof account.id === "string" && ACCOUNT_ID.test(account.id)
    && (account.username === null || typeof account.username === "string"));
  if (record.version !== 1 || typeof record.generation !== "string" || !record.generation || typeof record.live !== "boolean"
    || !accountOk || typeof record.confirm_required !== "boolean") return "unreadable";
  return { version: 1, generation: record.generation, live: record.live, account: account ? { id: account.id, username: account.username } : null, confirm_required: record.confirm_required };
}

type Verification =
  | { kind: "account"; account: ApifyAccount }
  | { kind: "refused"; reason: "token_rejected" | "upstream_unreachable" | "upstream_incompatible" };

export interface ApifyAuthority {
  /** Truthful current state. Contacts Apify only while enabled with a token, at most once per TTL unless `refresh`. */
  status(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<ApifyStatus>;
  /** Live admission of a new call: re-reads policy, re-verifies the account. Throws {@link ApifyAuthorityError}. */
  admit(options?: { signal?: AbortSignal }): Promise<ApifyAdmission>;
  /** Whether a binding still authorizes new work. Throws `provider_disabled`/`proposal_stale` when it does not. */
  check(binding: ApifyBinding): Promise<void>;
  /** A new-work request on the fixed origin under a current binding. */
  request(binding: ApifyBinding, request: ApifyRequest): Promise<ApifyResponse>;
  /**
   * One catalog call (`search-actors` or `fetch-actor-details`) on the fixed
   * MCP origin under a current binding (#3160). Callers own the consent; this
   * owns the recipient, the credential and the envelope.
   */
  catalog(binding: ApifyBinding, call: ApifyCatalogCall): Promise<ApifyCatalogResult>;
  /** Owned cleanup of one run (status or abort), permitted after disablement while the account still matches. */
  cleanupRequest(binding: ApifyBinding, request: ApifyRequest): Promise<ApifyResponse>;
  /** An owner accepts the token's current account, starting a new generation. */
  confirmAccount(accountId: string, options?: { signal?: AbortSignal }): Promise<ApifyStatus>;
}

export function createApifyAuthority(options: ApifyAuthorityOptions): ApifyAuthority {
  const origin = options.origin ?? APIFY_API_ORIGIN;
  const mcpOrigin = options.mcpOrigin ?? APIFY_MCP_ORIGIN;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // The digest key lives and dies with this process; nothing persists a token digest.
  const digestKey = randomBytes(32);
  const fingerprint = (token: string) => createHmac("sha256", digestKey).update(token).digest("hex");

  const loaded = parseRecord(options.store.read());
  let record: ApifyAuthorityRecord = loaded === null
    ? { version: 1, generation: randomUUID(), live: false, account: null, confirm_required: false }
    : loaded === "unreadable"
      // Unreadable state cannot vouch for any account: require confirmation.
      ? { version: 1, generation: randomUUID(), live: false, account: null, confirm_required: true }
      : loaded;
  let verified: { fingerprint: string; account: ApifyAccount; at: number } | null = null;
  let pending: { fingerprint: string; account: ApifyAccount } | null = null;
  const inflight = new Map<string, Promise<Verification>>();
  let writes: Promise<void> = Promise.resolve();

  /** Serialized durable transitions; the in-memory record changes only after the write lands. */
  function transition(change: (current: ApifyAuthorityRecord) => ApifyAuthorityRecord | null): Promise<void> {
    const next = writes.then(async () => {
      const updated = change(record);
      if (!updated) return;
      await options.store.write(updated);
      record = updated;
    });
    writes = next.catch(() => undefined);
    return next;
  }
  /** The bound account stopped authorizing new work: every earlier binding goes stale. */
  const revoke = () => transition(current => current.live ? { ...current, live: false, generation: randomUUID() } : null);

  async function send(token: string, request: ApifyRequest): Promise<ApifyResponse> {
    if (!PATH.test(request.path) || request.path.split("/").some(part => part === "." || part === ".."))
      throw new TypeError("Refused an Apify request outside the fixed API paths.");
    const url = new URL(request.path, origin);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      // The API also accepts a token parameter; a URL never carries one here.
      if (!QUERY_KEY.test(key) || key.toLowerCase() === "token")
        throw new TypeError("Refused an Apify request with an unsupported query parameter.");
      url.searchParams.set(key, String(value));
    }
    if (url.origin !== new URL(origin).origin || url.pathname !== request.path)
      throw new TypeError("Refused an Apify request outside the fixed API origin.");
    const { response, bytes } = await transmit(token, url, { method: request.method, accept: "application/json",
      ...(request.body !== undefined ? { body: request.body } : {}), ...(request.signal ? { signal: request.signal } : {}) });
    let data: unknown = null;
    if (bytes.length) {
      try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw refusal("upstream_incompatible"); }
    }
    return { status: response.status, data };
  }

  /** The one place a token leaves this module: a bearer header on a fixed-origin URL, no redirects, a bounded body. */
  async function transmit(token: string, url: URL, init: { method: "GET" | "POST" | "DELETE"; accept: string; body?: unknown;
    headers?: Readonly<Record<string, string>>; signal?: AbortSignal }): Promise<{ response: Response; bytes: Uint8Array }> {
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${token}`, Accept: init.accept };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const signals = [AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])];
    let response: Response;
    try {
      response = await fetchImpl(url, { method: init.method, headers, redirect: "manual", signal: AbortSignal.any(signals),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    } catch {
      throw refusal("upstream_unreachable");
    }
    // A redirect would carry the Authorization header to a recipient nobody chose.
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => undefined); throw refusal("upstream_incompatible"); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => undefined); throw refusal("token_rejected"); }
    if (response.status === 429 || response.status >= 500) { await response.body?.cancel().catch(() => undefined); throw refusal("upstream_unreachable"); }
    return { response, bytes: await boundedBody(response, maxBytes) };
  }

  /**
   * A minimal Streamable HTTP MCP exchange: initialize, initialized, one
   * `tools/call`, then a best-effort session close. The URL is fixed to the
   * two catalog tools with telemetry off, so no execution helper is loaded
   * and no session id or use-case text is reported upstream as telemetry.
   */
  async function catalogExchange(token: string, call: ApifyCatalogCall): Promise<ApifyCatalogResult> {
    const url = new URL("/", mcpOrigin);
    url.searchParams.set("tools", APIFY_CATALOG_TOOLS.join(","));
    url.searchParams.set("telemetry-enabled", "false");
    if (url.origin !== new URL(mcpOrigin).origin) throw new TypeError("Refused an Apify catalog request outside the fixed MCP origin.");
    let session: string | null = null;
    const rpc = async (message: Record<string, unknown>): Promise<unknown> => {
      const { response, bytes } = await transmit(token, url, { method: "POST", accept: "application/json, text/event-stream", body: message,
        headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, ...(session ? { "Mcp-Session-Id": session } : {}) },
        ...(call.signal ? { signal: call.signal } : {}) });
      if (!("id" in message)) {
        if (response.status !== 202 && response.status !== 200 && response.status !== 204) throw refusal("upstream_incompatible");
        return null;
      }
      if (response.status !== 200) throw refusal("upstream_incompatible");
      const header = response.headers.get("mcp-session-id");
      if (header !== null) {
        if (!MCP_SESSION_ID.test(header) || (session !== null && header !== session)) throw refusal("upstream_incompatible");
        session = header;
      }
      return rpcResult(response.headers.get("content-type") ?? "", bytes, message.id as number);
    };
    try {
      const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "brain-kit", version: "1" } } });
      const version = (initialized as { protocolVersion?: unknown } | null)?.protocolVersion;
      if (typeof version !== "string" || !MCP_PROTOCOL_VERSIONS.has(version)) throw refusal("upstream_incompatible");
      await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
      const result = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: call.tool, arguments: call.arguments } });
      if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) throw refusal("upstream_incompatible");
      const envelope = result as { content: unknown[]; structuredContent?: unknown; isError?: unknown };
      const text = envelope.content.flatMap(part => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n");
      return { structured: envelope.structuredContent ?? null, text: text || null, isError: envelope.isError === true };
    } finally {
      if (session) {
        const closing = session;
        // Best effort: the server expires an abandoned session on its own.
        await transmit(token, url, { method: "DELETE", accept: "application/json", headers: { "Mcp-Session-Id": closing, "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } })
          .catch(() => undefined);
      }
    }
  }

  function verify(token: string, signal?: AbortSignal): Promise<Verification> {
    const key = fingerprint(token);
    const existing = inflight.get(key);
    if (existing) return existing;
    const attempt = (async (): Promise<Verification> => {
      try {
        const response = await send(token, { method: "GET", path: IDENTITY_PATH, signal });
        const data = (response.data as { data?: { id?: unknown; username?: unknown } } | null)?.data;
        if (response.status !== 200 || !data || typeof data.id !== "string" || !ACCOUNT_ID.test(data.id)
          || (data.username !== undefined && data.username !== null && typeof data.username !== "string"))
          return { kind: "refused", reason: "upstream_incompatible" };
        const username = typeof data.username === "string" ? data.username.slice(0, 256) : null;
        return { kind: "account", account: { id: data.id, username } };
      } catch (error) {
        if (error instanceof ApifyAuthorityError && (error.reason === "token_rejected" || error.reason === "upstream_unreachable" || error.reason === "upstream_incompatible"))
          return { kind: "refused", reason: error.reason };
        return { kind: "refused", reason: "upstream_unreachable" };
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, attempt);
    return attempt;
  }

  const view = (state: ApifyState, reason: ApifyStateReason | null): ApifyStatus => ({
    state, reason, account: record.account,
    pending_account: reason === "account_changed" ? pending?.account ?? null : null,
    checked_at: verified ? new Date(verified.at).toISOString() : null,
  });
  const refused = async (reason: ApifyStateReason): Promise<ApifyStatus> => {
    // Not knowing (unreachable/incompatible) proves nothing about the account.
    if (STATE[reason] !== "unavailable") await revoke();
    return view(STATE[reason], reason);
  };

  async function status(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ApifyStatus> {
    const policy = options.policy();
    if (!policy.valid) return refused("policy_invalid");
    if (!policy.enabled) return refused("not_enabled");
    const token = options.token();
    if (!token) { verified = null; return refused("token_missing"); }
    const key = fingerprint(token);
    let account: ApifyAccount;
    if (!opts.refresh && verified?.fingerprint === key && now() - verified.at < STATUS_TTL_MS) account = verified.account;
    else {
      const outcome = await verify(token, opts.signal);
      if (outcome.kind === "refused") {
        if (outcome.reason === "token_rejected") verified = null;
        return refused(outcome.reason);
      }
      account = outcome.account;
      verified = { fingerprint: key, account, at: now() };
    }
    if (record.confirm_required || (record.account && record.account.id !== account.id)) {
      pending = { fingerprint: key, account };
      return refused("account_changed");
    }
    pending = null;
    // First account, or the bound one again (same account, possibly a rotated token).
    await transition(current => current.live && current.account?.id === account.id && current.account.username === account.username ? null
      : { ...current, live: true, account, generation: current.live && current.account?.id === account.id ? current.generation : randomUUID() });
    return view("configured", null);
  }

  async function check(binding: ApifyBinding): Promise<void> {
    const policy = options.policy();
    if (!policy.valid || !policy.enabled) {
      const reason = policy.valid ? "not_enabled" : "policy_invalid";
      await revoke();
      throw refusal(reason);
    }
    if (!record.live || !record.account || record.account.id !== binding.account_id || record.generation !== binding.generation) throw stale();
  }

  /** The current token belongs to `accountId`, verified on this token at least once. */
  async function tokenFor(accountId: string, signal?: AbortSignal): Promise<string> {
    const token = options.token();
    if (!token) throw refusal("token_missing");
    const key = fingerprint(token);
    let account = verified?.fingerprint === key ? verified.account : null;
    if (!account) {
      const outcome = await verify(token, signal);
      if (outcome.kind === "refused") throw refusal(outcome.reason);
      account = outcome.account;
      verified = { fingerprint: key, account, at: now() };
    }
    if (account.id !== accountId) throw refusal("account_changed");
    return token;
  }

  async function guarded(token: string, request: ApifyRequest): Promise<ApifyResponse> {
    try { return await send(token, request); }
    catch (error) {
      if (error instanceof ApifyAuthorityError && error.reason === "token_rejected") { verified = null; await revoke(); }
      throw error;
    }
  }

  return {
    status,
    async admit(opts = {}) {
      const current = await status({ refresh: true, signal: opts.signal });
      if (current.state !== "configured" || !record.account) throw refusal(current.reason ?? "upstream_unreachable");
      return Object.freeze({ account: record.account, binding: Object.freeze({ account_id: record.account.id, generation: record.generation }) });
    },
    check,
    async request(binding, request) {
      await check(binding);
      let token: string;
      try { token = await tokenFor(binding.account_id, request.signal); }
      catch (error) {
        if (error instanceof ApifyAuthorityError && error.reason !== "upstream_unreachable" && error.reason !== "upstream_incompatible") await revoke();
        throw error;
      }
      await check(binding);
      return guarded(token, request);
    },
    async catalog(binding, call) {
      if (!(APIFY_CATALOG_TOOLS as readonly string[]).includes(call.tool)) throw new TypeError("Refused an Apify MCP tool outside the catalog tools.");
      await check(binding);
      let token: string;
      try { token = await tokenFor(binding.account_id, call.signal); }
      catch (error) {
        if (error instanceof ApifyAuthorityError && error.reason !== "upstream_unreachable" && error.reason !== "upstream_incompatible") await revoke();
        throw error;
      }
      await check(binding);
      try { return await catalogExchange(token, call); }
      catch (error) {
        if (error instanceof ApifyAuthorityError && error.reason === "token_rejected") { verified = null; await revoke(); }
        throw error;
      }
    },
    async cleanupRequest(binding, request) {
      const allowed = (request.method === "GET" && CLEANUP_PATH.test(request.path) && !request.path.endsWith("/abort"))
        || (request.method === "POST" && CLEANUP_PATH.test(request.path) && request.path.endsWith("/abort"));
      if (!allowed) throw new TypeError("Owned cleanup reaches only a run's status or abort.");
      // Deliberately no enablement check: disablement still lets owned work be stopped.
      return guarded(await tokenFor(binding.account_id, request.signal), request);
    },
    async confirmAccount(accountId, opts = {}) {
      const policy = options.policy();
      if (!policy.valid) throw refusal("policy_invalid");
      if (!policy.enabled) throw refusal("not_enabled");
      const token = options.token();
      if (!token) throw refusal("token_missing");
      const outcome = await verify(token, opts.signal);
      if (outcome.kind === "refused") { if (outcome.reason === "token_rejected") await revoke(); throw refusal(outcome.reason); }
      verified = { fingerprint: fingerprint(token), account: outcome.account, at: now() };
      if (outcome.account.id !== accountId)
        throw new ApifyAuthorityError("proposal_stale", "account_changed", "The host's APIFY_TOKEN does not belong to the account being confirmed. Reload and review the account again.");
      pending = null;
      const account = outcome.account;
      await transition(current => !current.confirm_required && current.live && current.account?.id === account.id ? null
        : { version: 1, live: true, account, confirm_required: false, generation: randomUUID() });
      return view("configured", null);
    },
  };
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      throw refusal("upstream_incompatible");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** The JSON-RPC result for `id` from a JSON or event-stream response; an error or anything else is incompatible. */
function rpcResult(contentType: string, bytes: Uint8Array, id: number): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw refusal("upstream_incompatible"); }
  const messages: unknown[] = [];
  try {
    if (contentType.toLowerCase().startsWith("text/event-stream")) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) messages.push(JSON.parse(data));
      }
    } else messages.push(JSON.parse(text));
  } catch { throw refusal("upstream_incompatible"); }
  const reply = messages.flat().find(message => !!message && typeof message === "object" && (message as { id?: unknown }).id === id) as
    { jsonrpc?: unknown; result?: unknown; error?: unknown } | undefined;
  if (!reply || reply.jsonrpc !== "2.0" || reply.error !== undefined || !reply.result || typeof reply.result !== "object") throw refusal("upstream_incompatible");
  return reply.result;
}
