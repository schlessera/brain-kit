/**
 * The metered host relay for the `brain` CLI's paid providers (#1673).
 *
 * A governed or strict turn worker, and a relayed maintenance worker, holds no
 * provider key. A built-in Gemini, Anthropic or OpenAI image provider in it
 * sends its native request to this Unix socket instead, naming its request
 * family, the key variable and the origin it would have called
 * (`@schlessera/brain-common/internal/provider-relay`). The relay:
 *
 * - forwards only fixed first-party POST routes, never a redirect;
 * - releases a host key only to a recipient it authorizes: the key's own
 *   first-party origin, or an exact origin the operator lists for that key in
 *   `BRAIN_UI_CLI_PROVIDER_ORIGINS`. A worker-chosen origin, key name, model or
 *   header never selects anything else;
 * - strips every credential the worker sent and adds the host's;
 * - refuses each request once a budget scope is blocked, with
 *   `budget_exceeded`, before any byte leaves the host;
 * - reports one receipt per dispatched attempt with the raw usage the provider
 *   reported, read before any SDK converts the response. Missing usage stays
 *   unknown.
 *
 * Nothing is reserved in advance: requests already in flight when a scope
 * becomes blocked complete and are counted, so a budget can be overshot by
 * those requests (docs/decisions/governed-writable-workers.md, "Cost and
 * budgets").
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_RELAY_FAMILY_HEADER, PROVIDER_RELAY_KEY_HEADER, PROVIDER_RELAY_ORIGIN_HEADER, type ProviderRelayFamily,
} from "@schlessera/brain-common/internal/provider-relay";
import { workerIdentityHelper } from "./worker-identity.js";
import { WORKER_EGRESS_DIR, type startEgressProxy } from "./egress-proxy.js";
import { hostProviderCredential } from "../config/env.js";

/** The relay's socket name inside the turn's egress directory. */
export const PROVIDER_RELAY_SOCKET_NAME = "providers.sock";
/** Where a governed or strict turn worker reaches the relay. */
export const WORKER_PROVIDER_RELAY_SOCKET = `${WORKER_EGRESS_DIR}/${PROVIDER_RELAY_SOCKET_NAME}`;
/** A request body larger than this is refused before anything is forwarded. */
export const MAX_PROVIDER_REQUEST_BYTES = 32 * 1024 * 1024;
/** Response bytes kept to read usage from; a larger response is forwarded with usage unknown. */
const MAX_USAGE_CAPTURE_BYTES = 64 * 1024 * 1024;

/** Each built-in's key variable, the only origin that key goes to by default, and where the key is placed. */
export const FIRST_PARTY_PROVIDER_RECIPIENTS: Readonly<Record<ProviderRelayFamily, { key: string; origin: string }>> = Object.freeze({
  gemini: { key: "GEMINI_API_KEY", origin: "https://generativelanguage.googleapis.com" },
  anthropic: { key: "ANTHROPIC_API_KEY", origin: "https://api.anthropic.com" },
  openai: { key: "OPENAI_API_KEY", origin: "https://api.openai.com" },
});
const PLACEMENT: Readonly<Record<ProviderRelayFamily, (key: string) => Record<string, string>>> = {
  gemini: key => ({ "x-goog-api-key": key }),
  anthropic: key => ({ "x-api-key": key }),
  openai: key => ({ authorization: `Bearer ${key}` }),
};

export type ProviderOperation = "embeddings" | "completions" | "image";
/** The fixed routes of each family: the request the first-party CLI provider sends, and nothing else. */
const ROUTES: Readonly<Record<ProviderRelayFamily, readonly { path: RegExp; operation: ProviderOperation }[]>> = {
  gemini: [
    { path: /^\/v1beta\/models\/([A-Za-z0-9._-]{1,128}):(?:embedContent|batchEmbedContents)$/, operation: "embeddings" },
    { path: /^\/v1beta\/models\/([A-Za-z0-9._-]{1,128}):generateContent$/, operation: "completions" },
    { path: /^\/v1beta\/interactions$/, operation: "image" },
  ],
  anthropic: [{ path: /^\/v1\/messages$/, operation: "completions" }],
  openai: [{ path: /^\/v1\/images\/(?:generations|edits)$/, operation: "image" }],
};

