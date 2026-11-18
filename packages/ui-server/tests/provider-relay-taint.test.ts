/**
 * #3246: a validated provider-relay operation neither taints a governed session
 * nor is narrowed by its taint (G6), so tool order no longer decides whether
 * WebFetch or reranking works. Its `provider: true` connection record never
 * makes its host a contacted one for the worker, in this turn or a later one. Composed as a turn runs it: the real provider
 * relay shares the real turn proxy's admission, and taint lives in the
 * session's governance record. The provider is a fictional loopback Gemini
 * endpoint the operator lists; nothing here needs a key or the network.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import { startProviderRelay, type ProviderRelayOptions, type ProviderRelayRefusal } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { Database } from "bun:sqlite";
import {connectedSafetySession} from "./helpers/connected-safety";
import { createUiDb } from "../src/db/client.js";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";
import { beginSafetyCollection, acknowledgeSafety } from "../src/governance/safety-store.js";

const HOST_KEY = "odysseus-host-gemini-key";
const RERANK = "/v1beta/models/gemini-2.5-flash:generateContent";
let provider: ReturnType<typeof Bun.serve>, harbour: ReturnType<typeof Bun.serve>, island: ReturnType<typeof Bun.serve>;
const reached: string[] = [];
beforeAll(() => {
  // Three loopback hosts: the provider, WebFetch's target and a later new host.
  provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    reached.push(`${request.headers.get("x-goog-api-key")} ${new URL(request.url).pathname}`);
    await request.arrayBuffer();
    return Response.json({ candidates: [], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } });
  } });
  harbour = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("Ithaca") });
  island = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("Aeaea") });
});
afterAll(() => { provider.stop(true); harbour.stop(true); island.stop(true); });

function connectStatus(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", data => { text += data; const status = /^HTTP\/1\.1 (\d{3})/.exec(text); if (status) { socket.destroy(); resolve(Number(status[1])); } });
    socket.on("close", () => resolve(0)); socket.on("error", reject);
  });
}
function httpStatus(socketPath: string, target: string, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = httpRequest({ socketPath, path: target, method }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!)); response.once("error", reject);
    });
    child.once("error", reject); child.end();
  });
}

const bridge = { requestPermission: async () => ({ behavior: "deny", message: "Odysseus declines" }), emit() {} } as unknown as BackendBridge;

/** One governed turn of session `sessionId`: its proxy, and the real provider relay sharing its admission. */
async function turn(db: Database, sessionId: string, turnId: string, policy: GovernancePolicyInput = { schema_version: 1 },
  relayOptions: Partial<ProviderRelayOptions> = {}) {
  const controller = new AbortController();
  beginSafetyCollection(db, { turnId, bindingId: crypto.randomUUID(), sessionId, principalId: "odysseus", backendId: "claude", at: 0 });
  acknowledgeSafety(db, turnId, "claude", 1);
  const egress = await prepareTurnEgress({ controller, policy: resolveGovernancePolicy(policy), turnId, sessionId: () => sessionId,
    model: () => "claude-haiku-4-5", profile: "governed", origin: "interactive", bridge,
    record: event => recordGovernanceEvent(db, event), governanceDb: db });
  const refusals: ProviderRelayRefusal[] = [];
  const relay = startProviderRelay({ egress, credential: name => (name === "GEMINI_API_KEY" ? HOST_KEY : undefined),
    origins: new Map([["GEMINI_API_KEY", [provider.url.origin]]]), refused: refusal => refusals.push(refusal), ...relayOptions });
  /** What the brain CLI sends for reranking, through the relay's socket. */
  const rerank = (request: { path?: string; origin?: string; body?: string } = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = Buffer.from(request.body ?? JSON.stringify({ contents: [{ parts: [{ text: "Rank the harbours of Ithaca." }] }] }));
    const outgoing = httpRequest({ socketPath: relay.socketPath, method: "POST", path: request.path ?? RERANK, headers: {
      "content-type": "application/json", "content-length": String(body.byteLength), "x-brain-provider": "gemini",
      "x-brain-provider-key": "GEMINI_API_KEY", "x-brain-provider-origin": request.origin ?? provider.url.origin } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject); outgoing.end(body);
  });
  const stop = async () => { await relay.stop(); egress.stop(); await egress.settled(); };
  return { egress, relay, rerank, refusals, controller, stop };
}

