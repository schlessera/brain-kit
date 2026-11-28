/**
 * Provider attempt receipts exist only for attempts that left the host
 * (#4370). A refusal at preparation, at the final charge/egress fence or at
 * the dispatch itself answers the caller and publishes no `dispatched` or
 * terminal receipt, so the host books no usage row for work never sent. An
 * attempt whose upstream request started keeps exactly one terminal receipt.
 * Covers the ordinary relay, a Gemini Files step and the Files cleanup DELETE.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy.js";
import { startProviderRelay, type ProviderRelayOptions, type ProviderRelayReceipt, type ProviderRelayRefusal } from "../src/server/provider-relay.js";

let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ method: string; path: string }> = [];
beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname });
    if (url.pathname === "/upload/v1beta/files" && !url.search) return Response.json({}, { headers: { "x-goog-upload-url": `${upstream.url.origin}/upload/v1beta/files?upload_id=ithaca` } });
    if (url.pathname === "/upload/v1beta/files") return Response.json({ file: { name: "files/ithaca-1", uri: `${upstream.url.origin}/v1beta/files/ithaca-1` } }, { headers: { "x-goog-upload-status": "final" } });
    if (request.method === "DELETE") return Response.json({});
    return Response.json({ usage: { input_tokens: 7, output_tokens: 3 } });
  } });
});
afterAll(() => upstream.stop(true));
beforeEach(() => { seen.length = 0; });

type Refusal = "prepare" | "fence" | "dispatch";
type Path = "ordinary" | "files" | "cleanup";
const KEYS: Record<string, string> = { ANTHROPIC_API_KEY: "odysseus-host-anthropic", GEMINI_API_KEY: "odysseus-host-gemini" };

/** A real turn proxy; `refuse` arms one pre-dispatch refusal for the next attempt. */
async function harness(origin = upstream.url.origin, committed?: () => void) {
  const rows: EgressRecord[] = [], receipts: ProviderRelayReceipt[] = [], refusals: ProviderRelayRefusal[] = [];
  let refuse: Refusal | null = null, authority = true, lose: { path: string; skip: number } | null = null, loseBeforeSend: "armed" | "now" | null = null;
  // The order of recording checks, the microtask after each, and charges, for the delivery-fence proofs.
  const events: string[] = [];
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], maxBytes: 1 << 20, outwardHosts: [], observe: row => rows.push(row), ...(committed ? { committed } : {}),
    // A host recording refusal at preparation: the proxy's own `preparing` boundary.
    preparing: () => { if (loseBeforeSend === "armed") loseBeforeSend = "now"; if (refuse === "prepare") throw new Error("Odysseus recorder unavailable"); },
    admissionSafety: { read: () => ({ evidenceRevision: "1", trustRevision: "1", authorityEpoch: "1", scope: "ithaca", policyHash: null, restricted: false,
      recordingAvailable: true, authorityCurrent: authority }), subscribe: () => () => {},
      // Armed with a path, one host recording wait rejects once that request
      // reached the upstream, after `skip` checks that pass (a late cleanup
      // DELETE of an earlier test never counts).
      *pendingRecording() {
        // Armed before the send, the relay's final-fence wait (the first after preparation) rejects.
        if (loseBeforeSend === "now") { loseBeforeSend = null; yield Promise.reject(new Error("Odysseus recorder lost")); return; }
        if (lose && seen.some(entry => entry.path === lose!.path) && lose.skip-- <= 0) { lose = null; yield Promise.reject(new Error("Odysseus recorder lost")); return; }
        events.push("checked"); queueMicrotask(() => events.push("tick"));
      } } });
  // The dispatch boundary refusing after the fence passed (a stale send-time check).
  const egress: NonNullable<ProviderRelayOptions["egress"]> = {
    remainingBytes: () => proxy.remainingBytes(),
    relayed(method, target, signal) {
      const operation = proxy.relayed(method, target, signal);
      return { ...operation, charge: count => { events.push("charge"); return operation.charge(count); }, dispatch: send => {
        if (refuse !== "dispatch") return operation.dispatch(send);
        operation.finish("denied", "safety_changed");
        return { ok: false as const, reason: "safety_changed" as const };
      } };
    },
  };
  const relay = startProviderRelay({ egress, credential: name => KEYS[name],
    origins: new Map([["ANTHROPIC_API_KEY", [origin]], ["GEMINI_API_KEY", [origin]]]),
    observe: receipt => { receipts.push(receipt); events.push(receipt.outcome); }, refused: refusal => refusals.push(refusal),
    // The relay's own diagnostic runs after preparation, before the final fence.
    preparing: () => { if (refuse === "fence") authority = false; } });
  const send = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const outgoing = httpRequest({ socketPath: relay.socketPath, method, path, headers: { "content-type": "application/json", ...headers,
      ...(payload ? { "content-length": String(payload.byteLength) } : {}) } }, incoming => {
      incoming.resume();
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers })).on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
  const gemini = { "x-brain-provider": "gemini", "x-brain-provider-key": "GEMINI_API_KEY", "x-brain-provider-origin": origin };
  const filesStart = () => send("POST", "/upload/v1beta/files", { ...gemini, "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start",
    "x-goog-upload-header-content-length": "5", "x-goog-upload-header-content-type": "video/mp4" }, "{}");
  return {
    rows, receipts, refusals, relay, proxy, events,
    arm(next: Refusal | null) { refuse = next; authority = true; },
    loseRecordingAfterDispatch(path: string, skip = 0) { lose = { path, skip }; },
    loseRecordingBeforeSend() { loseBeforeSend = "armed"; },
    ordinary: () => send("POST", "/v1/messages", { "x-brain-provider": "anthropic", "x-brain-provider-key": "ANTHROPIC_API_KEY", "x-brain-provider-origin": origin },
      JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] })),
    filesStart,
    /** Leaves one owned handle, so stopping the relay sends its cleanup DELETE. */
    async owned() {
      const started = await filesStart();
      const url = new URL(String(started.headers["x-goog-upload-url"]));
      return send("POST", `${url.pathname}${url.search}`, { ...gemini, "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0" }, "troy!");
    },
    async close() { await relay.stop(); proxy.stop(); },
  };
}

