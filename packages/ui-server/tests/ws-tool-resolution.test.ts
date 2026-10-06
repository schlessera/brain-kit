/**
 * Host-authoritative permission outcomes (#957). Sending a denial is not
 * confirmation of one: the host says whether a request was granted, denied,
 * expired with its turn, or never pending at all — and says it only to
 * connections that asked, so legacy clients see the protocol they always saw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 25));

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** A turn that raises one card for `tool-loom` and then waits to be told to finish. */
function setup() {
  const db = createUiDb(":memory:");
  const state: { decided: PermissionDecision | null; finish: () => void; toolResults: number } = {
    decided: null,
    finish: () => {},
    toolResults: 0,
  };
  const backend = makeFakeBackend({
    id: "fake",
    capabilities: { permissions: true },
    startTurn: async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-loom", isNew: true });
      state.decided = await bridge.requestPermission({ toolUseId: "tool-loom", toolName: "Write", input: { path: "notes/loom.md" } });
      await new Promise<void>((r) => (state.finish = r));
      bridge.emit({ type: "result", sessionId: "sess-loom", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  cleanup = () => {
    state.finish();
    host.coordinator.reset();
    host.close();
    db.close();
  };
  async function connect(capabilities?: Record<string, boolean>) {
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    if (capabilities) send({ type: "client_hello", protocolRev: 4, capabilities });
    await settle();
    const frames = (type: string): any[] => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    return { send, frames };
  }
  async function raise(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
    client.send({ type: "chat_message", text: "Record the loom's pattern" });
    await until(() => client.frames("tool_approval_request").length === 1);
    return client.frames("tool_approval_request")[0].turnId;
  }
  return { host, state, connect, raise };
}

describe("tool_resolution", () => {
  test("a confirmed denial reaches every connection that asked, and no other", async () => {
    const s = setup();
    const card = await s.connect({ toolResolution: true });
    const watcher = await s.connect({ toolResolution: true });
    const legacy = await s.connect();
    const turnId = await s.raise(card);
    card.send({ type: "tool_denial", toolUseId: "tool-loom", message: "Not now", channel: "voice", turnId });
    await until(() => s.state.decided !== null);
    await until(() => watcher.frames("tool_resolution").length === 1);
    const expected = { type: "tool_resolution", toolUseId: "tool-loom", outcome: "denied", sessionId: "sess-loom", turnId, channel: "voice" };
    expect(card.frames("tool_resolution")).toEqual([expected]);
    expect(watcher.frames("tool_resolution")).toEqual([expected]);
    expect(legacy.frames("tool_resolution")).toEqual([]);
  });

  test("a spoken denial that loses to a card grant is told granted, never denied", async () => {
    const s = setup();
    const client = await s.connect({ toolResolution: true });
    const turnId = await s.raise(client);
    client.send({ type: "tool_approval", toolUseId: "tool-loom", channel: "card", turnId });
    await until(() => s.state.decided !== null);
    client.send({ type: "tool_denial", toolUseId: "tool-loom", message: "Refused by voice", channel: "voice", turnId });
    await settle();
    expect(s.state.decided).toEqual({ behavior: "allow" });
    expect(client.frames("tool_resolution").map((f) => [f.outcome, f.channel])).toEqual([
      ["granted", "card"],
      ["granted", "card"],
    ]);
  });

  test("terminal expiry settles the card without any tool_result, and a late denial learns it expired", async () => {
    const s = setup();
    const client = await s.connect({ toolResolution: true });
    const turnId = await s.raise(client);
    client.send({ type: "cancel", sessionId: "sess-loom" });
    await until(() => s.host.coordinator.pendingApprovals.size === 0);
    await settle();
    expect(client.frames("tool_resolution")[0]).toEqual({
      type: "tool_resolution", toolUseId: "tool-loom", outcome: "expired", sessionId: "sess-loom", turnId, reason: "Cancelled by user",
    });
    expect(client.frames("tool_result")).toEqual([]);
    expect(s.host.coordinator.pendingApprovals.size).toBe(0);

    client.send({ type: "tool_denial", toolUseId: "tool-loom", message: "Refused by voice", channel: "voice", turnId });
    await until(() => client.frames("tool_resolution").length === 2);
    expect(client.frames("tool_resolution")[1]).toMatchObject({ outcome: "expired", turnId });
  });

  test("a denial for a request the host never held, or for another turn, is unknown", async () => {
    const s = setup();
    const client = await s.connect({ toolResolution: true });
    client.send({ type: "tool_denial", toolUseId: "tool-never", message: "no", channel: "voice" });
    await until(() => client.frames("tool_resolution").length === 1);
    expect(client.frames("tool_resolution")[0]).toEqual({ type: "tool_resolution", toolUseId: "tool-never", outcome: "unknown" });

    await s.raise(client);
    client.send({ type: "tool_denial", toolUseId: "tool-loom", message: "no", channel: "voice", turnId: "turn-from-before-reconnect" });
    await until(() => client.frames("tool_resolution").length === 2);
    expect(client.frames("tool_resolution")[1]).toEqual({
      type: "tool_resolution", toolUseId: "tool-loom", outcome: "unknown", turnId: "turn-from-before-reconnect",
    });
    // The stale reply settled nothing.
    expect(s.state.decided).toBeNull();
    expect(s.host.coordinator.pendingApprovals.has("tool-loom")).toBe(true);
  });

  test("a voice grant stays refused and produces no resolution", async () => {
    const s = setup();
    const client = await s.connect({ toolResolution: true });
    const turnId = await s.raise(client);
    client.send({ type: "tool_approval", toolUseId: "tool-loom", channel: "voice", turnId });
    await until(() => client.frames("tool_approval_request").length === 2);
    await settle();
    expect(s.state.decided).toBeNull();
    expect(client.frames("tool_resolution")).toEqual([]);
  });

  test("server_hello offers toolResolution to every client", async () => {
    const s = setup();
    const client = await s.connect();
    expect(client.frames("server_hello")[0].capabilities.toolResolution).toBe(true);
  });
});
