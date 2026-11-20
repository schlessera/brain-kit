/** Offline joined journey: detector + real streaming proxy + FULL writer + owner HTTP + two WS views. */
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { SafetyHistory } from "../src/governance/safety-history";
import { resolvePrincipal, isUsablePrincipal } from "../src/db/principals";
import { request } from "node:http";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { queryGovernanceEvents } from "../src/governance/events";
import { createSafetyStore } from "../../ui-react/src/stores/safety-state";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
async function review(f: Fixture, id: string, value?: ReturnType<typeof body>) {
  const input = value ?? body(f, id), origin = f.url.replace("ws:", "http:").replace("/ws", "");
  const post = (suffix: string) => fetch(`${origin}/api/sessions/ithaca/safety/reviews/${suffix}`, {
    method: "POST", headers: { cookie: f.cookie, origin, "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const prepared = await post("prepare"), result = await prepared.json();
  if (prepared.status !== 200) return { status: prepared.status, result };
  const committed = await post(`${result.receipt.requestId}/commit`);
  return { status: committed.status, result: await committed.json() };
}
function body(f: Fixture, id: string) {
  const state = f.writes.safety(null, "ithaca");
  return { version: 1 as const, session: state.session!, occurrenceId: id, expectedEvidenceRevision: state.evidenceRevision, verdict: "safe" as const };
}
async function view(f: Fixture) {
  const socket = await f.connect(), store = createSafetyStore();
  const refresh = async () => {
    const requestId = crypto.randomUUID();
    store.getState().reset(true); store.getState().begin(requestId);
    socket.send({ type: "safety_read", version: 1, requestId, target: { sessionId: "ithaca" } });
    const frame = await socket.until(m => m.type === "safety_history" && m.requestId === requestId);
    if (frame.type !== "safety_history") throw new Error("Missing safety page");
    expect(store.getState().page(requestId, frame.page)).toBe(true);
    return frame.page;
  };
  return { store, refresh };
}

test("two owner views review A/B/C independently across real streaming and delayed detector delivery", async () => {
  const f = await safetyHistoryFixture(true, true), controller = new AbortController();
  const collector = createSafetyCollector(f.db, f.writes, { turnId: "voyage", bindingId: f.bindingId, backendId: "claude",
    sessionId: () => "ithaca", shellProxied: () => true, signal: controller.signal });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({
    start(value) { stream = value; value.enqueue(new TextEncoder().encode("Odysseus")); },
  })) });
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }),
    bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" as const }) }, controller,
    turnId: "voyage", sessionId: () => "ithaca", model: () => null, profile: "governed", origin: "interactive",
    governanceDb: f.db, governanceWrites: f.writes, record: event => f.writes.record(event) });
  try {
    await collector.begin("A", "WebFetch", { url: "https://example.com/odyssey" });
    await collector.result("A", "WebFetch", "Voyage notes", true);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: proxy.socketPath, path: origin.url.href }, resolve); req.on("error", reject); req.end();
    });
    const drained = new Promise<void>((resolve, reject) => { response.on("end", resolve); response.on("error", reject); response.resume(); });
    // Teardown can interrupt the response after a failed assertion. Observe
    // that cleanup rejection without masking the awaited healthy completion.
    void drained.catch(() => {});
    await collector.begin("C", "WebFetch", { url: "https://example.com/odyssey" });
    const events = queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 });
    expect(events, "JOURNEY_THREE_INDEPENDENT_BOUNDARIES").toHaveLength(3);
    const ids = events.map(event => (event.payload.occurrence as { id: string }).id), [a, b, c] = ids as [string, string, string];
    expect(new Set(ids).size).toBe(3);
    const one = await view(f), two = await view(f), stale = await two.refresh();
    await one.refresh();
    expect((await review(f, b)).result.receipt.reason, "JOURNEY_STREAM_CANNOT_BE_REVIEWED").toBe("not_finalized");
    expect((await review(f, c)).result.receipt.reason, "JOURNEY_DELAYED_INPUT_CANNOT_BE_REVIEWED").toBe("not_finalized");
    expect((await review(f, a)).result.currentProjection.unresolvedCount, "JOURNEY_A_LEAVES_B_C").toBe(2);
    expect((await review(f, c, { ...body(f, c), expectedEvidenceRevision: stale.highWater })).status, "JOURNEY_STALE_TAB_REFUSES").toBe(409);
    stream.close(); await drained; await proxy.settled();
    expect((await review(f, b)).result.currentProjection.unresolvedCount, "JOURNEY_B_LEAVES_DELAYED_C").toBe(1);
    for (const client of [one, two]) {
      await client.refresh();
      expect(client.store.getState().normal, "JOURNEY_BOTH_VIEWS_STAY_RESTRICTED").toBe(false);
      expect(client.store.getState().projection?.earliestUnresolvedId).toBe(c);
    }
    await collector.result("C", "WebFetch", "Later voyage notes", true);
    expect((await review(f, c)).result.currentProjection.restriction, "JOURNEY_ONLY_FINAL_C_RESTORES_NORMAL").toBe("normal");
    for (const client of [one, two]) {
      const page = await client.refresh();
      expect(client.store.getState().normal, "JOURNEY_BOTH_VIEWS_RESTORE_NORMAL").toBe(true);
      expect(page.records.filter(row => row.kind === "safe_decision").map(row => row.occurrenceId).sort()).toEqual([...ids].sort());
    }
    // A future same-source call never inherits C's committed verdict.
    await collector.begin("D", "WebFetch", { url: "https://example.com/odyssey" });
    for (const client of [one, two]) {
      await client.refresh();
      expect(client.store.getState().projection?.unresolvedCount, "JOURNEY_FUTURE_INPUT_HAS_NO_INHERITED_VERDICT").toBe(1);
      expect(client.store.getState().normal).toBe(false);
    }
    await collector.result("D", "WebFetch", "Future voyage notes", true);
    await f.writes.safetyEnd("voyage");
  } finally { proxy.stop(); await proxy.settled(); origin.stop(true); await f.close(); }
});