const attempt = async (h: Awaited<ReturnType<typeof harness>>, path: Path) => {
  if (path === "ordinary") return (await h.ordinary()).status;
  if (path === "files") return (await h.filesStart()).status;
  await h.relay.stop();
  return null;
};

for (const path of ["ordinary", "files", "cleanup"] as const) for (const refusal of ["prepare", "fence", "dispatch"] as const)
  test(`#4370: a ${refusal}-refused ${path} attempt answers its caller and leaves no receipt`, async () => {
    const h = await harness();
    try {
      if (path === "cleanup") { expect((await h.owned()).status).toBe(200); }
      h.receipts.length = 0; h.refusals.length = 0; seen.length = 0;
      h.arm(refusal);
      const status = await attempt(h, path);
      expect(seen, "PRE_DISPATCH_REFUSAL_NEVER_CONTACTS_PROVIDER").toEqual([]);
      expect(h.receipts, "PRE_DISPATCH_REFUSAL_LEAVES_NO_RECEIPT").toEqual([]);
      if (path !== "cleanup") {
        // The caller's refusal and the `refused` diagnostic are unchanged.
        expect(status).toBe(refusal === "prepare" ? 503 : 403);
        expect(h.refusals.map(r => r.reason)).toEqual(["egress_refused"]);
      }
      expect(h.rows.at(-1), "PROXY_RECORDS_THE_UNDISPATCHED_REFUSAL").toMatchObject({ outcome: "denied", dispatched: false });
    } finally { await h.close(); }
  });

for (const path of ["ordinary", "files", "cleanup"] as const) test(`#4370: a started ${path} attempt keeps exactly one terminal receipt`, async () => {
  const h = await harness();
  try {
    if (path === "cleanup") expect((await h.owned()).status).toBe(200);
    h.receipts.length = 0;
    const status = await attempt(h, path);
    if (path !== "cleanup") expect(status).toBe(200);
    expect(h.receipts.map(r => r.outcome), "STARTED_ATTEMPT_DISPATCHED_THEN_SETTLED_ONCE").toEqual(["dispatched", "completed"]);
    expect(new Set(h.receipts.map(r => r.attemptId)).size).toBe(1);
  } finally { await h.close(); }
});

test("#4370: a constructor-returned request that later fails keeps exactly one terminal receipt", async () => {
  // A closed port: fetch returns its request at once and rejects later.
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Troy") });
  const origin = closed.url.origin;
  closed.stop(true);
  const h = await harness(origin);
  try {
    const status = (await h.ordinary()).status;
    expect(status).toBe(502);
    expect(h.receipts.map(r => [r.outcome, r.status]), "STARTED_THEN_FAILED_ATTEMPT_SETTLES_ONCE").toEqual([["dispatched", 0], ["failed", 0]]);
    expect(h.rows.at(-1)).toMatchObject({ outcome: "failed", reason: "upstream_unreachable", dispatched: true });
  } finally { await h.close(); }
});

for (const path of ["ordinary", "cleanup"] as const) test(`#4370: a ${path} request started before its dispatch notification failed reports dispatched, then settles once`, async () => {
  let armed = false;
  const h = await harness(upstream.url.origin, () => { if (armed) throw new Error("Odysseus dispatch notice lost"); });
  try {
    if (path === "cleanup") expect((await h.owned()).status).toBe(200);
    h.receipts.length = 0;
    armed = true;
    await attempt(h, path);
    expect(h.receipts.map(r => r.outcome), "STARTED_REQUEST_ALWAYS_HAS_ITS_DISPATCH_RECEIPT").toEqual(["dispatched", "cancelled"]);
    expect(new Set(h.receipts.map(r => r.attemptId)).size).toBe(1);
  } finally { await h.close(); }
});

