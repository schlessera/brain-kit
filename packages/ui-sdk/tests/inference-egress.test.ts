import { expect, test } from "bun:test";
import { request } from "node:http";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy";
import { startInferenceRelay } from "../src/server/inference-relay";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function send(socketPath: string, path: string, method = "POST", body = "{}") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { "content-length": Buffer.byteLength(body) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: text }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function setup(maxBytes: number, fetch: (request: Request) => Response | Promise<Response>, extra: { deny?: string[]; credentials?: (signal: AbortSignal) => Promise<Record<string, string>> } = {}) {
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: extra.deny ?? [], outwardHosts: [], maxBytes,
    observe: record => records.push(record), approveOutward: async () => true });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], egress: proxy,
    credentials: extra.credentials ?? (async () => ({ authorization: "Bearer odysseus-host-held" })) });
  return { records, origin, proxy, relay, stop() { relay.stop(); proxy.stop(); origin.stop(true); } };
}

test("shared inference destination admission refuses before credentials and upstream without confusing denial with cancellation", async () => {
  let credentials = 0, contacts = 0;
  const f = await setup(10000, () => { contacts++; return new Response("Ithaca"); }, {
    deny: ["127.0.0.1"], credentials: async () => { credentials++; return { authorization: "secret" }; },
  });
  try {
    expect((await send(f.relay.socketPath, "/v1/messages?private=Odysseus")).status, "INFERENCE_DESTINATION_DENIAL_IS_403").toBe(403);
    expect(credentials, "DENIAL_PRECEDES_CREDENTIAL_RELEASE").toBe(0);
    expect(contacts).toBe(0);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ inference: true, host: "127.0.0.1", port: f.origin.port, path: "/v1/messages", bytes: 0, outcome: "denied", reason: "destination_not_allowed" });
    expect(JSON.stringify(f.records)).not.toContain("private");
  } finally { f.stop(); }
});

test("inference and generic HTTP consume one turn counter and preserve redacted destination records", async () => {
  let contacts = 0;
  const f = await setup(5000, request => { contacts++; expect(request.headers.get("authorization")).toBe("Bearer odysseus-host-held"); return new Response("raft"); });
  try {
    expect((await send(f.relay.socketPath, "/v1/messages?private=Odysseus")).status).toBe(200);
    const first = f.proxy.usedBytes();
    expect(first, "INFERENCE_CHARGED_APPLICATION_FRAMING").toBeGreaterThan(2000);
    expect(f.records[0]).toMatchObject({ inference: true, outcome: "completed", accounting: "http_wire_bound" });
    // A cleartext request shares the same counter; its large body cannot fit.
    await send(f.proxy.socketPath, f.origin.url.href, "POST", "x".repeat(4000)).catch(() => ({ status: 0, body: "closed" }));
    expect(f.records.at(-1), "GENERIC_TRAFFIC_SHARES_INFERENCE_COUNTER").toMatchObject({ outcome: "denied", reason: "max_bytes_per_turn" });
    expect(f.proxy.usedBytes()).toBeLessThanOrEqual(5000);
    expect(f.proxy.usedBytes()).toBe(f.records.reduce((sum, record) => sum + record.bytes, 0));
    expect(JSON.stringify(f.records)).not.toContain("odysseus-host-held");
    expect(JSON.stringify(f.records)).not.toContain("private");
  } finally { f.stop(); }
});

test("oversized streamed inference request is refused before credential release and provider contact", async () => {
  let contacts = 0, credentials = 0;
  const f = await setup(1000, () => { contacts++; return new Response("raft"); }, { credentials: async () => { credentials++; return {}; } });
  try {
    expect((await send(f.relay.socketPath, "/v1/messages", "POST", "x".repeat(2000))).status).toBe(403);
    expect(contacts, "BODY_CEILING_PRECEDES_PROVIDER_CONTACT").toBe(0); expect(credentials).toBe(0);
    expect(f.proxy.usedBytes()).toBeLessThanOrEqual(1000);
    expect(f.records[0]).toMatchObject({ outcome: "denied", reason: "max_bytes_per_turn" });
  } finally { f.stop(); }
});