for (const unfinished of [false, true]) test(`real database restart replays ${unfinished ? "unfinished delivery as an honest gap" : "committed single-trigger verdicts"}`, async () => {
  const f = await safetyHistoryFixture(true, true);
  let closed = false;
  try {
    const collector = createSafetyCollector(f.db, f.writes, { turnId: "voyage", bindingId: f.bindingId, backendId: "claude",
      sessionId: () => "ithaca", shellProxied: () => true, signal: new AbortController().signal });
    await collector.begin("A", "WebFetch", { url: "https://example.com/odyssey" });
    await collector.result("A", "WebFetch", "Voyage notes", true);
    const a = queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 })[0]!.payload.occurrence as { id: string };
    expect((await review(f, a.id)).result.receipt.verdict).toBe("committed");
    if (unfinished) await collector.begin("C", "WebFetch", { url: "https://example.com/odyssey" });
    else await f.writes.safetyEnd("voyage");
    const before = f.writes.safety(null, "ithaca");
    await f.close(true); closed = true;
    // A fresh FULL writer and history service on the same WAL file, with no
    // inherited in-memory collector, pending latch, cursor or projection.
    const db = createUiDb(f.path), writer = openSqliteWriter(db);
    const history = new SafetyHistory(db, principal => {
      const current = resolvePrincipal(db, principal.id); return !!current && isUsablePrincipal(current, Date.now());
    }, () => writer.idle());
    try {
      const page = await history.read(f.principal, { sessionId: "ithaca" });
      const store = createSafetyStore(); store.getState().reset(true); store.getState().begin("restart");
      expect(store.getState().page("restart", page)).toBe(true);
      expect(page.records.filter(row => row.kind === "safe_decision").map(row => row.occurrenceId), "JOURNEY_RESTART_RETAINS_INDIVIDUAL_VERDICT").toEqual([a.id]);
      expect(page.projection.unresolvedCount).toBe(unfinished ? 1 : 0);
      expect(store.getState().normal, "JOURNEY_RESTART_NEVER_INVENTS_COMPLETENESS").toBe(!unfinished);
      expect(page.projection.coverage.state).toBe(unfinished ? "incomplete" : "complete");
      expect(BigInt(page.projection.evidenceRevision)).toBeGreaterThanOrEqual(BigInt(before.evidenceRevision));

    } finally { history.close(); await writer.close(); db.close(); }
  } finally { if (!closed) await f.close(); else rmSync(f.root, { recursive: true, force: true }); }
});
