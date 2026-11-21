import { inferenceUsageObserver } from "./inference-usage.js";
/**
 * The one network path out of a restricted (autonomous) worker (#676).
 *
 * A restricted worker has its own network namespace with only loopback, so
 * it reaches nothing on the host network. Its inference requests travel over
 * a Unix socket that the server owns and bind-mounts into the worker. This
 * relay forwards exactly the server-selected inference routes to the
 * server-selected upstream, replacing every credential header with the
 * server-held credential. The worker holds only a placeholder, so a hostile
 * document cannot read, print or reuse the real credential, and no other
 * method, path, host or redirect is reachable through it.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { workerIdentityHelper } from "./worker-identity.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceTimingMark, startEgressProxy } from "./egress-proxy.js";
import { INFERENCE_RELAY_PLACEHOLDER } from "@schlessera/brain-common/internal/provider-unavailable";
import { observeDiagnostic } from "./startup-timing.js";

/** Where the relay directory appears inside a restricted worker. */
export const WORKER_INFERENCE_DIR = "/run/brain-inference";
export const WORKER_INFERENCE_SOCKET = `${WORKER_INFERENCE_DIR}/relay.sock`;
/** The value a worker holds where a credential would be. Never a secret; the CLI never sends it (#1673). */
export const INFERENCE_PLACEHOLDER = INFERENCE_RELAY_PLACEHOLDER;
/** A request body larger than this is refused before anything is forwarded. */
export const MAX_INFERENCE_REQUEST_BYTES = 32 * 1024 * 1024;

/** Internal turn-level gate, registered even when a request has no egress operation. */
export interface InferenceArrival {
  prepareDispatch(body: Uint8Array): Promise<boolean>;
  dispatch(): boolean;
  responseReady(): Promise<boolean>;
  close(): void;
}
type InferenceOperation = ReturnType<Awaited<ReturnType<typeof startEgressProxy>>["inference"]>;
const gated = Symbol("gated relay response");
type Gated = { [gated]: Response };

export interface InferenceRelayOptions {
  /** Server-selected upstream base, e.g. `https://api.anthropic.com`. */
  upstream: string;
  /** Exact paths below the upstream base path that carry inference. */
  routes: readonly string[];
  /** Server-held headers, resolved for each dispatch after inbound credentials are removed. */
  credentials: Readonly<Record<string, string>> | ((signal: AbortSignal, target: URL) => Promise<Readonly<Record<string, string>>>);
  /** Concrete turn proxy: share its destination admission, application-byte ceiling and audit. */
  egress?: {
    inference(method: string, target: URL, signal: AbortSignal, arrival?: InferenceArrival): InferenceOperation;
    inferenceArrival?(path: string): InferenceArrival | undefined;
    inferenceRoutes?(paths: readonly string[]): void;
  };
  /** Called for every request, forwarded or refused. Values are never logged. */
  observe?(event: InferenceRelayEvent): void;
  /** Host receipt of an authorized route, before egress admission or reading its body. Observability only. */
  received?(path: string): void;
  /**
   * The exact origin turn admission proved this turn's recipient from (#2695).
   * A relay whose upstream has another origin refuses to start, so a turn that
   * sees provider folders reaches no recipient but the one they were unmasked for.
   */
  recipientOrigin?: string;
}

export interface InferenceRelayEvent {
  method: string;
  path: string;
  outcome: "forwarded" | "refused";
  status: number;
  reason?: string;
  /** Host-only admission cause; the HTTP body remains unchanged. */
  denialReason?: string;
}

export interface InferenceRelay {
  /** Host directory to bind at {@link WORKER_INFERENCE_DIR}. */
  dir: string;
  /** Host path of the socket, for the server's own tests and diagnostics. */
  socketPath: string;
  stop(): void;
}

/** Headers a worker may not choose: credentials, routing and hop-by-hop. */
const STRIPPED = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie", "host",
  "proxy-authorization", "proxy-connection", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "content-length", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "accept-encoding"]);
const RESPONSE_STRIPPED = new Set(["connection", "keep-alive", "transfer-encoding", "content-length",
  "content-encoding", "set-cookie"]);