function session(db: Database, id: string) {
  connectedSafetySession(db,id,`birth-${id}`);
  const events = (kind: "taint" | "egress_connection" | "egress_denial") => queryGovernanceEvents(db, { sessionId: id, kinds: [kind], limit: 50 });
  return { taints: () => events("taint").map(event => { const { occurrence: _occurrence, ...source } = event.payload; return source; }), events };
}

test("provider first, then WebFetch: the provider request never taints, and WebFetch's target is the first taint (#3246)", async () => {
  const db = createUiDb(":memory:"), voyage = session(db, "ithaca");
  const first = await turn(db, "ithaca", "turn-provider-first");
  reached.length = 0;
  try {
    expect((await first.rerank()).status, "PROVIDER_FIRST_ADMITTED").toBe(200);
    expect(reached, "PROVIDER_FIRST_REACHED_WITH_HOST_KEY").toEqual([`${HOST_KEY} ${RERANK}`]);
    expect(voyage.taints(), "PROVIDER_RELAY_CREATES_NO_TAINT").toEqual([]);
    // WebFetch's target, then the next new host.
    expect(await connectStatus(first.egress.socketPath, `127.0.0.2:${harbour.port}`), "WEBFETCH_AFTER_PROVIDER_ADMITTED").toBe(200);
    expect(voyage.taints(), "WEBFETCH_IS_FIRST_TAINT").toEqual([{ source: "egress_connection", tool: null, detail: `CONNECT 127.0.0.2:${harbour.port}` }]);
    expect(await connectStatus(first.egress.socketPath, `127.0.0.3:${island.port}`), "WORKER_NEW_HOST_STILL_NARROWED").toBe(403);
    // The provider's host is not a contacted host the worker's own traffic may now reach.
    expect(await connectStatus(first.egress.socketPath, `127.0.0.1:${provider.port}`), "WORKER_CONNECT_TO_PROVIDER_HOST_NARROWED").toBe(403);
    expect(await httpStatus(first.egress.socketPath, `${provider.url.origin}${RERANK}`, "POST"), "WORKER_HTTP_TO_PROVIDER_HOST_NARROWED").toBe(403);
    // The provider keeps working after taint, and neither clears nor replaces it.
    expect((await first.rerank()).status, "PROVIDER_AFTER_TAINT_ADMITTED").toBe(200);
    await first.stop();
    expect(voyage.taints(), "PROVIDER_LEAVES_FIRST_TAINT").toEqual([{ source: "egress_connection", tool: null, detail: `CONNECT 127.0.0.2:${harbour.port}` }]);
    expect(reached).toHaveLength(2);
    const denials = voyage.events("egress_denial").map(event => event.payload);
    expect(denials, "ONLY_WORKER_TRAFFIC_DENIED").toEqual([
      { host: "127.0.0.3", port: island.port, method: "CONNECT", reason: "taint_allowlist", bytes: 0 },
      { host: "127.0.0.1", port: provider.port, method: "CONNECT", reason: "taint_allowlist", bytes: 0 },
      { host: "127.0.0.1", port: provider.port, method: "POST", reason: "taint_allowlist", bytes: 0 }]);
    // Provider requests keep their own connection receipt, never tagged as inference.
    const providerRecords = voyage.events("egress_connection").map(event => event.payload).filter(record => record.host === "127.0.0.1" && record.outcome === "completed");
    expect(providerRecords.map(record => [record.method, record.path, record.inference, record.provider]), "PROVIDER_CONNECTION_RECEIPTS")
      .toEqual([["POST", RERANK, undefined, true], ["POST", RERANK, undefined, true]]);
    // Worker records never carry the provider tag, even to the provider's host.
    expect(voyage.events("egress_connection").filter(record => record.payload.method === "CONNECT" && record.payload.provider !== undefined).map(record => record.payload),
      "WORKER_RECORDS_NEVER_PROVIDER").toEqual([]);
  } finally { await first.stop(); db.close(); }
});

