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
import type { startEgressProxy } from "./egress-proxy.js";

/** Where the relay directory appears inside a restricted worker. */
export const WORKER_INFERENCE_DIR = "/run/brain-inference";
export const WORKER_INFERENCE_SOCKET = `${WORKER_INFERENCE_DIR}/relay.sock`;
/** The value a worker holds where a credential would be. Never a secret. */
export const INFERENCE_PLACEHOLDER = "brain-inference-relay-placeholder";
/** A request body larger than this is refused before anything is forwarded. */
export const MAX_INFERENCE_REQUEST_BYTES = 32 * 1024 * 1024;

export interface InferenceRelayOptions {
  /** Server-selected upstream base, e.g. `https://api.anthropic.com`. */
  upstream: string;
  /** Exact paths below the upstream base path that carry inference. */
  routes: readonly string[];
  /** Server-held headers, resolved for each dispatch after inbound credentials are removed. */
  credentials: Readonly<Record<string, string>> | ((signal: AbortSignal, target: URL) => Promise<Readonly<Record<string, string>>>);
  /** Concrete turn proxy: share its destination admission, application-byte ceiling and audit. */
  egress?: Pick<Awaited<ReturnType<typeof startEgressProxy>>, "inference">;
  /** Called for every request, forwarded or refused. Values are never logged. */
  observe?(event: InferenceRelayEvent): void;
}

export interface InferenceRelayEvent {
  method: string;
  path: string;
  outcome: "forwarded" | "refused";
  status: number;
  reason?: string;
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
  const base = upstream.pathname.replace(/\/+$/, "");
  const routes = new Set(options.routes.map(route => `${base}${route}`));
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
  const refuse = (method: string, path: string, status: number, reason: string): Response => {
    options.observe?.({ method, path, outcome: "refused", status, reason });
    return Response.json({ type: "error", error: { type: "brain_inference_refused", message: reason } }, { status });
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: socketPath,
      async fetch(request, owner) {
        // Streaming inference can idle between events for longer than the default.
        owner.timeout(request, 0);
        const url = new URL(request.url);
        const path = url.pathname;
        if (request.method !== "POST") return refuse(request.method, path, 405, "Only inference requests are relayed");
        if (!routes.has(path)) return refuse(request.method, path, 403, "This path is not an authorized inference route");
        const target = new URL(upstream.origin);
        target.pathname = path; target.search = url.search;
        const operation = options.egress?.inference(request.method, target, request.signal);
        const signal = operation ? AbortSignal.any([request.signal, operation.signal]) : request.signal;
        const denied = (reason: string, status = 403): Response => {
          operation?.finish("denied", reason);
          return refuse(request.method, path, status, reason === "max_bytes_per_turn" ? "Inference egress limit exceeded" : "Inference request refused");
        };
        if (operation && !await operation.admit()) {
          const cancelled = request.signal.aborted || operation.outcome() === "cancelled";
          operation.finish(cancelled ? "cancelled" : "denied", "inference_admission_refused");
          return refuse(request.method, path, cancelled ? 499 : 403, "Inference network admission refused");
        }
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
            if (length > MAX_INFERENCE_REQUEST_BYTES || operation && !operation.charge(next.value.byteLength + 16)) {
              await reader.cancel().catch(() => {});
              return denied(length > MAX_INFERENCE_REQUEST_BYTES ? "inference_request_too_large" : "max_bytes_per_turn",
                length > MAX_INFERENCE_REQUEST_BYTES ? 413 : 403);
            }
            chunks.push(next.value);
          }
        } catch {
          operation?.finish("cancelled", "client_disconnected");
          return refuse(request.method, path, 499, "Inference request cancelled");
        } finally { signal.removeEventListener("abort", cancelBody); reader?.releaseLock(); }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        const headers = new Headers();
        for (const [name, value] of request.headers) if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
        let credentials: Readonly<Record<string, string>>;
        if (signal.aborted) {
          operation?.finish("cancelled", "client_disconnected");
          return refuse(request.method, path, 499, "Inference request cancelled");
        }
        try {
          credentials = typeof options.credentials === "function" ? await options.credentials(signal, new URL(target)) : options.credentials;
          validateCredentials(credentials);
          if (signal.aborted) {
            operation?.finish("cancelled", "client_disconnected");
            return refuse(request.method, path, 499, "Inference request cancelled");
          }
          for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
        } catch {
          // A resolver error may carry a provider reply, credential or host path.
          operation?.finish(signal.aborted ? "cancelled" : "failed", "inference_credentials_unavailable");
          return refuse(request.method, path, signal.aborted ? 499 : 503,
            signal.aborted ? "Inference request cancelled" : "Inference credentials unavailable");
        }
        // HTTP application framing before provider TLS: never describe this as
        // measured TLS ciphertext/handshake bytes. Include every observable
        // query/header byte plus a conservative runtime framing allowance.
        const headerBytes = (first: string, values: Headers): number => {
          let bytes = Buffer.byteLength(first) + 1028;
          for (const [name, value] of values) bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
          return bytes;
        };
        if (operation && !operation.charge(headerBytes(`${request.method} ${path}${url.search} HTTP/1.1`, headers))) {
          return denied("max_bytes_per_turn");
        }
        let response: Response;
        try {
          // Never follow a redirect: the upstream must not choose another host.
          response = await fetch(target, { method: "POST", headers, body, redirect: "manual", signal });
        } catch {
          operation?.finish(signal.aborted ? "cancelled" : "failed", "upstream_unreachable");
          return refuse(request.method, path, signal.aborted ? 499 : 502,
            signal.aborted ? "Inference request cancelled" : "Inference upstream unreachable");
        }
        if (response.status >= 300 && response.status < 400) {
          operation?.finish("failed", "upstream_redirected");
          await response.body?.cancel().catch(() => {});
          return refuse(request.method, path, 502, "Inference upstream redirected; redirects are not followed");
        }
        options.observe?.({ method: request.method, path, outcome: "forwarded", status: response.status });
        const out = new Headers();
        for (const [name, value] of response.headers) if (!RESPONSE_STRIPPED.has(name.toLowerCase())) out.set(name, value);
        if (operation && !operation.charge(headerBytes(`HTTP/1.1 ${response.status} ${response.statusText}`, response.headers))) {
          operation.finish("denied", "max_bytes_per_turn");
          await response.body?.cancel().catch(() => {});
          return refuse(request.method, path, 403, "Inference egress limit exceeded");
        }
        if (!operation) return new Response(response.body, { status: response.status, headers: out });
        if (!response.body) {
          operation.finish("completed");
          return new Response(null, { status: response.status, headers: out });
        }
        const upstreamReader = response.body.getReader();
        let released = false;
        const release = () => { if (!released) { released = true; upstreamReader.releaseLock(); } };
        const output = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await upstreamReader.read();
              if (next.done) { operation.finish("completed"); release(); controller.close(); }
              else if (!operation.charge(next.value.byteLength + 16)) {
                operation.finish("denied", "max_bytes_per_turn");
                await upstreamReader.cancel().catch(() => {}); release();
                controller.error(new Error("Inference egress limit exceeded"));
              } else controller.enqueue(next.value);
            } catch {
              operation.finish(signal.aborted ? "cancelled" : "failed", "upstream_response_failed");
              release(); controller.error(new Error("Inference response interrupted"));
            }
          },
          async cancel() {
            operation.finish("cancelled", "client_disconnected");
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

/** Anthropic Messages routes, the only ones a Claude or pi Anthropic turn needs. */
export const ANTHROPIC_INFERENCE_ROUTES = Object.freeze(["/v1/messages", "/v1/messages/count_tokens"]);
