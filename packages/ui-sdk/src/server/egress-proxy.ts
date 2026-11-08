/** Concrete host-owned HTTP/CONNECT transport for one turn; no TLS interception. */
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { chmodSync, chownSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { workerIdentityHelper } from "./worker-identity.js";
import { join } from "node:path";
import { safetyAdmissionRefusal, type AdmissionSafety, type AdmissionSafetySnapshot } from "./admission-safety.js";

export const WORKER_EGRESS_DIR = "/run/brain-egress";
export const WORKER_EGRESS_SOCKET = `${WORKER_EGRESS_DIR}/proxy.sock`;
/** What the worker bootstrap sets so a tool's network reaches the turn proxy; a tool spawn must keep them. */
export const WORKER_EGRESS_TRANSPORT_ENV = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "GIT_SSH_COMMAND"]);
export interface EgressRecord {
  /** Host identity, shared with admission and terminal observation; never a tool correlation. */
  connectionId?: string;
  /** Only the server's concrete inference-relay admission supplies this tag. */
  inference?: true;
  /** Only a validated provider-relay operation supplies this tag (#3246); never with `inference`. */
  provider?: true;
  method: string;
  host: string;
  port: number;
  /** Only cleartext HTTP has an observable path. Never invent one for CONNECT. */
  path?: string;
  bytes: number;
  /** HTTP includes a conservative framing allowance; CONNECT counts opaque stream bytes. */
  accounting: "http_wire_bound" | "opaque_bytes";
  durationMs: number;
  outcome: "completed" | "denied" | "failed" | "cancelled";
  reason?: string;
}
export interface EgressProxyOptions {
  /** Host-owned effective state. No request header or concurrent operation supplies authority. */
  admissionSafety?: AdmissionSafety;
  mode: "record" | "allowlist";
  /** Exact DNS names/IPs or *.suffix; deny always wins. */
  allow: readonly string[];
  deny: readonly string[];
  maxBytes: number;
  outwardHosts: readonly string[];
  /** Destination ports that are outward on any host, such as mail submission. */
  outwardPorts?: readonly number[];
  /** Host authority for this connection. An observation of a tool is not a grant. */
  approveOutward?(destination: { host: string; port: number; method: string }, signal: AbortSignal): Promise<boolean>;
  observe(record: EgressRecord): void;
  /**
   * Untrusted-input narrowing (G6). While `tainted()` holds, a destination
   * other than a host relay (the inference relay or a validated provider-relay
   * operation, #3246) must also match `allow` or be one `contacted()` reports;
   * deny and the ordinary rules still apply first. `approve`, when present,
   * asks before refusing a narrowed destination (#3430); absent, or resolving
   * anything but `true`, refuses.
   */
  taint?: { allow: readonly string[]; tainted(connectionId?: string): boolean; contacted(host: string): boolean;
    approve?(destination: { host: string; port: number; method: string }, signal: AbortSignal): Promise<boolean>;
    /** What tainted the session, as "it …" completes it, for a refusal's message (#3431). */
    cause?(): string | null };
  /**
   * A destination passed every check; called before its first upstream byte.
   * A returned promise is awaited first, so a durable record it makes commits
   * before any byte flows; its rejection refuses the connection.
   */
  admitted?(destination: { host: string; port: number; method: string; inference: boolean; provider: boolean; connectionId: string; protocol?: string }): unknown;
  /** Synchronous notification only after final admission, immediately before dispatch. */
  committed?(destination: { host: string; connectionId: string; inference: boolean; provider: boolean }): void;
  signal?: AbortSignal;
}
const hostname = (value: string) => value.toLowerCase().replace(/\.$/, "");
function matches(host: string, patterns: readonly string[]): boolean {
  return patterns.some(value => {
    const pattern = hostname(value);
    return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) : host === pattern;
  });
}
/**
 * What a refused connection tells the tool that made it (#3430, #3431). curl,
 * git and `egress-connect` print the status line, so it carries the reason;
 * HTTP clients also get it as the body. `cause` uses `egress_denial`'s reason
 * words, plus `outward_not_approved`. No request content, header or credential
 * appears in either.
 */
