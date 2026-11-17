import { expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { request } from "node:http";
import { existsSync } from "node:fs";
import { startEgressProxy, type EgressRecord, type EgressProxyOptions } from "../src/server/egress-proxy.js";

const defaults = (records: EgressRecord[]): EgressProxyOptions => ({ mode: "record", allow: [], deny: [], maxBytes: 1024,
  outwardHosts: [], observe: value => records.push(value) });
function get(socketPath: string, target: string, method = "GET", body?: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: target, method, headers: { ...extraHeaders, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, response => {
      let text = ""; response.on("data", bytes => text += bytes);
      response.on("end", () => resolve({ status: response.statusCode!, body: text }));
      response.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}
/**
 * The proxy records an HTTP exchange when its server response closes, which
 * can land after the client has read the whole body: wait for the record.
 */
async function recorded(records: EgressRecord[], count: number) {
  for (let polls = 0; records.length < count && polls < 5_000; polls++) await Bun.sleep(1);
}
function tunnel(socketPath: string, target: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${body}`));
    socket.on("data", data => { text += data; if (text.includes("403") || text.endsWith(body.toUpperCase())) socket.end(); });
    socket.on("end", () => resolve(text)); socket.on("close", () => resolve(text)); socket.on("error", reject);
  });
}

test("invalid byte ceilings are rejected before creating a proxy", async () => {
  for (const maxBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(startEgressProxy({ ...defaults([]), maxBytes }), `INVALID_EGRESS_BYTE_CEILING_${maxBytes}`)
      .rejects.toThrow("Egress maxBytes must be a finite nonnegative integer");
  }
});

test("real Unix HTTP proxy forwards cleartext and records only path and payload accounting", async () => {
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const proxy = await startEgressProxy(defaults(records));
  try {
    expect(await get(proxy.socketPath, `${origin.url}voyage?private=excluded`)).toEqual({ status: 200, body: "Ithaca" });
    await recorded(records, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ method: "GET", host: "127.0.0.1", port: origin.port, path: "/voyage", accounting: "http_wire_bound", outcome: "completed" });
    expect(records[0]!.bytes).toBeGreaterThan(6);
    expect(JSON.stringify(records)).not.toContain("private");
  } finally { proxy.stop(); origin.stop(true); }
  expect(existsSync(proxy.dir)).toBe(false);
});
test("query and header bytes cannot bypass the turn ceiling", async () => {
  let calls = 0; const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("raft"); } });
  const proxy = await startEgressProxy({ ...defaults(records), maxBytes: 512 });
  try {
    expect((await get(proxy.socketPath, `${origin.url}?notes=${"x".repeat(1024)}`)).status, "EGRESS_QUERY_BYTES_CHARGED_BEFORE_CONTACT").toBe(403);
    expect((await get(proxy.socketPath, origin.url.href, "GET", undefined, { "x-odysseus-note": "x".repeat(1024) })).status, "EGRESS_HEADER_BYTES_CHARGED_BEFORE_CONTACT").toBe(403);
    expect(calls).toBe(0);
    expect(records[0]).toMatchObject({ outcome: "denied", reason: "max_bytes_per_turn" });
  } finally { proxy.stop(); origin.stop(true); }
});
test("destination deny precedes allow and denied HTTP never reaches an upstream", async () => {
  let calls = 0; const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await startEgressProxy({ ...defaults(records), mode: "allowlist", allow: ["127.0.0.1"], deny: ["127.0.0.1"] });
  try {
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_DENY_PRECEDENCE").toBe(403);
    expect(calls).toBe(0);
    expect(records[0]).toMatchObject({ outcome: "denied", reason: "destination_not_allowed", bytes: 0 });
  } finally { proxy.stop(); origin.stop(true); }
});
test("allowlist omission refuses before any upstream request", async () => {
  let calls = 0; const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await startEgressProxy({ ...defaults(records), mode: "allowlist", allow: ["example.org"] });
  try {
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_ALLOWLIST_REFUSES_UNLISTED_HOST").toBe(403);
    expect(calls).toBe(0);
    expect(records[0]).toMatchObject({ outcome: "denied", reason: "destination_not_allowed" });
  } finally { proxy.stop(); origin.stop(true); }
});
test("cleartext writes to outward hosts require approval and an oversized response is cut off", async () => {
  const records: EgressRecord[] = []; let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Odysseus repairs the raft".repeat(100)); } });
  const refused = await startEgressProxy({ ...defaults(records), outwardHosts: ["127.0.0.1"] });
  try {
    expect((await get(refused.socketPath, origin.url.href, "POST", "voyage")).status, "EGRESS_OUTWARD_POST_REQUIRES_APPROVAL").toBe(403);
    expect(calls, "EGRESS_OUTWARD_POST_REFUSED_BEFORE_CONTACT").toBe(0);
    expect(records[0]).toMatchObject({ method: "POST", outcome: "denied", reason: "outward_not_approved" });
  } finally { refused.stop(); }
  const bounded = await startEgressProxy({ ...defaults(records), maxBytes: 1024 });
  try {
    expect((await get(bounded.socketPath, origin.url.href)).status, "EGRESS_OVERSIZED_RESPONSE_REFUSED").toBe(403);
    expect(calls).toBe(1);
    expect(bounded.usedBytes(), "EGRESS_PAYLOAD_NEVER_EXCEEDS_CAP").toBeLessThanOrEqual(1024);
    expect(records.at(-1)).toMatchObject({ outcome: "denied", reason: "max_bytes_per_turn" });
  } finally { bounded.stop(); origin.stop(true); }
});
test("POST outside outward hosts reaches the origin without approval and records charged bytes only", async () => {
  const records: EgressRecord[] = []; let calls = 0, approvals = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    expect(request.method).toBe("POST");
    expect(await request.text()).toBe("Odysseus payload");
    expect(request.headers.get("authorization")).toBe("Bearer odysseus-fictional-secret");
    return new Response("Ithaca");
  } });
  const proxy = await startEgressProxy({ ...defaults(records), maxBytes: 4096,
    approveOutward: async () => { approvals++; return false; } });
  try {
    expect(await get(proxy.socketPath, `${origin.url}voyage?private=odysseus-query`, "POST", "Odysseus payload",
      { authorization: "Bearer odysseus-fictional-secret" }), "EGRESS_OUTSIDE_OUTWARD_POST_FORWARDED").toEqual({ status: 200, body: "Ithaca" });
    await recorded(records, 1);
    expect(calls).toBe(1); expect(approvals).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ method: "POST", host: "127.0.0.1", port: origin.port, path: "/voyage", outcome: "completed", accounting: "http_wire_bound" });
    expect(records[0]!.bytes).toBeGreaterThan(Buffer.byteLength("Odysseus payloadIthaca"));
    expect(proxy.usedBytes()).toBe(records[0]!.bytes);
    for (const secret of ["Odysseus payload", "odysseus-fictional-secret", "odysseus-query", "authorization"]) expect(JSON.stringify(records)).not.toContain(secret);
  } finally { proxy.stop(); origin.stop(true); }
});
test("outside-list POST still obeys destination denial and the shared turn byte ceiling", async () => {
  let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("raft"); } });
  try {
    for (const restrictions of [{ deny: ["127.0.0.1"] }, { mode: "allowlist" as const, allow: ["example.org"] }]) {
      const records: EgressRecord[] = [];
      const proxy = await startEgressProxy({ ...defaults(records), ...restrictions });
      try {
        expect((await get(proxy.socketPath, origin.url.href, "POST", "voyage")).status).toBe(403);
        expect(calls).toBe(0);
        expect(records[0]).toMatchObject({ method: "POST", outcome: "denied", reason: "destination_not_allowed", bytes: 0 });
      } finally { proxy.stop(); }
    }
    const records: EgressRecord[] = [];
    const proxy = await startEgressProxy({ ...defaults(records), maxBytes: 512 });
    try {
      expect((await get(proxy.socketPath, origin.url.href, "POST", "voyage")).status).toBe(200);
      const charged = proxy.usedBytes();
      expect(charged).toBeGreaterThan(0);
      const refused = await get(proxy.socketPath, origin.url.href, "POST", "voyage").catch(error => {
        // A body that exhausts the cap closes its already-started stream.
        expect(error.code).toBe("ECONNRESET");
        return { status: 0 };
      });
      expect([0, 403], "EGRESS_OUTSIDE_POST_SHARED_CAP").toContain(refused.status);
      expect(proxy.usedBytes()).toBeGreaterThanOrEqual(charged);
      expect(proxy.usedBytes()).toBeLessThanOrEqual(512);
      expect(records.at(-1)).toMatchObject({ method: "POST", outcome: "denied", reason: "max_bytes_per_turn" });
    } finally { proxy.stop(); }
  } finally { origin.stop(true); }
});
test("outward POST waits for approval and pending HTTP approval cancels before origin contact", async () => {
  let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  try {
    for (const cancelled of [false, true]) {
      const records: EgressRecord[] = [], controller = new AbortController();
      let allow: ((value: boolean) => void) | undefined, approvalSignal: AbortSignal | undefined;
      const proxy = await startEgressProxy({ ...defaults(records), signal: controller.signal, outwardHosts: ["127.0.0.1"],
        approveOutward: async (_destination, signal) => { approvalSignal = signal; return new Promise<boolean>(resolve => { allow = resolve; }); } });
      const before = calls;
      const pending = get(proxy.socketPath, origin.url.href, "POST", "voyage").catch(() => ({ status: 0, body: "closed" }));
      try {
        for (let index = 0; index < 100 && !allow; index++) await Bun.sleep(1);
        expect(allow).toBeDefined(); expect(calls).toBe(before);
        if (cancelled) {
          controller.abort();
          expect((await pending).status).not.toBe(200);
          expect(approvalSignal!.aborted).toBe(true);
          expect(calls).toBe(before);
        } else {
          allow!(true);
          expect(await pending).toEqual({ status: 200, body: "Ithaca" });
          expect(calls).toBe(before + 1);
        }
      } finally { controller.abort(); proxy.stop(); await pending; }
    }
  } finally { origin.stop(true); }
});
test("CONNECT opaque bytes require outward approval and retain bidirectional accounting", async () => {
  const records: EgressRecord[] = []; let approved = false, calls = 0;
  const recorded = Promise.withResolvers<void>();
  const origin = createServer(socket => { calls++; socket.on("data", bytes => socket.end(bytes.toString().toUpperCase())); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as { port: number }).port;
  const proxy = await startEgressProxy({ ...defaults(records), outwardHosts: ["127.0.0.1"], approveOutward: async () => approved,
    observe: record => { records.push(record); if (records.length === 2) recorded.resolve(); } });
  try {
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${port}`, "raft")).toContain("403");
    expect(calls).toBe(0);
    approved = true;
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${port}`, "raft")).toContain("RAFT");
    // The client can receive its payload before the proxy's close callback records completion.
    await recorded.promise;
    expect(records[1]).toMatchObject({ method: "CONNECT", bytes: 8, outcome: "completed" });
    expect(records[1]).not.toHaveProperty("path");
  } finally { proxy.stop(); origin.close(); }
});
test("an outward port asks before contact on any host and invalid ports are refused", async () => {
  for (const port of [0, 65536, 1.5, NaN]) {
    await expect(startEgressProxy({ ...defaults([]), outwardPorts: [port] }), `EGRESS_INVALID_OUTWARD_PORT_${port}`).rejects.toThrow("Invalid outward port");
  }
  const records: EgressRecord[] = []; let approved = false, calls = 0, asked = 0;
  const origin = createServer(socket => { calls++; socket.on("data", bytes => socket.end(bytes.toString().toUpperCase())); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as { port: number }).port;
  const proxy = await startEgressProxy({ ...defaults(records), outwardPorts: [port], approveOutward: async () => { asked++; return approved; } });
  try {
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${port}`, "letter"), "EGRESS_OUTWARD_PORT_REQUIRES_APPROVAL").toContain("403");
    expect(calls, "EGRESS_OUTWARD_PORT_REFUSED_BEFORE_CONTACT").toBe(0);
    expect(records[0]).toMatchObject({ method: "CONNECT", port, outcome: "denied", reason: "outward_not_approved" });
    approved = true;
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${port}`, "letter")).toContain("LETTER");
    expect(asked).toBe(2);
  } finally { proxy.stop(); origin.close(); }
});
test("per-turn payload ceiling is shared across requests and a pending approval cancels closed", async () => {
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("raft") });
  const proxy = await startEgressProxy({ ...defaults(records), maxBytes: 512 });
  try {
    expect((await get(proxy.socketPath, origin.url.href)).body).toBe("raft");
    let status = 200;
    for (let index = 0; index < 8 && status !== 403; index++) status = (await get(proxy.socketPath, origin.url.href)).status;
    expect(status, "EGRESS_AGGREGATE_BYTE_LIMIT").toBe(403);
    expect(proxy.usedBytes()).toBeLessThanOrEqual(512);
    expect(records.at(-1)).toMatchObject({ outcome: "denied", reason: "max_bytes_per_turn" });
  } finally { proxy.stop(); origin.stop(true); }
  const controller = new AbortController(); let approvalSignal: AbortSignal | undefined;
  const pending = await startEgressProxy({ ...defaults(records), signal: controller.signal, outwardHosts: ["127.0.0.1"],
    approveOutward: async (_destination, signal) => { approvalSignal = signal; return new Promise<boolean>(() => {}); } });
  const result = tunnel(pending.socketPath, "127.0.0.1:443", "raft").catch(() => "closed");
  try {
    for (let index = 0; index < 100 && !approvalSignal; index++) await Bun.sleep(1);
    expect(approvalSignal).toBeDefined(); controller.abort(); await result;
    expect(approvalSignal!.aborted).toBe(true);
    expect(existsSync(pending.dir)).toBe(false);
  } finally { pending.stop(); }
});

test("turn stop synchronously records each active HTTP connection exactly once", async () => {
  const records: EgressRecord[] = [];
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { entered(); await held; return new Response("Ithaca"); } });
  const proxy = await startEgressProxy(defaults(records));
  const pending = get(proxy.socketPath, origin.url.href).catch(() => undefined);
  try {
    await started;
    expect(records).toHaveLength(0);
    proxy.stop();
    expect(records, "STOP_FINALIZES_HTTP_BEFORE_RETURN").toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "cancelled", reason: "turn_cancelled" });
    release(); await pending;
    expect(records).toHaveLength(1);
  } finally { release(); proxy.stop(); await pending; origin.stop(true); }
});

test("turn stop synchronously records an active CONNECT exactly once", async () => {
  const records: EgressRecord[] = [], peers = new Set<import("node:net").Socket>();
  const origin = createServer(socket => { peers.add(socket); socket.once("close", () => peers.delete(socket)); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const proxy = await startEgressProxy(defaults(records));
  const client = connect(proxy.socketPath), closed = new Promise<void>(resolve => client.once("close", resolve));
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.once("connect", () => client.write(`CONNECT 127.0.0.1:${(origin.address() as { port: number }).port} HTTP/1.1\r\n\r\n`));
      client.once("data", bytes => bytes.toString().includes("200") ? resolve() : reject(Error("CONNECT was refused")));
    });
    proxy.stop();
    expect(records, "STOP_FINALIZES_CONNECT_BEFORE_RETURN").toHaveLength(1);
    expect(records[0]).toMatchObject({ method: "CONNECT", outcome: "cancelled", reason: "turn_cancelled" });
    await closed;
    expect(records).toHaveLength(1);
  } finally { proxy.stop(); client.destroy(); for (const peer of peers) peer.destroy(); origin.close(); await closed; }
});
test("a tainted turn reaches only taint-allowed or already contacted hosts; the inference and provider relays are exempt", async () => {
  let calls = 0; const records: EgressRecord[] = [], admitted: Array<{ host: string; inference: boolean; provider: boolean }> = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  let tainted = false; const contacted = new Set<string>(), allow: string[] = [];
  const proxy = await startEgressProxy({ ...defaults(records), maxBytes: 65536, taint: { allow, tainted: () => tainted, contacted: host => contacted.has(host) },
    admitted: destination => admitted.push({ host: destination.host, inference: destination.inference, provider: destination.provider }) });
  try {
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_CLEAN_TURN_UNCHANGED").toBe(200);
    expect(admitted, "EGRESS_ADMISSION_REPORTED").toEqual([{ host: "127.0.0.1", inference: false, provider: false }]);
    tainted = true;
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_TAINT_REFUSES_UNLISTED_HOST").toBe(403);
    expect(calls).toBe(1);
    expect(records.at(-1)).toMatchObject({ outcome: "denied", reason: "taint_not_allowed", bytes: 0 });
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${origin.port}`, ""), "EGRESS_TAINT_REFUSES_TUNNEL").toContain("403");
    // The relay's own admission is never narrowed.
    const relay = proxy.inference("POST", new URL(`${origin.url.href}v1/messages`), new AbortController().signal);
    expect(await relay.admit(), "EGRESS_TAINT_EXEMPTS_INFERENCE").toBe(true); relay.finish("completed");
    // So is a validated provider-relay operation (#3246); it is reported as one, never as inference.
    const provider = proxy.relayed("POST", new URL(`${origin.url.href}v1beta/models/gemini-2.5-flash:generateContent`), new AbortController().signal);
    expect(await provider.admit(), "EGRESS_TAINT_EXEMPTS_PROVIDER_RELAY").toBe(true); provider.finish("completed");
    expect(admitted.at(-1), "EGRESS_PROVIDER_ADMISSION_REPORTED").toEqual({ host: "127.0.0.1", inference: false, provider: true });
    expect(records.at(-1)?.inference, "EGRESS_PROVIDER_RECORD_NOT_INFERENCE").toBeUndefined();
    expect(records.at(-1)?.provider, "EGRESS_PROVIDER_RECORD_MARKED").toBe(true);
    // Worker and inference records never carry the provider tag.
    expect(records.slice(0, -1).map(record => [record.inference, record.provider]), "EGRESS_ONLY_PROVIDER_RECORD_MARKED")
      .toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined], [true, undefined]]);
    contacted.add("127.0.0.1");
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_TAINT_KEEPS_CONTACTED_HOST").toBe(200);
    contacted.clear(); allow.push("127.0.0.1");
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_TAINT_ALLOW_LIST").toBe(200);
  } finally { proxy.stop(); origin.stop(true); }
});
test("a narrowed destination asks through taint.approve before refusing; a failed or absent approval refuses (#3430)", async () => {
  let calls = 0; const records: EgressRecord[] = [], asked: Array<{ host: string; port: number; method: string }> = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  let answer: () => Promise<boolean> = async () => true;
  const proxy = await startEgressProxy({ ...defaults(records), maxBytes: 65536,
    taint: { allow: [], tainted: () => true, contacted: () => false, approve: async destination => { asked.push(destination); return answer(); } } });
  try {
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_TAINT_APPROVED_ADMITS").toBe(200);
    expect(asked, "EGRESS_TAINT_APPROVE_NAMES_DESTINATION").toEqual([{ host: "127.0.0.1", port: origin.port!, method: "GET" }]);
    answer = async () => { throw new Error("Scylla"); };
    const refused = await get(proxy.socketPath, origin.url.href);
    expect(refused.status, "EGRESS_TAINT_FAILED_APPROVAL_REFUSES").toBe(403);
    expect(refused.body, "EGRESS_TAINT_DECLINE_REASON").toContain("the user declined the connection");
    expect(records.at(-1)).toMatchObject({ outcome: "denied", reason: "taint_not_approved", bytes: 0 });
    // The relay's own admission is never narrowed, so never asked about.
    const relay = proxy.inference("POST", new URL(`${origin.url.href}v1/messages`), new AbortController().signal);
    expect(await relay.admit()).toBe(true); relay.finish("completed");
    expect(asked, "EGRESS_TAINT_INFERENCE_NOT_ASKED").toHaveLength(2);
    expect(calls).toBe(1);
  } finally { proxy.stop(); origin.stop(true); }
});
test("taint narrowing never overrides deny or the ordinary allowlist, and its patterns are validated", async () => {
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const proxy = await startEgressProxy({ ...defaults(records), mode: "allowlist", allow: ["example.org"],
    taint: { allow: ["127.0.0.1"], tainted: () => true, contacted: () => true } });
  try {
    expect((await get(proxy.socketPath, origin.url.href)).status, "EGRESS_TAINT_IS_NARROWING_ONLY").toBe(403);
    expect(records[0]).toMatchObject({ reason: "destination_not_allowed" });
  } finally { proxy.stop(); origin.stop(true); }
  await expect(startEgressProxy({ ...defaults([]), taint: { allow: ["bad host"], tainted: () => true, contacted: () => false } })).rejects.toThrow("Invalid egress host pattern");
});

