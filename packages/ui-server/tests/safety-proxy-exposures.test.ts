import { expect, test } from "bun:test";
import { request } from "node:http";
import { createServer } from "node:net";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { createUiDb } from "../src/db/client";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { queryGovernanceEvents } from "../src/governance/events";
import { prepareTurnEgress } from "../src/brain/turn-egress";

async function fixture() {
  const db = createUiDb(":memory:");
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',0,0)").run();
  const writes = createGovernanceWrites(db);
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }),
    bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" as const }) }, controller: new AbortController(),
    turnId: "voyage", sessionId: () => "ithaca", model: () => null, profile: "governed", origin: "interactive",
    governanceDb: db, governanceWrites: writes, record: event => writes.record(event) });
  const events = (kind: "taint" | "taint_exposure") => queryGovernanceEvents(db, { sessionId: "ithaca", kinds: [kind], limit: 100 });
  return { db, proxy, events, async close() { proxy.stop(); await proxy.settled(); db.close(); } };
}

const response = (socketPath: string, target: string) => new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
  const req = request({ socketPath, path: target }, resolve); req.on("error", reject); req.end();
});
const drained = (res: import("node:http").IncomingMessage) => new Promise<void>((resolve, reject) => {
  res.on("error", reject); res.on("end", resolve); res.resume();
});

test("HTTP exposure remains open during delivery and only a completed response finalizes it", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode("Ithaca")); },
  })) });
  const f = await fixture();
  try {
    const res = await response(f.proxy.socketPath, origin.url.href);
    expect(f.events("taint"), "SAFETY_HTTP_OPEN_DURING_DELIVERY").toMatchObject([{ payload: { occurrence: { exposure: "open" } } }]);
    expect(f.events("taint_exposure")).toHaveLength(0);
    const done = drained(res); stream.close(); await done; await f.proxy.settled();
    const occurrence = f.events("taint")[0]!.payload.occurrence as { id: string };
    expect(f.events("taint_exposure").map(e => e.payload), "SAFETY_HTTP_FINALIZATION_IS_SEPARATE_EVIDENCE")
      .toEqual([{ occurrenceId: occurrence.id, state: "finalized" }]);
  } finally { origin.stop(true); await f.close(); }
});

test("later connections and redirect destinations retain separate host identities while restricted", async () => {
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname === "/redirect"
    ? new Response(null, { status: 302, headers: { location: "/notice" } }) : new Response("Ithaca") });
  const f = await fixture();
  try {
    for (const path of ["redirect", "notice", "notice"]) {
      const res = await response(f.proxy.socketPath, new URL(path, origin.url).href); await drained(res);
    }
    await f.proxy.settled();
    const occurrences = f.events("taint").map(e => e.payload.occurrence as { id: string; operationId: string; provenance: unknown });
    expect(occurrences, "SAFETY_PROXY_RETAINS_LATER_EXPOSURES").toHaveLength(3);
    expect(new Set(occurrences.map(e => e.id)).size).toBe(3);
    expect(new Set(occurrences.map(e => e.operationId)).size).toBe(3);
    expect(occurrences.map(e=>e.provenance), "SAFETY_PROXY_ATTESTS_ONLY_ITS_TRANSPORT").toEqual(Array.from({length:3},()=>({kind:"web_origin",origin:{scheme:"http",host:"127.0.0.1",port:origin.port},verifiedBy:"host_transport"})));
    expect(f.events("taint_exposure")).toHaveLength(3);
  } finally { origin.stop(true); await f.close(); }
});

test("an opaque tunnel closure never claims finalized input", async () => {
  const origin = createServer(socket => socket.on("data", bytes => socket.write(bytes)));
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as import("node:net").AddressInfo).port;
  const f = await fixture();
  try {
    const tunnel = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const req = request({ socketPath: f.proxy.socketPath, method: "CONNECT", path: `127.0.0.1:${port}` });
      req.on("error", reject); req.on("connect", (_res, socket) => resolve(socket)); req.end();
    });
    expect(f.events("taint"), "SAFETY_TUNNEL_IS_OPEN").toMatchObject([{ payload: { occurrence: { exposure: "open" } } }]);
    const closed = new Promise<void>(resolve => tunnel.once("close", resolve)); tunnel.destroy(); await closed;
    f.proxy.stop(); await f.proxy.settled();
    expect(f.events("taint_exposure"), "SAFETY_OPAQUE_CLOSE_STAYS_UNKNOWN")
      .toMatchObject([{ payload: { state: "interrupted_unknown" } }]);
  } finally { origin.close(); await f.close(); }
});
