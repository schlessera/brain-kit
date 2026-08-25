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

  activityRun: (runId: string) =>
    fetchJson<ActivityRunDetail>(`/activity/runs/${encodeURIComponent(runId)}`),

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
