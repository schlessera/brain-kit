/**
 * Web-search configuration for the pi backend's `pi-web-access` extension —
 * the Settings UI's way to enable providers and store their API keys without
 * a shell on the host.
 *
 * Providers are TOGGLES, not a single choice. The enabled set is written as
 * `searchRouting.providers`, ordered cheapest-first from the catalog's
 * `costRank`, so an ordinary search is answered by a free provider and a paid
 * one is reached only when the cheap ones fail. The model is told the same
 * list (see `webSearchBrief`) and may override per call when a question
 * warrants it.
 *
 * The catalog, the path resolver and the override rules live in
 * `@schlessera/brain-ui-sdk/server` so this surface, the pi backend's system
 * prompt and the client all read one table.
 *
 * Two hazards this file exists to handle:
 *
 * - `provider`/`searchProvider` OVERRIDE `searchRouting` in the extension, and
 *   pi's own `/curator` command writes `provider` back. Every write here
 *   deletes both; a GET that finds one reports it as an override instead of
 *   showing a chain that is not running.
 * - A provider with no credential is skipped at search time. Enabling one is
 *   refused here rather than written into a chain that silently ignores it.
 *
 * Key VALUES never leave the server: GET reports only which providers have a
 * key configured. Mount BEHIND the /api auth guard.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Hono } from "hono";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import {
  WEB_SEARCH_FALLBACK_ON,
  WEB_SEARCH_PROVIDER_KEYS,
  WEB_SEARCH_PROVIDERS,
  hasWebSearchCredential,
  readWebSearchOverride,
  readWebSearchRouting,
  resolveWebSearchConfigPath,
  webSearchProvider,
} from "@schlessera/brain-ui-sdk/server";
import type { AgentConfig } from "../config/env.js";
import { resolveWebSearchEnv } from "../config/env.js";
import { loadBackendModule, parsePiProfiles } from "../agent/backend.js";

/** One toggleable provider, as the Settings UI renders it. */
export interface WebSearchProviderView {
  id: string;
  label: string;
  /** In the active chain. */
  enabled: boolean;
  /** Whether this provider accepts an API key. */
  hasKeyField: boolean;
  /** A key for it is stored in the config file. */
  keyConfigured: boolean;
  /** Its key comes from the environment instead — not editable here. */
  keyFromEnv: boolean;
  /** Works without any credential. */
  keyless: boolean;
  /** Qualitative cost, for the UI. */
  costNote: string;
  /** What it is good at. */
  blurb: string;
}

export interface WebSearchConfigView {
  /** False when the pi backend is not configured — the client hides the card. */
  configured: boolean;
  /** The active chain, in the order it is tried. Empty = the extension picks. */
  order: string[];
  /**
   * Set when a single-provider selection in the file is overriding the chain
   * (a pre-toggle config, or pi's `/curator` command writing one back). The
   * UI offers to clear it; until then the chain is not what runs.
   */
  overriddenBy: string | null;
  /**
   * Labels of the models these providers actually reach — the pi profiles.
   * Claude models use the Agent SDK's own Anthropic-hosted WebSearch, which
   * has no provider setting, so the card has to say who it is talking about.
   */
  appliesTo: string[];
  providers: WebSearchProviderView[];
}

