/** Offline joined journey: detector + real streaming proxy + FULL writer + owner HTTP + two WS views. */
import { expectRejection } from "./helpers/expect-rejection";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { SafetyHistory } from "../src/governance/safety-history";
import { resolvePrincipal, isUsablePrincipal } from "../src/db/principals";
import { join } from "node:path";
import { createEffectiveSafety } from "../src/governance/effective-safety";
import { decidePiToolPermission } from "../../ui-backend-pi/src/permission-gate";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createGovernanceWrites } from "../src/governance/event-writes";
import * as held from "./fixtures/held-publication-writer";
import { request } from "node:http";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { queryGovernanceEvents } from "../src/governance/events";
import { createSafetyStore } from "../../ui-react/src/stores/safety-state";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
async function postReview(f: Fixture, suffix: string, input: ReturnType<typeof body>) {
  const origin = f.url.replace("ws:", "http:").replace("/ws", "");
  const response = await fetch(`${origin}/api/sessions/ithaca/safety/reviews/${suffix}`, {
    method: "POST", headers: { cookie: f.cookie, origin, "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return { status: response.status, result: await response.json() };
}
async function review(f: Fixture, id: string, value?: ReturnType<typeof body>) {
  const input = value ?? body(f, id), prepared = await postReview(f, "prepare", input);
  if (prepared.status !== 200) return prepared;
  return postReview(f, `${prepared.result.receipt.requestId}/commit`, input);
}
function liveSafety(f: Fixture) {
  return createEffectiveSafety(f.db, { turnId: "voyage", sessionId: () => "ithaca", policyHash: null, writes: f.writes,
    authority: () => ({ current: isUsablePrincipal(resolvePrincipal(f.db, f.principal.id)!, Date.now()), epoch: "0" }) });
}
/** A standing outward allowance must produce a real process effect only when
 * current admission permits it. The fake Git executable cannot contact a host. */
async function admit(f: Fixture, safety: ReturnType<typeof liveSafety>, expected: boolean, assertion: string) {
  const command = "git push https://github.com/odysseus/voyage.git main";
  const decision = await decidePiToolPermission({ turn: { ...createTurnContext(), signal: new AbortController().signal,
    bridge: { emit() {}, admissionSafety: safety, requestPermission: async () => ({ behavior: "deny", message: "Odysseus declines." }) },
    commandPolicy: { hash: null, deny: [], confirm: [], outwardAllow: [{ command: "^git push ", remotes: ["github.com/odysseus/*"], index: 0 }],
      taint: () => f.writes.taint("voyage", "ithaca") } }, allowedTools: new Set(["bash"]), confirmPatterns: [] }, "bash", { command }, crypto.randomUUID());
  const bin = join(f.root, "bin"), marker = join(f.root, "outward-effect");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'Ithaca\\n' >> '${marker}'\n`, { mode: 0o755 });
  const before = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  if (decision.behavior === "allow") {
    const child = Bun.spawn(["/bin/sh", "-c", command], { cwd: f.root, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  }
  expect((existsSync(marker) ? readFileSync(marker, "utf8") : "") !== before, assertion).toBe(expected);
}
async function holdWriter(f: Fixture) {
  const channel = f.writer.channel(held, undefined); await channel.ready;
  expect(await channel.call<number>("level")).toBe(2);
  const entered = new Int32Array(new SharedArrayBuffer(4)), release = new Int32Array(new SharedArrayBuffer(4));
  const pending = channel.call("hold", entered, release), waiting = Atomics.waitAsync(entered, 0, 0, 5000);
  if (waiting.async) await waiting.value;
  expect(Atomics.load(entered, 0)).toBe(1);
  return { pending, release() { Atomics.store(release, 0, 1); Atomics.notify(release, 0); } };
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
  const safety = liveSafety(f);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({
    start(value) { stream = value; value.enqueue(new TextEncoder().encode("Odysseus")); },
  })) });
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }),
    bridge: { emit() {}, admissionSafety: safety, requestPermission: async () => ({ behavior: "allow" as const }) }, controller,
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
    await admit(f, safety, false, "JOURNEY_A_CANNOT_RESTORE_ADMISSION");
    expect((await review(f, c, { ...body(f, c), expectedEvidenceRevision: stale.highWater })).status, "JOURNEY_STALE_TAB_REFUSES").toBe(409);
    stream.close(); await drained; await proxy.settled();
    expect((await review(f, b)).result.currentProjection.unresolvedCount, "JOURNEY_B_LEAVES_DELAYED_C").toBe(1);
    await admit(f, safety, false, "JOURNEY_B_CANNOT_RESTORE_ADMISSION");
    for (const client of [one, two]) {
      await client.refresh();
      expect(client.store.getState().normal, "JOURNEY_BOTH_VIEWS_STAY_RESTRICTED").toBe(false);
      expect(client.store.getState().projection?.earliestUnresolvedId).toBe(c);
    }
    await collector.result("C", "WebFetch", "Later voyage notes", true);
    expect((await review(f, c)).result.currentProjection.restriction, "JOURNEY_ONLY_FINAL_C_RESTORES_NORMAL").toBe("normal");
    await admit(f, safety, true, "JOURNEY_FINAL_C_RESTORES_REAL_ADMISSION");
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
    await admit(f, safety, false, "JOURNEY_D_RESTRICTS_REAL_ADMISSION_AGAIN");
    await collector.result("D", "WebFetch", "Future voyage notes", true);
    await f.writes.safetyEnd("voyage");
  } finally { proxy.stop(); await proxy.settled(); origin.stop(true); await f.close(); }
});

for (const failed of [false, true]) test(`late collector write after an owner verdict ${failed ? "fails closed through recovery and restart" : "blocks admission before COMMIT and stays independent"}`, async () => {
  const f = await safetyHistoryFixture(true, true), safety = liveSafety(f);
  const collector = createSafetyCollector(f.db, f.writes, { turnId: "voyage", bindingId: f.bindingId, backendId: "claude",
    sessionId: () => "ithaca", shellProxied: () => true, signal: new AbortController().signal });
  let barrier: Awaited<ReturnType<typeof holdWriter>> | undefined, closed = false;
  let input: Promise<void> | undefined, retry: ReturnType<typeof postReview> | undefined;
  try {
    await collector.begin("A", "WebFetch", { url: "https://example.com/odyssey" });
    await collector.result("A", "WebFetch", "Voyage notes", true);
    const a = queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 })[0]!.payload.occurrence as { id: string };
    const value = body(f, a.id), prepared = await postReview(f, "prepare", value);
    expect(prepared.status).toBe(200);
    const handle = prepared.result.receipt.requestId as string, original = await postReview(f, `${handle}/commit`, value);
    expect(original.result.receipt.verdict).toBe("committed");
    await admit(f, safety, true, "JOURNEY_BASELINE_REVIEW_PERMITS_REAL_ADMISSION");
    const clients = [await view(f), await view(f)];
    for (const client of clients) { await client.refresh(); expect(client.store.getState().normal).toBe(true); }
    if (failed) f.db.exec("CREATE TRIGGER fail_late_occurrence BEFORE INSERT ON governance_events WHEN NEW.kind='taint' BEGIN SELECT RAISE(ABORT,'Odysseus late recording failure'); END");
    // Pause the real FULL writer immediately before the detector's occurrence
    // reservation. The real facade registers its pending input while SQLite
    // still contains only the already-reviewed A. No timing sleep is an oracle.
    const submitted = Promise.withResolvers<void>(), firstTaint = f.writes.firstTaint.bind(f.writes);
    f.writes.firstTaint = async (...args) => {
      barrier = await holdWriter(f);
      const pending = firstTaint(...args); submitted.resolve(); return pending;
    };
    input = collector.begin("B", "WebFetch", { url: "https://example.com/odyssey" });
    void input.catch(() => {});
    await submitted.promise;
    expect(queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 })).toHaveLength(1);
    await admit(f, safety, false, "JOURNEY_PENDING_ADD_BLOCKS_REAL_ADMISSION");
    // A second device retries the earlier successful verdict while B's write
    // is delayed. Its original receipt cannot become a standing permission.
    retry = postReview(f, `${handle}/commit`, value);
    const reads = clients.map(client => client.refresh());
    for (const client of clients) expect(client.store.getState().normal, "JOURNEY_WAITING_VIEWS_CANNOT_CLAIM_NORMAL").toBe(false);
    barrier!.release(); await barrier!.pending;
    if (failed) await expectRejection(input, "Odysseus late recording failure"); else await input;
    f.writes.firstTaint = firstTaint;
    const replayed = await retry;
    expect(replayed.result.receipt, "JOURNEY_LATE_WRITE_NEVER_REWRITES_EARLIER_VERDICT").toEqual(original.result.receipt);
    expect(replayed.result.currentProjection.restriction, "JOURNEY_ORIGINAL_RECEIPT_CANNOT_AUTHORIZE_LATE_INPUT").toBe("restricted");
    const pages = await Promise.all(reads);
    for (const page of pages) expect(page.projection.restriction).toBe("restricted");
    if (!failed) {
      await collector.result("B", "WebFetch", "Later voyage notes", true);
      await admit(f, safety, false, "JOURNEY_LATE_COMMIT_REMAINS_RESTRICTED");
      const b = queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 })[1]!.payload.occurrence as { id: string };
      expect((await review(f, b.id)).result.receipt.verdict).toBe("committed");
      await admit(f, safety, true, "JOURNEY_LATE_TRIGGER_NEEDS_ITS_OWN_VERDICT");
      for (const client of clients) { await client.refresh(); expect(client.store.getState().normal).toBe(true); }
      await f.writes.safetyEnd("voyage");
    } else {
      expect(f.writes.safety(null, "ithaca").reasons).toContain("recording_failed");
      expect(createGovernanceWrites(f.db, f.writer).recordingAvailable("voyage", "ithaca")).toBe(false);
      await admit(f, safety, false, "JOURNEY_FAILURE_LATCH_BLOCKS_REAL_ADMISSION");
      for (const client of clients) {
        const page = await client.refresh();
        expect(page.projection.reasons, "JOURNEY_BOTH_VIEWS_DISCLOSE_RECORDING_LOSS").toContain("recording_failed");
        expect(client.store.getState().normal).toBe(false);
      }
      // Removing the injected SQL fault does not repair the lost input. End
      // and reopen the actual database with a new writer/facade/admission path.
      f.db.exec("DROP TRIGGER fail_late_occurrence");
      await f.writes.safetyEnd("voyage");
      await f.close(true); closed = true;
      const db = createUiDb(f.path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
      try {
        const restarted = { ...f, db, writer, writes }, current = writes.safety(null, "ithaca");
        expect(current.coverage.state, "JOURNEY_FAILED_LATE_WRITE_SURVIVES_RESTART").toBe("incomplete");
        expect(current.restriction).toBe("restricted");
        await admit(restarted, liveSafety(restarted), false, "JOURNEY_RESTARTED_FAILURE_BLOCKS_REAL_ADMISSION");
      } finally { await writer.close(); db.close(); }
    }
  } finally {
    barrier?.release(); await input?.catch(() => {}); await retry?.catch(() => {});
    if (!closed) await f.close(); else rmSync(f.root, { recursive: true, force: true });
  }
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
      const writes = createGovernanceWrites(db, writer);
      await expectRejection(writes.firstTaint({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null,
        profile: "governed", payload: { source: "web_fetch", tool: "WebFetch", detail: null } }), "collection ended",
        "JOURNEY_RESTART_REFUSES_LATE_OLD_COLLECTION_WRITE");

    } finally { history.close(); await writer.close(); db.close(); }
  } finally { if (!closed) await f.close(); else rmSync(f.root, { recursive: true, force: true }); }
});
