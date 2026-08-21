import type { Logger } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import {
  SHARE_MAX_CONCURRENT_INTAKE,
  SHARE_MAX_TOTAL_BYTES,
} from "@schlessera/brain-ui-sdk/protocol";
import { isSameOriginRequest } from "../middleware/origin.js";
import {
  EmptyShareError,
  ShareTooLargeError,
  pruneShareStaging,
  stageShare,
} from "../share/staging.js";

/**
 * Slack over the total cap for multipart framing (boundaries, part headers, and
 * the title/text/url fields).
 */
const BODY_SLACK_BYTES = 1_000_000;
const HARD_BODY_LIMIT = SHARE_MAX_TOTAL_BYTES + BODY_SLACK_BYTES;

/**
 * Read the body, refusing to buffer more than `limit` bytes.
 *
 * `content-length` is only a hint — HTTP/2 and chunked transfer encoding omit
 * it entirely, and a client is free to lie — so the cap has to be counted off
 * the stream itself. Calling `formData()` first would hand an unbounded body to
 * the multipart parser and let an authenticated caller exhaust memory well
 * inside the advertised limits.
 *
 * Returns null when the body exceeds the limit.
 */
async function readCappedBody(
  request: Request,
  limit: number
): Promise<Blob | null> {
  const stream = request.body;
  if (!stream) return new Blob([]);

  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) return null;
      // Copy out of the reader's view: the underlying buffer may be reused.
      chunks.push(value.slice().buffer as ArrayBuffer);
    }
  } finally {
    reader.releaseLock();
    // Nothing more is wanted from an over-limit body; let the peer find out.
    if (total > limit) await stream.cancel().catch(() => {});
  }

  // Hand the chunks to the parser as they are. Concatenating them into one
  // buffer first would copy the whole payload a second time, for nothing.
  return new Blob(chunks);
}

/**
 * Answer a share that reached the SERVER — which means no service worker was
 * there to intercept it.
 *
 * That happens: the worker is evicted, storage was cleared, or the app was
 * installed before the worker activated. Android bakes the share target's
 * intent filters into the WebAPK at install time, so the share sheet keeps
 * offering the app regardless, and the POST lands here. Without this route the
 * user gets a bare 404 inside the app window (the SPA fallback is GET-only).
 *
 * The body is deliberately not read: the payload cannot be recovered from here
 * anyway. Landing in the app is still the best outcome, because loading the app
 * re-registers the worker and the next share works.
 *
 * Registered BEFORE the auth guard, and it must stay there: a share navigation
 * is cross-site, so the SameSite=Strict session cookie is absent by
 * construction and an authenticated version of this route could never fire.
 */
export const shareTargetFallbackRoutes = new Hono().post("/share-target", (c) =>
  c.redirect("/?share_error=no_worker", 303)
);

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

function firstString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value : undefined;
}

export interface ShareRoutesDeps {
  brainRoot: string;
  /** ALLOWED_ORIGINS — the same-origin check's split-topology allowlist. */
  allowedOrigins: string[];
  /** Where failures are reported; absent means silence. */
  log?: Logger;
}

export function createShareRoutes(deps: ShareRoutesDeps): Hono {
  const { brainRoot, allowedOrigins, log } = deps;

  /**
   * In-flight intakes. Each one holds its whole payload in memory while the
   * multipart parser runs, so without a bound the per-share cap multiplies by
   * however many clients ask at once — on a box that also runs headless Chrome
   * for the renderer.
   */
  let inFlight = 0;

  /** At most one sweep per interval: the intake path should not stat the inbox on every upload. */
  let lastPrune = 0;

  function maybePrune(): void {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    // Deliberately not awaited: pruning is housekeeping, and the client is
    // waiting on the staging result, not on it.
    void pruneShareStaging(brainRoot, Date.now(), log).catch((err) => {
      log?.emit({ severityText: "ERROR", body: "share staging prune failed", attributes: { error: err instanceof Error ? err.message : String(err) } });
    });
  }

  return new Hono().post("/share", async (c) => {
  // See middleware/origin.ts: a multipart POST is a CORS-simple request, so it
  // reaches this route with no preflight, and in tailscale mode the credential
  // is the source IP. This route is only ever called by the app itself.
  if (!isSameOriginRequest(c, allowedOrigins)) {
    return c.json({ error: "cross_origin_rejected" }, 403);
  }

  if (inFlight >= SHARE_MAX_CONCURRENT_INTAKE) {
    return c.json({ error: "busy" }, 503);
  }

  const tooLarge = () =>
    c.json({ error: "share_too_large", limit: SHARE_MAX_TOTAL_BYTES }, 413);

  // Cheap early-out for a client that declares its size honestly; the streamed
  // count below is what actually enforces the cap.
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > HARD_BODY_LIMIT) {
    return tooLarge();
  }

  const raw = await readCappedBody(c.req.raw, HARD_BODY_LIMIT);
  if (raw === null) return tooLarge();

  let form: FormData;
  try {
    const contentType = c.req.header("content-type");
    form = await new Response(raw, {
      headers: contentType ? { "content-type": contentType } : {},
    }).formData();
  } catch {
    // A truncated upload or a malformed multipart body. The share is gone
    // either way; the client re-offers it from its own copy.
    return c.json({ error: "invalid_form" }, 400);
  }

  // Empty parts are what an app sends when it has nothing to attach.
  const files = form
    .getAll("files")
    .filter((value): value is File => value instanceof File && value.size > 0);

  inFlight += 1;
  try {
    const result = await stageShare(
      brainRoot,
      {
        title: firstString(form, "title"),
        text: firstString(form, "text"),
        url: firstString(form, "url"),
        files,
      },
      log
    );

    maybePrune();
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof EmptyShareError) {
      return c.json({ error: "empty_share" }, 400);
    }
    if (err instanceof ShareTooLargeError) {
      return c.json({ error: err.reason, limit: err.limit }, 413);
    }
    log?.emit({ severityText: "ERROR", body: "share request failed", attributes: { error: err instanceof Error ? err.message : String(err) } });
    return c.json({ error: "share_failed" }, 500);
  } finally {
    inFlight -= 1;
  }
});
}
