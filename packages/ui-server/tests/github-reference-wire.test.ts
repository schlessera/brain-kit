import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { startEgressProxy, type EgressRecord } from "../../ui-sdk/src/server/egress-proxy";
import { createGitHubReferenceWire } from "../src/brain/github-reference-wire";
import { fixtureTls } from "./fixtures/fixture-tls";

let root: string, tls: ReturnType<typeof fixtureTls>;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "odysseus-reference-wire-")); tls = fixtureTls(root, ["api.github.com", "github.com"]); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const publicAddress = "93.184.216.34";
const metadata = { id: 101, owner: { id: 201, login: "Odysseus" }, name: "Ithaca", private: false };
async function fixture(port: number, options: { owner?: string; maxBytes?: number; turnBytes?: number; timeoutMs?: number; signal?: AbortSignal; authorize?: (recipient: "git" | "metadata", credentialed: boolean) => void;
  recordingAvailable?: () => boolean;
  lookup?: (host: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]> } = {}) {
  const records: EgressRecord[] = [], destinations: unknown[] = [];
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: options.turnBytes ?? 1048576, observe: r => records.push(r),...(options.recordingAvailable?{admissionSafety:{read:()=>({evidenceRevision:"1",trustRevision:"1",authorityEpoch:"1",scope:"ithaca",policyHash:null,restricted:false,recordingAvailable:options.recordingAvailable!(),authorityCurrent:true}),subscribe:()=>()=>{}}}:{}) });
  try {
    const wire = await createGitHubReferenceWire({ ...(options.owner ? { owner: options.owner } : { repository: "odysseus/ithaca" }), egress, maxBytes: options.maxBytes ?? 1048576,
      authorize: options.authorize ?? (() => {}), timeoutMs: options.timeoutMs, signal: options.signal, ca: readFileSync(tls.ca, "utf8"),
      lookup: options.lookup ?? (async () => [{ address: publicAddress, family: 4 }]),
      connect: ((input: unknown) => { destinations.push(input); return connect({ host: "127.0.0.1", port }); }) as typeof connect });
    return { wire, egress, records, destinations, async close() { await wire.close(); egress.stop(); } };
  } catch (error) { egress.stop(); throw error; }
}
function tunnel(proxy: string, target: string, body = "", authenticate = true): Promise<string> {
  const url = new URL(proxy);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }); let text = "";
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authenticate ? `Proxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}\r\n` : ""}\r\n${body}`));
    socket.on("data", chunk => { text += chunk; if (text.includes("403") || text.includes("407")) socket.end(); });
    socket.once("close", () => resolve(text)); socket.once("error", reject);
  });
}

test("fixed metadata GET meters actual TLS, HTTP framing and both anonymous and credentialed attempts", async () => {
  const received: { path: string; method: string; auth: string | null }[] = [], authority: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    received.push({ path: new URL(request.url).pathname, method: request.method, auth: request.headers.get("authorization") });
    return Response.json(metadata);
  } });
  const f = await fixture(server.port!, { authorize: (recipient, credentialed) => authority.push([recipient, credentialed]) });
  try {
    expect(await f.wire.metadata(null)).toEqual({ status: 200, value: metadata });
    expect(await f.wire.metadata("odysseus-fixture-token")).toEqual({ status: 200, value: metadata });
    expect(received, "REFERENCE_FIXED_METADATA_REQUESTS").toEqual([
      { path: "/repos/odysseus/ithaca", method: "GET", auth: null },
      { path: "/repos/odysseus/ithaca", method: "GET", auth: "Bearer odysseus-fixture-token" },
    ]);
    expect(authority).toContainEqual(["metadata", false]); expect(authority).toContainEqual(["metadata", true]);
    expect(f.wire.bytes().chargedBytes, "REFERENCE_TLS_AND_METADATA_WIRE_ACCOUNTED").toBeGreaterThan(JSON.stringify(metadata).length * 2);
    expect(f.egress.usedBytes()).toBe(f.wire.bytes().chargedBytes);
    expect(f.destinations).toEqual([{ host: publicAddress, port: 443 }, { host: publicAddress, port: 443 }]);
  } finally { await f.close(); server.stop(true); }
});

test("owner wire permits only its fixed anonymous GET and provides no Git capability", async () => {
  const received: { path: string; auth: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    received.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization") });
    return Response.json({ id: 201, login: "Odysseus" });
  } });
  const f = await fixture(server.port!, { owner: "odysseus" });
  try {
    expect(f.wire.repository).toBeNull();
    await expect(f.wire.metadata(null)).resolves.toMatchObject({ status: 200 });
    expect(() => f.wire.gitProxyUrl(false), "REFERENCE_OWNER_LOOKUP_HAS_NO_GIT_CAPABILITY").toThrow();
    await expect(f.wire.metadata("odysseus-fixture-token"), "REFERENCE_OWNER_LOOKUP_NEVER_SENDS_CREDENTIAL").rejects.toThrow();
    expect(received).toEqual([{ path: "/users/odysseus", auth: null }]);
  } finally { await f.close(); server.stop(true); }
});

test("the Git channel forwards and counts raw bidirectional wire, including CONNECT head bytes", async () => {
  const server = createServer(socket => socket.once("data", chunk => socket.end(chunk.toString().toUpperCase())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture((server.address() as { port: number }).port);
  try {
    expect(await tunnel(f.wire.gitProxyUrl(false), "github.com:443", "oars")).toEndWith("OARS");
    expect(f.wire.bytes(), "REFERENCE_ACTUAL_BIDIRECTIONAL_WIRE").toMatchObject({ chargedBytes: 8, incomingWireBytes: 4, outgoingWireBytes: 4 });
    expect(f.egress.usedBytes()).toBe(8);
  } finally { await f.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Git proxy capability cannot reach API metadata or another recipient", async () => {
  const f = await fixture(1);
  try {
    for (const target of ["api.github.com:443", "github.com.evil.example:443", "github.com:444"])
      expect(await tunnel(f.wire.gitProxyUrl(true), target), "REFERENCE_GIT_CAPABILITY_CANNOT_BORROW_API_RECIPIENT").toContain("403");
    expect(f.destinations).toEqual([]);
  } finally { await f.close(); }
});

test("an unauthenticated Git CONNECT gets a challenge without authority or upstream dispatch", async () => {
  const f = await fixture(1);
  try {
    const response = await tunnel(f.wire.gitProxyUrl(false), "github.com:443", "", false);
    expect(response, "REFERENCE_GIT_PROXY_CHALLENGE_BEFORE_CAPABILITY").toContain("407 Proxy Authentication Required");
    expect(response).toContain('Proxy-Authenticate: Basic realm="reference"');
    expect(f.destinations, "REFERENCE_PROXY_CHALLENGE_GRANTS_NO_UPSTREAM").toEqual([]);
    expect(f.records).toEqual([]);
  } finally { await f.close(); }
});

test("operation and turn bounds include TLS bytes before any authenticated metadata request arrives", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch() { calls++; return Response.json(metadata); } });
  try {
    for (const kind of ["operation", "turn"] as const) {
      const f = await fixture(server.port!, kind === "operation" ? { maxBytes: 1024 } : { turnBytes: 1024 });
      try {
        await expect(f.wire.metadata("odysseus-fixture-token"), "REFERENCE_ACTUAL_TLS_BYTES_EXHAUST_BUDGET").rejects.toThrow();
        expect(f.wire.failure()).toMatchObject({ reason: "capacity" });
        expect(f.wire.bytes().chargedBytes).toBeLessThanOrEqual(1024);
        // A ClientHello larger than the allowance is refused before TCP payload.
        if (f.wire.bytes().chargedBytes === 0)
          expect(f.wire.bytes().incomingWireBytes + f.wire.bytes().outgoingWireBytes).toBe(0);
      } finally { await f.close(); }
    }
    expect(calls, "REFERENCE_BUDGET_STOPS_BEFORE_CREDENTIAL_HEADERS").toBe(0);
  } finally { server.stop(true); }
});

test("authority revoked during DNS wait refuses before TCP and credential dispatch", async () => {
  let ready!: () => void, release!: () => void, allowed = true;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(1, { authorize: () => { if (!allowed) throw new Error("Revoked"); }, lookup: async () => {
    ready(); await held; return [{ address: publicAddress, family: 4 }];
  } });
  const pending = f.wire.metadata("odysseus-fixture-token");
  try {
    await reached; allowed = false; release();
    await expect(pending, "REFERENCE_LIVE_AUTHORITY_AFTER_DNS_WAIT").rejects.toThrow();
    expect(f.destinations, "REFERENCE_REVOKED_DNS_NEVER_DISPATCHES_TCP").toEqual([]); expect(f.wire.bytes().chargedBytes).toBe(0);
  } finally { release(); await pending.catch(() => {}); await f.close(); }
});

test("mixed private/public DNS and redirects supply no generic metadata access", async () => {
  let redirectedCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    if (new URL(request.url).pathname !== "/repos/odysseus/ithaca") redirectedCalls++;
    return new Response(null, { status: 302, headers: { location: "/other" } });
  } });
  const redirected = await fixture(server.port!);
  try { expect(await redirected.wire.metadata(null)).toEqual({ status: 302, value: null }); expect(redirectedCalls).toBe(0); }
  finally { await redirected.close(); server.stop(true); }
  const refused = await fixture(1, { lookup: async () => [{ address: publicAddress, family: 4 }, { address: "127.0.0.1", family: 4 }] });
  try { await expect(refused.wire.metadata(null)).rejects.toThrow(); expect(refused.destinations, "REFERENCE_MIXED_DNS_REFUSED_BEFORE_TCP").toEqual([]); }
  finally { await refused.close(); }
});


test("inbound overflow consumes the remaining shared turn allowance and preserves observed wire counts", async () => {
  const server = createServer(socket => socket.once("data", () => socket.end("OARS")));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture((server.address() as { port: number }).port, { turnBytes: 7 });
  try {
    const result = await tunnel(f.wire.gitProxyUrl(false), "github.com:443", "oars");
    expect(result, "REFERENCE_OVERFLOW_NOT_DELIVERED").not.toEndWith("OARS");
    expect(f.wire.failure()).toMatchObject({ reason: "capacity" });
    expect(f.wire.bytes(), "REFERENCE_OVERFLOW_OBSERVATION_RETAINED").toMatchObject({ chargedBytes: 7, incomingWireBytes: 4, outgoingWireBytes: 4 });
    expect(f.egress.remainingBytes(), "REFERENCE_WIRE_CANNOT_REUSE_EXHAUSTED_TURN").toBe(0);
  } finally { await f.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const kind of ["cancel", "deadline", "turn-stop"] as const) test(`reference wire ${kind} ends held resolution without a late connection`, async () => {
  let ready!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const f = await fixture(1, { signal: controller.signal, timeoutMs: kind === "deadline" ? 1000 : 120000,
    lookup: async () => { ready(); await held; return [{ address: publicAddress, family: 4 }]; } });
  const pending = f.wire.metadata(null);
  try {
    await reached; if (kind === "cancel") controller.abort(); else if (kind === "turn-stop") f.egress.stop();
    await expect(pending, "REFERENCE_CANCELLED_METADATA_DOES_NOT_COMPLETE").rejects.toThrow();
    await f.close(); release(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.destinations, "REFERENCE_CANCELLED_DNS_NEVER_CONNECTS_LATER").toEqual([]);
    expect(f.wire.bytes().chargedBytes).toBe(0);
  } finally { release(); await pending.catch(() => {}); await f.close(); }
});


for(const unavailable of [false,true])test(`review12: managed chunks preserve ${unavailable?'unavailable':'capacity'} after an independent change`,async()=>{
 let available=true,received!:()=>void;const reached=new Promise<void>(r=>{received=r;});const server=createServer(socket=>socket.on('data',b=>socket.write(b.toString().toUpperCase())));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const f=await fixture((server.address() as {port:number}).port,{turnBytes:64,...(unavailable?{recordingAvailable:()=>available}:{})});const url=new URL(f.wire.gitProxyUrl(false)),client=connect({host:url.hostname,port:Number(url.port)});client.on('error',()=>{});let text='';const closed=new Promise<void>(r=>client.once('close',()=>r()));
 try{client.on('data',b=>{text+=b;if(text.includes('FIRST'))received();});client.once('connect',()=>client.write(`CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}\r\n\r\nfirst`));await reached;if(unavailable)available=false;else{const other=f.egress.inference('POST',new URL('https://api.example.org/'),new AbortController().signal);expect(await other.admit()).toBe(true);expect(other.charge(f.egress.remainingBytes()).ok).toBe(true);other.finish('completed');}client.write('second');await closed;expect(f.wire.failure(),'MANAGED_CHUNKS_PRESERVE_TYPED_SEND_FAILURE').toMatchObject({reason:unavailable?'unavailable':'capacity'});expect(text).not.toContain('SECOND');
 }finally{client.destroy();await f.close();await new Promise<void>(r=>server.close(()=>r()));}
});
