// Deepgram token mint.
// Short-lived grant via /v1/auth/grant. The API key used to call grant needs at
// least *Member* project permission (NOT `keys:write`, which belongs to the
// older temporary-API-key flow). The minted token is scoped to usage::write on
// the core voice APIs and expires quickly, so it is safe to hand to the browser.
//
// We NEVER fall back to shipping the raw DEEPGRAM_API_KEY: it is full-scope
// (can create/delete keys, run batch jobs) and never expires, so a fallback
// would latch a full-power credential into every browser response on the first
// transient blip. If the grant cannot be minted we fail loudly (the caller
// 500s) — a temporarily broken voice feature is strictly better than a leaked
// master key.
// Docs: https://developers.deepgram.com/reference/token-based-auth-api/grant-token

interface DeepgramGrantResponse {
  access_token: string;
  expires_in: number;
}

// A terminal (non-retryable) grant failure — currently only a 403, meaning the
// key lacks the required permission. Thrown so it propagates past the retry.
class DeepgramGrantError extends Error {}

function requestGrant(apiKey: string, ttlSeconds: number): Promise<Response> {
  return fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });
}

export async function mintDeepgramToken(
  apiKey: string | null,
  ttlSeconds = 60
): Promise<{
  token: string;
  expiresAt: number;
}> {
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not set");
  }

  // One retry for transient failures (5xx / 429 / network). A 403 is a hard
  // config error and is not retried.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await requestGrant(apiKey, ttlSeconds);
      if (res.ok) {
        const data = (await res.json()) as DeepgramGrantResponse;
        return {
          token: data.access_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };
      }
      if (res.status === 403) {
        throw new DeepgramGrantError(
          "Deepgram grant rejected (403): the DEEPGRAM_API_KEY lacks Member " +
            "permission. Grant it at least Member in the Deepgram console to " +
            "enable short-lived voice tokens."
        );
      }
      lastError = new Error(
        `Deepgram grant failed (${res.status}): ${await res
          .text()
          .catch(() => "")}`
      );
    } catch (err) {
      if (err instanceof DeepgramGrantError) throw err; // terminal — do not retry
      lastError = err; // network error — allow one retry
    }
  }

  throw new Error(
    `Deepgram grant unavailable after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