test("streamed inference remains open until EOF and overflow cancels the actual provider stream", async () => {
  const release = deferred(), prefix = deferred(), cancelled = deferred();
  const f = await setup(4000, () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("Ithaca")); },
    async pull(controller) { await release.promise; controller.enqueue(new Uint8Array(5000)); },
    cancel() { cancelled.resolve(); },
  })));
  let req: ReturnType<typeof request> | undefined;
  try {
    const result = new Promise<string>(resolve => {
      req = request({ socketPath: f.relay.socketPath, path: "/v1/messages", method: "POST" }, response => {
        response.once("data", () => prefix.resolve()); response.once("error", () => resolve("interrupted")); response.once("end", () => resolve("complete"));
      });
      req.on("error", () => resolve("interrupted")); req.end("{}");
    });
    await prefix.promise;
    expect(f.records, "NO_COMPLETION_BEFORE_PROVIDER_EOF").toEqual([]);
    release.resolve();
    expect(await result, "STREAM_LIMIT_INTERRUPTS_REAL_CLIENT").toBe("interrupted");
    await cancelled.promise;
    expect(f.records[0]).toMatchObject({ inference: true, outcome: "denied", reason: "max_bytes_per_turn" });
    expect(f.proxy.usedBytes()).toBeLessThanOrEqual(4000);
  } finally { release.resolve(); req?.destroy(); f.stop(); }
});

test("turn proxy stop aborts pending host credential resolution and records cancellation", async () => {
  const entered = deferred(), aborted = deferred(); let contacts = 0;
  const f = await setup(10000, () => { contacts++; return new Response("raft"); }, {
    credentials: signal => new Promise((_resolve, reject) => {
      entered.resolve(); signal.addEventListener("abort", () => { aborted.resolve(); reject(new Error("odysseus-host-held")); }, { once: true });
    }),
  });
  try {
    const pending = send(f.relay.socketPath, "/v1/messages");
    await entered.promise; f.proxy.stop(); await aborted.promise;
    expect((await pending).status).toBe(499);
    expect(contacts, "TURN_CANCEL_PREVENTS_PROVIDER_CONTACT").toBe(0);
    expect(f.records[0]).toMatchObject({ inference: true, outcome: "cancelled" });
    expect(JSON.stringify(f.records)).not.toContain("odysseus-host-held");
  } finally { f.stop(); }
});

test("parallel inference responses share the turn ceiling rather than independent per-request budgets", async () => {
  const release = deferred(), bothPrefixes = deferred(); let prefixes = 0;
  const f = await setup(7000, () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("raft")); },
    async pull(controller) { await release.promise; controller.enqueue(new Uint8Array(1800)); controller.close(); },
  })));
  const clients: Array<ReturnType<typeof request>> = [];
  const run = () => new Promise<string>(resolve => {
    const client = request({ socketPath: f.relay.socketPath, method: "POST", path: "/v1/messages" }, response => {
      response.once("data", () => { if (++prefixes === 2) bothPrefixes.resolve(); });
      response.once("error", () => resolve("interrupted")); response.once("end", () => resolve("completed"));
    });
    clients.push(client); client.on("error", () => resolve("interrupted")); client.end("{}");
  });
  try {
    const pending = [run(), run()];
    await bothPrefixes.promise;
    expect(f.records).toHaveLength(0);
    release.resolve();
    const outcomes = await Promise.all(pending);
    expect(outcomes.sort(), "PARALLEL_STREAMS_SHARE_ONE_CEILING").toEqual(["completed", "interrupted"]);
    expect(f.records.map(record => record.outcome).sort()).toEqual(["completed", "denied"]);
    expect(f.proxy.usedBytes()).toBeLessThanOrEqual(7000);
    expect(f.proxy.usedBytes()).toBe(f.records.reduce((sum, record) => sum + record.bytes, 0));
  } finally { release.resolve(); for (const client of clients) client.destroy(); f.stop(); }
});
