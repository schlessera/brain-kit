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
  ActivityRuntimeStats,
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
  ActivityRuntimeStats,
} from "@schlessera/brain-ui-sdk/protocol";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

/**
 * `brain stats --json`, passed through by `GET /api/brain/stats` — the corpus
 * half of /stats (`docs/integration-contract.md`, "brain stats --json").
 * Restated rather than imported: this package may not depend on the CLI's.
 * A figure that could not be measured is `null`, never `0`.
 */
export interface CorpusStats {
  documents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byRelevance: Record<string, number>;
  tags: number;
  links: number;
  brokenLinks: number;
  chunks: number;
  /** Stored vectors; `0` with no vector table, `null` when one could not be counted. */
  embeddings: number | null;
  health: {
    brokenLinkRate: number | null;
    /** `null` when the brain neither embeds nor holds vectors, has no chunks, or the count failed. */
    embeddingCoverage: number | null;
    stale: number;
    orphans: number;
    untagged: number;
    thresholds: { coverageFloor: number; brokenLinkCeiling: number };
  };
  size: {
    corpus: { bytes: number; files: number } | null;
    db: {
      bytes: number | null;
      tables: Record<string, number>;
      vectorSlots: { live: number | null; allocated: number | null };
    };
    freeBytes: number | null;
  };
}

/**
 * `brain stats --history --json`, passed through by
 * `GET /api/brain/stats/history` (additive in 0.40.0): the daily snapshots,
 * oldest first, one array per field, so `dates[i]` names `documents[i]`. A
 * slot is `null` where that snapshot has no figure, never `0`. Only the
 * fields the PWA draws are typed; the rest pass through.
 */
export interface CorpusStatsHistory {
  dates: string[];
  documents: (number | null)[];
  health: {
    brokenLinkRate: (number | null)[];
    embeddingCoverage: (number | null)[];
    stale: (number | null)[];
    orphans: (number | null)[];
    untagged: (number | null)[];
  };
}

/**
 * One hit from `brain search`. `snippet` carries the CLI's FTS highlight
 * markers (`>>>term<<<`) — render it through `renderSnippet()` in the search
 * panel rather than printing it raw.
 */
/** `GET /api/geo/coastline`: `[lon, lat]` polylines by tier, plus closed land rings. */
export interface CoastlineGeometry {
  coastline: [number, number][][];
  roads: [number, number][][];
  streets: [number, number][][];
  land: [number, number][][];
  detail: "coast" | "roads" | "streets";
  partial: boolean;
  toleranceM: number;
  attribution: string;
}

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

/** One active browser/device or delegated agent credential. */
export interface PrincipalSummary {
  id: string;
  kind: "owner" | "agent" | "ambient" | "system";
  auth_method: "password" | "passkey" | "delegated" | "ambient";
  label: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  is_own: boolean;
}

