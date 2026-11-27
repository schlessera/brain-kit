/**
 * Real-component proofs for #4966: Network approval cards stay answerable while
 * concurrent fetches write safety evidence, update in place on a new untrusted-
 * input class, expire orphaned cards with `operation_cancelled`, eliminate the
 * expiry ghost window, and never refuse a clean-session racer without a card.
 */
import { describe, expect, test } from "bun:test";
import { until as waitFor } from "../../../tests/helpers/until.js";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy, type TrustRule } from "@schlessera/brain-common/internal/governance-policy";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createModelPricing } from "../src/pricing/model-pricing.js";
import { resolveStandalonePricingConfig } from "../src/config/env.js";
import { createGovernanceWrites } from "../src/governance/event-writes.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { occurrence } from "../src/governance/occurrence.js";
import type { OriginTrust } from "../src/brain/origin-trust.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { WsHost } from "../src/ws/host.js";
import { makeBridge } from "../src/ws/bridge.js";
import type { RunningTurn } from "../src/ws/turns.js";
import { handleToolApproval } from "../src/ws/handlers/tool-permission.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import * as heldWriter from "./fixtures/held-publication-writer.js";

interface ProxyFetch {
  status: number;
  body: string;
}

function fetchViaProxy(socketPath: string, url: URL, signal?: AbortSignal): Promise<ProxyFetch> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: url.href }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    const onAbort = () => { req.destroy(); resolve({ status: 0, body: "aborted" }); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err) => {
      if (signal?.aborted) resolve({ status: 0, body: "aborted" });
      else resolve({ status: 0, body: err.message });
    });
    req.end();
  });
}