/** Provider-reported units, as reported. Absent classes were not reported. */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Input tokens by modality (`TEXT`, `IMAGE`, `DOCUMENT`, ...), when the provider splits them. */
  inputByModality?: Record<string, number>;
}

/** One physical attempt the relay dispatched. Never carries prompts, media, credentials or response content. */
export interface ProviderRelayReceipt {
  /** Host-generated; one per upstream attempt, so a retry is a second receipt. */
  attemptId: string;
  family: ProviderRelayFamily;
  operation: ProviderOperation;
  /** The authorized recipient. */
  origin: string;
  /** The key variable released. A name, never a value. */
  key: string;
  /** The requested model, when the request names one. An observation, never authority. */
  model: string | null;
  outcome: "completed" | "failed" | "cancelled";
  status: number;
  /** Null when the provider reported no usable usage: unknown spend, not zero. */
  usage: ProviderUsage | null;
  /** Whether the request carried inline media, for pricing by modality when the provider does not split it. */
  inlineMedia: boolean;
}

/** A request refused before anything was sent upstream. */
export interface ProviderRelayRefusal {
  family: string | null;
  path: string;
  status: number;
  reason: "method_not_allowed" | "unknown_family" | "route_not_allowed" | "recipient_not_authorized"
    | "credential_unavailable" | "budget_exceeded" | "egress_refused" | "request_too_large" | "cancelled"
    | "upstream_unreachable" | "upstream_redirected";
}

export interface ProviderRelayOptions {
  /** Exact recipients the operator added: key variable → origins (`BRAIN_UI_CLI_PROVIDER_ORIGINS`). */
  origins?: ReadonlyMap<string, readonly string[]>;
  /** Host credential lookup by name. Default: the server's own environment. */
  credential?(name: string): string | undefined;
  /** The concrete turn proxy: share its destination admission, byte ceiling and connection records. */
  egress?: Pick<Awaited<ReturnType<typeof startEgressProxy>>, "relayed">;
  /** Called before each dispatch. A refusal is answered with `budget_exceeded` and nothing is sent. */
  admit?(): { allowed: true } | { allowed: false; message: string };
  /** One receipt per dispatched attempt. A throw is reported through `failed`, never to the worker. */
  observe?(receipt: ProviderRelayReceipt): void;
  refused?(refusal: ProviderRelayRefusal): void;
}

export interface ProviderRelay {
  /** Host directory holding the socket. */
  dir: string;
  socketPath: string;
  stop(): void;
}

/** Every key variable the relay may release: the built-ins' own and those the operator lists. */
export function relayedProviderKeys(origins?: ReadonlyMap<string, readonly string[]>): string[] {
  return [...new Set([...Object.values(FIRST_PARTY_PROVIDER_RECIPIENTS).map(recipient => recipient.key), ...origins?.keys() ?? []])].sort();
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** An exact `https:` origin, or an `http:` loopback origin for a local endpoint. */
export function isExactProviderOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && LOOPBACK.has(url.hostname));
  } catch { return false; }
}

/**
 * `BRAIN_UI_CLI_PROVIDER_ORIGINS`: `KEY=origin[,origin];...`, each origin exact.
 * Unset or empty: only the built-in first-party recipients. Throws on anything
 * malformed, naming the entry but never a value from the environment.
 */
export function parseCliProviderOrigins(value: string | undefined): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const entry of (value ?? "").split(";").map(part => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator).trim();
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      throw new Error("BRAIN_UI_CLI_PROVIDER_ORIGINS entries are KEY=origin[,origin], separated by semicolons");
    }
    const origins = entry.slice(separator + 1).split(",").map(origin => origin.trim()).filter(Boolean);
    if (!origins.length) throw new Error(`BRAIN_UI_CLI_PROVIDER_ORIGINS lists no origin for ${key}`);
    for (const origin of origins) {
      if (!isExactProviderOrigin(origin)) {
        throw new Error(`BRAIN_UI_CLI_PROVIDER_ORIGINS lists something other than an exact https origin (or http loopback origin) for ${key}`);
      }
    }
    result.set(key, [...new Set([...result.get(key) ?? [], ...origins])]);
  }
  return result;
}