for (const path of ["ordinary", "files"] as const) test(`#4370: a ${path} attempt whose recording wait rejects after headers still settles once`, async () => {
  const h = await harness();
  try {
    const sent = path === "ordinary" ? "/v1/messages" : "/upload/v1beta/files";
    h.loseRecordingAfterDispatch(sent);
    const status = await attempt(h, path);
    const reached = seen.filter(entry => entry.path === sent).length;
    expect(h.receipts.map(r => r.outcome), "REJECTED_RECORDING_AFTER_HEADERS_SETTLES_THE_ATTEMPT").toEqual(["dispatched", "cancelled"]);
    expect(reached, "THE_ATTEMPT_LEFT_THE_HOST").toBe(1);
    expect(status).toBe(503);
    expect(new Set(h.receipts.map(r => r.attemptId)).size).toBe(1);
    expect(h.rows.at(-1)).toMatchObject({ outcome: "denied", reason: "egress_unavailable", dispatched: true });
  } finally { await h.close(); }
});

// #4370, delivery fences: each recording check and the charge after it run
// in one synchronous segment, so no sibling can reserve a write between them.
// A microtask queued at each check would land between them on any await.
for (const path of ["ordinary", "files", "empty"] as const) test(`#4370: every ${path} delivery charge follows its recording check in one synchronous segment`, async () => {
  const empty = path === "empty" ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) }) : null;
  const h = await harness(empty?.url.origin);
  try {
    expect(await attempt(h, path === "files" ? "files" : "ordinary")).toBe(path === "empty" ? 204 : 200);
    const after = h.events.slice(h.events.indexOf("dispatched"));
    const charges = after.flatMap((event, index) => event === "charge" ? [after[index - 1]] : []);
    expect(charges.length, "A_DELIVERY_CHARGE_FOLLOWS_DISPATCH").toBeGreaterThan(0);
    expect(charges, "CHECK_AND_CHARGE_SHARE_ONE_SYNCHRONOUS_SEGMENT").toEqual(charges.map(() => "checked"));
  } finally { await h.close(); empty?.stop(true); }
});

// #4370: a recording wait that rejects during a body read is a recording
// loss: 503 and `cancelled`, never an upstream failure.
for (const path of ["ordinary", "files", "cleanup"] as const) test(`#4370: a recording loss during a ${path} body read settles as cancelled, not failed`, async () => {
  const h = await harness();
  try {
    if (path === "cleanup") expect((await h.owned()).status).toBe(200);
    h.receipts.length = 0;
    // The first check after the upstream answered passes (the head fence); the body read's rejects.
    h.loseRecordingAfterDispatch(path === "ordinary" ? "/v1/messages" : path === "files" ? "/upload/v1beta/files" : "/v1beta/files/ithaca-1", 1);
    const status = path === "cleanup" ? (await h.relay.stop(), null) : await attempt(h, path).catch(() => null);
    expect(h.receipts.map(r => r.outcome), "BODY_READ_RECORDING_LOSS_IS_CANCELLED").toEqual(["dispatched", "cancelled"]);
    if (path === "files") expect(status).toBe(503);
    expect(h.rows.at(-1)).toMatchObject({ outcome: "denied", reason: "egress_unavailable", dispatched: true });
  } finally { await h.close(); }
});

// #4370, the other side of the send: a recording wait that rejects at the
// final fence, before the request starts, keeps the base answer (502,
// `upstream_unreachable`) and publishes no receipt.
for (const path of ["ordinary", "files"] as const) test(`#4370: a ${path} recording loss before the send keeps its upstream-failure answer and leaves no receipt`, async () => {
  const h = await harness();
  try {
    h.loseRecordingBeforeSend();
    const status = await attempt(h, path);
    expect(seen).toEqual([]);
    expect(h.receipts, "PRE_SEND_RECORDING_LOSS_LEAVES_NO_RECEIPT").toEqual([]);
    expect(status, "PRE_SEND_RECORDING_LOSS_KEEPS_ITS_502").toBe(502);
    expect(h.refusals.map(r => r.reason)).toEqual(["upstream_unreachable"]);
  } finally { await h.close(); }
});
test("#4370: a cleanup recording loss before the send keeps its upstream-failure classification and leaves no receipt", async () => {
  const h = await harness();
  try {
    expect((await h.owned()).status).toBe(200);
    h.receipts.length = 0; seen.length = 0;
    h.loseRecordingBeforeSend();
    await h.relay.stop();
    expect(seen.filter(entry => entry.method === "DELETE")).toEqual([]);
    expect(h.receipts, "PRE_SEND_CLEANUP_LOSS_LEAVES_NO_RECEIPT").toEqual([]);
    expect(h.rows.at(-1), "PRE_SEND_CLEANUP_LOSS_KEEPS_ITS_CLASSIFICATION").toMatchObject({ outcome: "failed", reason: "upstream_unreachable", dispatched: false });
  } finally { await h.close(); }
});
