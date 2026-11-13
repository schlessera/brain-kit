/**
 * Who receives what a web call sends (#3687): the provider policy's name for
 * each curated web provider, and for each API host the pinned extension
 * reaches on its behalf.
 *
 * A web search sends the model's query, and an extraction fallback sends the
 * URL, to a third party. That party is a recipient in the provider policy's
 * sense (G2), as Apify is (`APIFY_RECIPIENT`): a conversation that has shown
 * it a provider folder it may not receive sends it nothing. Vendors that also
 * serve inference keep the names the inference recipients use
 * (`FIRST_PARTY_RECIPIENT_ORIGINS`), so one policy rule names one company.
 *
 * Every other host a call reaches is a page the call fetches. Pages are
 * egress-policy territory (G5): the route checks their addresses and bytes,
 * not their routing. A provider the curated catalog does not list, configured
 * by hand, is reached as a page too; its spend is not counted and its routing
 * is not checked, and the decision record says so.
 */

/** Curated provider id (`WEB_SEARCH_PROVIDERS`) to provider-policy recipient. */
const PROVIDER_RECIPIENTS: Readonly<Record<string, string>> = Object.freeze({
  exa: "exa", duckduckgo: "duckduckgo", brave: "brave", jina: "jina", perplexity: "perplexity", tavily: "tavily",
  openai: "openai", gemini: "google", firecrawl: "firecrawl", kagi: "kagi",
});

/**
 * The API hosts of the pinned extension (pi-web-access 0.41.0) for those
 * providers and its extraction fallbacks, to their recipient. Exact names:
 * a page on a vendor's other hosts is still a page.
 */
const HOST_RECIPIENTS: Readonly<Record<string, string>> = Object.freeze({
  "api.exa.ai": "exa", "mcp.exa.ai": "exa",
  "html.duckduckgo.com": "duckduckgo",
  "api.search.brave.com": "brave",
  // Jina search, and the reader the extraction fallback sends a page's URL to.
  "s.jina.ai": "jina", "r.jina.ai": "jina",
  "api.perplexity.ai": "perplexity",
  "api.tavily.com": "tavily",
  "api.openai.com": "openai",
  // Gemini search, URL context and PDF extraction: nested model calls.
  "generativelanguage.googleapis.com": "google",
  // Kagi's API shares its host with its site: every connection there counts as Kagi's.
  "kagi.com": "kagi",
});

/** Host config keys that move a provider's API to another origin; Firecrawl has no default one. */
const BASE_URL_RECIPIENTS: Readonly<Record<string, string>> = Object.freeze({ exaBaseUrl: "exa", firecrawlBaseUrl: "firecrawl" });

/** The recipient a curated provider id names. An id outside the table names itself, which no policy rule allows by accident. */
export function webProviderRecipient(provider: string): string {
  return Object.hasOwn(PROVIDER_RECIPIENTS, provider) ? PROVIDER_RECIPIENTS[provider]! : provider;
}

const hostName = (host: string) => host.toLowerCase().replace(/\.$/u, "");

/** The API hosts the host-owned configuration moves a provider to, by recipient. */
export function configuredWebHosts(config: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>();
  for (const [key, recipient] of Object.entries(BASE_URL_RECIPIENTS)) {
    const value = config[key];
    if (typeof value !== "string") continue;
    try { hosts.set(hostName(new URL(value).hostname), recipient); } catch { /* Not a URL: the extension refuses it too. */ }
  }
  return hosts;
}

/** The recipient an executor connection's host is, or undefined for a page. */
export function webHostRecipient(host: string, configured: ReadonlyMap<string, string> = new Map()): string | undefined {
  const name = hostName(host);
  return configured.get(name) ?? (Object.hasOwn(HOST_RECIPIENTS, name) ? HOST_RECIPIENTS[name] : undefined);
}