const STRIPPED = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie", "host",
  "proxy-authorization", "proxy-connection", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "content-length", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "accept-encoding", PROVIDER_RELAY_FAMILY_HEADER, PROVIDER_RELAY_KEY_HEADER, PROVIDER_RELAY_ORIGIN_HEADER]);
const RESPONSE_STRIPPED = new Set(["connection", "keep-alive", "transfer-encoding", "content-length",
  "content-encoding", "set-cookie"]);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function defined(usage: ProviderUsage): ProviderUsage | null {
  const entries = Object.entries(usage).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) as ProviderUsage : null;
}
function modalities(details: unknown): Record<string, number> | undefined {
  if (!Array.isArray(details)) return undefined;
  const result: Record<string, number> = {};
  for (const item of details) {
    const modality = (item as { modality?: unknown })?.modality;
    const tokens = count((item as { tokenCount?: unknown })?.tokenCount);
    if (typeof modality !== "string" || !/^[A-Z_]{1,32}$/.test(modality) || tokens === undefined) return undefined;
    result[modality] = (result[modality] ?? 0) + tokens;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Raw usage from a provider's JSON response body, or null: never estimated from bytes or vectors. */
export function providerUsage(family: ProviderRelayFamily, operation: ProviderOperation, body: unknown): ProviderUsage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (family === "gemini" && operation !== "image") {
    const meta = record.usageMetadata as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== "object") return null;
    const prompt = count(meta.promptTokenCount);
    const cached = count(meta.cachedContentTokenCount);
    const candidates = count(meta.candidatesTokenCount);
    const thoughts = count(meta.thoughtsTokenCount);
    const output = candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0);
    return defined({
      ...(prompt !== undefined ? { inputTokens: Math.max(0, prompt - (cached ?? 0)) } : {}),
      ...(cached ? { cacheReadTokens: cached } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      ...(prompt !== undefined && modalities(meta.promptTokenDetails ?? meta.promptTokensDetails)
        ? { inputByModality: modalities(meta.promptTokenDetails ?? meta.promptTokensDetails)! } : {}),
    });
  }
  const usage = record.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  if (family === "anthropic") {
    return defined({ inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens), cacheCreationTokens: count(usage.cache_creation_input_tokens) });
  }
  return defined({ inputTokens: count(usage.input_tokens ?? usage.total_input_tokens),
    outputTokens: count(usage.output_tokens ?? usage.total_output_tokens) });
}

