/**
 * A tainted Network card's scope through the WebSocket host (#3595): the
 * request frame and its re-delivery carry the host's offer, a reply's scope
 * reaches the backend only when the card offered it, and the decision
 * receipt and host outcome keep the scope that was granted.
 */
import { afterEach, expect, test } from "bun:test";
import type { NetworkApprovalOffer } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
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
    await new Promise(r => setTimeout(r, 5));
  }
}
const settle = () => new Promise(r => setTimeout(r, 25));
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

const OFFER: NetworkApprovalOffer = { transport: "http", host: "aeaea.invalid", port: 8080, scopes: ["once", "origin", "session"] };

/** A turn raising one Network card (with `network`, when given) for `tool-aeaea`. */
function setup(network?: NetworkApprovalOffer) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "server-test" });
  const stream = createActivityStream(store);
  const state: { decided: PermissionDecision | null; finish: () => void } = { decided: null, finish: () => {} };
  const backend = makeFakeBackend({
    id: "fake",
    capabilities: { permissions: true },
    startTurn: async ({ bridge }: { bridge: BackendBridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-aeaea", isNew: true });
      bridge.emit({ type: "tool_use_start", toolUseId: "tool-aeaea", toolName: "Network" });
      state.decided = await bridge.requestPermission({ toolUseId: "tool-aeaea", toolName: "Network", kind: "command",
        input: { host: "aeaea.invalid", port: 8080, method: "GET", target: "aeaea.invalid:8080" }, ...(network ? { network } : {}) });
      await new Promise<void>(r => (state.finish = r));
      bridge.emit({ type: "result", sessionId: "sess-aeaea", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db), activity: { store, stream } });
  cleanup = () => { state.finish(); host.close(); stream.close(); db.close(); };
  async function connect() {
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    send({ type: "client_hello", protocolRev: 4, capabilities: { toolResolution: true } });
    await settle();
    const frames = (type: string): any[] => sent.map(x => JSON.parse(x)).filter(f => f.type === type);
    return { send, frames };
  }
  async function raise(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
    client.send({ type: "chat_message", text: "Sail to Aeaea" });
    await until(() => client.frames("tool_approval_request").length === 1);
    return client.frames("tool_approval_request")[0].turnId;
  }
  const decisions = () => {
    const span = store.getSpan("tool-aeaea");
    return span ? store.snapshotRun(span.runId)!.events.filter(e => e.eventType === "approval_decision").map(e => e.payload) : [];
  };
  return { state, connect, raise, decisions };
}

test("the card and its re-delivery carry the offer; an offered scope reaches the backend and its receipts", async () => {
  const s = setup(OFFER);
  const card = await s.connect();
  const turnId = await s.raise(card);
  expect(card.frames("tool_approval_request")[0].network, "NETWORK_OFFER_ON_THE_CARD").toEqual(OFFER);
  const reconnected = await s.connect();
  await until(() => reconnected.frames("tool_approval_request").length === 1);
  expect(reconnected.frames("tool_approval_request")[0].network, "NETWORK_OFFER_ON_REDELIVERY").toEqual(OFFER);
  reconnected.send({ type: "tool_approval", toolUseId: "tool-aeaea", networkScope: "origin", channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided, "OFFERED_SCOPE_REACHES_THE_BACKEND").toEqual({ behavior: "allow", networkScope: "origin" });
  expect(s.decisions(), "DECISION_RECEIPT_KEEPS_THE_SCOPE").toEqual([{ principalId: "test-principal", decision: "allow", requestKind: "command", channel: "card", networkScope: "origin" }]);
  await until(() => card.frames("tool_resolution").length === 1);
  expect(card.frames("tool_resolution")[0], "HOST_OUTCOME_KEEPS_THE_SCOPE").toMatchObject({ outcome: "granted", networkScope: "origin" });
});

test("a scope the card did not offer narrows to this one connection", async () => {
  const s = setup({ ...OFFER, scopes: ["once"] });
  const client = await s.connect();
  const turnId = await s.raise(client);
  client.send({ type: "tool_approval", toolUseId: "tool-aeaea", networkScope: "session", channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided, "UNOFFERED_SCOPE_CREATES_NO_GRANT").toEqual({ behavior: "allow", networkScope: "once" });
});

for (const reply of ["legacy reply", "scope on an unrelated card"] as const) test(`a ${reply} keeps the existing answer`, async () => {
  const s = setup(reply === "legacy reply" ? OFFER : undefined);
  const client = await s.connect();
  const turnId = await s.raise(client);
  if (reply === "scope on an unrelated card") expect(client.frames("tool_approval_request")[0]).not.toHaveProperty("network");
  client.send({ type: "tool_approval", toolUseId: "tool-aeaea", ...(reply === "legacy reply" ? {} : { networkScope: "session" }), channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided, "UNSCOPED_ANSWER_UNCHANGED").toEqual({ behavior: "allow" });
});