export function startInferenceRelay(options: InferenceRelayOptions): InferenceRelay {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
    throw new Error("The inference upstream must be an http(s) URL");
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("The inference upstream must not carry credentials, a query or a fragment");
  }
  if (options.recipientOrigin !== undefined && upstream.origin !== options.recipientOrigin) {
    throw new Error(`The inference upstream ${upstream.origin} is not the recipient this turn was admitted for (${options.recipientOrigin})`);
  }
  const base = upstream.pathname.replace(/\/+$/, "");
  const routes = new Set(options.routes.map(route => `${base}${route}`));
  options.egress?.inferenceRoutes?.([...routes]);
  const validateCredentials = (credentials: Readonly<Record<string, string>>): void => {
    for (const [name, value] of Object.entries(credentials)) {
      if (!value || /[\r\n]/.test(value) || !/^[a-z0-9-]+$/i.test(name)) throw new Error("Invalid relay credential header");
    }
  };
  if (typeof options.credentials !== "function") validateCredentials(options.credentials);
  // Private to this server user; the worker sees only the bind-mounted socket.
  const dir = mkdtempSync(join(tmpdir(), "brain-inference-"));
  const separateIdentity = Boolean(workerIdentityHelper());
  chmodSync(dir, separateIdentity ? 0o750 : 0o700);
  const socketPath = join(dir, "relay.sock");
  const refuse = (method: string, path: string, status: number, reason: string, denialReason?: string): Response => {
    observeDiagnostic(() => options.observe?.({ method, path, outcome: "refused", status, reason, ...(denialReason ? { denialReason } : {}) }));
    return Response.json({ type: "error", error: { type: "brain_inference_refused", message: reason } }, { status });
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: socketPath,
      // Streaming inference can idle between events for longer than Bun's 10s
      // default, e.g. while a model writes one large tool input. Bun 1.4 does
      // not honour a per-request `timeout(request, 0)` once the response
      // streams, so disable it here.
      // bun-types declares idleTimeout only for hostname servers; the runtime
      // honours it on a Unix socket too (#3441 regression tests prove it).
      ...({ idleTimeout: 0 } as object),
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        let operation: InferenceOperation | undefined;
        let arrival: InferenceArrival | undefined;
        // Only exit can brand an inner result. Every return, including catch,
        // crosses the turn gate before the outer fetch can expose a Response.
        const exit = async (create: () => Response | Promise<Response>, discard?: () => Promise<void>): Promise<Gated> => {
          const ready = () => operation?.responseReady() ?? arrival?.responseReady() ?? Promise.resolve(true);
          if (!await ready()) {
            await discard?.(); await ready();
            operation?.finish("denied", "deferred_observation_refused");
            return { [gated]: refuse(request.method, path, 403, "Inference request refused", "deferred_observation_refused") };
          }
          const response = await create();
          // Async response construction can cross a newer tool result too.
          if (!await ready()) {
            await response.body?.cancel().catch(() => {}); await ready();
            operation?.finish("denied", "deferred_observation_refused");
            return { [gated]: refuse(request.method, path, 403, "Inference request refused", "deferred_observation_refused") };
          }
          return { [gated]: response };
        };
        const handle = async (): Promise<Gated> => {
          arrival = options.egress?.inferenceArrival?.(path);
          if (request.method !== "POST") return exit(() => refuse(request.method, path, 405, "Only inference requests are relayed"));
          if (!routes.has(path)) return exit(() => refuse(request.method, path, 403, "This path is not an authorized inference route"));
          observeDiagnostic(() => options.received?.(path));
          const target = new URL(upstream.origin);
          target.pathname = path; target.search = url.search;
          operation = options.egress?.inference(request.method, target, request.signal, arrival);
          const op = operation;
          const mark = (name: InferenceTimingMark) => observeDiagnostic(() => op?.mark(name));
          const signal = op ? AbortSignal.any([request.signal, op.signal]) : request.signal;
          const denied = (reason: string, status = 403): Promise<Gated> => exit(() => {
            op?.finish("denied", reason);
            return refuse(request.method, path, status, reason === "max_bytes_per_turn" ? "Inference egress limit exceeded" : "Inference request refused", op?.reason?.() ?? reason);
          });
          if (op && !await op.admit()) {
            const cancelled = request.signal.aborted || op.outcome() === "cancelled";
            op.finish(cancelled ? "cancelled" : "denied", "inference_admission_refused");
            return exit(() => refuse(request.method, path, cancelled ? 499 : 403, "Inference network admission refused", op.reason?.()));
          }
          mark("admitMs");
          const declared = Number(request.headers.get("content-length") ?? "0");
          if (declared > MAX_INFERENCE_REQUEST_BYTES) return denied("inference_request_too_large", 413);
          // Do not allocate an unbounded arrayBuffer before checking the ceiling.
          // Charge each received body chunk before retaining or forwarding it.
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
              if (length > MAX_INFERENCE_REQUEST_BYTES || op && !op.charge(next.value.byteLength + 16)) {
                await reader.cancel().catch(() => {});
                return denied(length > MAX_INFERENCE_REQUEST_BYTES ? "inference_request_too_large" : "max_bytes_per_turn",
                  length > MAX_INFERENCE_REQUEST_BYTES ? 413 : 403);
              }
              chunks.push(next.value);
            }
          } catch {
            op?.finish("cancelled", "client_disconnected");
            return exit(() => refuse(request.method, path, 499, "Inference request cancelled"));
          } finally { signal.removeEventListener("abort", cancelBody); reader?.releaseLock(); }
          mark("bodyMs");
          const body = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
          const headers = new Headers();
          for (const [name, value] of request.headers) if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
          let credentials: Readonly<Record<string, string>>;
          if (signal.aborted) {
            op?.finish("cancelled", "client_disconnected");
            return exit(() => refuse(request.method, path, 499, "Inference request cancelled"));
          }
          try {
            credentials = typeof options.credentials === "function" ? await options.credentials(signal, new URL(target)) : options.credentials;
            validateCredentials(credentials);
            mark("credentialMs");
            if (signal.aborted) {
              op?.finish("cancelled", "client_disconnected");
              return exit(() => refuse(request.method, path, 499, "Inference request cancelled"));
            }
            for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
          } catch {
            // A resolver error may carry a provider reply, credential or host path.
            const cancelled = signal.aborted;
            op?.finish(cancelled ? "cancelled" : "failed", "inference_credentials_unavailable");
            return exit(() => refuse(request.method, path, cancelled ? 499 : 503,
              cancelled ? "Inference request cancelled" : "Inference credentials unavailable"));
          }
          // HTTP application framing before provider TLS: never describe this as
          // measured TLS ciphertext/handshake bytes. Include every observable
          // query/header byte plus a conservative runtime framing allowance.
          const headerBytes = (first: string, values: Headers): number => {
            let bytes = Buffer.byteLength(first) + 1028;
            for (const [name, value] of values) bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
            return bytes;
          };
          if (op && !op.charge(headerBytes(`${request.method} ${path}${url.search} HTTP/1.1`, headers))) {
            return denied("max_bytes_per_turn");
          }
          // Body/credential waits may have crossed an input-recording failure.
          // Re-enter the concrete host admission at the last dispatch boundary.
          if(op&&!await op.admit())return denied("inference_admission_refused");
          if (op && !await op.prepareDispatch(body)) return denied("inference_admission_refused");
          if (op && !op.dispatch()) {
            // An unconfirmed speculative stop falls back to the existing held
            // observation. After it commits, base admission may proceed normally.
            if (!await op.responseReady() || !await op.admit() || !op.dispatch()) return denied("inference_admission_refused");
          }
          let response: Response;
          try {
            // Never follow a redirect: the upstream must not choose another host.
            mark("dispatchMs");
            response = await fetch(target, { method: "POST", headers, body, redirect: "manual", signal });
          } catch {
            const cancelled = signal.aborted;
            op?.finish(cancelled ? "cancelled" : "failed", "upstream_unreachable");
            return exit(() => refuse(request.method, path, cancelled ? 499 : 502,
              cancelled ? "Inference request cancelled" : "Inference upstream unreachable"));
          }
          mark("headersMs");
          return exit(async () => {
            if (response.status >= 300 && response.status < 400) {
              op?.finish("failed", "upstream_redirected");
              await response.body?.cancel().catch(() => {});
              return refuse(request.method, path, 502, "Inference upstream redirected; redirects are not followed");
            }
            observeDiagnostic(() => options.observe?.({ method: request.method, path, outcome: "forwarded", status: response.status }));
            const out = new Headers();
            for (const [name, value] of response.headers) if (!RESPONSE_STRIPPED.has(name.toLowerCase())) out.set(name, value);
            if (op && !op.charge(headerBytes(`HTTP/1.1 ${response.status} ${response.statusText}`, response.headers))) {
              op.finish("denied", "max_bytes_per_turn");
              await response.body?.cancel().catch(() => {});
              return refuse(request.method, path, 403, "Inference egress limit exceeded");
            }
            if (!op) return new Response(response.body, { status: response.status, headers: out });
            if (!response.body) {
              op.finish("completed");
              return new Response(null, { status: response.status, headers: out });
            }
            const upstreamReader = response.body.getReader();
            let observeUsage: ((chunk: Uint8Array) => void) | undefined;
            observeDiagnostic(() => { observeUsage = inferenceUsageObserver(usage => observeDiagnostic(() => op.observeUsage(usage))); });
            let firstReadAttempted = false;
            let released = false;
            const release = () => { if (!released) { released = true; upstreamReader.releaseLock(); } };
            const output = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await upstreamReader.read();
                  if (!firstReadAttempted) { firstReadAttempted = true; mark("firstChunkMs"); }
                  if (next.done) { op.finish("completed"); release(); controller.close(); }
                  else if (!op.charge(next.value.byteLength + 16)) {
                    op.finish("denied", "max_bytes_per_turn");
                    await upstreamReader.cancel().catch(() => {}); release();
                    controller.error(new Error("Inference egress limit exceeded"));
                  } else { controller.enqueue(next.value); observeDiagnostic(() => observeUsage?.(next.value)); }
                } catch {
                  op.finish(signal.aborted ? "cancelled" : "failed", "upstream_response_failed");
                  release(); controller.error(new Error("Inference response interrupted"));
                }
              },
              async cancel() {
                op.finish("cancelled", "client_disconnected");
                await upstreamReader.cancel().catch(() => {}); release();
              },
            });
            return new Response(output, { status: response.status, headers: out });
          }, async () => { await response.body?.cancel().catch(() => {}); });
        };
        try { return (await handle())[gated]; }
        catch {
          // Exception messages can contain provider bytes or credentials.
          operation?.finish("failed", "inference_relay_failed");
          return (await exit(() => refuse(request.method, path, 500, "Inference relay failed")))[gated];
        } finally { if (!operation) arrival?.close(); }
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

/** Anthropic Messages routes, the only ones a Claude or pi Anthropic turn needs. */
export const ANTHROPIC_INFERENCE_ROUTES = Object.freeze(["/v1/messages", "/v1/messages/count_tokens"]);
