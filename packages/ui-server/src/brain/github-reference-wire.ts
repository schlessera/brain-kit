/** Fixed host GitHub acquisition wire. It grants no source trust or worker relay. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as lookupHost } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { Duplex, Transform } from "node:stream";
import { connect as connectTls } from "node:tls";
import { egressAddressRefusal, egressChargeRefusal, type EgressChargeFailure } from "@schlessera/brain-ui-sdk/internal";
import { githubReferenceOwner, githubReferenceRepository, type GitHubReferenceRepository } from "./github-reference-identity.js";
import { ReferenceTransportError } from "./reference-transport.js";
import type { prepareTurnEgress } from "./turn-egress.js";

type Egress = Pick<Awaited<ReturnType<typeof prepareTurnEgress>>, "managedReference" | "remainingBytes">;
type Recipient = "git" | "metadata";
const chargeError = (failure:EgressChargeFailure) => new ReferenceTransportError(failure.reason === "budget" ? "capacity" : failure.reason === "safety_changed" || failure.reason === "policy_denied" ? "denied" : "unavailable",egressChargeRefusal(failure,"Reference").message);
const MAX_METADATA_BYTES = 65536;

/** One acquisition owns this budget across metadata, discovery, auth retries and Git fetch. */
export async function createGitHubReferenceWire(options: ({ repository: unknown; owner?: never } | { owner: unknown; repository?: never }) & {
  egress: Egress;
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  pendingRecording?(signal?: AbortSignal): Iterable<Promise<void>>;
  /** Host reads live principal/grant/recipient state, including after async waits. */
  authorize(recipient: Recipient, credentialed: boolean): void;
  /** Lowest transport test seams; production uses fixed public DNS/TCP and system TLS trust. */
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
  connect?: typeof connect;
  ca?: string;
}) {
  const repository: GitHubReferenceRepository | null = options.owner === undefined ? githubReferenceRepository(options.repository) : null;
  const resource = repository ?? githubReferenceOwner(options.owner);
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new ReferenceTransportError("invalid", "reference wire needs positive byte and deadline bounds");
  options.signal?.throwIfAborted();
  const controller = new AbortController(), sockets = new Set<Duplex>();
  const operations = new Set<ReturnType<Egress["managedReference"]>>();
  const capabilities = (["git", "metadata"] as const).flatMap(recipient => [false, true].map(credentialed => {
    const secret = randomBytes(32).toString("base64url");
    return { recipient, credentialed, secret, authorization: Buffer.from(`Basic ${Buffer.from(`reference:${secret}`).toString("base64")}`) };
  }));
  const upstreams = new Set<Socket>();
  let outgoingWireBytes = 0, incomingWireBytes = 0;
  let chargedBytes = 0, observedIncomingBytes = 0, failure: Error | undefined, closed = false;
  const check = (recipient: Recipient, credentialed: boolean) => {
    controller.signal.throwIfAborted();
    if (!repository && (recipient !== "metadata" || credentialed))
      throw new ReferenceTransportError("denied", "owner metadata is anonymous and grants no Git channel");
    try { options.authorize(recipient, credentialed); }
    catch {
      const error = new ReferenceTransportError("denied", "reference authority is no longer available"); fail(error); throw error;
    }
  };
  function* settledAuthority(recipient: Recipient, credentialed: boolean) {
    yield* options.pendingRecording?.(controller.signal) ?? [];
    check(recipient, credentialed);
  }
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); return socket;
  };
  const fail = (error: Error) => {
    failure ??= error;
    controller.abort(error);
    for (const operation of operations) operation.finish("cancelled", "reference_cancelled");
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  const abort = () => fail(new ReferenceTransportError("unavailable", "reference acquisition was cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => fail(new ReferenceTransportError("unavailable", "reference acquisition reached its deadline")), timeoutMs);
  deadline.unref?.();
  const server = createServer({ maxHeaderSize: 4096 }, (_request, response) => { response.writeHead(403); response.end(); });
  server.maxHeadersCount = 8; server.maxConnections = 8; server.headersTimeout = 5000; server.requestTimeout = 10000;
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    client.pause();
    void (async () => {
      const received = Buffer.from(request.headers["proxy-authorization"] ?? "");
      const recipient: Recipient | null = request.url === "github.com:443" ? "git" : request.url === "api.github.com:443" ? "metadata" : null;
      // Git/libcurl can wait for the standard proxy challenge before sending
      // URL credentials. A challenge grants no connection or recipient authority.
      if (recipient && received.length === 0) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="reference"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      const capability = capabilities.find(value => value.recipient === recipient && received.length === value.authorization.length
        && timingSafeEqual(received, value.authorization));
      if (!recipient || !capability) {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      for (const pending of settledAuthority(recipient, capability.credentialed)) await pending;
      const target = new URL(recipient === "git" ? repository!.canonical : resource.metadataUrl);
      const operation = options.egress.managedReference(target, controller.signal); operations.add(operation);
      let upstream: Socket | undefined, piping = false;
      const operationStopped = () => {
        if (operation.outcome() === "completed") return;
        upstream?.destroy(); client.destroy();
        if (operation.outcome() === "cancelled" && !controller.signal.aborted) {
          const decision = operation.failure();
          if (decision) fail(chargeError(decision));
        }
      };
      operation.signal.addEventListener("abort", operationStopped, { once: true });
      const finish = (outcome: "completed" | "failed" | "cancelled") => {
        operations.delete(operation); operation.signal.removeEventListener("abort", operationStopped); operation.finish(outcome);
      };
      client.once("close", () => {
        const closed = () => { upstream?.destroy(); finish(controller.signal.aborted ? "cancelled" : "completed"); };
        if (piping && client.readableEnded && upstream && !upstream.destroyed && !upstream.writableFinished) upstream.once("finish", closed);
        else closed();
      });
      try {
        if (!await operation.admit()) throw chargeError(operation.failure() ?? {ok:false,reason:"unavailable"});
        const addresses = options.lookup ? await options.lookup(target.hostname, { all: true, verbatim: true })
          : await lookupHost(target.hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(value => egressAddressRefusal(value.address)))
          throw new ReferenceTransportError("denied", "reference recipient did not resolve to public addresses");
        for (const pending of operation.pendingRecording?.() ?? []) await pending;
        check(recipient, capability.credentialed);
        const beforeConnection = operation.prepare(); if (!beforeConnection.ok) throw chargeError(beforeConnection);
        for (const pending of operation.pendingRecording?.() ?? []) await pending;
        check(recipient, capability.credentialed);
        if (client.destroyed) throw new ReferenceTransportError("unavailable", "reference client closed before connection");
        const dispatched=operation.dispatch(()=>{upstream=track((options.connect??connect)({host:addresses[0]!.address,port:443,signal:AbortSignal.any([controller.signal,operation.signal])}));});
        if(!dispatched.ok)throw chargeError(dispatched);
        const heldUpstream = upstream!; upstreams.add(heldUpstream);
        heldUpstream.once("close", () => {
          upstreams.delete(heldUpstream); outgoingWireBytes += heldUpstream.bytesWritten; incomingWireBytes += heldUpstream.bytesRead;
        });
        await new Promise<void>((resolve, reject) => {
          const done = (error?: Error) => {
            controller.signal.removeEventListener("abort", cancel);
            upstream!.removeListener("connect", ready); upstream!.removeListener("error", refused); upstream!.removeListener("close", ended);
            if (error) reject(error); else resolve();
          };
          const ready = () => done(), refused = (error: Error) => done(error);
          const ended = () => done(new Error("Reference connection closed before dispatch"));
          const cancel = () => { upstream!.destroy(); done(new Error("Reference connection cancelled")); };
          upstream!.once("connect", ready); upstream!.once("error", refused); upstream!.once("close", ended);
          controller.signal.addEventListener("abort", cancel, { once: true });
          if (controller.signal.aborted) cancel();
        });
        for (const pending of operation.pendingRecording?.() ?? []) await pending;
        check(recipient, capability.credentialed);
        const afterConnection = operation.charge(0); if (!afterConnection.ok) throw chargeError(afterConnection);
        if (client.destroyed) throw new ReferenceTransportError("unavailable", "reference client closed after connection");
        const meter = (incoming: boolean) => new Transform({ async transform(chunk: Buffer, _encoding, done) {
          if (incoming) observedIncomingBytes += chunk.length;
          try {
            for (const pending of operation.pendingRecording?.() ?? []) await pending;
            check(recipient, capability.credentialed);
            const remaining = Math.min(options.maxBytes - chargedBytes, options.egress.remainingBytes());
            if (chunk.length > remaining) {
              // Charge received wire up to the ceiling, then close every channel.
              // A rejected outbound chunk never reaches the upstream.
              if (incoming && remaining > 0) { const charged = operation.charge(remaining); if (!charged.ok) throw chargeError(charged); chargedBytes += remaining; }
              operation.finish("denied", "max_reference_wire_bytes");
              throw new ReferenceTransportError("capacity", "reference acquisition exhausted its network byte allowance");
            }
            const charged = operation.charge(chunk.length); if (!charged.ok) throw chargeError(charged);
            chargedBytes += chunk.length; done(null, chunk);
          } catch (error) { fail(error as Error); done(error as Error); }
        } });
        const outgoing = meter(false), incoming = meter(true);
        outgoing.on("error", () => { upstream?.destroy(); client.destroy(); });
        incoming.on("error", () => { upstream?.destroy(); client.destroy(); });
        heldUpstream.once("error", () => { finish("failed"); client.destroy(); });
        heldUpstream.once("close", () => {
          const closed = () => {
            finish(controller.signal.aborted ? "cancelled" : heldUpstream.readableEnded ? "completed" : "failed");
            if (!heldUpstream.readableEnded) client.destroy();
          };
          if (heldUpstream.readableEnded && !client.destroyed && !client.writableFinished) client.once("finish", closed);
          else closed();
        });
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        piping = true;
        if (head.length) outgoing.write(head);
        client.pipe(outgoing).pipe(heldUpstream); heldUpstream.pipe(incoming).pipe(client);
        client.resume();
      } catch (error) {
        finish(controller.signal.aborted ? "cancelled" : "failed");
        if (error instanceof ReferenceTransportError) fail(error);
        client.destroy();
      }
    })().catch(error => { if (error instanceof ReferenceTransportError) fail(error); client.destroy(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  } catch (error) {
    clearTimeout(deadline); options.signal?.removeEventListener("abort", abort); server.close(); throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new ReferenceTransportError("unavailable", "reference wire did not start");
  if (options.signal?.aborted) abort();
  if (controller.signal.aborted) {
    clearTimeout(deadline); options.signal?.removeEventListener("abort", abort);
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw failure ?? new ReferenceTransportError("unavailable", "reference acquisition ended before wire startup");
  }

  return Object.freeze({
    repository: repository?.canonical ?? null,
    signal: controller.signal,
    gitProxyUrl(credentialed: boolean): string {
      if (!repository) throw new ReferenceTransportError("denied", "owner metadata grants no Git channel");
      const capability = capabilities.find(value => value.recipient === "git" && value.credentialed === credentialed)!;
      return `http://reference:${capability.secret}@127.0.0.1:${address.port}`;
    },
    bytes: () => ({ chargedBytes, observedIncomingBytes,
      incomingWireBytes: incomingWireBytes + [...upstreams].reduce((sum, socket) => sum + socket.bytesRead, 0),
      outgoingWireBytes: outgoingWireBytes + [...upstreams].reduce((sum, socket) => sum + socket.bytesWritten, 0) }),
    failure: () => failure,
    /** Fixed GET only; no redirect, worker header/body, arbitrary API path or generic authenticated relay. */
    async metadata(token: string | null): Promise<{ status: number; value: unknown }> {
      for (const pending of settledAuthority("metadata", token !== null)) await pending;
      const capability = capabilities.find(value => value.recipient === "metadata" && value.credentialed === (token !== null))!;
      const agent = new Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = (_input, callback) => {
        if (!callback) throw new ReferenceTransportError("unavailable", "reference metadata needs an asynchronous TLS connection");
        let completed = false;
        const complete = (error: Error | null, socket?: Socket) => {
          if (completed) { if (socket) socket.destroy(); return; }
          completed = true; callback(error, socket as never);
        };
        const request = httpRequest({ host: "127.0.0.1", port: address.port, method: "CONNECT", path: "api.github.com:443",
          headers: { "proxy-authorization": capability.authorization.toString() }, signal: controller.signal });
        request.once("error", error => complete(error));
        request.once("response", response => { response.resume(); complete(new Error("Reference metadata tunnel refused")); });
        request.once("connect", (response, socket, head) => {
          if (response.statusCode !== 200 || head.length) { socket.destroy(); complete(new Error("Reference metadata tunnel refused")); return; }
          const tls = connectTls({ socket, servername: "api.github.com", minVersion: "TLSv1.2", rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) });
          tls.once("error", error => { if (!completed) complete(error); });
          tls.once("secureConnect", async () => {
            try {
              for (const pending of settledAuthority("metadata", token !== null)) await pending;
              complete(null, tls);
            }
            catch (error) { tls.destroy(); complete(error as Error); }
          });
        });
        request.end(); return undefined as never;
      };
      try {
        const result = await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
          const request = httpsRequest(resource.metadataUrl, { agent, method: "GET", signal: controller.signal,
            headers: { accept: "application/vnd.github+json", "accept-encoding": "identity", "user-agent": "brain-reference",
              ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
            const chunks: Buffer[] = []; let bytes = 0;
            if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
              response.destroy(); reject(new ReferenceTransportError("unavailable", "reference metadata encoding is unsupported")); return;
            }
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_METADATA_BYTES) { response.destroy(); reject(new ReferenceTransportError("capacity", "reference metadata exceeds its body bound")); }
              else chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", async () => {
              try {
                for (const pending of settledAuthority("metadata", token !== null)) await pending;
                const status = response.statusCode ?? 0;
                resolve({ status, value: status === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
              } catch (error) { reject(error); }
            });
          });
          request.once("error", reject); request.end();
        });
        for (const pending of settledAuthority("metadata", token !== null)) await pending;
        return result;
      } finally { agent.destroy(); }
    },
    async close() {
      if (closed) return; closed = true; clearTimeout(deadline); options.signal?.removeEventListener("abort", abort);
      controller.abort();
      for (const operation of operations) operation.finish("cancelled", "reference_closed");
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  });
}
export type GitHubReferenceWire = Awaited<ReturnType<typeof createGitHubReferenceWire>>;