test("WebFetch first, then provider: the session stays tainted by WebFetch and the provider request is admitted (#3246)", async () => {
  const db = createUiDb(":memory:"), voyage = session(db, "calypso");
  const first = await turn(db, "calypso", "turn-fetch-first");
  reached.length = 0;
  try {
    expect(await connectStatus(first.egress.socketPath, `127.0.0.2:${harbour.port}`), "WEBFETCH_FIRST_ADMITTED").toBe(200);
    const fetched = { source: "egress_connection", tool: null, detail: `CONNECT 127.0.0.2:${harbour.port}` };
    expect(voyage.taints()).toEqual([fetched]);
    const reranked = await first.rerank();
    expect(reranked.status, "TAINTED_SESSION_ADMITS_PROVIDER").toBe(200);
    expect(first.refusals, "NO_TAINT_DERIVED_PROVIDER_REFUSAL").toEqual([]);
    expect(reached, "PROVIDER_REACHED_AFTER_TAINT").toEqual([`${HOST_KEY} ${RERANK}`]);
    expect(await connectStatus(first.egress.socketPath, `127.0.0.1:${provider.port}`), "WORKER_STILL_NARROWED_FROM_PROVIDER_HOST").toBe(403);
    await first.stop();
    // A later turn of the same tainted session: the provider still works, the worker is still narrowed.
    const later = await turn(db, "calypso", "turn-fetch-later");
    try {
      expect((await later.rerank()).status, "LATER_TURN_PROVIDER_ADMITTED").toBe(200);
      expect(await connectStatus(later.egress.socketPath, `127.0.0.3:${island.port}`), "LATER_TURN_NEW_HOST_NARROWED").toBe(403);
    } finally { await later.stop(); }
    expect(voyage.taints(), "PROVIDER_NEITHER_CLEARS_NOR_REPLACES_TAINT").toEqual([fetched]);
    expect(voyage.events("egress_denial").filter(event => event.payload.host === "127.0.0.1" && event.payload.method === "POST").map(event => event.payload), "NO_PROVIDER_TAINT_DENIAL").toEqual([]);
  } finally { await first.stop(); db.close(); }
});

test("in a tainted session, every other control still refuses the provider request through the real relay (#3246)", async () => {
  const db = createUiDb(":memory:");
  const cases: Array<{ name: string; policy?: GovernancePolicyInput; relay?: Partial<ProviderRelayOptions>;
    request?: { path?: string; origin?: string; body?: string }; status: number; reason: ProviderRelayRefusal["reason"]; denial?: string }> = [
    { name: "DENIED_PROVIDER_HOST", policy: { schema_version: 1, egress: { deny: ["127.0.0.1"] } }, status: 403, reason: "egress_refused", denial: "denied_host" },
    { name: "NOT_ALLOWLISTED_PROVIDER_HOST", policy: { schema_version: 1, egress: { mode: "allowlist", allow: ["127.0.0.2"] } }, status: 403, reason: "egress_refused", denial: "not_allowlisted" },
    { name: "BYTE_CEILING", policy: { schema_version: 1, egress: { max_bytes_per_turn: 200 } }, request: { body: JSON.stringify({ contents: [{ parts: [{ text: "Odysseus ".repeat(64) }] }] }) }, status: 403, reason: "egress_refused", denial: "byte_cap" },
    { name: "BUDGET_STOP", relay: { admit: () => ({ allowed: false, message: "Athena stops the voyage" }) }, status: 403, reason: "budget_exceeded" },
    { name: "UNLISTED_ORIGIN", request: { origin: "http://localhost:1" }, status: 403, reason: "recipient_not_authorized" },
    { name: "FORGED_ROUTE", request: { path: "/v1beta/files" }, status: 403, reason: "route_not_allowed" },
    { name: "UNAVAILABLE_CREDENTIAL", relay: { credential: () => undefined }, status: 403, reason: "credential_unavailable" },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const voyage = session(db, `voyage-${index}`);
      const current = await turn(db, `voyage-${index}`, `turn-${index}`, entry.policy, entry.relay);
      reached.length = 0;
      try {
        expect(await connectStatus(current.egress.socketPath, `127.0.0.2:${harbour.port}`), `${entry.name}_TAINT_SOURCE`).toBe(200);
        const result = await current.rerank(entry.request);
        expect(result.status, entry.name).toBe(entry.status);
        expect(current.refusals.map(refusal => refusal.reason), entry.name).toEqual([entry.reason]);
        expect(reached, `${entry.name}_NEVER_REACHES_PROVIDER`).toEqual([]);
        await current.stop();
        const denials = voyage.events("egress_denial").map(event => event.payload);
        expect(denials.map(denial => denial.reason), `${entry.name}_DENIAL`).toEqual(entry.denial ? [entry.denial] : []);
        expect(voyage.taints(), `${entry.name}_TAINT_UNCHANGED`).toEqual([{ source: "egress_connection", tool: null, detail: `CONNECT 127.0.0.2:${harbour.port}` }]);
      } finally { await current.stop(); }
    }
  } finally { db.close(); }
});

