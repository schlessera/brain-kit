/**
 * Boat transport: plain `fetch` through the host's `ctx.fetch`, bounded
 * retries, and the vendor error envelope read in one place.
 *
 * The key travels only in the `Authorization` header of requests to the API
 * origin. Signed file URLs carry no header, redirects are refused so the
 * header can never follow one, and neither the key nor a signed URL is
 * logged.
 *
 * Retries: at most `MAX_ATTEMPTS` per call, each wait taken from the
 * response (`retryAfterSeconds`, `retryAfter` or `Retry-After`), capped at
 * `MAX_WAIT_MS` and never past `ctx.deadline`. Only calls whose repetition is
 * harmless retry on an unknown outcome (`"safe"`); a detached command
 * (`"exec"`) is sent again only when Boat says it provably did not run.
 */

import type { ComputeContext } from "@schlessera/brain";

import type { Redactor } from "./redact.js";

export const BOAT_API_BASE = "https://boat.dev/api/v1";
export const MAX_ATTEMPTS = 3;
export const MAX_WAIT_MS = 30_000;
/** The most of an error answer read; Boat's error envelope is far smaller. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024;

/** How a call may be repeated. */
export type RetryPolicy = "safe" | "exec" | "none";

export interface CallSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** An API path (with query) under the base URL; authenticated. */
  path?: string;
  /** A signed file URL; sent without credentials. */
  signedUrl?: string;
  /** What the log shows instead of the URL. */
  label: string;
  json?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  retry: RetryPolicy;
  /** Read the body as bytes, stopping after this many plus one. */
  readBytes?: number;
}

export type Attempt =
  | { kind: "response"; status: number; headers: Headers; body: unknown; bytes?: Uint8Array; overflow?: boolean }
  | { kind: "transport"; sent: boolean; reason: string };

export interface CallResult {
  last: Attempt;
  /** An earlier or the final attempt may have taken effect without an answer. */
  ambiguous: boolean;
  attempts: number;
}

/** What the adapter reads from Boat's error envelope. */
export interface BoatError {
  code: string | undefined;
  message: string | undefined;
  retryable: boolean | undefined;
  detailMessage: string | undefined;
  window: string | undefined;
  retryAfterSeconds: number | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The code is `code`, else `error.code`, else `error` when that is a string. */
export function boatError(body: unknown): BoatError {
  const top = record(body) ?? {};
  const error = record(top.error);
  const details = record(error?.details) ?? record(top.details) ?? {};
  return {
    code: str(top.code) ?? str(error?.code) ?? str(top.error),
    message: str(top.message) ?? str(error?.message),
    retryable: typeof details.retryable === "boolean" ? details.retryable : typeof top.retryable === "boolean" ? top.retryable : undefined,
    detailMessage: str(details.message),
    window: str(top.window) ?? str(details.window),
    retryAfterSeconds: num(top.retryAfterSeconds) ?? num(top.retryAfter) ?? num(details.retryAfterSeconds) ?? num(details.retryAfter),
  };
}

/** Boat names some codes `sandbox_*` in its guides and `boat_*` in its reference; both are accepted. */
export const isCode = (code: string | undefined, suffix: string) =>
  code === `sandbox_${suffix}` || code === `boat_${suffix}`;

const restoring = (e: BoatError) => isCode(e.code, "direct_failed") && e.retryable === true && (e.message === "sandbox_restoring" || e.detailMessage === "sandbox_restoring");

/** An attempt whose effect on Boat is unknown. */
export function ambiguousAttempt(attempt: Attempt): boolean {
  if (attempt.kind === "transport") return attempt.sent;
  if (attempt.status < 500) return false;
  const e = boatError(attempt.body);
  if (attempt.status === 503 && (e.code === "no_ready_machine" || e.code === "out_of_capacity")) return false;
  return !restoring(e);
}

/** Milliseconds to wait before sending again, or undefined to stop. */
function retryAfter(attempt: Attempt, policy: RetryPolicy, index: number): number | undefined {
  if (policy === "none") return undefined;
  const backoff = 500 * 2 ** index;
  if (attempt.kind === "transport") return attempt.sent && policy === "safe" ? backoff : undefined;
  const status = attempt.status;
  if (status < 400) return undefined;
  const e = boatError(attempt.body);
  const header = Number(attempt.headers.get("retry-after"));
  const hinted = (fallback: number) =>
    e.retryAfterSeconds !== undefined ? e.retryAfterSeconds * 1000 : Number.isFinite(header) && header >= 0 ? header * 1000 : fallback;
  // Sent again by either policy: Boat says these provably did not run.
  if (status === 409 && isCode(e.code, "starting")) return hinted(2000);
  if (status === 502 && restoring(e)) return hinted(1500);
  if (status === 429 && e.code === "IP_RATE_LIMIT_EXCEEDED") return hinted(backoff);
  // A start limit: only the minute window can clear within one call, so it gets one retry.
  if (status === 429 && e.code === "rate_limited") return e.window === "minute" && index === 0 ? hinted(backoff) : undefined;
  if (policy !== "safe") return undefined;
  if (status === 409 && e.code === "idempotency_in_progress") return hinted(1000);
  if (status === 503) return hinted(2000);
  if (status >= 500) return backoff;
  return undefined;
}

export interface ClientDeps {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: ClientDeps = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }),
};

