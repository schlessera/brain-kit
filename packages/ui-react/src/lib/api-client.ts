import { apiBase } from "./backend.js";
import type {
  VoiceKeytermsResponse,
  VoiceTokenResponse,
  VoiceSessionResponse,
  PronunciationOverride,
  ProviderInfo,
  PasskeySummary,
  BillingMode,
  ModelCatalogResponse,
  ThinkingLevel,
  ActivityRunSummary,
  ActivityRunDetail,
  ActivityRollups,
  ActivityDigest,
  ActivityIntent,
} from "@schlessera/brain-ui-sdk/protocol";

// Activity REST types live in the SDK protocol (shared with the server);
// re-exported here so existing importers keep working.
export type {
  ActivityRunSummary,
  ActivityRunDetail,
  ActivityRunRollup,
  ActivityAggregate,
  ActivityRollups,
  ActivityDigest,
  ActivityIntent,
} from "@schlessera/brain-ui-sdk/protocol";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

/**
 * One hit from `brain search`. `snippet` carries the CLI's FTS highlight
 * markers (`>>>term<<<`) — render it through `renderSnippet()` in the search
 * panel rather than printing it raw.
 */
export interface BrainSearchHit {
  path: string;
  title: string;
  type: string;
  relevance: string;
  score: number;
  snippet: string;
}

export interface BrainSearchResponse {
  results: BrainSearchHit[];
  /** Degraded-mode notices, e.g. vector search unavailable so results are FTS-only. */
  warnings: string[];
}

/**
 * Pricing-table freshness (GET /api/models/pricing) — mirrors the server
 * pricing service's state. The route is additive: an older server 404s, and
 * callers treat the rejection as "no freshness signal, show nothing".
 */
export interface PricingState {
  enabled: boolean;
  /** When a refresh last succeeded (either source); null when none ever has. */
  fetchedAt: number | null;
  /** The current table is older than the TTL (or was never fetched). */
  stale: boolean;
  /** What the table is served from: remote data (cache included) or the bundled snapshot. */
  source: "remote" | "snapshot";
  /** Last refresh failure, if the current table is served despite one. */
  error?: string;
}

/** Backend id + capability flags the client renders behavior from. */
export interface BackendInfo {
  id: string;
  capabilities: {
    concurrentSessions: boolean;
    followUp: boolean;
    [key: string]: boolean;
  };
}

/** Auth status of one configured pi provider (mirror of the server view). */
export interface PiAuthProviderStatus {
  providerId: string;
  /** Human label for the credential, e.g. "OpenAI (ChatGPT Plus/Pro)". */
  name: string;
  configured: boolean;
  source?: string;
  /** Whether this provider can be signed in through the UI. */
  oauth: boolean;
}

/** One OAuth device-code login flow (mirror of the server view). */
export interface PiLoginFlow {
  id: string;
  providerId: string;
  status: "pending" | "success" | "error" | "cancelled";
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
  error?: string;
  startedAt: number;
}

/** One managed skill row (mirror of the server view). */
export interface SkillEntry {
  name: string;
  description: string;
  /** "builtin" = shipped by brain-kit/modules (read-only); "custom" = the user's. */
  source: "builtin" | "custom";
  enabled: boolean;
  warning?: string;
}

/** One skill with its SKILL.md content. */
export interface SkillDetail extends SkillEntry {
  content: string;
  extraFiles: string[];
}

/** One selectable web-search provider (mirror of the server view). */
export interface WebSearchProvider {
  id: string;
  label: string;
  /** Whether this provider accepts an API key ("auto" does not). */
  hasKeyField: boolean;
  /** True when a key for it is stored server-side (values never travel). */
  keyConfigured: boolean;
  /** True when the provider works without any key (Exa's free tier). */
  keyless: boolean;
}

/** Web-search configuration for the pi backend's web extension. */
export interface WebSearchConfig {
  /** False when the pi backend is not configured — hide the card. */
  configured: boolean;
  provider: string;
  providers: WebSearchProvider[];
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  health: () =>
    fetchJson<{ status: string; uptime: number; version: string }>("/health"),

