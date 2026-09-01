/**
 * The web-search provider catalog — one source of truth for the Settings API,
 * the pi backend's system-prompt brief, and the client's types.
 *
 * Searching itself is the `pi-web-access` extension's job; brain-kit only owns
 * the config file it reads (`web-search.json` in the pi config dir). That file
 * is the entire interface: nothing here calls a search API.
 *
 * Two of the extension's knobs matter, and they are mutually exclusive:
 *
 * - `provider` (or `searchProvider`) — a single id, or an array that fans out
 *   to every listed provider IN PARALLEL and merges the results. Every paid
 *   provider in that array is billed on every search.
 * - `searchRouting.providers` — an ORDERED chain tried one at a time, moving
 *   on only when the failure kind is listed in `fallbackOn`.
 *
 * brain-kit writes the chain, cheapest first, so a free provider answers the
 * ordinary case and a paid one is only reached when the cheap ones fail. The
 * catch that makes this delicate: the extension IGNORES `searchRouting`
 * entirely whenever `provider`/`searchProvider` is present, and pi's own
 * `/curator` command writes `provider` back into the file. Anything writing
 * routing here must delete both keys, or the chain silently does nothing.
 */

import { join } from "path";

/** One provider the Settings UI can toggle. */
export interface WebSearchProviderSpec {
  /** The id the extension accepts in `searchRouting.providers`. */
  id: string;
  label: string;
  /** Config key holding its API key, or null when it takes none. */
  keyField: string | null;
  /** Env var the extension reads instead, when set. */
  envVar: string | null;
  /** True when it works with no credential at all. */
  keyless: boolean;
  /** Chain position — lower runs first. Cheapest first, by intent. */
  costRank: number;
  /** Cost, qualitatively. Shown in Settings; deliberately not a price. */
  costNote: string;
  /** What it is good at, in one clause. Rides the system prompt. */
  blurb: string;
}

/**
 * A curated subset of the extension's ~28 providers: the ones worth a toggle,
 * each configurable by a single API key. The rest (SearXNG endpoints, Ollama,
 * Bright Data zones, …) stay hand-edited config, deliberately outside the UI —
 * a write here preserves any key it does not manage.
 */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderSpec[] = [
  {
    id: "exa",
    label: "Exa",
    keyField: "exaApiKey",
    envVar: "EXA_API_KEY",
    keyless: true,
    costRank: 10,
    costNote: "Free tier, rate-limited — a key lifts the limit",
    blurb: "neural search over the open web; the everyday default",
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    keyField: null,
    envVar: null,
    keyless: true,
    costRank: 20,
    costNote: "Free, no key",
    blurb: "keyless general web results; a free backstop",
  },
  {
    id: "brave",
    label: "Brave",
    keyField: "braveApiKey",
    envVar: "BRAVE_API_KEY",
    keyless: false,
    costRank: 30,
    costNote: "Paid — low cost per search",
    blurb: "an independent web index, fast for general lookups",
  },
  {
    id: "jina",
    label: "Jina",
    keyField: "jinaApiKey",
    envVar: "JINA_API_KEY",
    keyless: false,
    costRank: 40,
    costNote: "Paid — metered by tokens read",
    blurb: "results with full page text, for reading rather than linking",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    keyField: "perplexityApiKey",
    envVar: "PERPLEXITY_API_KEY",
    keyless: false,
    costRank: 50,
    costNote: "Paid — metered per search",
    blurb: "synthesized answers with citations, not just a list of links",
  },
  {
    id: "tavily",
    label: "Tavily",
    keyField: "tavilyApiKey",
    envVar: "TAVILY_API_KEY",
    keyless: false,
    costRank: 60,
    costNote: "Paid — metered per search",
    blurb: "research-oriented results tuned for agents",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyField: "openaiApiKey",
    envVar: "OPENAI_API_KEY",
    keyless: false,
    costRank: 70,
    costNote: "Paid — metered per search",
    blurb: "OpenAI's hosted web search",
  },
  {
    id: "gemini",
    label: "Gemini",
    keyField: "geminiApiKey",
    envVar: "GEMINI_API_KEY",
    keyless: false,
    costRank: 80,
    costNote: "Paid — metered per request",
    blurb: "Google-grounded results",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    keyField: "firecrawlApiKey",
    envVar: "FIRECRAWL_API_KEY",
    keyless: false,
    costRank: 90,
    costNote: "Paid — metered per page scraped",
    blurb: "search plus page scraping, for sites that need rendering",
  },
  {
    id: "kagi",
    label: "Kagi",
    keyField: "kagiApiKey",
    envVar: "KAGI_API_KEY",
    keyless: false,
    costRank: 100,
    costNote: "Paid — premium, highest cost per search",
    blurb: "a premium ad-free index",
  },
];