/** The response to minting an agent. `cookie` is intentionally returned once. */
export interface MintedAgent {
  id: string;
  label: string;
  expiresAt: number;
  cookie: string;
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

/** Per-skill result of an archive/GitHub install. */
export interface SkillInstallOutcome {
  name: string;
  status: "installed" | "replaced" | "skipped";
  reason?: string;
  files?: number;
}

/** One toggleable web-search provider (mirror of the server view). */
export interface WebSearchProvider {
  id: string;
  label: string;
  /** In the active chain. */
  enabled: boolean;
  /** Whether this provider accepts an API key. */
  hasKeyField: boolean;
  /** True when a key for it is stored server-side (values never travel). */
  keyConfigured: boolean;
  /** Its key comes from the environment instead — not editable here. */
  keyFromEnv: boolean;
  /** True when the provider works without any credential. */
  keyless: boolean;
  /** Qualitative cost note, e.g. "Free tier, rate-limited". */
  costNote: string;
  /** What the provider is good at. */
  blurb: string;
}

/** Web-search configuration for the pi backend's web extension. */
export interface WebSearchConfig {
  /** False when the pi backend is not configured — hide the card. */
  configured: boolean;
  /** The enabled chain, cheapest first. Empty = the extension chooses. */
  order: string[];
  /**
   * Set when a single-provider selection in the config file is overriding the
   * chain (a pre-toggle config, or pi's own /curator command). Until it is
   * cleared, the chain below is not what actually runs.
   */
  overriddenBy: string | null;
  /**
   * Labels of the models these providers reach (the pi profiles). Claude
   * models use Anthropic's own built-in web search and ignore all of this.
   */
  appliesTo: string[];
  providers: WebSearchProvider[];
}

/**
 * A concrete REST client owned by one UI root. The getter is evaluated for
 * EVERY request: a root can be constructed before the shell supplies its
 * configuration without freezing the default URL. Multipart uploads use the
 * same getter and transport as JSON requests.
 */
export function createBrainApi(
  getBase: () => string,
  request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await request(`${getBase()}${path}`, {
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

  return {
    health: () =>
      fetchJson<{ status: string; uptime: number; version: string }>("/health"),

    vpnCheck: () => fetchJson<{ vpn: boolean }>("/vpn-check"),

    status: () =>
      fetchJson<{
        /** Optional for servers predating software identity reporting. */
        software?: { release: string; sourceCommit: string };
        version?: string;
        healthy: boolean;
        uptime: number;
        cronJobs: Array<{
          name: string;
          lastRunAt: number | null;
          lastStatus: string | null;
        }>;
        activeSession: boolean;
      }>("/status", { cache: "no-store" }),

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

    /**
     * Map geometry for a view, `[west, south, east, north]` in degrees. The
     * server fetches once per place and caches forever; it answers 200 with
     * empty geometry on any failure, so a caller never has to draw an error
     * where a map should be. `attribution` is non-optional in the answer
     * because the geometry is OpenStreetMap's (ODbL).
     */
    geoCoastline: (bbox: [number, number, number, number], opts?: { width?: number; signal?: AbortSignal }) =>
      fetchJson<CoastlineGeometry>(
        `/geo/coastline?bbox=${bbox.map((n) => n.toFixed(5)).join(",")}` +
          (opts?.width ? `&width=${Math.round(opts.width)}` : ""),
        { signal: opts?.signal }
      ),

    brainStats: () => fetchJson<CorpusStats>("/brain/stats"),

    /** The corpus figures over time, for the /stats trends. An older server 404s. */
    brainStatsHistory: () => fetchJson<CorpusStatsHistory>("/brain/stats/history"),

    brainSync: () =>
      fetchJson<{ success: boolean; message: string }>("/brain/sync", {
        method: "POST",
      }),

    brainAdd: (content: string, opts?: { type?: string; title?: string; tags?: string[] }) =>
      fetchJson<{ success: boolean; path?: string; indexed?: boolean; indexError?: string }>("/brain/add", {
        method: "POST",
        body: JSON.stringify({ content, ...opts }),
      }),

    brainIndex: () => fetchJson<{ success: boolean }>("/brain/index", {
      method: "POST", body: "{}",
    }),

    sessions: () =>
      fetchJson<{
        unavailableBackends?: string[];
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

    /** Install skill(s) from an uploaded ZIP archive. */
    skillInstallZip: async (file: File, overwrite: boolean) => {
      const form = new FormData();
      form.append("file", file);
      form.append("overwrite", overwrite ? "true" : "false");
      // Raw fetch: the browser must set the multipart boundary itself.
      const res = await request(`${getBase()}/skills/install/zip`, {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | { outcomes?: SkillInstallOutcome[]; warning?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body as { outcomes: SkillInstallOutcome[]; warning?: string };
    },

    /** Install skill(s) from a GitHub repository (owner/repo or URL). */
    skillInstallGitHub: (source: string, overwrite: boolean, ref?: string) =>
      fetchJson<{ outcomes: SkillInstallOutcome[]; warning?: string }>(
        "/skills/install/github",
        {
          method: "POST",
          body: JSON.stringify({ source, overwrite, ...(ref ? { ref } : {}) }),
        }
      ),

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
     * Toggle providers and/or store API keys (null/"" clears a key), or clear a
     * single-provider override. Returns the updated config.
     */
    webSearchUpdate: (update: {
      enabled?: Record<string, boolean>;
      apiKeys?: Record<string, string | null>;
      clearOverride?: boolean;
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

    principals: () =>
      fetchJson<{ principals: PrincipalSummary[] }>("/auth/principals"),

    principalMint: (label: string, ttlDays: number) =>
      fetchJson<MintedAgent>("/auth/principals", {
        method: "POST",
        body: JSON.stringify({ label, ttlDays }),
      }),

    principalRevoke: (id: string) =>
      fetchJson<{ ok: true }>(`/auth/principals/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),

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

    /** The runtime half of /stats; `days` is clamped to 1-90 server-side, default 30. */
    activityStats: (days?: number) =>
      fetchJson<ActivityRuntimeStats>(`/activity/stats${days ? `?days=${days}` : ""}`),

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
}

export type BrainApi = ReturnType<typeof createBrainApi>;

/** Default application client; configuration remains late-bound. */
export const api = createBrainApi(apiBase);
