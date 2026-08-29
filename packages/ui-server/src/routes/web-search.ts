/**
 * Web-search configuration for the pi backend's `pi-web-access` extension —
 * the Settings UI's way to pick a search provider and store its API key
 * without a shell on the host.
 *
 * The extension reads `web-search.json` from the pi config dir; these routes
 * read-modify-write that same file, touching ONLY the managed fields (the
 * `provider` selector and the per-provider `<name>ApiKey` entries) so any
 * hand-edited config beside them survives.
 *
 * Defaults are deliberate: no file (or `provider: "auto"`) means the
 * extension's automatic chain, which starts with Exa's keyless MCP endpoint —
 * free, throttled. Adding an `exaApiKey` lifts the throttle; picking another
 * provider routes searches there instead.
 *
 * Key VALUES never leave the server: GET reports only which providers have a
 * key configured. Mount BEHIND the /api auth guard.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Hono } from "hono";
import type { AgentConfig } from "../config/env.js";
import { resolvePiConfigDir } from "../config/env.js";
import { loadBackendModule } from "../agent/backend.js";

/** One selectable provider, as the Settings UI renders it. */
export interface WebSearchProviderView {
  id: string;
  label: string;
  /** Whether this provider accepts an API key ("auto" does not). */
  hasKeyField: boolean;
  /** True when a key for it is present in the config file. */
  keyConfigured: boolean;
  /** True when the provider works without any key (Exa's free MCP tier). */
  keyless: boolean;
}

export interface WebSearchConfigView {
  /** False when the pi backend is not configured — the client hides the card. */
  configured: boolean;
  /** The active provider selection ("auto" when unset). */
  provider: string;
  providers: WebSearchProviderView[];
}

/**
 * The providers this surface manages. A curated subset of pi-web-access's
 * catalog: the ones configurable by a single `<id>ApiKey` field. The
 * extension itself accepts more (SearXNG endpoints, Ollama, …) — those stay
 * hand-edited config, deliberately outside this UI.
 */
const MANAGED_PROVIDERS: ReadonlyArray<{
  id: string;
  label: string;
  keyField: string | null;
  keyless: boolean;
}> = [
  { id: "auto", label: "Auto — Exa (free) with fallbacks", keyField: null, keyless: true },
  { id: "exa", label: "Exa", keyField: "exaApiKey", keyless: true },
  { id: "openai", label: "OpenAI", keyField: "openaiApiKey", keyless: false },
  { id: "brave", label: "Brave", keyField: "braveApiKey", keyless: false },
  { id: "tavily", label: "Tavily", keyField: "tavilyApiKey", keyless: false },
  { id: "perplexity", label: "Perplexity", keyField: "perplexityApiKey", keyless: false },
  { id: "firecrawl", label: "Firecrawl", keyField: "firecrawlApiKey", keyless: false },
  { id: "jina", label: "Jina", keyField: "jinaApiKey", keyless: false },
  { id: "kagi", label: "Kagi", keyField: "kagiApiKey", keyless: false },
  { id: "gemini", label: "Gemini", keyField: "geminiApiKey", keyless: false },
];

const MANAGED_IDS = new Set(MANAGED_PROVIDERS.map((p) => p.id));

export interface WebSearchRoutesDeps {
  agent: AgentConfig;
  /** Test seam — overrides the config file location. */
  configPath?: string;
  /** Test seam — forwarded to loadBackendModule. */
  importer?: (specifier: string) => Promise<unknown>;
}

type JsonRecord = Record<string, unknown>;

function readConfig(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    // Unreadable config: treat as empty for GET; PUT refuses instead of
    // silently clobbering whatever the user had there.
    return {};
  }
}

function writeConfig(path: string, config: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic-enough: temp file + rename, so the extension never reads a torn write.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

export function createWebSearchRoutes(deps: WebSearchRoutesDeps): Hono {
  const { agent } = deps;
  const configPath = () => deps.configPath ?? join(resolvePiConfigDir(), "web-search.json");

  const piConfigured = () =>
    Boolean(agent.piProfilesJson) || (agent.backend || "claude") === "pi";

  function view(): WebSearchConfigView {
    const config = readConfig(configPath());
    const provider =
      typeof config.provider === "string" && MANAGED_IDS.has(config.provider)
        ? config.provider
        : "auto";
    return {
      configured: true,
      provider,
      providers: MANAGED_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        hasKeyField: p.keyField !== null,
        keyConfigured:
          p.keyField !== null &&
          typeof config[p.keyField] === "string" &&
          (config[p.keyField] as string).trim() !== "",
        keyless: p.keyless,
      })),
    };
  }

  return new Hono()
    .get("/web-search", (c) => {
      // Not-configured is a normal state, not an error: the client hides the
      // whole card (same convention as /pi-auth/providers).
      if (!piConfigured()) {
        return c.json({ configured: false, provider: "auto", providers: [] });
      }
      return c.json(view());
    })
    .put("/web-search", async (c) => {
      if (!piConfigured()) {
        return c.json({ error: "The pi backend is not configured." }, 409);
      }
      const body = (await c.req.json().catch(() => null)) as {
        provider?: unknown;
        apiKeys?: unknown;
      } | null;
      if (!body || typeof body !== "object") {
        return c.json({ error: "Invalid body." }, 400);
      }

      const path = configPath();
      if (existsSync(path)) {
        // A config that exists but does not parse must not be clobbered by a
        // settings save — that would eat hand-written provider config.
        try {
          JSON.parse(readFileSync(path, "utf-8"));
        } catch {
          return c.json(
            { error: `${path} exists but is not valid JSON — fix or remove it first.` },
            409
          );
        }
      }
      const config = readConfig(path);

      if (body.provider !== undefined) {
        if (typeof body.provider !== "string" || !MANAGED_IDS.has(body.provider)) {
          return c.json({ error: "Unknown provider." }, 400);
        }
        // "auto" is the extension's default — store it as absence, so an
        // untouched deployment and a reset-to-default one look identical.
        if (body.provider === "auto") delete config.provider;
        else config.provider = body.provider;
      }

      if (body.apiKeys !== undefined) {
        if (!body.apiKeys || typeof body.apiKeys !== "object" || Array.isArray(body.apiKeys)) {
          return c.json({ error: "apiKeys must be an object." }, 400);
        }
        for (const [id, value] of Object.entries(body.apiKeys as JsonRecord)) {
          const spec = MANAGED_PROVIDERS.find((p) => p.id === id);
          if (!spec || spec.keyField === null) {
            return c.json({ error: `Provider "${id}" does not take an API key here.` }, 400);
          }
          if (value === null || value === "") {
            delete config[spec.keyField];
          } else if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed || trimmed.length > 512 || /[\r\n]/.test(trimmed)) {
              return c.json({ error: `Invalid API key for "${id}".` }, 400);
            }
            config[spec.keyField] = trimmed;
          } else {
            return c.json({ error: `Invalid API key for "${id}".` }, 400);
          }
        }
      }

      writeConfig(path, config);

      // Extension modules cache their config per process; clearing pi's
      // extension cache makes NEW sessions re-read web-search.json. Best
      // effort: on failure the change still lands, it just needs a restart
      // (or a naturally recycled session) to apply.
      try {
        const mod = (await loadBackendModule("pi", deps.importer)) as {
          invalidateExtensionCache?: () => Promise<boolean>;
        };
        await mod.invalidateExtensionCache?.();
      } catch {
        /* config written; cache clearing is an optimization */
      }

      return c.json(view());
    });
}
