/**
 * Truthful approval expiry attribution (#1763): automatic settlement (turn
 * timeout, cancellation, host stop, session end, safety withdrawal) never
 * records a human "user declined" denial or fictitious approval_decision event,
 * while explicit human denials keep their responding principal and attribution.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { queryGovernanceEvents } from "../src/governance/events";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { stopTurnForHost } from "../src/ws/host-stop";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";
import { until } from "../../../tests/helpers/until";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(options: { turnTimeoutMs?: number; emitLateError?: boolean } = {}) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const stream = createActivityStream(store);
  const governanceWrites = createGovernanceWrites(db);
  let finishTurn = () => {};
  let observedTurnId: string | null = null;
  let lastDecision: unknown = null;

  const backend = makeFakeBackend({
    id: "fake",
    capabilities: { permissions: true },
    startTurn: async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
      bridge.emit({ type: "tool_use_start", toolUseId: "tool-provisions", toolName: "Bash" });
      bridge.emit({ type: "tool_use_complete", toolUseId: "tool-provisions", toolName: "Bash", input: { command: "echo sail" } });
      lastDecision = await bridge.requestPermission({
        toolUseId: "tool-provisions",
        toolName: "Bash",
        kind: "command",
        input: { command: "echo sail" },
      });
      if (options.emitLateError) {
        bridge.emit({
          type: "tool_result",
          toolUseId: "tool-provisions",
          output: "Tool permission denied by runtime",
          isError: true,
        });
      }
      await new Promise<void>((r) => (finishTurn = r));
      bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });

  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: () => true,
    turnTimeoutMs: options.turnTimeoutMs ?? 60_000,
    activity: {
      store,
      stream,
      governanceDb: db,
      governanceWrites,
      governance: (event) => governanceWrites.record(event),
    },
  });

  cleanup = () => {
    finishTurn();
    host.close();
    db.close();
  };

  async function startAndAwaitCard() {
    const principal = testPrincipal("principal-odysseus");
    const handlers = createWsHandlers(host, principal);
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    send({ type: "client_hello", protocolRev: 4, capabilities: { toolResolution: true } });
    send({ type: "chat_message", text: "Check Ithaca harbour supplies" });
    await until(() => sent.some((raw) => JSON.parse(raw).type === "tool_approval_request"));
    const card = sent.map((raw) => JSON.parse(raw)).find((f) => f.type === "tool_approval_request");
    observedTurnId = card.turnId;
    return { send, sent, turnId: card.turnId as string, principal };
  }

  return {
    db, store, host, startAndAwaitCard,
    finish: async () => { await until(() => lastDecision !== null); finishTurn(); },
    spanEvents: (turnId: string, spanId: string) =>
      (store.snapshotRun(turnId)?.events ?? []).filter((e) => e.spanId === spanId),
    getDecision: () => lastDecision,
    getTurnId: () => observedTurnId,
  };
}

describe("approval expiry attribution (#1763)", () => {
  test("turn timeout records timeout with actual cause, never user declined or permission_denied roadblock", async () => {
    const s = setup({ emitLateError: true });
    const { turnId } = await s.startAndAwaitCard();
    const turn = [...s.host.coordinator.running][0]!;
    turn.timedOutTurnId = turn.turnId;
    s.host.coordinator.drainPendingForTurn(turn, "Turn timed out");
    turn.abortController.abort();
    await s.finish();

    await until(() => s.store.getSpan("tool-provisions")?.outcome !== null);
    await until(() => s.store.getSpan(`${turnId}:turn`)?.outcome !== null);

    const span = s.store.getSpan("tool-provisions")!;
    expect(span.outcome).toBe("timeout");
    expect(span.outcomeReason).toBe("Turn timed out");
    expect(span.outcomeReason).not.toBe("user declined");
    expect(span.principalId).toBeNull();

    const events = s.spanEvents(turnId, "tool-provisions");
    expect(events.some((e) => e.eventType === "approval_decision")).toBe(false);
    expect(events.some((e) => e.eventType === "approval_expired")).toBe(true);

    const outcome = s.host.coordinator.resolvedApprovals.get("tool-provisions");
    expect(outcome?.outcome).toBe("expired");
    expect(outcome?.reason).toBe("Turn timed out");

    const roadblocks = queryGovernanceEvents(s.db, { turnId, kinds: ["roadblock"], limit: 50 });
    expect(roadblocks.some((r) => (r.payload as { category?: string }).category === "permission_denied")).toBe(false);
  });

  test("explicit human denial retains responding principal, approval_decision event and user declined reason", async () => {
    const s = setup({ emitLateError: true });
    const { send, turnId, principal } = await s.startAndAwaitCard();
    send({ type: "tool_denial", toolUseId: "tool-provisions", message: "Not needed", channel: "card", turnId });
    await s.finish();
    await until(() => s.store.getSpan(`${turnId}:turn`)?.outcome !== null);

    const span = s.store.getSpan("tool-provisions")!;
    expect(span.outcome).toBe("denied");
    expect(span.outcomeReason).toBe("user declined");
    expect(span.principalId).toBe(principal.id);

    const decisions = s.spanEvents(turnId, "tool-provisions").filter((e) => e.eventType === "approval_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ principalId: principal.id, decision: "deny", channel: "card" });
  });

  test("cancellation and host-stop drains retain distinct non-decline causes without permission_denied roadblocks", async () => {
    const s = setup({ emitLateError: true });
    const { turnId } = await s.startAndAwaitCard();
    const turn = [...s.host.coordinator.running][0]!;
    stopTurnForHost(s.host, turn, turnId, turn.abortController, "egress_record", new Error("disk full"));
    await s.finish();

    await until(() => s.store.getSpan(`${turnId}:turn`)?.outcome !== null);

    const span = s.store.getSpan("tool-provisions")!;
    expect(span.outcome).toBe("cancelled");
    expect(span.outcomeReason).toContain("Stopped by the host");
    expect(span.outcomeReason).not.toBe("user declined");
    expect(span.principalId).toBeNull();
    expect(s.spanEvents(turnId, "tool-provisions").some((e) => e.eventType === "approval_decision")).toBe(false);

    const roadblocks = queryGovernanceEvents(s.db, { turnId, kinds: ["roadblock"], limit: 50 });
    expect(roadblocks.some((r) => (r.payload as { category?: string }).category === "permission_denied")).toBe(false);
  });

  test("safety_changed withdrawal records expiry cause rather than user declined", async () => {
    const s = setup();
    const { turnId } = await s.startAndAwaitCard();
    s.host.coordinator.expireApproval("tool-provisions", "Safety or authority changed before admission.", "safety_changed");
    await s.finish();

    await until(() => s.store.getSpan(`${turnId}:turn`)?.outcome !== null);

    const span = s.store.getSpan("tool-provisions")!;
    expect(span.outcome).toBe("cancelled");
    expect(span.outcomeReason).toContain("Safety or authority changed");
    expect(span.principalId).toBeNull();
    const expiredEvents = s.spanEvents(turnId, "tool-provisions").filter((e) => e.eventType === "approval_expired");
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0]!.payload).toMatchObject({ cause: "safety_changed" });
  });
});