export function startProviderRelay(options: ProviderRelayOptions = {}): ProviderRelay {
  const credential = options.credential ?? hostProviderCredential;
  const authorized = (family: ProviderRelayFamily, key: string, origin: string): boolean => {
    const own = FIRST_PARTY_PROVIDER_RECIPIENTS[family];
    return own.key === key && own.origin === origin || (options.origins?.get(key) ?? []).includes(origin);
  };
  // Private to this server user; a worker sees only the bound socket.
  const dir = mkdtempSync(join(tmpdir(), "brain-providers-"));
  const separateIdentity = Boolean(workerIdentityHelper());
  chmodSync(dir, separateIdentity ? 0o750 : 0o700);
  const socketPath = join(dir, "relay.sock");
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: socketPath,
      async fetch(request, owner) {
        // Image generation can take minutes before the first response byte.
        owner.timeout(request, 0);
        const url = new URL(request.url);
        const path = url.pathname;
        const familyName = request.headers.get(PROVIDER_RELAY_FAMILY_HEADER);
        const refuse = (status: number, reason: ProviderRelayRefusal["reason"], message: string): Response => {
          try { options.refused?.({ family: familyName && familyName in ROUTES ? familyName : null, path, status, reason }); } catch { /* Diagnostics never answer for the relay. */ }
          return Response.json({ type: "error", error: { type: reason === "budget_exceeded" ? "budget_exceeded" : "brain_provider_refused", message } }, { status });
        };
        if (request.method !== "POST") return refuse(405, "method_not_allowed", "Only provider requests are relayed");
        if (!familyName || !Object.hasOwn(ROUTES, familyName)) return refuse(403, "unknown_family", "Not a relayed provider");
        const family = familyName as ProviderRelayFamily;
        const route = url.search ? undefined : ROUTES[family].find(candidate => candidate.path.test(path));
        if (!route) return refuse(403, "route_not_allowed", "This path is not a relayed provider route");
        const key = request.headers.get(PROVIDER_RELAY_KEY_HEADER) ?? FIRST_PARTY_PROVIDER_RECIPIENTS[family].key;
        const origin = request.headers.get(PROVIDER_RELAY_ORIGIN_HEADER) ?? FIRST_PARTY_PROVIDER_RECIPIENTS[family].origin;
        if (!isExactProviderOrigin(origin) || !authorized(family, key, origin)) {
          return refuse(403, "recipient_not_authorized", `${origin} may not receive ${key}; list it as ${key}=${origin} in BRAIN_UI_CLI_PROVIDER_ORIGINS`);
        }
        const secret = credential(key);
        if (!secret || /[\r\n]/.test(secret)) return refuse(403, "credential_unavailable", `The host has no ${key} to relay`);
        const budget = options.admit?.() ?? { allowed: true as const };
        if (!budget.allowed) return refuse(403, "budget_exceeded", budget.message);
        const target = new URL(path, origin);
        const operation = options.egress?.relayed(request.method, target, request.signal);
        const signal = operation ? AbortSignal.any([request.signal, operation.signal]) : request.signal;
        if (operation && !await operation.admit()) {
          const cancelled = request.signal.aborted || operation.outcome() === "cancelled";
          operation.finish(cancelled ? "cancelled" : "denied", "provider_admission_refused");
          return refuse(cancelled ? 499 : 403, cancelled ? "cancelled" : "egress_refused", "Provider network admission refused");
        }
        const denied = (reason: string, status = 403): Response => {
          operation?.finish("denied", reason);
          return refuse(status, reason === "provider_request_too_large" ? "request_too_large" : "egress_refused",
            reason === "max_bytes_per_turn" ? "Provider egress limit exceeded" : "Provider request refused");
        };
        if (Number(request.headers.get("content-length") ?? "0") > MAX_PROVIDER_REQUEST_BYTES) return denied("provider_request_too_large", 413);
        // Charge each received chunk before retaining or forwarding it.
        const chunks: Uint8Array[] = [];
        let length = 0;
        const reader = request.body?.getReader();
        const cancelBody = () => { void reader?.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancelBody, { once: true });
        if (signal.aborted) cancelBody();
        try {
          if (reader) for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > MAX_PROVIDER_REQUEST_BYTES || operation && !operation.charge(next.value.byteLength + 16)) {
              await reader.cancel().catch(() => {});
              return denied(length > MAX_PROVIDER_REQUEST_BYTES ? "provider_request_too_large" : "max_bytes_per_turn",
                length > MAX_PROVIDER_REQUEST_BYTES ? 413 : 403);
            }
            chunks.push(next.value);
          }
        } catch {
          operation?.finish("cancelled", "client_disconnected");
          return refuse(499, "cancelled", "Provider request cancelled");
        } finally { signal.removeEventListener("abort", cancelBody); reader?.releaseLock(); }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        const headers = new Headers();
        for (const [name, value] of request.headers) if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
        for (const [name, value] of Object.entries(PLACEMENT[family](secret))) headers.set(name, value);
        const model = await requestedModel(family, path, headers.get("content-type"), body);
        const inlineMedia = family === "gemini" && /"inlineData"|"inline_data"/.test(new TextDecoder().decode(body.subarray(0, Math.min(body.byteLength, 8 * 1024 * 1024))));
        if (signal.aborted) {
          operation?.finish("cancelled", "client_disconnected");
          return refuse(499, "cancelled", "Provider request cancelled");
        }
        const headerBytes = (first: string, values: Headers): number => {
          let bytes = Buffer.byteLength(first) + 1028;
          for (const [name, value] of values) bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
          return bytes;
        };
        if (operation && !operation.charge(headerBytes(`POST ${path} HTTP/1.1`, headers))) return denied("max_bytes_per_turn");
        const attemptId = crypto.randomUUID();
        let reported = false;
        const report = (outcome: ProviderRelayReceipt["outcome"], status: number, usage: ProviderUsage | null): void => {
          if (reported) return;
          reported = true;
          try { options.observe?.({ attemptId, family, operation: route.operation, origin, key, model, outcome, status, usage, inlineMedia }); }
          catch { /* The host's own accounting reports its failure; the worker's answer is unaffected. */ }
        };
        let response: Response;
        try {
          // Never follow a redirect: the upstream must not choose another host.
          response = await fetch(target, { method: "POST", headers, body, redirect: "manual", signal });
        } catch {
          operation?.finish(signal.aborted ? "cancelled" : "failed", "upstream_unreachable");
          // The request may have reached the provider: its spend is unknown, never zero.
          report(signal.aborted ? "cancelled" : "failed", 0, null);
          return refuse(signal.aborted ? 499 : 502, signal.aborted ? "cancelled" : "upstream_unreachable",
            signal.aborted ? "Provider request cancelled" : "Provider upstream unreachable");
        }
        if (response.status >= 300 && response.status < 400) {
          operation?.finish("failed", "upstream_redirected");
          await response.body?.cancel().catch(() => {});
          report("failed", response.status, null);
          return refuse(502, "upstream_redirected", "Provider upstream redirected; redirects are not followed");
        }
        const out = new Headers();
        for (const [name, value] of response.headers) if (!RESPONSE_STRIPPED.has(name.toLowerCase())) out.set(name, value);
        if (operation && !operation.charge(headerBytes(`HTTP/1.1 ${response.status} ${response.statusText}`, response.headers))) {
          operation.finish("denied", "max_bytes_per_turn");
          await response.body?.cancel().catch(() => {});
          report("cancelled", response.status, null);
          return refuse(403, "egress_refused", "Provider egress limit exceeded");
        }
        const json = /\bjson\b/i.test(response.headers.get("content-type") ?? "");
        const captured: Uint8Array[] = [];
        let capturedBytes = 0;
        const settle = (): void => {
          let usage: ProviderUsage | null = null;
          if (json && capturedBytes <= MAX_USAGE_CAPTURE_BYTES) {
            try { usage = providerUsage(family, route.operation, JSON.parse(Buffer.concat(captured).toString("utf8"))); }
            catch { usage = null; }
          }
          report(response.ok ? "completed" : "failed", response.status, usage);
        };
        if (!response.body) {
          operation?.finish("completed");
          settle();
          return new Response(null, { status: response.status, headers: out });
        }
        const upstreamReader = response.body.getReader();
        let released = false;
        const release = () => { if (!released) { released = true; upstreamReader.releaseLock(); } };
        const output = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await upstreamReader.read();
              if (next.done) { operation?.finish("completed"); settle(); release(); controller.close(); return; }
              if (operation && !operation.charge(next.value.byteLength + 16)) {
                operation.finish("denied", "max_bytes_per_turn");
                report("cancelled", response.status, null);
                await upstreamReader.cancel().catch(() => {}); release();
                controller.error(new Error("Provider egress limit exceeded"));
                return;
              }
              capturedBytes += next.value.byteLength;
              if (json && capturedBytes <= MAX_USAGE_CAPTURE_BYTES) captured.push(next.value);
              controller.enqueue(next.value);
            } catch {
              operation?.finish(signal.aborted ? "cancelled" : "failed", "upstream_response_failed");
              report(signal.aborted ? "cancelled" : "failed", response.status, null);
              release(); controller.error(new Error("Provider response interrupted"));
            }
          },
          async cancel() {
            operation?.finish("cancelled", "client_disconnected");
            report("cancelled", response.status, null);
            await upstreamReader.cancel().catch(() => {}); release();
          },
        });
        return new Response(output, { status: response.status, headers: out });
      },
    });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  chmodSync(socketPath, separateIdentity ? 0o660 : 0o600);
  let stopped = false;
  return {
    dir,
    socketPath,
    stop() {
      if (stopped) return;
      stopped = true;
      void server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The model the request names: in the path for Gemini, the JSON or multipart `model` field otherwise. */
async function requestedModel(family: ProviderRelayFamily, path: string, contentType: string | null, body: Uint8Array): Promise<string | null> {
  const valid = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value) ? value : null;
  if (family === "gemini") {
    const fromPath = /^\/v1beta\/models\/([^:]+):/.exec(path)?.[1];
    if (fromPath) return valid(fromPath);
  }
  try {
    if (/multipart\/form-data/i.test(contentType ?? "")) {
      const form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": contentType! } }).formData();
      return valid(form.get("model"));
    }
    return valid((JSON.parse(new TextDecoder().decode(body)) as { model?: unknown }).model);
  } catch { return null; }
}