test("a cancelled turn refuses a tainted session's provider request before contact (#3246)", async () => {
  const db = createUiDb(":memory:"), voyage = session(db, "scylla");
  const current = await turn(db, "scylla", "turn-cancelled");
  reached.length = 0;
  try {
    expect(await connectStatus(current.egress.socketPath, `127.0.0.2:${harbour.port}`)).toBe(200);
    current.controller.abort();
    const result = await current.rerank();
    expect(result.status, "CANCELLED_TURN_REFUSES_PROVIDER").not.toBe(200);
    expect(reached, "CANCELLED_NEVER_REACHES_PROVIDER").toEqual([]);
    await current.stop();
    expect(voyage.taints()).toHaveLength(1);
  } finally { await current.stop(); db.close(); }
});

test("a provider request in one turn grants a later tainted turn's worker CONNECT no contacted-host pass (#3246)", async () => {
  const db = createUiDb(":memory:"), voyage = session(db, "aeolus");
  const first = await turn(db, "aeolus", "turn-provider-earlier");
  reached.length = 0;
  try {
    expect((await first.rerank()).status, "EARLIER_TURN_PROVIDER_ADMITTED").toBe(200);
    await first.stop();
    expect(voyage.taints(), "EARLIER_PROVIDER_CREATES_NO_TAINT").toEqual([]);
    const marked = voyage.events("egress_connection").map(event => event.payload).filter(record => record.host === "127.0.0.1");
    expect(marked.map(record => [record.method, record.provider, record.inference]), "PROVIDER_RECORD_MARKED").toEqual([["POST", true, undefined]]);
    const later = await turn(db, "aeolus", "turn-worker-later");
    try {
      expect(await connectStatus(later.egress.socketPath, `127.0.0.2:${harbour.port}`), "LATER_TURN_WEBFETCH_TAINTS").toBe(200);
      expect(voyage.taints()).toEqual([{ source: "egress_connection", tool: null, detail: `CONNECT 127.0.0.2:${harbour.port}` }]);
      expect(await connectStatus(later.egress.socketPath, `127.0.0.1:${provider.port}`), "CROSS_TURN_PROVIDER_HOST_NARROWED").toBe(403);
      // The worker's own earlier contact still counts: WebFetch's host stays reachable.
      expect(await connectStatus(later.egress.socketPath, `127.0.0.2:${harbour.port}`), "LATER_TURN_OWN_HOST_STILL_CONTACTED").toBe(200);
      expect((await later.rerank()).status, "LATER_TURN_PROVIDER_STILL_ADMITTED").toBe(200);
    } finally { await later.stop(); }
  } finally { await first.stop(); db.close(); }
});
