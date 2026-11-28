/**
 * Real-component proofs for #3595: explicit `once`, `origin`, and `session`
 * scopes on tainted Network approval cards, host-owned `network_grant`
 * persistence, new-class suspension, listing/revoking via HTTP routes, and
 * managed GitHub acquisition isolation.
 */
import { describe, expect, test } from "bun:test";
import { until as waitFor } from "../../../tests/helpers/until.js";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { NetworkApprovalScope, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { AppEnv } from "../src/app-env.js";
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
import { contactedHosts } from "../src/governance/session-taint.js";
import { sessionHistoryGeneration } from "../src/governance/safety-store.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { WsHost } from "../src/ws/host.js";
import { makeBridge } from "../src/ws/bridge.js";
import type { RunningTurn } from "../src/ws/turns.js";
import { handleToolApproval, handleToolDenial } from "../src/ws/handlers/tool-permission.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";
import { createNetworkGrantRoutes } from "../src/routes/network-grants.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

function fetchViaProxy(socketPath: string, url: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: url.href }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function connectViaProxy(socketPath: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let head = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", (chunk) => {
      head += chunk.toString();
      if (head.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(head));
    socket.on("error", reject);
  });
}

async function openScopeHarness() {
  const root = mkdtempSync(join(tmpdir(), "brain-scopes-3595-"));
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
  const host = new WsHost({
    brainPath: root,
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog,
    isPrincipalAuthorized: (id) => id === principal.id,
    activity: { store, stream: createActivityStream(store), governanceDb: db, governanceWrites: writes },
  });
  const authorization = host.coordinator.openAuthorization({
    principalId: principal.id,
    valid: true,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const frames: ServerMessage[] = [];
  const ws = { send(text: string) { frames.push(JSON.parse(text) as ServerMessage); } };
  host.clients.add(ws, principal.id);
  host.clients.setCapabilities(ws as never, {
    toolResolution: true,
    approvalUpdates: true,
    networkApprovalScopes: true,
    networkGrants: true,
  });

  const routes = new Hono<AppEnv>();
  routes.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  routes.route("/api", createNetworkGrantRoutes({
    db,
    governanceWrites: writes,
    isPrincipalValid: (p) => p.id === principal.id,
    onGrantsChanged: (sid) => host.broadcastNetworkGrants(sid),
  }));

  const openTurn = async (options: {
    turnId: string;
    sessionId: string;
    origin?: "interactive" | "voice";
    policy?: GovernancePolicyInput;
    createSession?: boolean;
  }) => {
    const controller = new AbortController();
    const turn = {
      sessionId: options.createSession ? null : options.sessionId,
      turnId: options.turnId,
      principalId: principal.id,
      authorization,
      startedAt: Date.now(),
      abortController: controller,
      queue: [],
    } as unknown as RunningTurn;
    await writes.safetyBegin({
      turnId: options.turnId,
      bindingId: `binding-${options.turnId}`,
      sessionId: options.createSession ? null : options.sessionId,
      principalId: principal.id,
      backendId: backend.id,
      at: Date.now(),
    });
    await writes.safetyReady(options.turnId, backend.id, 1);
    const bridge: BackendBridge = await makeBridge(host, turn, {
      promptText: "Odysseus sails.",
      backendId: backend.id,
    });
    if (options.createSession) {
      bridge.emit({ type: "session_info", sessionId: options.sessionId, isNew: true });
      turn.sessionId = options.sessionId;
      await catalog.settled!();
    }
    const egress = await prepareTurnEgress({
      controller,
      turnId: options.turnId,
      sessionId: () => turn.sessionId,
      model: () => "claude-haiku-4-5",
      origin: options.origin ?? "interactive",
      profile: "governed",
      policy: resolveGovernancePolicy(options.policy ?? { schema_version: 1 }),
      bridge,
      governanceDb: db,
      governanceWrites: writes,
      record: (event) => writes.record(event),
      networkRefusal: (id) => host.coordinator.networkRefusal(options.turnId, id),
      settleSiblings: (predicate, scope, reason, excludeToolUseId, grantedClasses) =>
        host.coordinator.settleSiblingNetworkApprovals(turn.sessionId, turn.turnId, excludeToolUseId, predicate, scope, reason, grantedClasses),
      onGrantsChanged: (sid) => host.broadcastNetworkGrants(sid),
      emitStandingReceipt: ({ connectionId, scope, reason }) => {
        if (!turn.sessionId) return;
        host.sendToClients({
          type: "tool_resolution",
          toolUseId: `network-grant:${connectionId}`,
          outcome: "granted",
          sessionId: turn.sessionId,
          turnId: options.turnId,
          networkScope: scope,
          grantedByGrant: true,
          reason,
        });
      },
    });
    return {
      turn,
      controller,
      bridge,
      egress,
      async stop() {
        controller.abort();
        egress.stop();
        await egress.settled();
      },
    };
  };

  const addTaint = (turnId: string, sessionId: string, source: "web_fetch" | "staged_share" | "chat_attachment") =>
    writes.firstTaint({
      turnId,
      sessionId,
      actor: "interactive",
      model: null,
      profile: "governed",
      kind: "taint",
      payload: {
        source,
        tool: source === "web_fetch" ? "WebFetch" : null,
        detail: `https://untrusted.invalid/${source}`,
        occurrence: occurrence(`binding-${turnId}`, "tool_web_input", `occ-${crypto.randomUUID().slice(0, 8)}`, "open"),
      },
    });

  const ctx = { host, ws, requireEcho: true, connection: { principal, authorization, capabilities: { toolResolution: true, approvalUpdates: true, networkApprovalScopes: true, networkGrants: true } } } as never;
  const approve = (card: Extract<ServerMessage, { type: "tool_approval_request" }>, scope?: NetworkApprovalScope) =>
    handleToolApproval(ctx, {
      type: "tool_approval",
      toolUseId: card.toolUseId,
      turnId: card.turnId,
      channel: "card",
      revision: card.revision,
      ...(scope ? { networkScope: scope } : {}),
    });
  const cards = () => frames.filter((f): f is Extract<ServerMessage, { type: "tool_approval_request" }> => f.type === "tool_approval_request");
  const resolutions = () => frames.filter((f): f is Extract<ServerMessage, { type: "tool_resolution" }> => f.type === "tool_resolution");

  return {
    root, db, writer, writes, host, principal, authorization, frames, routes, openTurn, addTaint, approve, cards, resolutions, ctx,
    async close() {
      await host.close();
      authorization.release();
      await writer.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("network approval scopes (#3595)", () => {
  test("once permits exactly one connection across concurrent calls and later turns, never polluting contactedHosts", async () => {
    const h = await openScopeHarness();
    let hits = 0;
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response(`hit-${++hits}`) });
    const t1 = await h.openTurn({ turnId: "t1", sessionId: "ithaca", createSession: true });
    try {
      await h.addTaint("t1", "ithaca", "web_fetch");
      await h.writer.idle();
      const p1 = fetchViaProxy(t1.egress.socketPath, new URL("/one", island.url)).then((r) => ({ which: "p1" as const, ...r }));
      const p2 = fetchViaProxy(t1.egress.socketPath, new URL("/two", island.url)).then((r) => ({ which: "p2" as const, ...r }));
      await waitFor(() => h.cards().length === 2, "two cards raised");
      const [c1, c2] = h.cards();
      await h.approve(c1!, "once");
      const firstDone = await Promise.race([p1, p2]);
      expect(firstDone.status, "ONCE_ADMITS_NAMED_CONNECTION").toBe(200);
      expect(hits).toBe(1);
      expect(h.host.coordinator.pendingApprovals.has(c2!.toolUseId), "ONCE_LEAVES_SIBLING_PENDING").toBe(true);
      const latestC2 = h.cards().findLast((c) => c.toolUseId === c2!.toolUseId)!;
      await handleToolDenial(h.ctx, { type: "tool_denial", toolUseId: latestC2.toolUseId, turnId: "t1", channel: "card", revision: latestC2.revision, message: "Decline sibling" });
      const secondDone = await (firstDone.which === "p1" ? p2 : p1);
      expect(secondDone.status).toBe(403);
      await t1.stop();
      await h.writer.idle();
      expect(contactedHosts(h.db, "ithaca"), "ONCE_EXCLUDED_FROM_CONTACTED_HOSTS").toEqual([]);

      const t2 = await h.openTurn({ turnId: "t2", sessionId: "ithaca" });
      try {
        const beforeT2Cards = h.cards().length;
        const p3 = fetchViaProxy(t2.egress.socketPath, new URL("/three", island.url));
        await waitFor(() => h.cards().length > beforeT2Cards, "later turn asks again after once");
        await h.approve(h.cards().at(-1)!, "once");
        expect((await p3).status).toBe(200);
        expect(hits).toBe(2);
      } finally {
        await t2.stop();
      }
    } finally {
      await t1.stop();
      island.stop(true);
      await h.close();
    }
  });

  test("origin grant settles 3 pending same-origin requests, survives later turns, distinguishes ports/CONNECT/other sessions, and emits standing receipts", async () => {
    const h = await openScopeHarness();
    let hitsA = 0, hitsB = 0;
    const portA = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response(`A-${++hitsA}`) });
    const portB = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response(`B-${++hitsB}`) });
    const t1 = await h.openTurn({ turnId: "t1", sessionId: "ithaca", createSession: true });
    try {
      await h.addTaint("t1", "ithaca", "web_fetch");
      await h.writer.idle();
      const batch = [
        fetchViaProxy(t1.egress.socketPath, new URL("/1", portA.url)),
        fetchViaProxy(t1.egress.socketPath, new URL("/2", portA.url)),
        fetchViaProxy(t1.egress.socketPath, new URL("/3", portA.url)),
      ];
      await waitFor(() => h.cards().length === 3, "3 same-origin cards");
      await h.approve(h.cards()[0]!, "origin");
      expect((await Promise.all(batch)).map((r) => r.status), "ORIGIN_SETTLES_ALL_THREE").toEqual([200, 200, 200]);
      expect(hitsA).toBe(3);

      const pPortB = fetchViaProxy(t1.egress.socketPath, portB.url);
      await waitFor(() => h.cards().length === 4, "different port asks");
      await handleToolDenial(h.ctx, { type: "tool_denial", toolUseId: h.cards()[3]!.toolUseId, turnId: "t1", channel: "card", revision: h.cards()[3]!.revision, message: "No portB" });
      expect((await pPortB).status).toBe(403);

      const pConnect = connectViaProxy(t1.egress.socketPath, `127.0.0.2:${portA.port}`);
      await waitFor(() => h.cards().length === 5, "CONNECT asks separately from HTTP");
      await handleToolDenial(h.ctx, { type: "tool_denial", toolUseId: h.cards()[4]!.toolUseId, turnId: "t1", channel: "card", revision: h.cards()[4]!.revision, message: "No CONNECT" });
      expect(await pConnect).toStartWith("HTTP/1.1 403");

      await t1.stop();
      await h.writer.idle();

      const t2 = await h.openTurn({ turnId: "t2", sessionId: "ithaca" });
      try {
        const prevCards = h.cards().length;
        const r2 = await fetchViaProxy(t2.egress.socketPath, new URL("/later-turn", portA.url));
        expect(r2.status, "ORIGIN_SURVIVES_LATER_TURN").toBe(200);
        expect(h.cards().length, "NO_NEW_CARD_ON_STANDING_GRANT").toBe(prevCards);
        expect(h.resolutions().some((r) => r.toolUseId.startsWith("network-grant:") && r.grantedByGrant === true && r.networkScope === "origin")).toBe(true);
      } finally {
        await t2.stop();
      }

      const otherTurn = await h.openTurn({ turnId: "t-pylos", sessionId: "pylos", createSession: true });
      try {
        await h.addTaint("t-pylos", "pylos", "web_fetch");
        await h.writer.idle();
        const prevCards = h.cards().length;
        const pOther = fetchViaProxy(otherTurn.egress.socketPath, portA.url);
        await waitFor(() => h.cards().length === prevCards + 1, "other session asks");
        await handleToolDenial(h.ctx, { type: "tool_denial", toolUseId: h.cards().at(-1)!.toolUseId, turnId: "t-pylos", channel: "card", revision: h.cards().at(-1)!.revision, message: "No cross-session" });
        expect((await pOther).status).toBe(403);
      } finally {
        await otherTurn.stop();
      }
    } finally {
      await t1.stop();
      portA.stop(true);
      portB.stop(true);
      await h.close();
    }
  });

  test("standing grant suspends on new class and asks once more; further occurrence of granted class does not suspend", async () => {
    const h = await openScopeHarness();
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("island") });
    const t1 = await h.openTurn({ turnId: "t1", sessionId: "ithaca", createSession: true });
    try {
      await h.addTaint("t1", "ithaca", "web_fetch");
      await h.writer.idle();
      const p1 = fetchViaProxy(t1.egress.socketPath, new URL("/1", island.url));
      await waitFor(() => h.cards().length === 1, "first card");
      await h.approve(h.cards()[0]!, "origin");
      expect((await p1).status).toBe(200);

      await h.addTaint("t1", "ithaca", "web_fetch");
      await h.writer.idle();
      expect((await fetchViaProxy(t1.egress.socketPath, new URL("/2", island.url))).status, "SAME_CLASS_KEEPS_GRANT_ACTIVE").toBe(200);
      expect(h.cards()).toHaveLength(1);

      await h.addTaint("t1", "ithaca", "staged_share");
      await h.writer.idle();
      const p3 = fetchViaProxy(t1.egress.socketPath, new URL("/3", island.url));
      await waitFor(() => h.cards().length === 2, "suspended grant asks again");
      const suspendedCard = h.cards()[1]!;
      expect(suspendedCard.network?.suspendedGrant, "SUSPENDED_GRANT_FLAG").toBe(true);
      expect(suspendedCard.description).toContain("This chat has now also");
      await h.approve(suspendedCard, "origin");
      expect((await p3).status).toBe(200);

      expect((await fetchViaProxy(t1.egress.socketPath, new URL("/4", island.url))).status).toBe(200);
      expect(h.cards()).toHaveLength(2);
    } finally {
      await t1.stop();
      island.stop(true);
      await h.close();
    }
  });

  test("session grant settles multiple sites, respects deny/voice limits, and can be listed and revoked via HTTP", async () => {
    const h = await openScopeHarness();
    const a = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("a") });
    const b = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("b") });
    const denied = Bun.serve({ hostname: "127.0.0.4", port: 0, fetch: () => new Response("denied") });
    const t1 = await h.openTurn({
      turnId: "t1",
      sessionId: "ithaca",
      createSession: true,
      policy: { schema_version: 1, egress: { deny: ["127.0.0.4"] } },
    });
    try {
      await h.addTaint("t1", "ithaca", "web_fetch");
      await h.writer.idle();
      const pA = fetchViaProxy(t1.egress.socketPath, a.url);
      const pB = fetchViaProxy(t1.egress.socketPath, b.url);
      await waitFor(() => h.cards().length === 2, "2 sites waiting");
      await h.approve(h.cards()[0]!, "session");
      expect((await Promise.all([pA, pB])).map((r) => r.status), "SESSION_GRANT_SETTLES_ALL_SITES").toEqual([200, 200]);

      const rDenied = await fetchViaProxy(t1.egress.socketPath, denied.url);
      expect(rDenied.status, "DENY_LIST_STILL_APPLIES").toBe(403);

      const voiceTurn = await h.openTurn({ turnId: "t-voice", sessionId: "ithaca", origin: "voice" });
      try {
        expect((await fetchViaProxy(voiceTurn.egress.socketPath, a.url)).status, "VOICE_NEVER_USES_SESSION_GRANT").toBe(403);
      } finally {
        await voiceTurn.stop();
      }

      const listRes = await h.routes.request("/api/sessions/ithaca/network-grants");
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { sessionId: string; grants: Array<{ grantId: string; scope: string }> };
      expect(listBody.grants).toHaveLength(1);
      expect(listBody.grants[0]!.scope).toBe("session");

      const grantId = listBody.grants[0]!.grantId;
      const delRes = await h.routes.request(`/api/sessions/ithaca/network-grants/${grantId}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      await h.writer.idle();
      expect(queryGovernanceEvents(h.db, { sessionId: "ithaca", kinds: ["network_grant_revoked"], limit: 10 })).toHaveLength(1);

      const prevCards = h.cards().length;
      const pAfter = fetchViaProxy(t1.egress.socketPath, new URL("/after-revoke", a.url));
      await waitFor(() => h.cards().length === prevCards + 1, "asks again after revoke");
      await h.approve(h.cards().at(-1)!, "once");
      expect((await pAfter).status).toBe(200);
    } finally {
      await t1.stop();
      a.stop(true);
      b.stop(true);
      denied.stop(true);
      await h.close();
    }
  });

  test("unadvertised scope is refused; managed GitHub reference offers only once and is never covered by session/origin grants", async () => {
    const h = await openScopeHarness();
    const t1 = await h.openTurn({ turnId: "t1", sessionId: "ithaca", createSession: true });
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("open") });
    try {
      await h.addTaint("t1", "ithaca", "web_fetch");
      await h.writer.idle();
      const pOpen = fetchViaProxy(t1.egress.socketPath, island.url);
      await waitFor(() => h.cards().length === 1, "open card");
      await h.approve(h.cards()[0]!, "session");
      expect((await pOpen).status).toBe(200);

      // Exercise the real managedReference path through egress-proxy + turn-egress (H5):
      // even with an active `session` standing grant, managed GitHub acquisition asks
      // with `managed:` origin, `managedReference: true`, and `scopes: ["once"]`.
      const managedTarget = new URL("https://github.com/ithaca/voyage");
      const op1 = t1.egress.managedReference(managedTarget, new AbortController().signal);
      const admit1 = op1.admit();
      await waitFor(() => h.cards().length === 2, "real managed GitHub card raised despite session grant");
      const mCard1 = h.cards()[1]!;
      expect(mCard1.origin, "MANAGED_ORIGIN_PREFIX").toBe("managed:connect://github.com:443");
      expect(mCard1.network?.managedReference, "MANAGED_FLAG_TRUE").toBe(true);
      expect(mCard1.network?.scopes, "MANAGED_OFFERS_ONLY_ONCE").toEqual(["once"]);

      await handleToolApproval(h.ctx, {
        type: "tool_approval",
        toolUseId: mCard1.toolUseId,
        turnId: "t1",
        channel: "card",
        revision: mCard1.revision,
        networkScope: "origin",
      });
      expect(h.host.coordinator.pendingApprovals.has(mCard1.toolUseId), "UNADVERTISED_ORIGIN_REFUSED").toBe(true);
      await handleToolApproval(h.ctx, {
        type: "tool_approval",
        toolUseId: mCard1.toolUseId,
        turnId: "t1",
        channel: "card",
        revision: mCard1.revision,
        networkScope: "session",
      });
      expect(h.host.coordinator.pendingApprovals.has(mCard1.toolUseId), "UNADVERTISED_SESSION_REFUSED").toBe(true);
      await h.approve(mCard1, "once");
      expect(await admit1, "MANAGED_ONCE_ADMITTED").toBe(true);
      op1.finish("completed");

      // A second managed GitHub acquisition still requires fresh approval (never added to contacted or grants).
      const beforeOp2 = h.cards().length;
      const op2 = t1.egress.managedReference(managedTarget, new AbortController().signal);
      const admit2 = op2.admit();
      await waitFor(
        () => h.cards().length > beforeOp2,
        () => `second managed GitHub acquisition asks again (cards=${h.cards().length}, outcome=${op2.outcome()}, reason=${op2.reason()}, recFail=${t1.egress.recordingFailure()?.message})`
      );
      const mCard2 = h.cards().at(-1)!;
      expect(mCard2.toolUseId).not.toBe(mCard1.toolUseId);
      expect(mCard2.network?.managedReference).toBe(true);
      expect(mCard2.network?.scopes).toEqual(["once"]);
      await h.approve(mCard2, "once");
      expect(await admit2).toBe(true);
      op2.finish("completed");
    } finally {
      await t1.stop();
      island.stop(true);
      await h.close();
    }
  });

  test("security & streaming invariants: account-isolated broadcasts, fail-closed unowned sessions, strict grant schema, in-flight survives revoke", async () => {
    const h = await openScopeHarness();
    const t1 = await h.openTurn({ turnId: "t1", sessionId: "session-sec", createSession: true });
    let releaseStream1!: () => void;
    const gate1 = new Promise<void>((r) => { releaseStream1 = r; });
    let chunk1Ready!: () => void;
    const chunk1Sent = new Promise<void>((r) => { chunk1Ready = r; });
    const upstream1 = Bun.serve({
      hostname: "127.0.0.2",
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("part-1:"));
            chunk1Ready();
            await gate1;
            controller.enqueue(new TextEncoder().encode("part-2"));
            controller.close();
          },
        }));
      },
    });
    let releaseStream2!: () => void;
    const gate2 = new Promise<void>((r) => { releaseStream2 = r; });
    let chunk2Ready!: () => void;
    const chunk2Sent = new Promise<void>((r) => { chunk2Ready = r; });
    const upstream2 = Bun.serve({
      hostname: "127.0.0.3",
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("live-1:"));
            chunk2Ready();
            await gate2;
            controller.enqueue(new TextEncoder().encode("live-2"));
            controller.close();
          },
        }));
      },
    });
    try {
      await h.addTaint("t1", "session-sec", "web_fetch");
      // Attach a foreign delegated agent socket that declares networkGrants.
      const foreign = createPrincipal(h.db, { authMethod: "delegated", createdBy: h.principal.id, label: "ForeignAgent", ttlSeconds: 3600 });
      const foreignFrames: ServerMessage[] = [];
      const foreignWs = { send(text: string) { foreignFrames.push(JSON.parse(text) as ServerMessage); } };
      h.host.clients.add(foreignWs, foreign.id);
      h.host.clients.setCapabilities(foreignWs as never, { networkGrants: true });

      // Insert future-schema-version, managed:, and malformed grantedClasses rows using the live historyGeneration
      // so the schema_version, safeParse, and managed: guards themselves (not generation mismatch) reject them.
      const currentGen = sessionHistoryGeneration(h.db, "t1", "session-sec");
      h.db.query(`INSERT INTO governance_events (session_id, turn_id, at, kind, schema_version, actor, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("session-sec", "t1", Date.now(), "network_grant", 99, "user", JSON.stringify({
          grantId: "ng_future_v99", scope: "session", grantedClasses: ["web_fetch"], historyGeneration: currentGen, toolUseId: "t-v99", principalId: h.principal.id,
        }));
      h.db.query(`INSERT INTO governance_events (session_id, turn_id, at, kind, schema_version, actor, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("session-sec", "t1", Date.now(), "network_grant", 1, "user", JSON.stringify({
          grantId: "ng_bad_managed", scope: "origin", origin: "managed:connect://api.github.com:443", transport: "connect", scheme: "connect", host: "api.github.com", port: 443, grantedClasses: ["web_fetch"], historyGeneration: currentGen, toolUseId: "t-bad", principalId: h.principal.id,
        }));
      h.db.query(`INSERT INTO governance_events (session_id, turn_id, at, kind, schema_version, actor, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("session-sec", "t1", Date.now(), "network_grant", 1, "user", JSON.stringify({
          grantId: "ng_bad_classes", scope: "session", grantedClasses: "not-an-array", historyGeneration: currentGen, toolUseId: "t-bad2", principalId: h.principal.id,
        }));

      // Invalid rows must not create a standing grant, so request 1 still asks for a card.
      const firstReq = fetchViaProxy(t1.egress.socketPath, upstream1.url);
      await waitFor(() => h.cards().length === 1, "card raised despite invalid rows");
      const c1 = h.cards()[0]!;
      await handleToolApproval(h.ctx, {
        type: "tool_approval",
        toolUseId: c1.toolUseId,
        turnId: "t1",
        channel: "card",
        revision: c1.revision,
        networkScope: "session",
      });
      await chunk1Sent;
      releaseStream1();
      expect((await firstReq).body).toBe("part-1:part-2");

      // Owner received broadcast with only the valid grant; foreign account received zero network_grants frames.
      const ownerGrants = h.frames.filter((f): f is Extract<ServerMessage, { type: "network_grants" }> => f.type === "network_grants");
      expect(ownerGrants.length).toBeGreaterThanOrEqual(1);
      const ids = ownerGrants.at(-1)!.grants.map((g) => g.grantId);
      expect(ids).not.toContain("ng_future_v99");
      expect(ids).not.toContain("ng_bad_managed");
      expect(ids).not.toContain("ng_bad_classes");
      expect(foreignFrames.filter((f) => f.type === "network_grants"), "FOREIGN_ACCOUNT_NO_GRANT_LEAK").toEqual([]);

      // Unowned session fails closed (404).
      h.db.query("INSERT INTO sessions (id, backend_id, created_at, last_active_at) VALUES (?, ?, ?, ?)")
        .run("session-unowned", "claude", Date.now(), Date.now());
      const unownedRes = await h.routes.request("/api/sessions/session-unowned/network-grants");
      expect(unownedRes.status, "UNOWNED_SESSION_FAILS_CLOSED").toBe(404);

      // In-flight request covered by standing grant completes even if the grant is revoked mid-stream (#3595).
      const inFlight = fetchViaProxy(t1.egress.socketPath, upstream2.url);
      await chunk2Sent;
      const activeGrantId = ownerGrants.at(-1)!.grants[0]!.grantId;
      const del = await h.routes.request(`/api/sessions/session-sec/network-grants/${activeGrantId}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      releaseStream2();
      const inFlightResult = await inFlight;
      expect(inFlightResult.status, "IN_FLIGHT_SURVIVES_REVOKE").toBe(200);
      expect(inFlightResult.body).toBe("live-1:live-2");
    } finally {
      await t1.stop();
      upstream1.stop(true);
      upstream2.stop(true);
      await h.close();
    }
  });

  test("sibling settlement isolates concurrent unbound turns, revalidates/checks abort before granting, and terminal drain records reason before abort", async () => {
    const h = await openScopeHarness();
    try {
      const turnA = { sessionId: null, turnId: "unbound-a", abortController: new AbortController(), queue: [], cancelled: false } as unknown as RunningTurn;
      const turnB = { sessionId: null, turnId: "unbound-b", abortController: new AbortController(), queue: [], cancelled: false } as unknown as RunningTurn;
      const decisions: Record<string, string> = {};
      const abortedSignal = new AbortController();
      abortedSignal.abort();

      h.host.coordinator.openApproval("sib-other-chat", {
        turn: turnB,
        turnId: "unbound-b",
        request: {
          toolUseId: "sib-other-chat",
          toolName: "Network",
          input: {},
          origin: "https://ithaca.example:443",
          networkCard: { evaluateChange: () => "noop", revalidate: () => null, signal: new AbortController().signal },
        },
        revalidate: () => null,
        resolve: (d) => { decisions["sib-other-chat"] = d.behavior; },
      });
      h.host.coordinator.openApproval("sib-aborted", {
        turn: turnA,
        turnId: "unbound-a",
        request: {
          toolUseId: "sib-aborted",
          toolName: "Network",
          input: {},
          origin: "https://ithaca.example:443",
          networkCard: { evaluateChange: () => "noop", revalidate: () => null, signal: abortedSignal.signal },
        },
        revalidate: () => null,
        resolve: (d) => { decisions["sib-aborted"] = d.behavior; },
      });
      h.host.coordinator.openApproval("sib-stale-auth", {
        turn: turnA,
        turnId: "unbound-a",
        request: {
          toolUseId: "sib-stale-auth",
          toolName: "Network",
          input: {},
          origin: "https://ithaca.example:443",
          networkCard: { evaluateChange: () => "noop", revalidate: () => "Authority expired.", signal: new AbortController().signal },
        },
        revalidate: () => "Authority expired.",
        resolve: (d) => { decisions["sib-stale-auth"] = d.behavior; },
      });
      h.host.coordinator.openApproval("sib-same-turn-valid", {
        turn: turnA,
        turnId: "unbound-a",
        request: {
          toolUseId: "sib-same-turn-valid",
          toolName: "Network",
          input: {},
          origin: "https://ithaca.example:443",
          networkCard: { evaluateChange: () => "noop", revalidate: () => null, signal: new AbortController().signal },
        },
        revalidate: () => null,
        resolve: (d) => { decisions["sib-same-turn-valid"] = d.behavior; },
      });

      const settled = h.host.coordinator.settleSiblingNetworkApprovals(
        null,
        "unbound-a",
        "source-id",
        (req) => req.origin === "https://ithaca.example:443",
        "origin",
        "Covered by origin grant"
      );
      expect(settled, "ONLY_VALID_SAME_TURN_SIBLING_SETTLED").toBe(1);
      expect(decisions["sib-other-chat"], "UNBOUND_OTHER_CHAT_UNTOUCHED").toBeUndefined();
      expect(decisions["sib-aborted"], "ABORTED_SIBLING_EXPIRED_NOT_GRANTED").toBe("deny");
      expect(decisions["sib-stale-auth"], "STALE_SIBLING_EXPIRED_NOT_GRANTED").toBe("deny");
      expect(decisions["sib-same-turn-valid"], "VALID_SIBLING_GRANTED").toBe("allow");
      expect(h.resolutions().find((r) => r.toolUseId === "sib-aborted")?.expiryCause).toBe("operation_cancelled");
      expect(h.resolutions().find((r) => r.toolUseId === "sib-stale-auth")?.expiryCause).toBe("safety_changed");

      // Terminal budget-style drain before abortController.abort() still records drainedReason (#1763/#3553).
      h.host.coordinator.drainPendingForTurn(turnB, "Turn stopped: inference budget exceeded.", { terminal: true });
      expect(turnB.cancelled).toBe(false);
      expect(h.host.coordinator.drainedReason(turnB, "unbound-b"), "BUDGET_DRAIN_RECORDED_BEFORE_ABORT").toBe("Turn stopped: inference budget exceeded.");
    } finally {
      await h.close();
    }
  });

  test("degraded safety coverage disables standing origin/session grants until re-approved (#3595/#4966)", async () => {
    const h = await openScopeHarness();
    const t1 = await h.openTurn({ turnId: "t-cov", sessionId: "session-cov", createSession: true });
    const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("cov-ok") });
    try {
      await h.addTaint("t-cov", "session-cov", "web_fetch");
      await h.writer.idle();
      const first = fetchViaProxy(t1.egress.socketPath, island.url);
      await waitFor(() => h.cards().length === 1, "initial card raised");
      await h.approve(h.cards()[0]!, "origin");
      expect((await first).status).toBe(200);

      // Degrade coverage to incomplete via a recording gap on the collection.
      h.db.query("UPDATE safety_collections SET gap = 'uninstrumented_backend_input' WHERE turn_id = 't-cov'").run();
      const beforeDegraded = h.cards().length;
      const second = fetchViaProxy(t1.egress.socketPath, new URL("/after-gap", island.url));
      await waitFor(() => h.cards().length > beforeDegraded, "degraded coverage refuses standing grant and asks again");
      await h.approve(h.cards().at(-1)!, "once");
      expect((await second).status, "DEGRADED_COVERAGE_REQUIRES_FRESH_APPROVAL").toBe(200);

      // Restoring clean coverage and advancing dialogue_owners.generation (snapshot restore / lifecycle bump)
      // must invalidate prior-generation standing grants across standingGrant and HTTP listing.
      h.db.query("UPDATE safety_collections SET gap = NULL WHERE turn_id = 't-cov'").run();
      h.db.query("INSERT OR IGNORE INTO dialogue_owners (id, principal_id, session_id, coverage, generation, created_at) VALUES (?, ?, ?, 'complete', 1, ?)")
        .run("owner-cov", h.principal.id, "session-cov", Date.now());
      h.db.query("UPDATE dialogue_owners SET generation = generation + 1 WHERE session_id = 'session-cov'").run();
      const listedAfterBump = await (await h.routes.request("/api/sessions/session-cov/network-grants")).json() as { grants: unknown[] };
      expect(listedAfterBump.grants, "DIALOGUE_OWNER_GENERATION_BUMP_INVALIDATES_GRANTS").toEqual([]);
      const beforeBumpReq = h.cards().length;
      const third = fetchViaProxy(t1.egress.socketPath, new URL("/after-owner-bump", island.url));
      await waitFor(() => h.cards().length > beforeBumpReq, "generation-bumped standing grant asks again");
      await h.approve(h.cards().at(-1)!, "once");
      expect((await third).status).toBe(200);
    } finally {
      await t1.stop();
      island.stop(true);
      await h.close();
    }
  });
});
