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
  const backend = makeFakeBackend({ id: "scripted-3595" });
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
        host.coordinator.settleSiblingNetworkApprovals(turn.sessionId, excludeToolUseId, predicate, scope, reason, grantedClasses),
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

      const managedCardPromise = t1.bridge.requestPermission({
        toolUseId: "managed-gh-1",
        toolName: "Network",
        kind: "command",
        input: { host: "api.github.com", port: 443, method: "CONNECT", protocol: "connect", managedReference: true },
        origin: "managed:connect://api.github.com:443",
        revision: "rev-managed-1",
        network: { transport: "connect", scheme: "connect", host: "api.github.com", port: 443, managedReference: true, scopes: ["once"] },
      });
      await waitFor(() => h.host.coordinator.pendingApprovals.has("managed-gh-1"), "managed card pending");
      await handleToolApproval(h.ctx, {
        type: "tool_approval",
        toolUseId: "managed-gh-1",
        turnId: "t1",
        channel: "card",
        revision: "rev-managed-1",
        networkScope: "origin",
      });
      expect(h.host.coordinator.pendingApprovals.has("managed-gh-1"), "UNADVERTISED_ORIGIN_REFUSED").toBe(true);
      await handleToolApproval(h.ctx, {
        type: "tool_approval",
        toolUseId: "managed-gh-1",
        turnId: "t1",
        channel: "card",
        revision: "rev-managed-1",
        networkScope: "session",
      });
      expect(h.host.coordinator.pendingApprovals.has("managed-gh-1"), "UNADVERTISED_SESSION_REFUSED").toBe(true);
      await handleToolApproval(h.ctx, {
        type: "tool_approval",
        toolUseId: "managed-gh-1",
        turnId: "t1",
        channel: "card",
        revision: "rev-managed-1",
        networkScope: "once",
      });
      expect(await managedCardPromise).toMatchObject({ behavior: "allow" });
    } finally {
      await t1.stop();
      island.stop(true);
      await h.close();
    }
  });
});