test("each refusal tells the tool why in its status line and body (#3431)", async () => {
  let calls = 0; const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  // The status line is what `curl -v` prints for a refused CONNECT, and what `egress-connect` reports.
  const status = (head: string) => head.slice(0, head.indexOf("\r\n"));
  const target = `127.0.0.1:${origin.port}`;
  try {
    const capped = await startEgressProxy({ ...defaults(records), maxBytes: 0 });
    try {
      expect(status(await tunnel(capped.socketPath, target, "")), "EGRESS_REFUSAL_BYTE_CAP").toBe("HTTP/1.1 403 Forbidden - turn network byte limit reached");
      expect((await get(capped.socketPath, origin.url.href)).body).toContain("egress.max_bytes_per_turn");
    } finally { capped.stop(); }
    const outward = await startEgressProxy({ ...defaults(records), outwardHosts: ["127.0.0.1"], approveOutward: async () => false });
    try {
      const head = await tunnel(outward.socketPath, target, "");
      expect(status(head), "EGRESS_REFUSAL_OUTWARD").toBe("HTTP/1.1 403 Forbidden - outward connection not approved");
      expect(head).toContain("Blocked: a connection to 127.0.0.1 acts outside the brain in the user's name, and it was not approved.");
    } finally { outward.stop(); }
    // Without a taint cause the message still names taint, without inventing a source.
    const tainted = await startEgressProxy({ ...defaults(records), taint: { allow: [], tainted: () => true, contacted: () => false, cause: () => { throw new Error("unreadable"); } } });
    try {
      const head = await tunnel(tainted.socketPath, target, "");
      expect(status(head), "EGRESS_REFUSAL_TAINT").toBe("HTTP/1.1 403 Forbidden - untrusted session, host not allowed");
      expect(head, "EGRESS_REFUSAL_TAINT_WITHOUT_CAUSE").toContain("Blocked: this session read untrusted content, and 127.0.0.1 is not on its taint allow-list");
    } finally { tainted.stop(); }
    expect(calls).toBe(0);
  } finally { origin.stop(true); }
});
