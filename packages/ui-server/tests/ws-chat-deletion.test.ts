/**
 * Chat deletion (#3230) through the real host, run loop, catalog and
 * dispatch: busy refusal, a resume held across retirement, admission and
 * recovery refusing a retired chat, and targeted `chat_retired` delivery.
 * A scripted backend, synthetic Odysseus text; no model, key or network.
 */
import { afterEach, expect, test } from "bun:test";
import { CHAT_DELETION_CAPABILITY, type ClientMessage, type ServerMessage, type SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createPrincipal, resolvePrincipal } from "../src/db/principals";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { handleClientMessage as dispatch } from "../src/ws/dispatch";
import { WsHost } from "../src/ws/host";
import { readSessionRecovery } from "../src/ws/recovery";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createChatDeletion } from "../src/ws/chat-deletion";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

const MARKER = "Odysseus hid the oar under the olive root";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeoutMs) throw new Error("until: timed out"); await Bun.sleep(2); }
}

function world() {
  const db = createUiDb(":memory:");
  const transcript: SessionHistoryMessage[] = [];
  let finish: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let reads = 0;
  const backend = {
    ...makeFakeBackend({
      id: "fixture",
      capabilities: { historyRemoval: true },
      async getHistory() { reads++; await hold; return structuredClone(transcript); },
      startTurn: (req: StartTurnRequest) => new Promise<void>(resolve => {
        req.bridge.emit({ type: "session_info", sessionId: "voyage", isNew: true });
        transcript.push({ role: "user", content: req.prompt, toolCalls: [] });
        finish = () => {
          transcript.push({ role: "assistant", content: `${MARKER}, answered.`, toolCalls: [] });
          req.bridge.emit({ type: "result", sessionId: "voyage", numTurns: 1, durationMs: 1, isError: false, outcome: "success" });
          resolve();
        };
      }),
    }),
    async removeSessionHistory() { transcript.splice(0); return { outcome: "removed" as const }; },
  };
  const catalog = createSessionCatalog(() => db);
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, isPrincipalValid: () => true });
  const owner = resolvePrincipal(db, createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 86_400 }).id)!;
  const other = createPrincipal(db, { authMethod: "passkey", label: "Penelope tablet", ttlSeconds: 86_400 }).id;
  host.chatDeletion = createChatDeletion({ catalog, backends: async () => [backend], busy: identities => host.chatBusy(identities),
    retired: (principalId, retirement) => host.chatRetired(principalId, retirement) });
  const client = (principalId: string, capabilities?: Record<string, boolean>) => {
    const frames: ServerMessage[] = [];
    const ws: WSContext = { send: data => frames.push(JSON.parse(data)) };
    host.clients.add(ws, principalId);
    host.clients.setCapabilities(ws, capabilities);
    return { ws, frames };
  };
  const main = client(owner.id, { [CHAT_DELETION_CAPABILITY]: true });
  const connection = { principal: owner, authorization: testAuthorization(owner.id) };
  cleanups.push(() => { finish?.(); host.coordinator.cancelAll("Test teardown"); host.close(); db.close(); });
  return {
    db, host, catalog, owner, other, main, client, connection,
    send: (msg: ClientMessage) => dispatch(host, main.ws, msg, connection),
    finish: () => finish!(),
    holdHistory() { let release!: () => void; hold = new Promise(resolve => { release = resolve; }); reads = 0; return release; },
    reads: () => reads,
    remove: (operationId: string) => host.chatDeletion!.delete({ operationId, principalId: owner.id, target: { sessionId: "voyage" }, expected: { backendId: "fixture", generation: 1 } }),
  };
}

test("deletion refuses a running turn, then a resume held across retirement publishes nothing and the chat stays absent", async () => {
  const w = world();
  const hello: ServerMessage[] = [];
  await createWsHandlers(w.host, w.owner).onOpen(undefined as never, { send: (d: string) => hello.push(JSON.parse(d)), close: () => {} });
  const advertised = hello.find(frame => frame.type === "server_hello");
  expect(advertised?.type === "server_hello" && advertised.capabilities?.[CHAT_DELETION_CAPABILITY], "HELLO_ADVERTISES_CHAT_DELETION").toBe(true);

  await w.send({ type: "chat_message", text: `Plan the voyage home. ${MARKER}`, attachments: [] } as ClientMessage);
  await until(() => w.host.coordinator.bySession.has("voyage"));
  // The chat's recorded owner: a voice conversation bound to it.
  await w.catalog.dialogueOpen!({ conversationId: "ithaca", principalId: w.owner.id, epoch: 1, providerId: "gemini-live", sessionId: "voyage" });
  expect(await w.remove("busy-attempt"), "RUNNING_TURN_REFUSES").toEqual({ status: "refused", reason: "busy" });
  w.finish();
  await until(() => !w.host.coordinator.isTurnActive());
  await w.host.failureReplay.wait("voyage");

  const peer = w.client(w.owner.id, { [CHAT_DELETION_CAPABILITY]: true });
  const oldClient = w.client(w.owner.id);
  const stranger = w.client(w.other, { [CHAT_DELETION_CAPABILITY]: true });
  const release = w.holdHistory();
  const from = w.main.frames.length;
  const resume = w.send({ type: "session_resume", sessionId: "voyage" });
  await until(() => w.reads() > 0);
  const deleted = await w.remove("delete-voyage");
  expect(deleted.status === "retired" && deleted.receipt.status, "DELETION_COMPLETES").toBe("removed");
  release();
  await resume;
  const resumed = w.main.frames.slice(from);
  expect(resumed.some(frame => frame.type === "session_history"), "HELD_RESUME_PUBLISHES_NO_HISTORY").toBe(false);
  expect(JSON.stringify(resumed).includes(MARKER)).toBe(false);
  expect(resumed.find(frame => frame.type === "error"), "HELD_RESUME_REPORTS_ABSENT").toMatchObject({ code: "SESSION_NOT_FOUND", sessionId: "voyage" });

  // Targeted invalidation: the owner's declaring connections only.
  const notice: ServerMessage = { type: "chat_retired", sessionId: "voyage", historyOwnerIds: ["ithaca"], generation: 2 };
  expect(peer.frames.filter(frame => frame.type === "chat_retired"), "OWNER_PEER_INVALIDATED").toEqual([notice]);
  expect(oldClient.frames.some(frame => frame.type === "chat_retired"), "UNDECLARED_CLIENT_NOT_SENT").toBe(false);
  expect(stranger.frames.some(frame => frame.type === "chat_retired"), "OTHER_PRINCIPAL_NOT_SENT").toBe(false);

  // An old client that never learned of it is refused server-side.
  const later = w.main.frames.length;
  await w.send({ type: "session_resume", sessionId: "voyage" });
  expect(w.main.frames.slice(later), "RESUME_AFTER_DELETION_REFUSED").toEqual([expect.objectContaining({ type: "error", code: "SESSION_NOT_FOUND", sessionId: "voyage" })]);
  expect(await readSessionRecovery(w.host, "voyage", w.owner), "RECOVERY_REPORTS_ABSENT").toEqual({ kind: "not_found" });
  expect(() => w.host.prepareHistory("voyage", [{ role: "user", content: MARKER, toolCalls: [] }]), "PREPARE_HISTORY_FINAL_GATE").toThrow("This chat has been retired");
});