async function readBody(response: Response, limit: number | undefined): Promise<{ body: unknown; bytes?: Uint8Array; overflow?: boolean }> {
  if (limit === undefined || !response.ok) {
    let text: string;
    if (response.ok) text = await response.text();
    else {
      // An error is a small envelope: read no more than the bound, and an answer past it carries no code.
      const read = await readBytes(response, ERROR_BODY_MAX_BYTES);
      if (read.overflow || !read.bytes) return { body: undefined };
      text = new TextDecoder().decode(read.bytes);
    }
    if (text === "") return { body: undefined };
    try {
      return { body: JSON.parse(text) as unknown };
    } catch {
      return { body: undefined };
    }
  }
  return readBytes(response, limit);
}

/** The body as bytes, stopping once it passes `limit`. */
async function readBytes(response: Response, limit: number): Promise<{ body: undefined; bytes?: Uint8Array; overflow?: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: undefined, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { body: undefined, overflow: true };
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: undefined, bytes };
}

async function send(ctx: ComputeContext, spec: CallSpec, red: Redactor): Promise<Attempt> {
  if (ctx.signal.aborted) return { kind: "transport", sent: false, reason: "aborted before sending" };
  const headers: Record<string, string> = { ...spec.headers };
  let url: string;
  if (spec.path !== undefined) {
    if (!ctx.secret) return { kind: "transport", sent: false, reason: "no Boat API key is configured" };
    url = `${BOAT_API_BASE}${spec.path}`;
    headers.Authorization = `Bearer ${ctx.secret}`;
    headers.Accept = "application/json";
  } else {
    url = spec.signedUrl ?? "";
    if (!url.startsWith("https://")) return { kind: "transport", sent: false, reason: "Boat returned a file URL that is not https" };
    red.add(url);
  }
  let body: BodyInit | undefined;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    headers["Content-Type"] = "application/json";
  } else if (spec.bytes !== undefined) {
    body = new Blob([spec.bytes as Uint8Array<ArrayBuffer>]);
    headers["Content-Type"] = "application/octet-stream";
  }
  let response: Response;
  try {
    response = await ctx.fetch(url, { method: spec.method, headers, body, signal: ctx.signal, redirect: "error" });
  } catch (error) {
    return { kind: "transport", sent: true, reason: red.text(`${spec.label}: ${(error as Error)?.message ?? "transport failure"}`) };
  }
  try {
    const read = await readBody(response, spec.readBytes);
    return { kind: "response", status: response.status, headers: response.headers, ...read };
  } catch (error) {
    return { kind: "transport", sent: true, reason: red.text(`${spec.label}: reading the answer failed: ${(error as Error)?.message ?? "unknown"}`) };
  }
}

/** Send `spec`, retrying as its policy allows within the call's deadline. */
export async function call(ctx: ComputeContext, spec: CallSpec, red: Redactor, deps: ClientDeps): Promise<CallResult> {
  const log = red.log(ctx.log);
  let ambiguous = false;
  let last: Attempt = { kind: "transport", sent: false, reason: "not sent" };
  let attempts = 0;
  for (let index = 0; index < MAX_ATTEMPTS; index++) {
    last = await send(ctx, spec, red);
    if (last.kind === "transport" && !last.sent) break;
    attempts += 1;
    ambiguous ||= ambiguousAttempt(last);
    log.debug(`boat ${spec.method} ${spec.label} -> ${last.kind === "response" ? last.status : "transport failure"}`);
    if (last.kind === "response" && last.status < 400) break;
    const wait = retryAfter(last, spec.retry, index);
    if (wait === undefined || index === MAX_ATTEMPTS - 1) break;
    const ms = Math.min(wait, MAX_WAIT_MS);
    if (ctx.signal.aborted || deps.now() + ms >= ctx.deadline) break;
    await deps.sleep(ms, ctx.signal);
    if (ctx.signal.aborted) break;
  }
  return { last, ambiguous, attempts };
}

/** `status code` for a reason, or the transport reason. */
export function describe(attempt: Attempt): string {
  if (attempt.kind === "transport") return attempt.reason;
  const e = boatError(attempt.body);
  return `HTTP ${attempt.status}${e.code ? ` ${e.code}` : ""}`;
}
