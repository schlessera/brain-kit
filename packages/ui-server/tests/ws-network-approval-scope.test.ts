/**
 * A tainted Network card's scope through the WebSocket host (#3595): the
 * request frame and its re-delivery carry the host's offer, a reply's scope
 * reaches the backend only when the card offered it, and a wider grant is
 * committed before the host publishes a granted outcome naming it.
 */
import { afterEach, expect, test } from "bun:test";
import type { NetworkApprovalOffer } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { TurnCoordinator, type RunningTurn } from "../src/ws/turns";
import { testPrincipal } from "./helpers/principal";

/** Polls a condition; the watchdog only stops a hang and scales under load. */
async function until(cond: () => boolean, timeoutMs = watchdogMs(10_000)): Promise<void> {
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

/**
 * A turn raising one Network card for `net-aeaea`, as the turn proxy does:
 * no tool span, the offer when given, and the proxy's commit hook.
 */
function setup(network?: NetworkApprovalOffer, commit?: (scope: "origin" | "session") => boolean) {
  const db = createUiDb(":memory:");
  const state: { decided: PermissionDecision | null; finish: () => void; commits: string[] } = { decided: null, finish: () => {}, commits: [] };
  const backend = makeFakeBackend({
    id: "fake",
    capabilities: { permissions: true },
    startTurn: async ({ bridge }: { bridge: BackendBridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-aeaea", isNew: true });
      state.decided = await bridge.requestPermission({ toolUseId: "net-aeaea", toolName: "Network", kind: "command",
        input: { host: "aeaea.invalid", port: 8080, method: "GET", target: "aeaea.invalid:8080" }, ...(network ? { network } : {}),
        ...(commit ? { commitNetworkScope: (scope: "origin" | "session") => { state.commits.push(scope); return commit(scope); } } : {}) });
      await new Promise<void>(r => (state.finish = r));
      bridge.emit({ type: "result", sessionId: "sess-aeaea", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  cleanup = () => { state.finish(); host.close(); db.close(); };
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
  return { state, connect, raise };
}

test("the card and its re-delivery carry the offer; a committed wider scope reaches the backend and the host outcome", async () => {
  let resolutionBeforeCommit = false;
  const s = setup(OFFER, () => { resolutionBeforeCommit = card.frames("tool_resolution").length > 0; return true; });
  const card = await s.connect();
  const turnId = await s.raise(card);
  expect(card.frames("tool_approval_request")[0].network, "NETWORK_OFFER_ON_THE_CARD").toEqual(OFFER);
  const reconnected = await s.connect();
  await until(() => reconnected.frames("tool_approval_request").length === 1);
  expect(reconnected.frames("tool_approval_request")[0].network, "NETWORK_OFFER_ON_REDELIVERY").toEqual(OFFER);
  reconnected.send({ type: "tool_approval", toolUseId: "net-aeaea", networkScope: "origin", channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided, "OFFERED_SCOPE_REACHES_THE_BACKEND").toEqual({ behavior: "allow", networkScope: "origin" });
  expect(s.state.commits, "WIDER_SCOPE_COMMITS_ONCE").toEqual(["origin"]);
  expect(resolutionBeforeCommit, "GRANT_COMMITS_BEFORE_ITS_OUTCOME_IS_PUBLISHED").toBe(false);
  await until(() => card.frames("tool_resolution").length === 1);
  expect(card.frames("tool_resolution")[0], "HOST_OUTCOME_KEEPS_THE_SCOPE").toMatchObject({ outcome: "granted", networkScope: "origin" });
});

test("a wider grant that cannot commit expires the card and publishes no granted scope", async () => {
  const s = setup(OFFER, () => false);
  const client = await s.connect();
  const turnId = await s.raise(client);
  client.send({ type: "tool_approval", toolUseId: "net-aeaea", networkScope: "session", channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided?.behavior, "UNCOMMITTED_GRANT_ALLOWS_NOTHING").toBe("deny");
  await until(() => client.frames("tool_resolution").length === 1);
  const outcome = client.frames("tool_resolution")[0];
  expect(outcome, "UNCOMMITTED_GRANT_IS_EXPIRED").toMatchObject({ outcome: "expired" });
  expect(outcome).not.toHaveProperty("networkScope");
  // A late reply learns the same truthful outcome.
  client.send({ type: "tool_approval", toolUseId: "net-aeaea", networkScope: "session", channel: "card", turnId });
  await until(() => client.frames("tool_resolution").length === 2);
  expect(client.frames("tool_resolution")[1], "LATE_REPLY_GETS_NO_GRANTED_SCOPE").toMatchObject({ outcome: "expired" });
  expect(client.frames("tool_resolution")[1]).not.toHaveProperty("networkScope");
});

test("a scope the card did not offer narrows to this one connection and commits nothing", async () => {
  const s = setup({ ...OFFER, scopes: ["once"] }, () => true);
  const client = await s.connect();
  const turnId = await s.raise(client);
  client.send({ type: "tool_approval", toolUseId: "net-aeaea", networkScope: "session", channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided, "UNOFFERED_SCOPE_CREATES_NO_GRANT").toEqual({ behavior: "allow", networkScope: "once" });
  expect(s.state.commits).toEqual([]);
});

for (const reply of ["legacy reply", "scope on an unrelated card"] as const) test(`a ${reply} keeps the existing answer`, async () => {
  const s = setup(reply === "legacy reply" ? OFFER : undefined);
  const client = await s.connect();
  const turnId = await s.raise(client);
  if (reply === "scope on an unrelated card") expect(client.frames("tool_approval_request")[0]).not.toHaveProperty("network");
  client.send({ type: "tool_approval", toolUseId: "net-aeaea", ...(reply === "legacy reply" ? {} : { networkScope: "session" }), channel: "card", turnId });
  await until(() => s.state.decided !== null);
  expect(s.state.decided, "UNSCOPED_ANSWER_UNCHANGED").toEqual({ behavior: "allow" });
});

test("a card that fails revalidation commits no grant and publishes no granted scope", () => {
  const coordinator = new TurnCoordinator();
  const turn = { sessionId: "sess-aeaea", turnId: "turn-aeaea", principalId: "test-principal", pendingCancellationPrincipalIds: [], abortController: new AbortController(),
    timeoutHandle: setTimeout(() => {}, 0), queue: [], cancelled: false, lastResult: null } as unknown as RunningTurn;
  const commits: string[] = [], decisions: PermissionDecision[] = [];
  const request = { toolUseId: "net-aeaea", toolName: "Network", kind: "command" as const, input: {}, network: OFFER,
    commitNetworkScope: (scope: "origin" | "session") => { commits.push(scope); return true; } };
  coordinator.openApproval("net-aeaea", { turn, turnId: "turn-aeaea", request, resolve: decision => { decisions.push(decision); },
    revalidate: () => "Safety or authority changed while the card waited." });
  const claimed = coordinator.claimApproval("net-aeaea")!;
  coordinator.settleApproval("net-aeaea", claimed, { behavior: "allow", networkScope: "session" }, { principalId: "test-principal" });
  expect(commits, "EXPIRED_CARD_COMMITS_NO_GRANT").toEqual([]);
  expect(decisions[0]?.behavior).toBe("deny");
  expect(coordinator.resolvedApprovals.get("net-aeaea")).toMatchObject({ outcome: "expired" });
  expect(coordinator.resolvedApprovals.get("net-aeaea")).not.toHaveProperty("networkScope");
  clearTimeout(turn.timeoutHandle);
});
