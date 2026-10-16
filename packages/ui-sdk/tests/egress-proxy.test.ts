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
function tunnel(socketPath: string, target: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${body}`));
    socket.on("data", data => { text += data; if (text.includes("403") || text.endsWith(body.toUpperCase())) socket.end(); });
    socket.on("end", () => resolve(text)); socket.on("close", () => resolve(text)); socket.on("error", reject);
  });
}

test("real Unix HTTP proxy forwards cleartext and records only path and payload accounting", async () => {
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const proxy = await startEgressProxy(defaults(records));
  try {
    expect(await get(proxy.socketPath, `${origin.url}voyage?private=excluded`)).toEqual({ status: 200, body: "Ithaca" });
    await Bun.sleep(1);
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
test("cleartext writes require approval and an oversized response is cut off", async () => {
  const records: EgressRecord[] = []; let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Odysseus repairs the raft".repeat(100)); } });
  const refused = await startEgressProxy(defaults(records));
  try {
    expect((await get(refused.socketPath, origin.url.href, "POST", "voyage")).status).toBe(403);
    expect(calls).toBe(0);
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
test("CONNECT opaque bytes require outward approval and retain bidirectional accounting", async () => {
  const records: EgressRecord[] = []; let approved = false, calls = 0;
  const origin = createServer(socket => { calls++; socket.on("data", bytes => socket.end(bytes.toString().toUpperCase())); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as { port: number }).port;
  const proxy = await startEgressProxy({ ...defaults(records), outwardHosts: ["127.0.0.1"], approveOutward: async () => approved });
  try {
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${port}`, "raft")).toContain("403");
    expect(calls).toBe(0);
    approved = true;
    expect(await tunnel(proxy.socketPath, `127.0.0.1:${port}`, "raft")).toContain("RAFT");
    await Bun.sleep(1);
    expect(records[1]).toMatchObject({ method: "CONNECT", bytes: 8, outcome: "completed" });
    expect(records[1]).not.toHaveProperty("path");
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