export interface EgressRefusal {
  cause: "denied_host" | "not_allowlisted" | "byte_cap" | "taint_allowlist" | "outward_not_approved";
  message: string;
}
function describeRefusal(reason: string | undefined, host: string, denied: boolean, tainted: string | null | undefined): EgressRefusal | undefined {
  switch (reason) {
    case "taint_not_approved": return { cause: "taint_allowlist",
      message: "Blocked: this session read untrusted content, this host is outside its allow-list, and the user declined the connection. Do not retry it; say what you needed it for." };
    case "taint_not_allowed": return { cause: "taint_allowlist",
      message: `Blocked: this session read untrusted content${tainted ? ` (it ${tainted})` : ""}, and ${host} is not on its taint allow-list or among the hosts it already reached. `
        + "Do not retry it; tell the user. They can add the host to taint.egress.allow in the brain's governance policy, or continue in a new session." };
    case "destination_not_allowed": return denied
      ? { cause: "denied_host", message: `Blocked: ${host} is on this brain's egress deny list. Do not retry it; tell the user.` }
      : { cause: "not_allowlisted", message: `Blocked: ${host} is not on this brain's egress allow list. Do not retry it; tell the user, who can add it to egress.allow in the brain's governance policy.` };
    case "max_bytes_per_turn": return { cause: "byte_cap",
      message: "Blocked: this turn has used up its network byte limit (egress.max_bytes_per_turn). Do not retry in this turn; tell the user." };
    case "outward_not_approved": return { cause: "outward_not_approved",
      message: `Blocked: a connection to ${host} acts outside the brain in the user's name, and it was not approved. Do not retry it; say what you needed it for.` };
    default: return undefined;
  }
}
/** The status text each refusal answers with; the declined card's text predates #3431. */
const REFUSAL_STATUS: Readonly<Record<EgressRefusal["cause"], string>> = {
  denied_host: "Forbidden - host on the egress deny list", not_allowlisted: "Forbidden - host not on the egress allow list",
  byte_cap: "Forbidden - turn network byte limit reached", taint_allowlist: "Forbidden - untrusted session, host not allowed",
  outward_not_approved: "Forbidden - outward connection not approved",
};
/** One refused connection's 403, with its reason when it has one. */
function refusalHead(refusal: EgressRefusal | undefined, reason: string | undefined): { status: string; body: string } | undefined {
  if (!refusal) return undefined;
  const status = reason === "taint_not_approved" ? "Forbidden - declined by the user" : REFUSAL_STATUS[refusal.cause];
  return { status, body: `${refusal.message}\n` };
}
/** No header controlled by the peer can select a second upstream or carry proxy authority. */
const hopHeaders = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
function headers(message: IncomingMessage): Record<string, string | string[]> {
  const blocked = new Set([...hopHeaders, ...(message.headers.connection ?? "").split(",").map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(message.headers).filter(([name, value]) => value !== undefined && !blocked.has(name))) as Record<string, string | string[]>;
}

export async function startEgressProxy(options: EgressProxyOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error("Egress maxBytes must be a finite nonnegative integer");
  for (const pattern of [...options.allow, ...options.deny, ...options.outwardHosts, ...options.taint?.allow ?? []]) {
    if (!/^(?:\*\.)?[a-zA-Z0-9.-]+$/.test(pattern) || pattern.includes("..")) throw new Error("Invalid egress host pattern");
  }
  for (const port of options.outwardPorts ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid outward port");
  }
  const separateIdentity = Boolean(workerIdentityHelper());
  const dir = mkdtempSync(join(tmpdir(), "brain-egress-"));
  try {
    if (separateIdentity) chownSync(dir, process.getuid!(), process.getgid!());
    chmodSync(dir, separateIdentity ? 0o750 : 0o700);
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  const socketPath = join(dir, "proxy.sock");
  const connections = new Set<Socket>();
  const controllers = new Set<AbortController>();
  let usedBytes = 0, stopped = false;
  const server = createServer();
  server.maxHeadersCount = 100;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.on("connection", socket => { connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket)); });
  const track = (socket: Socket) => { connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket)); return socket; };
  /**
   * `relay` names the host relay that sent this operation; worker HTTP and
   * CONNECT traffic has none and cannot claim one, whatever its destination.
   */
  function operation(method: string, url: URL, relay?: "inference" | "provider") {
    const inference = relay === "inference", provider = relay === "provider";
    const connectionId = crypto.randomUUID();
    let snapshot: AdmissionSafetySnapshot | undefined;
    const started = performance.now();
    const controller = new AbortController(); controllers.add(controller);
    const host = hostname(url.hostname), port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    let bytes = 0, finished = false;
    let finalOutcome: EgressRecord["outcome"] | undefined, finalReason: string | undefined;
    const finish = (outcome: EgressRecord["outcome"], reason?: string) => {
      if (finished) return;
      finished = true; finalOutcome = outcome; finalReason = reason; controllers.delete(controller); controller.abort();
      // Records never contain request headers, content, credentials or query strings.
      try { options.observe({ connectionId, ...(inference ? { inference: true } : {}), ...(provider ? { provider: true } : {}), method, host, port, ...(method === "CONNECT" ? {} : { path: url.pathname }), bytes,
        accounting: method === "CONNECT" ? "opaque_bytes" : "http_wire_bound",
        durationMs: performance.now() - started, outcome, ...(reason ? { reason } : {}) }); } catch { /* A recorder cannot keep a connection alive. */ }
    };
    // Turn cleanup must observe final audit failures before it publishes its
    // terminal outcome; socket close callbacks run only after stop returns.
    controller.signal.addEventListener("abort", () => finish("cancelled", "turn_cancelled"), { once: true });
    const charge = (count: number) => {
      if (finished || stopped) return false;
      if (count > options.maxBytes - usedBytes) { finish("denied", "max_bytes_per_turn"); return false; }
      usedBytes += count; bytes += count; return true;
    };
    /** One approval wait; cancelling this connection or the turn resolves it as refused. */
    const approval = async (ask: ((destination: { host: string; port: number; method: string }, signal: AbortSignal) => Promise<boolean>) | undefined) => {
      if (!ask) return false;
      let approved = false;
      let cancelled: (() => void) | undefined;
      try {
        const cancellation = new Promise<false>(resolve => {
          cancelled = () => resolve(false);
          controller.signal.addEventListener("abort", cancelled, { once: true });
          if (controller.signal.aborted) resolve(false);
        });
        approved = await Promise.race([ask({ host, port, method }, controller.signal), cancellation]) === true;
      } catch { /* A failed approval denies. */ }
      finally { if (cancelled) controller.signal.removeEventListener("abort", cancelled); }
      return approved && !controller.signal.aborted && !stopped;
    };
    // An approval of this destination outside the taint allow-list (#3430).
    let granted = false;
    // Checked again after an approval wait, during which another connection may taint the session.
    // Neither host relay is narrowed by taint (G6; #3246 for the provider relay).
    const narrowed = (final = false) => !granted && !relay && options.taint?.tainted(final ? connectionId : undefined) && !matches(host, options.taint.allow) && !options.taint.contacted(host);
    const narrowing = async () => {
      if (!narrowed()) return true;
      if (options.taint?.approve) granted = await approval(options.taint.approve.bind(options.taint));
      if (!granted) finish(stopped ? "cancelled" : "denied", options.taint?.approve ? "taint_not_approved" : "taint_not_allowed");
      return granted;
    };
    const admit = async () => {
      snapshot = options.admissionSafety?.read();
      if (safetyAdmissionRefusal(options.admissionSafety, snapshot)) { finish("denied", "safety_changed"); return false; }
      if (stopped || options.signal?.aborted) { finish("cancelled", "turn_cancelled"); return false; }
      if (matches(host, options.deny) || options.mode === "allowlist" && !matches(host, options.allow)) { finish("denied", "destination_not_allowed"); return false; }
      if (usedBytes >= options.maxBytes) { finish("denied", "max_bytes_per_turn"); return false; }
      if (!await narrowing()) return false;
      if (matches(host, options.outwardHosts) || options.outwardPorts?.includes(port)) {
        if (!await approval(options.approveOutward)) { finish(stopped ? "cancelled" : "denied", "outward_not_approved"); return false; }
      }
      if (!await narrowing()) return false;
      // A recorder failure aborts the turn through its own signal; it cannot admit.
      try { await options.admitted?.({ host, port, method, inference, provider, connectionId, protocol:url.protocol }); } catch { finish("failed", "proxy_error"); return false; }
      if (stopped || controller.signal.aborted) { finish("cancelled", "turn_cancelled"); return false; }
      return true;
    };
    // No await may intervene between this check and connect/request/fetch.
    const commit = () => {
      if (stopped || controller.signal.aborted || safetyAdmissionRefusal(options.admissionSafety, snapshot)) { finish("denied", "safety_changed"); return false; }
      if (usedBytes >= options.maxBytes) { finish("denied", "max_bytes_per_turn"); return false; }
      if (narrowed(true)) { finish("denied", "taint_not_allowed"); return false; }
      options.committed?.({ host, connectionId, inference, provider });
      return true;
    };
    /** Why this connection was refused, for the tool that made it; undefined while admitted or for a bare refusal. */
    const refusal = () => {
      if (finalOutcome !== "denied") return undefined;
      let cause: string | null | undefined;
      if (finalReason === "taint_not_allowed") try { cause = options.taint?.cause?.(); } catch { /* The message names no cause. */ }
      return describeRefusal(finalReason, host, matches(host, options.deny), cause);
    };
    return { finish, charge, admit, commit, refusal, signal: controller.signal, outcome: () => finalOutcome, reason: () => finalReason };
  }
  server.on("connect", (request, client, head) => {
    client.on("error", () => {});
    let target: URL;
    try {
      if (!request.url || !/^[a-zA-Z0-9.-]+:[0-9]+$/.test(request.url)) throw new Error();
      target = new URL(`http://${request.url}`);
      if (!Number(target.port || 80)) throw new Error();
    } catch { client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const op = operation("CONNECT", target);
    let connected = false;
    client.once("close", () => op.finish(stopped || !connected ? "cancelled" : "completed"));
    void (async () => {
      if (!await op.admit() || client.destroyed || !op.commit()) {
        const declined = refusalHead(op.refusal(), op.reason());
        client.end(declined ? `HTTP/1.1 403 ${declined.status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(declined.body)}\r\nConnection: close\r\n\r\n${declined.body}`
          : "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = track(connect({ host: target.hostname, port: Number(target.port || 80) }));
      upstream.once("connect", () => {
        if (stopped || client.destroyed) { upstream.destroy(); return; }
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) { if (!op.charge(head.length)) { client.destroy(); upstream.destroy(); return; } upstream.write(head); }
        client.on("data", chunk => { if (!op.charge(chunk.length)) { client.destroy(); upstream.destroy(); return; } if (!upstream.write(chunk)) client.pause(); });
        upstream.on("data", chunk => { if (!op.charge(chunk.length)) { client.destroy(); upstream.destroy(); return; } if (!client.write(chunk)) upstream.pause(); });
        upstream.on("drain", () => client.resume()); client.on("drain", () => upstream.resume());
      });
      upstream.once("error", () => { op.finish("failed", "upstream_unreachable"); client.destroy(); });
      upstream.once("end", () => client.end());
      client.once("end", () => upstream.end());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    })().catch(() => { op.finish("failed", "proxy_error"); client.destroy(); });
  });
  server.on("request", (request, response) => {
    let target: URL;
    try {
      target = new URL(request.url!);
      if (target.protocol !== "http:" || target.username || target.password || target.hash) throw new Error();
    } catch { response.writeHead(400); response.end(); return; }
    const op = operation(request.method ?? "GET", target);
    response.once("close", () => op.finish(stopped ? "cancelled" : response.writableFinished ? "completed" : "cancelled"));
    const refuse = () => {
      const declined = refusalHead(op.refusal(), op.reason());
      if (declined) response.writeHead(403, declined.status, { "content-type": "text/plain; charset=utf-8" }).end(declined.body);
      else { response.writeHead(403); response.end(); }
    };
    void (async () => {
      if (!await op.admit() || response.destroyed || !op.commit()) { refuse(); return; }
      const outgoingHeaders = { ...headers(request), host: target.host, connection: "close" };
      // Include the complete observable target and headers: a body-only cap
      // would allow uncharged exfiltration in query strings or header values.
      // The fixed allowance covers runtime-generated framing fields. Chunk
      // accounting below additionally covers each HTTP chunk's framing.
      const headerBytes = (first: string, values: Record<string, string | string[]>) => Buffer.byteLength(first + "\r\n"
        + Object.entries(values).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`)).join("") + "\r\n") + 64;
      if (!op.charge(headerBytes(`${request.method} ${target.pathname}${target.search} HTTP/1.1`, outgoingHeaders))) {
        refuse(); return;
      }
      const outgoing = httpRequest(target, { method: request.method, headers: outgoingHeaders }, incoming => {
        if (!op.charge(headerBytes(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}`, headers(incoming)))) {
          refuse(); incoming.destroy(); outgoing.destroy(); return;
        }
        const writeHeaders = () => { if (!response.headersSent) response.writeHead(incoming.statusCode ?? 502, headers(incoming)); };
        incoming.on("data", chunk => {
          if (!op.charge(chunk.length + 16)) {
            if (!response.headersSent) refuse(); else response.destroy();
            incoming.destroy(); outgoing.destroy(); return;
          }
          writeHeaders(); if (!response.write(chunk)) incoming.pause();
        });
        response.on("drain", () => incoming.resume());
        incoming.once("end", () => { if (!response.destroyed && !response.writableEnded) { writeHeaders(); response.end(); } });
        incoming.once("error", () => { op.finish("failed", "upstream_response_failed"); response.destroy(); });
      });
      outgoing.once("error", () => { op.finish("failed", "upstream_unreachable"); if (!response.headersSent) response.writeHead(502); response.end(); });
      response.once("close", () => outgoing.destroy());
      request.on("data", chunk => { if (!op.charge(chunk.length + 16)) { outgoing.destroy(); response.destroy(); return; } if (!outgoing.write(chunk)) request.pause(); });
      outgoing.on("drain", () => request.resume());
      request.once("end", () => outgoing.end());
      request.once("error", () => { op.finish("cancelled", "client_disconnected"); outgoing.destroy(); });
    })().catch(() => { op.finish("failed", "proxy_error"); response.destroy(); });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); }); });
    if (separateIdentity) chownSync(socketPath, process.getuid!(), process.getgid!());
    chmodSync(socketPath, separateIdentity ? 0o660 : 0o600);
  } catch (error) { server.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
  const stop = () => {
    if (stopped) return;
    stopped = true; options.signal?.removeEventListener("abort", stop);
    for (const controller of controllers) controller.abort();
    for (const socket of connections) socket.destroy();
    server.close(); rmSync(dir, { recursive: true, force: true });
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  return { dir, socketPath, stop, usedBytes: () => usedBytes,
    /** The existing inference relay shares this turn's admission, counter and audit. */
    inference(method: string, target: URL, signal: AbortSignal) { return relayedOperation(method, target, signal, "inference"); },
    /**
     * The CLI provider relay's validated requests (#1673): egress to the
     * provider (G5), with the turn's deny/allow rules, byte ceiling and
     * connection record, sent by the host so the key stays there. Like the
     * inference relay, it neither taints the session nor is narrowed by its
     * taint (G6, #3246); only the relay's own validated routes reach this.
     */
    relayed(method: string, target: URL, signal: AbortSignal) { return relayedOperation(method, target, signal, "provider"); },
  };
  function relayedOperation(method: string, target: URL, signal: AbortSignal, relay: "inference" | "provider") {
    const op = operation(method, new URL(target), relay);
    const abort = () => op.finish("cancelled", "client_disconnected");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return { charge: op.charge, signal: op.signal, outcome: op.outcome, refusal: op.refusal,
      admit: async () => !op.signal.aborted && await op.admit() && op.commit(),
      /** The concrete relay calls this again after its own final async waits. */
      commit: op.commit,
      finish(outcome: EgressRecord["outcome"], reason?: string) {
        signal.removeEventListener("abort", abort); op.finish(outcome, reason);
      },
    };
  }
}
