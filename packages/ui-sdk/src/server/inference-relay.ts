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
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** Server-held credential headers, set after every inbound one is removed. */
  credentials: Readonly<Record<string, string>>;
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
  for (const [name, value] of Object.entries(options.credentials)) {
    if (!value || /[\r\n]/.test(value) || !/^[a-z0-9-]+$/i.test(name)) throw new Error(`Invalid relay credential header ${name}`);
  }
  // Private to this server user; the worker sees only the bind-mounted socket.
  const dir = mkdtempSync(join(tmpdir(), "brain-inference-"));
  chmodSync(dir, 0o700);
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
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_INFERENCE_REQUEST_BYTES) return refuse(request.method, path, 413, "Inference request too large");
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > MAX_INFERENCE_REQUEST_BYTES) return refuse(request.method, path, 413, "Inference request too large");
        const headers = new Headers();
        for (const [name, value] of request.headers) if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
        for (const [name, value] of Object.entries(options.credentials)) headers.set(name, value);
        const target = new URL(upstream.origin);
        target.pathname = path;
        target.search = url.search;
        let response: Response;
        try {
          // Never follow a redirect: the upstream must not choose another host.
          response = await fetch(target, { method: "POST", headers, body, redirect: "manual", signal: request.signal });
        } catch (error) {
          return refuse(request.method, path, 502, `Inference upstream unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return refuse(request.method, path, 502, "Inference upstream redirected; redirects are not followed");
        }
        options.observe?.({ method: request.method, path, outcome: "forwarded", status: response.status });
        const out = new Headers();
        for (const [name, value] of response.headers) if (!RESPONSE_STRIPPED.has(name.toLowerCase())) out.set(name, value);
        return new Response(response.body, { status: response.status, headers: out });
      },
    });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  chmodSync(socketPath, 0o600);
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
