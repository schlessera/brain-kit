---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-pi": minor
---

feat: web search providers are toggles, and the agent knows which are live

Settings → Models → Web search replaces its single provider dropdown with
per-provider toggles (Exa, DuckDuckGo, Brave, Jina, Perplexity, Tavily,
OpenAI, Gemini, Firecrawl, Kagi), each with its own API-key field, cost note
and description.

Enabled providers are written to `web-search.json` as an ordered
`searchRouting.providers` chain sorted cheapest-first, with every failure kind
in `fallbackOn`. An ordinary search is answered by a free provider; a paid one
like Perplexity is only reached when the cheap ones fail, or when the agent
asks for it by name.

The pi backend's system prompt now names the providers that are actually
reachable. This matters because `pi-web-access` hard-codes ~28 provider names
into its own tool description regardless of configuration — a model reading
only that will ask for a provider with no key and get an error. The brief also
carries the cost gradient, so the agent knows to leave `provider` off unless a
question warrants a specific one.

Two hazards are now handled explicitly:

- A `provider`/`searchProvider` key in `web-search.json` overrides
  `searchRouting` entirely, and pi's own `/curator` command writes one back.
  Writes here delete both keys, and the settings UI reports a stray one as an
  override rather than showing a chain that is not running.
- A provider with no credential is skipped at search time, so enabling one is
  refused up front. Credentials are detected from the config file *or* the
  environment, so a key supplied as `PERPLEXITY_API_KEY` counts.

The provider catalog, path resolution and override rules now live in
`@schlessera/brain-ui-sdk/server` (`WEB_SEARCH_PROVIDERS`, `webSearchBrief`,
`resolveWebSearchConfigPath`), replacing three hand-maintained copies.