async function openHarness(options: {
  taintSources?: Array<"web_fetch" | "egress_connection" | "staged_share">;
  withTrust?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "brain-net-4966-"));
  const db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db);
  const writes = createGovernanceWrites(db, writer);
  const store = createActivityStore(db);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const backend = makeFakeBackend({ id: "claude" });
  const catalog = createSessionCatalog(() => db, undefined, undefined, {
    writer,
    store,
    governance: writes,
    pricing: createModelPricing(resolveStandalonePricingConfig()),
  });

  let trustRev = "1";
  let trustRules: TrustRule[] = [];
  let trustRuleInstances: Record<string, string> = {};
  const trustListeners = new Set<() => void>();
  const policyHash = "a".repeat(64);
  const trust: OriginTrust | undefined = options.withTrust ? {
    revision: () => trustRev,
    subscribe: (listener) => { trustListeners.add(listener); return () => trustListeners.delete(listener); },
    read: () => ({ revision: trustRev, rules: trustRules, policyHash, ruleInstances: trustRuleInstances }),
  } : undefined;

  const host = new WsHost({
    brainPath: root,
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog,
    isPrincipalAuthorized: (id) => id === principal.id,
    ...(trust ? { safetyTrust: trust } : {}),
    activity: { store, stream: createActivityStream(store), governanceDb: db, governanceWrites: writes },
  });
  const authorization = host.coordinator.openAuthorization({
    principalId: principal.id,
    valid: true,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const controller = new AbortController();
  const turn = {
    sessionId: null,
    turnId: "turn-voyage",
    principalId: principal.id,
    authorization,
    startedAt: Date.now(),
    abortController: controller,
    queue: [],
  } as unknown as RunningTurn;

  const frames: ServerMessage[] = [];
  const ws = { send(text: string) { frames.push(JSON.parse(text) as ServerMessage); } };
  host.clients.add(ws, principal.id);
  host.clients.setCapabilities(ws as never, {
    toolResolution: true,
    approvalUpdates: true,
    networkApprovalScopes: true,
    networkGrants: true,
  });

  await writes.safetyBegin({
    turnId: "turn-voyage",
    bindingId: "binding-voyage",
    sessionId: null,
    principalId: principal.id,
    backendId: backend.id,
    at: Date.now(),
  });
  await writes.safetyReady("turn-voyage", backend.id, 1);
  const bridge: BackendBridge = await makeBridge(host, turn, {
    promptText: "Odysseus charts four islands.",
    backendId: backend.id,
    ...(trust ? { trust } : {}),
  });
  bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
  turn.sessionId = "ithaca";
  await catalog.settled!();

  const addTaint = (source: "web_fetch" | "egress_connection" | "staged_share", idSuffix = crypto.randomUUID().slice(0, 8)) =>
    writes.firstTaint({
      turnId: "turn-voyage",
      sessionId: "ithaca",
      actor: "interactive",
      model: null,
      profile: "governed",
      kind: "taint",
      payload: {
        source,
        tool: source === "web_fetch" ? "WebFetch" : null,
        detail: `https://source.invalid/${idSuffix}`,
        occurrence: occurrence("binding-voyage", source === "egress_connection" ? "proxy_input" : "tool_web_input", `occ-${idSuffix}`, "open"),
      },
    });

  for (const src of options.taintSources ?? []) await addTaint(src);
  await writer.idle();

  const egress = await prepareTurnEgress({
    controller,
    turnId: "turn-voyage",
    sessionId: () => turn.sessionId,
    model: () => "claude-haiku-4-5",
    origin: "interactive",
    profile: "governed",
    policy: resolveGovernancePolicy({ schema_version: 1 }),
    policyHash,
    bridge,
    ...(trust ? { trust } : {}),
    governanceDb: db,
    governanceWrites: writes,
    record: (event) => writes.record(event),
    networkRefusal: (id) => host.coordinator.networkRefusal("turn-voyage", id),
    settleSiblings: (predicate, scope, reason, excludeToolUseId, grantedClasses) =>
      host.coordinator.settleSiblingNetworkApprovals(turn.sessionId, excludeToolUseId, predicate, scope, reason, grantedClasses),
    onGrantsChanged: (sid) => host.broadcastNetworkGrants(sid),
  });

  const ctx = (capabilities: Record<string, boolean> = { toolResolution: true, approvalUpdates: true, networkApprovalScopes: true }) =>
    ({ host, ws, requireEcho: true, connection: { principal, authorization, capabilities } }) as never;

  const cards = () =>
    frames.filter((f): f is Extract<ServerMessage, { type: "tool_approval_request" }> => f.type === "tool_approval_request");
  const resolutions = () =>
    frames.filter((f): f is Extract<ServerMessage, { type: "tool_resolution" }> => f.type === "tool_resolution");

  return {
    root, db, writer, writes, host, turn, controller, authorization, principal, bridge, egress, frames, ws,
    updateTrustRules(rules: TrustRule[]) {
      trustRev = String(Number(trustRev) + 1);
      trustRules = rules;
      trustRuleInstances = Object.fromEntries(rules.map((r) => [r.id, trustRev]));
      for (const l of trustListeners) l();
    },
    addTaint,
    ctx,
    cards,
    resolutions,
    async close() {
      controller.abort();
      egress.stop();
      await egress.settled();
      await host.close();
      authorization.release();
      await writer.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("network approval stability (#4966)", () => {
  test("4 parallel connections to 4 hosts answered after delay produce 4 cards, 0 safety_changed expiries, 4 completions", async () => {
    const h = await openHarness({ taintSources: ["web_fetch", "egress_connection"] });
    const servers = ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"].map((hostname, i) =>
      Bun.serve({ hostname, port: 0, fetch: () => new Response(`island-${i}`) })
    );
    try {
      const pending = servers.map((s) => fetchViaProxy(h.egress.socketPath, s.url));
      await waitFor(() => h.cards().length === 4, "4 cards raised");
      const initialCards = [...h.cards()];
      await h.addTaint("web_fetch", "harbor-2");
      await Bun.sleep(100);
      expect(h.cards(), "NO_SPURIOUS_REVISION_UPDATE_ON_SAME_CLASS").toHaveLength(4);
      expect(new Set(initialCards.map((c) => c.toolUseId)).size, "UNIQUE_TOOL_USE_ID_PER_CONNECTION").toBe(4);

      for (const card of initialCards) {
        await handleToolApproval(h.ctx(), {
          type: "tool_approval",
          toolUseId: card.toolUseId,
          turnId: "turn-voyage",
          channel: "card",
          revision: card.revision,
          networkScope: "once",
        });
      }
      const results = await Promise.all(pending);
      expect(results.map((r) => r.status), "ALL_FOUR_COMPLETED").toEqual([200, 200, 200, 200]);
      await h.writer.idle();
      expect(queryGovernanceEvents(h.db, { kinds: ["safety_admission_expired"], limit: 20 }), "ZERO_SAFETY_CHANGED_EXPIRIES").toEqual([]);
    } finally {
      for (const s of servers) s.stop(true);
      await h.close();
    }
  });

  test("approving card 1 then cards 2 and 3 within 100ms applies all three", async () => {
    const h = await openHarness({ taintSources: ["web_fetch", "egress_connection"] });
    const servers = ["127.0.0.2", "127.0.0.3", "127.0.0.4"].map((hostname, i) =>
      Bun.serve({ hostname, port: 0, fetch: () => new Response(`rapid-${i}`) })
    );
    try {
      const pending = servers.map((s) => fetchViaProxy(h.egress.socketPath, s.url));
      await waitFor(() => h.cards().length === 3, "3 cards raised");
      const [c1, c2, c3] = h.cards();
      await handleToolApproval(h.ctx(), { type: "tool_approval", toolUseId: c1!.toolUseId, turnId: "turn-voyage", channel: "card", revision: c1!.revision, networkScope: "once" });
      await Bun.sleep(15);
      await handleToolApproval(h.ctx(), { type: "tool_approval", toolUseId: c2!.toolUseId, turnId: "turn-voyage", channel: "card", revision: c2!.revision, networkScope: "once" });
      await Bun.sleep(15);
      await handleToolApproval(h.ctx(), { type: "tool_approval", toolUseId: c3!.toolUseId, turnId: "turn-voyage", channel: "card", revision: c3!.revision, networkScope: "once" });

      const results = await Promise.all(pending);
      expect(results.map((r) => r.status), "RAPID_THREE_ALL_COMPLETE").toEqual([200, 200, 200]);
      await h.writer.idle();
      expect(queryGovernanceEvents(h.db, { kinds: ["safety_admission_expired"], limit: 20 })).toEqual([]);
    } finally {
      for (const s of servers) s.stop(true);
      await h.close();
    }
  });

  test("3 concurrent connections to one host + 1 legacy click completes all 3 via sibling settlement", async () => {
    const h = await openHarness({ taintSources: ["web_fetch"] });
    let hits = 0;
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response(`hit-${++hits}`) });
    try {
      const pending = [
        fetchViaProxy(h.egress.socketPath, new URL("/a", island.url)),
        fetchViaProxy(h.egress.socketPath, new URL("/b", island.url)),
        fetchViaProxy(h.egress.socketPath, new URL("/c", island.url)),
      ];
      await waitFor(() => h.cards().length === 3, "3 cards for same host");
      const first = h.cards()[0]!;
      expect(new Set(h.cards().map((c) => c.origin)).size).toBe(1);
      await handleToolApproval(h.ctx({ toolResolution: true }), {
        type: "tool_approval",
        toolUseId: first.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
      });
      const results = await Promise.all(pending);
      expect(results.map((r) => r.status), "LEGACY_CLICK_SETTLES_ALL_THREE").toEqual([200, 200, 200]);
      expect(hits).toBe(3);
      const siblingResolutions = h.resolutions().filter((r) => r.toolUseId !== first.toolUseId);
      expect(siblingResolutions).toHaveLength(2);
      expect(siblingResolutions.every((r) => r.outcome === "granted" && r.grantedByGrant === true)).toBe(true);
    } finally {
      island.stop(true);
      await h.close();
    }
  });

  test("orphaned connection aborts before click -> expires with operation_cancelled and late click records no grant", async () => {
    const h = await openHarness({ taintSources: ["web_fetch"] });
    let hits = 0;
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => { hits++; return new Response("ok"); } });
    try {
      const clientAbort = new AbortController();
      const pending = fetchViaProxy(h.egress.socketPath, island.url, clientAbort.signal);
      await waitFor(() => h.cards().length === 1, "card raised");
      const card = h.cards()[0]!;
      clientAbort.abort();
      await pending;
      await waitFor(() => h.resolutions().some((r) => r.toolUseId === card.toolUseId), "orphan resolution");
      const expired = h.resolutions().find((r) => r.toolUseId === card.toolUseId)!;
      expect(expired, "ORPHAN_EXPIRES_OPERATION_CANCELLED").toMatchObject({
        outcome: "expired",
        expiryCause: "operation_cancelled",
        sessionId: "ithaca",
      });
      await h.writer.idle();
      expect(queryGovernanceEvents(h.db, { kinds: ["safety_admission_expired"], limit: 10 }).map((e) => e.payload)).toMatchObject([
        { toolUseId: card.toolUseId, reason: "operation_cancelled" },
      ]);
      await handleToolApproval(h.ctx(), {
        type: "tool_approval",
        toolUseId: card.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
        revision: card.revision,
        networkScope: "origin",
      });
      expect(queryGovernanceEvents(h.db, { kinds: ["network_grant"], limit: 10 })).toEqual([]);
      expect(hits).toBe(0);
    } finally {
      island.stop(true);
      await h.close();
    }
  });

  test("new class updates card in place under same toolUseId; stale revision rejected; arming rejects revisionless reply", async () => {
    const h = await openHarness({ taintSources: ["web_fetch"] });
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("aeaea") });
    try {
      const pending = fetchViaProxy(h.egress.socketPath, island.url);
      await waitFor(() => h.cards().length === 1, "initial card");
      const v1 = h.cards()[0]!;
      await h.addTaint("web_fetch", "dup");
      await h.writer.idle();
      expect(h.cards(), "SAME_CLASS_IS_NOOP").toHaveLength(1);
      await h.addTaint("staged_share", "new-cls");
      await waitFor(() => h.cards().length === 2, "in-place update");
      const v2 = h.cards()[1]!;
      expect(v2.toolUseId, "IN_PLACE_SAME_ID").toBe(v1.toolUseId);
      expect(v2.revision, "IN_PLACE_NEW_REVISION").not.toBe(v1.revision);
      expect(v2.network?.classes).toContain("staged_share");
      await handleToolApproval(h.ctx(), {
        type: "tool_approval",
        toolUseId: v1.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
        revision: v1.revision,
        networkScope: "once",
      });
      expect(h.host.coordinator.pendingApprovals.has(v1.toolUseId), "STALE_REVISION_NOT_APPLIED").toBe(true);
      await handleToolApproval(h.ctx({ toolResolution: true }), {
        type: "tool_approval",
        toolUseId: v1.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
      });
      expect(h.host.coordinator.pendingApprovals.has(v1.toolUseId), "ARMING_REFUSES_REVISIONLESS").toBe(true);
      await handleToolApproval(h.ctx(), {
        type: "tool_approval",
        toolUseId: v2.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
        revision: v2.revision,
        networkScope: "once",
      });
      expect((await pending).status).toBe(200);
    } finally {
      island.stop(true);
      await h.close();
    }
  });

  test("pending write of a new class updates card in place; pending write of already-shown class passes", async () => {
    const h = await openHarness({ taintSources: ["web_fetch", "egress_connection"] });
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("pass") });
    const release = new Int32Array(new SharedArrayBuffer(4));
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const channel = h.writer.channel(heldWriter, {});
    await channel.ready;
    let held: Promise<unknown> | undefined;
    let pendingWrite: Promise<unknown> | undefined;
    try {
      const p1 = fetchViaProxy(h.egress.socketPath, new URL("/same", island.url));
      await waitFor(() => h.cards().length === 1, "card 1");
      const c1 = h.cards()[0]!;
      held = channel.call("hold", entered, release);
      const wait1 = Atomics.waitAsync(entered, 0, 0, 5_000);
      if (wait1.async) await wait1.value;
      pendingWrite = h.addTaint("web_fetch", "pending-same");
      await handleToolApproval(h.ctx(), {
        type: "tool_approval",
        toolUseId: c1.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
        revision: c1.revision,
        networkScope: "once",
      });
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await Promise.all([held, pendingWrite]);
      expect((await p1).status, "PENDING_SAME_CLASS_PASSES").toBe(200);

      const p2 = fetchViaProxy(h.egress.socketPath, new URL("/new", island.url));
      await waitFor(() => h.cards().length === 2, "card 2");
      const c2 = h.cards()[1]!;
      Atomics.store(entered, 0, 0);
      Atomics.store(release, 0, 0);
      held = channel.call("hold", entered, release);
      const wait2 = Atomics.waitAsync(entered, 0, 0, 5_000);
      if (wait2.async) await wait2.value;
      pendingWrite = h.addTaint("staged_share", "pending-new");
      await waitFor(() => h.cards().some((c) => c.toolUseId === c2.toolUseId && c.revision !== c2.revision), "card 2 updated for pending new class");
      const c2Updated = h.cards().at(-1)!;
      expect(c2Updated.toolUseId).toBe(c2.toolUseId);
      expect(c2Updated.network?.classes).toContain("staged_share");
      await handleToolApproval(h.ctx(), {
        type: "tool_approval",
        toolUseId: c2Updated.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
        revision: c2Updated.revision,
        networkScope: "once",
      });
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await Promise.all([held, pendingWrite]);
      expect((await p2).status, "PENDING_NEW_CLASS_UPDATED_AND_COMPLETED").toBe(200);
    } finally {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await Promise.allSettled([held, pendingWrite]);
      island.stop(true);
      await h.close();
    }
  });

  test("trust revision change re-evaluates recipient instead of withdrawing; authority revocation withdraws", async () => {
    const h = await openHarness({ taintSources: ["web_fetch"], withTrust: true });
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("trusted-recipient") });
    const other = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("other") });
    try {
      const p1 = fetchViaProxy(h.egress.socketPath, island.url);
      const p2 = fetchViaProxy(h.egress.socketPath, other.url);
      await waitFor(() => h.cards().length === 2, "two cards raised");
      const c1 = h.cards().find((c) => c.network?.host === "127.0.0.2")!;
      const c2 = h.cards().find((c) => c.network?.host === "127.0.0.3")!;

      h.updateTrustRules([{
        id: "rule-ithaca-harbour",
        label: "Trusted island harbour",
        incomingContent: false,
        recipientWhileRestricted: true,
        selector: { kind: "web_origin", scheme: "http", host: "127.0.0.2", port: island.port! },
      }]);

      expect((await p1).status, "TRUST_RULE_SETTLES_MATCHING_CARD").toBe(200);
      expect(h.host.coordinator.pendingApprovals.has(c2.toolUseId), "TRUST_CHANGE_KEEPS_UNMATCHED_CARD").toBe(true);
      expect(h.resolutions().find((r) => r.toolUseId === c1.toolUseId)).toMatchObject({ outcome: "granted", grantedByGrant: true });

      h.authorization.valid = false;
      await h.addTaint("web_fetch", "poke");
      await waitFor(() => h.resolutions().some((r) => r.toolUseId === c2.toolUseId), "withdrawn on authority loss");
      expect(h.resolutions().find((r) => r.toolUseId === c2.toolUseId)).toMatchObject({
        outcome: "expired",
        expiryCause: "safety_changed",
        sessionId: "ithaca",
      });
      expect((await p2).status).not.toBe(200);
    } finally {
      island.stop(true);
      other.stop(true);
      await h.close();
    }
  });

  test("two first connections racing on a clean session: second asks a card instead of taint_not_allowed without one (RC8)", async () => {
    const h = await openHarness({ taintSources: [] });
    const a = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("first") });
    const b = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("second") });
    const release = new Int32Array(new SharedArrayBuffer(4));
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const channel = h.writer.channel(heldWriter, {});
    await channel.ready;
    let held: Promise<unknown> | undefined;
    try {
      held = channel.call("hold", entered, release);
      const waited = Atomics.waitAsync(entered, 0, 0, 5_000);
      if (waited.async) await waited.value;

      const p1 = fetchViaProxy(h.egress.socketPath, a.url);
      await Bun.sleep(25);
      const p2 = fetchViaProxy(h.egress.socketPath, b.url);
      await Bun.sleep(25);

      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await held;
      await h.writer.idle();

      await waitFor(() => h.cards().length >= 1, "clean-session racer raises card", 2500);
      // Approve every card raised for the racing clean-session connection(s);
      // neither racer may be refused with `taint_not_allowed` without a card.
      const answered = new Set<string>();
      const done = Promise.all([p1, p2]);
      let settled = false;
      void done.then(() => { settled = true; });
      const deadline = Date.now() + 5_000;
      while (!settled) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for racing connections to finish");
        for (const card of h.cards()) {
          if (answered.has(card.toolUseId) || !h.host.coordinator.pendingApprovals.has(card.toolUseId)) continue;
          answered.add(card.toolUseId);
          const latest = h.cards().findLast((c) => c.toolUseId === card.toolUseId)!;
          await handleToolApproval(h.ctx(), {
            type: "tool_approval",
            toolUseId: latest.toolUseId,
            turnId: "turn-voyage",
            channel: "card",
            revision: latest.revision,
            networkScope: "once",
          });
        }
        await Bun.sleep(15);
      }
      const [r1, r2] = await done;
      expect(answered.size, "AT_LEAST_ONE_RACER_ASKED_A_CARD").toBeGreaterThanOrEqual(1);
      expect([r1.status, r2.status], "CLEAN_SESSION_RACER_BOTH_SUCCEED_VIA_CARD").toEqual([200, 200]);
      expect(queryGovernanceEvents(h.db, { kinds: ["egress_denial"], limit: 10 })).toEqual([]);
    } finally {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await Promise.allSettled([held]);
      a.stop(true);
      b.stop(true);
      await h.close();
    }
  });

  test("click during durable expiry write window gets provisional expired with sessionId, never unknown (RC4)", async () => {
    const h = await openHarness({ taintSources: ["web_fetch"] });
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("ghost") });
    const release = new Int32Array(new SharedArrayBuffer(4));
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const channel = h.writer.channel(heldWriter, {});
    await channel.ready;
    let held: Promise<unknown> | undefined;
    try {
      const clientAbort = new AbortController();
      const pending = fetchViaProxy(h.egress.socketPath, island.url, clientAbort.signal);
      await waitFor(() => h.cards().length === 1, "card raised");
      const card = h.cards()[0]!;

      held = channel.call("hold", entered, release);
      const waited = Atomics.waitAsync(entered, 0, 0, 5_000);
      if (waited.async) await waited.value;

      clientAbort.abort();
      await pending;
      await waitFor(() => h.host.coordinator.expiringApprovals.has(card.toolUseId), "entered expiring window");

      await handleToolApproval(h.ctx(), {
        type: "tool_approval",
        toolUseId: card.toolUseId,
        turnId: "turn-voyage",
        channel: "card",
        revision: card.revision,
      });
      expect(h.resolutions(), "PROVISIONAL_EXPIRED_NOT_UNKNOWN").toContainEqual({
        type: "tool_resolution",
        toolUseId: card.toolUseId,
        outcome: "expired",
        sessionId: "ithaca",
        turnId: "turn-voyage",
      });

      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await held;
      await waitFor(() => h.resolutions().some((r) => r.toolUseId === card.toolUseId && r.expiryCause === "operation_cancelled"), "final terminal resolution");
      expect(h.resolutions().every((r) => r.outcome !== "unknown"), "NEVER_UNKNOWN").toBe(true);
    } finally {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await Promise.allSettled([held]);
      island.stop(true);
      await h.close();
    }
  });
});
