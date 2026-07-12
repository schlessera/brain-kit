const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Per-domain rate limiter
const lastRequestTime = new Map<string, number>();

export interface HttpOptions {
  proxy?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  headers?: Record<string, string>;
  rateLimit?: number; // ms between requests to same domain
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Parse a Retry-After header (seconds or HTTP-date) into a delay in ms,
 * capped at 60s. Returns null when absent/unparseable/non-positive.
 */
function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  let ms: number;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const date = Date.parse(header);
    if (Number.isNaN(date)) return null;
    ms = date - Date.now();
  }
  if (ms <= 0) return null;
  return Math.min(ms, 60_000);
}

async function applyRateLimit(domain: string, limitMs: number): Promise<void> {
  const last = lastRequestTime.get(domain) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < limitMs) {
    await new Promise((r) => setTimeout(r, limitMs - elapsed));
  }
  lastRequestTime.set(domain, Date.now());
}

/**
 * When a proxy is specified, use curl subprocess (Bun fetch ignores HTTP_PROXY).
 * Without proxy, use native fetch for speed.
 */
async function fetchWithProxy(
  url: string,
  proxy: string,
  headers: Record<string, string>,
  timeout: number
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const args = [
    "curl",
    "-s",
    "-w", "\n%{http_code}",
    "-x", proxy,
    "--max-time", String(Math.ceil(timeout / 1000)),
    "-L", // follow redirects
    "-A", headers["User-Agent"] || USER_AGENT,
  ];

  // Add custom headers
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "user-agent") continue; // already set via -A
    args.push("-H", `${key}: ${value}`);
  }

  args.push(url);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`curl failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  // Last line is the HTTP status code
  const lines = output.split("\n");
  const statusCode = parseInt(lines.pop()?.trim() || "0");
  const body = lines.join("\n");

  return { status: statusCode, body, headers: {} };
}

export async function httpGet(url: string, opts?: HttpOptions): Promise<Response> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const retries = opts?.retries ?? DEFAULT_RETRIES;
  const retryDelay = opts?.retryDelay ?? DEFAULT_RETRY_DELAY;
  const rateLimit = opts?.rateLimit ?? 0;

  const domain = getDomain(url);
  if (rateLimit > 0) {
    await applyRateLimit(domain, rateLimit);
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/html, application/xml, */*",
    ...opts?.headers,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (opts?.proxy) {
        // Use curl for proxy support
        const result = await fetchWithProxy(url, opts.proxy, headers, timeout);

        if (result.status === 429 || (result.status >= 500 && attempt < retries)) {
          // Record the status so a final-attempt 429 throws a specific error
          // instead of the generic "failed after N retries" message.
          lastError = new Error(`HTTP ${result.status} from ${url} (after ${attempt + 1} attempts)`);
          if (attempt < retries) {
            const delay = retryDelay * Math.pow(2, attempt) + Math.random() * 500;
            await new Promise((r) => setTimeout(r, delay));
          }
          continue;
        }

        return new Response(result.body, {
          status: result.status,
          statusText: result.status === 200 ? "OK" : `HTTP ${result.status}`,
        });
      } else {
        // Use native fetch (faster, no proxy)
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          headers,
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timer);

        if (response.status === 429 || (response.status >= 500 && attempt < retries)) {
          // Record the status so a final-attempt 429 throws a specific error
          // instead of the generic "failed after N retries" message.
          lastError = new Error(`HTTP ${response.status} from ${url} (after ${attempt + 1} attempts)`);
          if (attempt < retries) {
            // Honor Retry-After when present (capped at 60s)
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            const delay = retryAfterMs ?? retryDelay * Math.pow(2, attempt) + Math.random() * 500;
            await new Promise((r) => setTimeout(r, delay));
          }
          continue;
        }

        return response;
      }
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        const delay = retryDelay * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url} after ${retries} retries`);
}

export async function httpGetJson<T = unknown>(url: string, opts?: HttpOptions): Promise<T> {
  const response = await httpGet(url, {
    ...opts,
    headers: { Accept: "application/json", ...opts?.headers },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

export async function httpGetText(url: string, opts?: HttpOptions): Promise<string> {
  const response = await httpGet(url, opts);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`);
  }
  return response.text();
}
