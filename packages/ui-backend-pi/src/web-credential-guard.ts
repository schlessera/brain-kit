/**
 * The web executor's credential guard (#3687): a provider credential never
 * follows a redirect to another origin.
 *
 * The egress route sees TLS tunnels only as host and port, so the request
 * headers that carry a provider key are invisible to it. This guard runs in
 * the executor itself, wrapping `fetch` before the pinned extension loads:
 *
 * - A request that follows redirects (`redirect: "follow"`, the default) is
 *   followed here, hop by hop. A cross-origin hop of a request that carried a
 *   credential, in its URL, headers or a text body, is refused outright;
 *   any other cross-origin hop drops its authorization, cookie and proxy
 *   headers.
 * - A caller that follows redirects itself (`redirect: "manual"`) gets the
 *   redirect response, and its target is remembered: re-issuing a credential
 *   to a remembered target on another origin is refused.
 *
 * The first destination of a request is the extension's own choice from the
 * host-owned configuration and its pinned code; only where a redirect leads
 * is untrusted. A credential is any provider key value the executor was
 * given, at least 8 characters long.
 */
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const MAX_REDIRECTS = 10;
const REMEMBERED_TARGETS = 256;

export class CredentialRedirectRefused extends Error {
  constructor(from: string, to: string) {
    super(`Refused to follow a redirect from ${from} to ${to} with a provider credential.`);
    this.name = "CredentialRedirectRefused";
  }
}

/** The provider key values in an executor's environment and configuration. */
export function webCredentialValues(env: Readonly<Record<string, string | undefined>>, names: readonly string[], config: unknown): string[] {
  const values = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.trim().length >= 8 && !value.trim().startsWith("$")) values.add(value.trim()); };
  for (const name of names) add(env[name]);
  const walk = (value: unknown, key: string) => {
    if (Array.isArray(value)) { for (const entry of value) walk(entry, key); return; }
    if (value && typeof value === "object") { for (const [child, entry] of Object.entries(value)) walk(entry, child); return; }
    if (/(?:api)?keys?$|token|secret/i.test(key)) add(value);
  };
  walk(config, "");
  return [...values];
}

function textBody(body: RequestInit["body"]): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

export function guardCredentialRedirects(fetchImpl: Fetch, credentials: readonly string[]): Fetch {
  const remembered: string[] = [];
  const carries = (url: URL, headers: Headers, body: string) => credentials.some(secret => {
    if (url.href.includes(secret) || url.href.includes(encodeURIComponent(secret)) || body.includes(secret)) return true;
    for (const [, value] of headers) if (value.includes(secret)) return true;
    return false;
  });
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    let url = new URL(request ? request.url : String(input));
    let headers = new Headers(init?.headers ?? request?.headers);
    let method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let body = init?.body;
    const mode = init?.redirect ?? request?.redirect ?? "follow";
    const credentialed = carries(url, headers, textBody(body));
    // A manual caller re-issuing a remembered redirect target is still a redirect.
    const target = remembered.find(entry => entry.split("\n")[1] === url.href);
    if (credentialed && target && new URL(target.split("\n")[0]!).origin !== url.origin) throw new CredentialRedirectRefused(new URL(target.split("\n")[0]!).origin, url.origin);
    if (mode !== "follow") {
      const response = await fetchImpl(input, init);
      const location = REDIRECT.has(response.status) ? response.headers.get("location") : null;
      if (location && mode === "manual") {
        try { remembered.push(`${url.href}\n${new URL(location, url).href}`); if (remembered.length > REMEMBERED_TARGETS) remembered.shift(); } catch { /* Not a URL. */ }
      }
      return response;
    }
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(url, { ...init, method, headers, body, redirect: "manual" });
      const location = REDIRECT.has(response.status) ? response.headers.get("location") : null;
      if (!location) return response;
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url.origin}`);
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        if (credentialed) { void response.body?.cancel(); throw new CredentialRedirectRefused(url.origin, next.origin); }
        headers = new Headers(headers);
        for (const name of SENSITIVE_HEADERS) headers.delete(name);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET"; body = undefined; headers.delete("content-type"); headers.delete("content-length");
      }
      void response.body?.cancel();
      url = next;
    }
  };
}