/** Lookup by id. */
export function webSearchProvider(id: string): WebSearchProviderSpec | undefined {
  return WEB_SEARCH_PROVIDERS.find((p) => p.id === id);
}

/**
 * Failure kinds that should advance the chain. All of them: a provider that
 * cannot answer THIS query is exactly when the next one should get a turn.
 * A kind left out here would abort the search instead of falling through.
 */
export const WEB_SEARCH_FALLBACK_ON = [
  "transient",
  "quota",
  "network",
  "invalid-response",
  "unsupported",
] as const;

/** The keys the extension reads as a single-provider selection. */
export const WEB_SEARCH_PROVIDER_KEYS = ["provider", "searchProvider"] as const;

type EnvRecord = Record<string, string | undefined>;

/**
 * Where the extension looks for its config — mirrors `pi-web-access`'s own
 * `getWebSearchConfigDir()`.
 *
 * NOTE this is NOT pi's agent dir: pi resolves that to `~/.pi/agent`, one
 * level deeper, and reading the file from there finds nothing.
 *
 * The environment arrives as a value — this package has no env chokepoint of
 * its own, so callers read it in theirs.
 */
export function resolveWebSearchConfigPath(env: EnvRecord): string {
  if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, "web-search.json");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pi", "web-search.json");
  return join(env.HOME || "/root", ".pi", "web-search.json");
}

/**
 * True when the extension would find a credential for this provider — from
 * the config file OR the environment. Checking only the file would wrongly
 * report a key-in-env provider as unusable; the extension runs in this
 * process, so its env is ours.
 */
export function hasWebSearchCredential(
  spec: WebSearchProviderSpec,
  config: Record<string, unknown>,
  env: EnvRecord
): boolean {
  if (spec.keyless) return true;
  if (spec.keyField && typeof config[spec.keyField] === "string") {
    if ((config[spec.keyField] as string).trim() !== "") return true;
  }
  return Boolean(spec.envVar && (env[spec.envVar] ?? "").trim() !== "");
}

/** The ordered chain currently written in a parsed config, if any. */
export function readWebSearchRouting(config: Record<string, unknown>): string[] {
  const routing = config.searchRouting;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return [];
  const providers = (routing as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return [];
  return providers.filter((id): id is string => typeof id === "string" && Boolean(webSearchProvider(id)));
}

/**
 * A single-provider selection left in the file — either a pre-toggle config or
 * pi's `/curator` command writing one back. It OVERRIDES `searchRouting`, so
 * the surfaces have to report it rather than pretend the chain is live.
 */
export function readWebSearchOverride(config: Record<string, unknown>): string | null {
  for (const key of WEB_SEARCH_PROVIDER_KEYS) {
    const value = config[key];
    if (typeof value === "string" && value.trim() && value !== "auto") return value.trim();
    if (Array.isArray(value) && value.length > 0) return value.filter((v) => typeof v === "string").join(", ");
  }
  return null;
}

/** What the model is told about web search. */
export interface WebSearchBrief {
  /** Runtime name of the search tool, so the brief names what it can call. */
  toolName: string;
  /**
   * The providers actually reachable, in the order they are tried. Empty when
   * nothing is configured — the extension then picks on its own.
   */
  providers: Array<{ id: string; label: string; blurb: string; paid: boolean }>;
}

/**
 * Build the brief from a parsed `web-search.json`. Providers without a
 * credential are dropped: the extension would skip them at search time, and
 * naming a provider the model cannot actually reach is the exact failure this
 * brief exists to fix.
 */
export function webSearchBrief(
  config: Record<string, unknown>,
  opts: { toolName: string; env: EnvRecord }
): WebSearchBrief {
  const env = opts.env;
  const override = readWebSearchOverride(config);
  const ids = override
    ? override.split(",").map((s) => s.trim())
    : readWebSearchRouting(config);
  const providers = ids
    .map((id) => webSearchProvider(id))
    .filter((spec): spec is WebSearchProviderSpec => Boolean(spec))
    .filter((spec) => hasWebSearchCredential(spec, config, env))
    .map((spec) => ({
      id: spec.id,
      label: spec.label,
      blurb: spec.blurb,
      paid: !spec.keyless,
    }));
  return { toolName: opts.toolName, providers };
}