  vpnCheck: () => fetchJson<{ vpn: boolean }>("/vpn-check"),

  status: () =>
    fetchJson<{
      healthy: boolean;
      uptime: number;
      cronJobs: Array<{
        name: string;
        lastRunAt: number | null;
        lastStatus: string | null;
      }>;
      activeSession: boolean;
    }>("/status"),

  brainSearch: (
    q: string,
    opts?: {
      type?: string;
      tag?: string;
      limit?: number;
      mode?: "fts" | "vector" | "hybrid";
      signal?: AbortSignal;
    }
  ) =>
    // Built with encodeURIComponent rather than URLSearchParams: the latter
    // form-encodes spaces as "+", which not every query parser turns back into
    // a space. %20 is unambiguous.
    fetchJson<BrainSearchResponse>(
      `/brain/search?q=${encodeURIComponent(q)}` +
        (opts?.type ? `&type=${encodeURIComponent(opts.type)}` : "") +
        (opts?.tag ? `&tag=${encodeURIComponent(opts.tag)}` : "") +
        (opts?.limit ? `&limit=${opts.limit}` : "") +
        (opts?.mode ? `&mode=${opts.mode}` : ""),
      { signal: opts?.signal }
    ),

  brainBriefing: () =>
    fetchJson<{ content: string }>("/brain/briefing"),

  brainStats: () =>
    fetchJson<{
      documents: number;
      byType: Record<string, number>;
      byStatus: Record<string, number>;
      tags: number;
      links: number;
    }>("/brain/stats"),

  brainSync: () =>
    fetchJson<{ success: boolean; message: string }>("/brain/sync", {
      method: "POST",
    }),

  brainAdd: (content: string, opts?: { type?: string; title?: string; tags?: string[] }) =>
    fetchJson<{ success: boolean }>("/brain/add", {
      method: "POST",
      body: JSON.stringify({ content, ...opts }),
    }),

  sessions: () =>
    fetchJson<{
      sessions: Array<{
        id: string;
        title: string | null;
        createdAt: number;
        lastActiveAt: number;
      }>;
    }>("/sessions"),

  /** Mint a dictation session for the active speech provider. */
  voiceSession: (signal?: AbortSignal) =>
    fetchJson<VoiceSessionResponse>("/voice/session", { method: "POST", signal }),

  /** @deprecated use voiceSession(); kept during client transition. */
  voiceToken: () =>
    fetchJson<VoiceTokenResponse>("/voice/token", { method: "POST" }),

  voiceKeyterms: () => fetchJson<VoiceKeytermsResponse>("/voice/keyterms"),

  voiceOverrides: (signal?: AbortSignal) =>
    fetchJson<{ overrides: PronunciationOverride[] }>("/voice/overrides", {
      signal,
    }),

  providers: () =>
    fetchJson<{
      providers: ProviderInfo[];
      backends?: Record<string, BackendInfo>;
    }>("/providers"),

  /** Full model catalog for the settings screen — hidden entries included. */
  models: () => fetchJson<ModelCatalogResponse>("/models"),

  /** Replace the hidden set (full list, not a delta); returns the new catalog. */
  setHiddenModels: (hidden: string[]) =>
    fetchJson<ModelCatalogResponse>("/models/hidden", {
      method: "PUT",
      body: JSON.stringify({ hidden }),
    }),

  /** Replace the billing-override record (full record, not a delta); returns the new catalog. */
  setBillingOverrides: (billing: Record<string, BillingMode>) =>
    fetchJson<ModelCatalogResponse>("/models/billing", {
      method: "PUT",
      body: JSON.stringify({ billing }),
    }),

  /** Pricing-table freshness for the Activity staleness indicator (see `PricingState`). */
  pricingState: () => fetchJson<PricingState>("/models/pricing"),

  /** Auth status of configured pi providers; empty when pi is not in play. */
  piAuthProviders: () =>
    fetchJson<{ providers: PiAuthProviderStatus[] }>("/pi-auth/providers"),