export interface WebSearchRoutesDeps {
  agent: AgentConfig;
  /** Test seam — overrides the config file location. */
  configPath?: string;
  /** Test seam — overrides the environment credential lookup. */
  env?: Record<string, string | undefined>;
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

/** Cheapest first — the whole point of writing a chain rather than a fan-out. */
function orderByCost(ids: Iterable<string>): string[] {
  return [...new Set(ids)]
    .map((id) => webSearchProvider(id))
    .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
    .sort((a, b) => a.costRank - b.costRank)
    .map((spec) => spec.id);
}

export function createWebSearchRoutes(deps: WebSearchRoutesDeps): Hono {
  const { agent } = deps;
  const env = deps.env ?? resolveWebSearchEnv();
  const configPath = () => deps.configPath ?? resolveWebSearchConfigPath(env);

  const piConfigured = () =>
    Boolean(agent.piProfilesJson) || (agent.backend || "claude") === "pi";

  /**
   * The pi models in the picker. Malformed config cannot reach here —
   * createApp refuses to boot on it — but a throw would take the whole
   * settings card down over a label, so it degrades to an empty list.
   */
  const appliesTo = (): string[] => {
    try {
      return parsePiProfiles(agent.piProfilesJson ?? null, agent.profilesJson ?? null).map(
        (p) => p.label
      );
    } catch {
      return [];
    }
  };

  function view(): WebSearchConfigView {
    const config = readConfig(configPath());
    const override = readWebSearchOverride(config);
    const order = orderByCost(readWebSearchRouting(config));
    const enabled = new Set(order);
    return {
      configured: true,
      order,
      overriddenBy: override,
      appliesTo: appliesTo(),
      providers: WEB_SEARCH_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        enabled: enabled.has(p.id),
        hasKeyField: p.keyField !== null,
        keyConfigured:
          p.keyField !== null &&
          typeof config[p.keyField] === "string" &&
          (config[p.keyField] as string).trim() !== "",
        keyFromEnv: Boolean(p.envVar && (env[p.envVar] ?? "").trim() !== ""),
        keyless: p.keyless,
        costNote: p.costNote,
        blurb: p.blurb,
      })),
    };
  }

  return new Hono()
    .get("/web-search", (c) => {
      // Not-configured is a normal state, not an error: the client hides the
      // whole card (same convention as /pi-auth/providers).
      if (!piConfigured()) {
        return c.json({ configured: false, order: [], overriddenBy: null, appliesTo: [], providers: [] });
      }
      return c.json(view());
    })
    .put("/web-search", requireJson(), async (c) => {
      if (!piConfigured()) {
        return c.json({ error: "The pi backend is not configured." }, 409);
      }
      const result = await readJsonBody(c).catch(() => null);
      if (result instanceof Response) return result;
      const body = result as {
        enabled?: unknown;
        apiKeys?: unknown;
        clearOverride?: unknown;
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

      // Keys first: enabling a provider in the same request as its key must
      // see that key when the credential check runs.
      if (body.apiKeys !== undefined) {
        if (!body.apiKeys || typeof body.apiKeys !== "object" || Array.isArray(body.apiKeys)) {
          return c.json({ error: "apiKeys must be an object." }, 400);
        }
        for (const [id, value] of Object.entries(body.apiKeys as JsonRecord)) {
          const spec = webSearchProvider(id);
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

      if (body.enabled !== undefined) {
        if (!body.enabled || typeof body.enabled !== "object" || Array.isArray(body.enabled)) {
          return c.json({ error: "enabled must be an object." }, 400);
        }
        // A pre-toggle single-provider config is the starting set, so the
        // first save after an upgrade keeps what the deployment was using.
        const override = readWebSearchOverride(config);
        const current = new Set(
          readWebSearchRouting(config).length > 0
            ? readWebSearchRouting(config)
            : override
                ? override.split(",").map((s) => s.trim()).filter((id) => webSearchProvider(id))
                : []
        );
        for (const [id, value] of Object.entries(body.enabled as JsonRecord)) {
          const spec = webSearchProvider(id);
          if (!spec) return c.json({ error: `Unknown provider "${id}".` }, 400);
          if (typeof value !== "boolean") {
            return c.json({ error: `enabled.${id} must be a boolean.` }, 400);
          }
          if (value) {
            // The extension skips a provider with no credential, leaving a
            // chain entry that silently never runs. Refuse instead.
            if (!hasWebSearchCredential(spec, config, env)) {
              return c.json(
                { error: `${spec.label} needs an API key before it can be enabled.` },
                400
              );
            }
            current.add(id);
          } else {
            current.delete(id);
          }
        }
        const order = orderByCost(current);
        if (order.length === 0) {
          // Nothing enabled: hand the choice back to the extension's own auto
          // chain rather than writing an empty (invalid) routing block.
          delete config.searchRouting;
        } else {
          config.searchRouting = {
            ...(typeof config.searchRouting === "object" &&
            config.searchRouting &&
            !Array.isArray(config.searchRouting)
              ? config.searchRouting
              : {}),
            providers: order,
            fallbackOn: [...WEB_SEARCH_FALLBACK_ON],
          };
        }
      }

      // Any single-provider key overrides searchRouting outright, so owning
      // the chain means removing them — including the one pi's own /curator
      // command writes back.
      if (body.enabled !== undefined || body.clearOverride === true) {
        for (const key of WEB_SEARCH_PROVIDER_KEYS) delete config[key];
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