  /** Start an OAuth device-code login; resolves once the user code exists. */
  piAuthStart: (providerId: string) =>
    fetchJson<{ flow: PiLoginFlow }>("/pi-auth/login", {
      method: "POST",
      body: JSON.stringify({ providerId }),
    }),

  /** Poll one login flow. */
  piAuthFlow: (id: string) =>
    fetchJson<{ flow: PiLoginFlow }>(`/pi-auth/login/${encodeURIComponent(id)}`),

  /** Abort a pending login flow. */
  piAuthCancel: (id: string) =>
    fetchJson<{ ok: boolean }>(`/pi-auth/login/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** Remove the stored credential for a pi provider. */
  piAuthLogout: (providerId: string) =>
    fetchJson<{ ok: boolean }>("/pi-auth/logout", {
      method: "POST",
      body: JSON.stringify({ providerId }),
    }),

  /** Custom + built-in skills, as managed from Settings → Skills. */
  skillsList: () => fetchJson<{ skills: SkillEntry[] }>("/skills"),

  /** One skill's SKILL.md and file list (builtins read-only). */
  skillGet: (name: string) =>
    fetchJson<SkillDetail>(`/skills/${encodeURIComponent(name)}`),

  /** Create a custom skill; runs `brain skills sync` server-side. */
  skillCreate: (name: string, content: string) =>
    fetchJson<{ skill: SkillEntry; warning?: string }>("/skills", {
      method: "POST",
      body: JSON.stringify({ name, content }),
    }),

  /** Replace a custom skill's SKILL.md. */
  skillUpdate: (name: string, content: string) =>
    fetchJson<{ skill: SkillEntry; warning?: string }>(`/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  /** Enable/disable a custom skill (applies to every backend at once). */
  skillSetEnabled: (name: string, enabled: boolean) =>
    fetchJson<{ skill: SkillEntry; warning?: string }>(
      `/skills/${encodeURIComponent(name)}/enabled`,
      { method: "POST", body: JSON.stringify({ enabled }) }
    ),

  /** Delete a custom skill permanently. */
  skillRemove: (name: string) =>
    fetchJson<{ ok: boolean; warning?: string }>(`/skills/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  /** Tools remembered as "always allow" (auto-approved without a card). */
  toolPermissions: () => fetchJson<{ tools: string[] }>("/tool-permissions"),

  /** Revoke one remembered tool grant; returns the updated list. */
  toolPermissionRevoke: (tool: string) =>
    fetchJson<{ tools: string[] }>(`/tool-permissions/${encodeURIComponent(tool)}`, {
      method: "DELETE",
    }),

  /** Web-search provider config; `configured: false` when pi is not in play. */
  webSearchConfig: () => fetchJson<WebSearchConfig>("/web-search"),

  /**
   * Update the web-search provider and/or stored API keys (null/"" clears a
   * key). Returns the updated config.
   */
  webSearchUpdate: (update: {
    provider?: string;
    apiKeys?: Record<string, string | null>;
  }) =>
    fetchJson<WebSearchConfig>("/web-search", {
      method: "PUT",
      body: JSON.stringify(update),
    }),

  /** Replace the reasoning-effort override record (full record, not a delta). */
  setThinkingOverrides: (thinking: Record<string, ThinkingLevel>) =>
    fetchJson<ModelCatalogResponse>("/models/thinking", {
      method: "PUT",
      body: JSON.stringify({ thinking }),
    }),

  /** Set the default model (a profile id, or null for auto); returns the new catalog. */
  setDefaultModel: (defaultId: string | null) =>
    fetchJson<ModelCatalogResponse>("/models/default", {
      method: "PUT",
      body: JSON.stringify({ defaultId }),
    }),

  /** Replace the custom OpenRouter model list (full list, not a delta). */
  setCustomModels: (models: string[]) =>
    fetchJson<ModelCatalogResponse>("/models/custom", {
      method: "PUT",
      body: JSON.stringify({ models }),
    }),

  /** Force a discovery refresh, bypassing the TTL. */
  refreshModels: () =>
    fetchJson<ModelCatalogResponse>("/models/refresh", { method: "POST" }),

  /** Password-mode login. Resolves on success; throws the server error otherwise. */
  login: (password: string) =>
    fetchJson<{ ok: true }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    fetchJson<{ ok: true }>("/auth/logout", { method: "POST" }),

  /** Which login methods the server offers (public; drives the login screen). */
  authMethods: () =>
    fetchJson<{ password: boolean; passkey: boolean }>("/auth/methods"),

  passkeyLoginOptions: () =>
    fetchJson<PublicKeyCredentialRequestOptionsJSON>("/auth/passkey/login-options", {
      method: "POST",
      body: "{}",
    }),

  passkeyLoginVerify: (response: AuthenticationResponseJSON) =>
    fetchJson<{ ok: true }>("/auth/passkey/login-verify", {
      method: "POST",
      body: JSON.stringify(response),
    }),

  passkeyRegisterOptions: () =>
    fetchJson<PublicKeyCredentialCreationOptionsJSON>("/auth/passkey/register-options", {
      method: "POST",
      body: "{}",
    }),

  passkeyRegisterVerify: (response: RegistrationResponseJSON, label?: string) =>
    fetchJson<{ ok: true; credential: PasskeySummary | null }>(
      "/auth/passkey/register-verify",
      { method: "POST", body: JSON.stringify({ response, label }) }
    ),

  passkeyList: () =>
    fetchJson<{ credentials: PasskeySummary[] }>("/auth/passkey/list"),

  passkeyRename: (id: string, label: string) =>
    fetchJson<{ ok: true }>(`/auth/passkey/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ label }),
    }),

  passkeyDelete: (id: string) =>
    fetchJson<{ ok: true }>(`/auth/passkey/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // --- Activity record (read side; live updates ride the WebSocket) ---

  activityRuns: (opts?: {
    origin?: "session" | "cron";
    job?: string;
    session?: string;
    status?: string;
    limit?: number;
    before?: number;
  }) =>
    fetchJson<{ live: ActivityRunSummary[]; history: ActivityRunSummary[] }>(
      "/activity/runs?" +
        [
          opts?.origin && `origin=${opts.origin}`,
          opts?.job && `job=${encodeURIComponent(opts.job)}`,
          opts?.session && `session=${encodeURIComponent(opts.session)}`,
          opts?.status && `status=${encodeURIComponent(opts.status)}`,
          opts?.limit && `limit=${opts.limit}`,
          opts?.before && `before=${opts.before}`,
        ]
          .filter(Boolean)
          .join("&")
    ),

  /**
   * One run's detail. Payload bodies (tool_input/tool_output events) are
   * excluded by default — the session-history fetch only needs span timings —
   * and opted into by the drill-in views via `includePayloads`.
   */
  activityRun: (runId: string, opts?: { includePayloads?: boolean }) =>
    fetchJson<ActivityRunDetail>(
      `/activity/runs/${encodeURIComponent(runId)}` +
        (opts?.includePayloads ? "?include=payloads" : "")
    ),

  activityRollups: (days?: number) =>
    fetchJson<ActivityRollups>(`/activity/rollups${days ? `?days=${days}` : ""}`),

  activityInbox: () => fetchJson<{ intents: ActivityIntent[] }>("/activity/inbox"),

  activityInboxAck: (id: number) =>
    fetchJson<{ ok: true }>(`/activity/inbox/${id}/ack`, { method: "POST" }),

  activityInboxAckAll: () =>
    fetchJson<{ acknowledged: number }>("/activity/inbox/ack-all", { method: "POST" }),

  activityDigest: () =>
    fetchJson<{ digest: ActivityDigest | null; dismissedAt: number }>("/activity/digest"),

  activityDigestDismiss: () =>
    fetchJson<{ ok: true }>("/activity/digest/dismiss", { method: "POST" }),

  pushPublicKey: () => fetchJson<{ publicKey: string }>("/push/public-key"),

  pushSubscribe: (subscription: unknown, label?: string) =>
    fetchJson<{ ok: true }>("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription, label }),
    }),

  pushUnsubscribe: (endpoint: string) =>
    fetchJson<{ removed: boolean }>("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
};
