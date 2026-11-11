/**
 * Typed chat owner bindings (#3337) through the real host, run loop, bridge,
 * dispatch and file-backed SQLite write worker, then `POST /api/chat-deletions`.
 * A typed request that creates a session binds its authenticated owner, so
 * that owner can delete it; a chat whose session existed before the binding
 * still refuses as unknown ownership, a resume binds nothing, and other
 * principals learn nothing about whether the chat exists. A scripted backend
 * and synthetic Odysseus text only: no model, key or network.
 */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { AppEnv } from "../src/app-env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import type { WSContext } from "../src/ws/clients.js";
import { handleClientMessage as dispatch } from "../src/ws/dispatch.js";
import { WsHost } from "../src/ws/host.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createChatDeletion } from "../src/ws/chat-deletion.js";
import { createChatDeletionRoutes } from "../src/routes/chat-deletions.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization } from "./helpers/principal.js";

const MARKER = "Odysseus hid the oar under the olive root";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeoutMs) throw new Error("until: timed out"); await Bun.sleep(2); }
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-chat-owner-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  const catalog = createSessionCatalog(() => db, undefined, undefined, { writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(db, writer) });
  // Each new typed request opens the next named session; a resume keeps its own.
  const fresh = ["voyage", "scylla"];
  let finished = 0;
  const backend = {
    ...makeFakeBackend({
      id: "fixture",
      capabilities: { historyRemoval: true },
      startTurn: async (req: StartTurnRequest) => {
        const sessionId = req.sessionId ?? fresh.shift()!;
        req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId });
        req.bridge.emit({ type: "result", sessionId, numTurns: 1, durationMs: 1, isError: false, outcome: "success" });
        finished++;
      },
    }),
    async removeSessionHistory() { return { outcome: "removed" as const }; },
  };
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, isPrincipalValid: () => true,
    isPrincipalAuthorized: id => { const current = resolvePrincipal(db, id); return !!current && isUsablePrincipal(current, Date.now()); } });
  const owner = resolvePrincipal(db, createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 86_400 }).id)!;
  const other = createPrincipal(db, { authMethod: "passkey", label: "Penelope tablet", ttlSeconds: 86_400 }).id;
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Mentor agent", createdBy: owner.id, ttlSeconds: 86_400 }).id;
  host.chatDeletion = createChatDeletion({ catalog, backends: async () => [backend], busy: identities => host.chatBusy(identities),
    retired: (principalId, retirement) => host.chatRetired(principalId, retirement) });
  const ws: WSContext = { send: () => {} };
  host.clients.add(ws, owner.id);
  const connection = { principal: owner, authorization: testAuthorization(owner.id) };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { const id = c.req.header("x-odysseus-principal"); const p = id ? resolvePrincipal(db, id) : null; if (p) c.set("principal", p); await next(); });
  app.route("/api", createChatDeletionRoutes({ deletion: host.chatDeletion, principalValid: p => { const current = resolvePrincipal(db, p.id); return !!current && isUsablePrincipal(current, Date.now()); } }));
  cleanups.push(async () => { await host.close(); await catalog.settled!(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    db, catalog, owner, other, agent,
    /** One typed request, through dispatch and the run loop, settled on the writer. */
    async type(text: string, sessionId?: string) {
      const before = finished;
      await dispatch(host, ws, { type: "chat_message", text, attachments: [], ...(sessionId ? { sessionId } : {}) } as ClientMessage, connection);
      await until(() => finished > before && !host.coordinator.isTurnActive() && host.coordinator.bySession.size === 0);
      await catalog.settled!();
    },
    remove: (principalId: string, sessionId: string, operationId = `delete-${sessionId}-${principalId}`) => app.request("/api/chat-deletions", {
      method: "POST", headers: { "content-type": "application/json", "x-odysseus-principal": principalId },
      body: JSON.stringify({ operationId, target: { sessionId }, expected: { backendId: "fixture", generation: 1 } }) }),
  };
}
const bindings = (db: Database) => db.query("SELECT session_id AS sessionId, principal_id AS principalId FROM chat_session_owners ORDER BY session_id").all();

test("a typed chat created now is deletable by its owner; one created before the binding still refuses as unavailable", async () => {
  const w = world();
  // A chat a host recorded before #3337: the same row, with no binding.
  w.db.prepare("INSERT INTO sessions (id, title, created_at, last_active_at, total_cost_usd, num_turns, provider_id, backend_id) VALUES (?,?,?,?,0,1,NULL,?)")
    .run("aeaea", "Ask Circe the way", 1, 1, "fixture");

  await w.type(`Plan the voyage home. ${MARKER}`);
  // Resuming a legacy chat by typing is not creating it: no owner is guessed,
  // whether the host recorded its row before (aeaea) or only the backend
  // holds it (ogygia, a native-only session the host first sees on resume).
  await w.type("Ask Circe again", "aeaea");
  await w.type("Ask Calypso for a raft", "ogygia");
  // Nor does a creator offered for an existing row bind it.
  w.catalog.persistSessionStub("aeaea", "Ask Circe the way", null, "fixture", w.owner.id);
  await w.catalog.settled!();
  // A follow-up on the new chat keeps its single, unchanged owner.
  await w.type("And past the Sirens?", "voyage");
  expect(bindings(w.db), "ONLY_CREATED_SESSIONS_BIND").toEqual([{ sessionId: "voyage", principalId: w.owner.id }]);
  // The binding is content-free and adds no dialogue owner: paging and retention are untouched.
  expect(JSON.stringify(w.db.query("SELECT * FROM chat_session_owners").all()), "BINDING_IS_CONTENT_FREE").not.toContain("voyage home");
  expect(w.db.query("SELECT COUNT(*) AS n FROM dialogue_owners").get(), "NO_DIALOGUE_OWNER_CREATED").toEqual({ n: 0 });
  expect(await w.catalog.dialogueRead!(w.owner.id, { sessionId: "voyage" }), "DIALOGUE_PAGING_UNCHANGED").toEqual(await w.catalog.dialogueRead!(w.owner.id, { sessionId: "aeaea" }));

  for (const sessionId of ["aeaea", "ogygia"]) {
    const legacy = await w.remove(w.owner.id, sessionId);
    expect(legacy.status, "LEGACY_TYPED_CHAT_UNAVAILABLE").toBe(404);
    expect(await legacy.json()).toMatchObject({ error: "CHAT_DELETION_REFUSED", reason: "unavailable" });
  }

  const deleted = await w.remove(w.owner.id, "voyage");
  expect(deleted.status, "NEW_TYPED_CHAT_DELETABLE_BY_OWNER").toBe(200);
  expect(await deleted.json()).toMatchObject({ generation: 2, status: "removed", stores: { native: "removed", dialogue: "removed" } });
  expect(w.db.query("SELECT kind, principal_id AS principalId FROM chat_lifecycles WHERE id='voyage'").get()).toEqual({ kind: "session", principalId: w.owner.id });
  expect(w.db.query("SELECT id FROM chat_lifecycles").all(), "LEGACY_CHATS_NOT_RETIRED").toEqual([{ id: "voyage" }]);
});

test("other principals refuse a bound typed chat exactly as they refuse one that does not exist", async () => {
  const w = world();
  await w.type(`Plan the voyage home. ${MARKER}`);
  await w.type("Steer between Scylla and Charybdis");
  expect(bindings(w.db)).toEqual([{ sessionId: "scylla", principalId: w.owner.id }, { sessionId: "voyage", principalId: w.owner.id }]);

  const foreign = await w.remove(w.other, "voyage");
  const missing = await w.remove(w.other, "nowhere");
  const foreignBody = await foreign.json(), missingBody = await missing.json();
  expect(foreign.status, "FOREIGN_OWNER_UNAVAILABLE").toBe(404);
  expect(foreignBody, "FOREIGN_REFUSAL_LEAKS_NOTHING").toEqual(missingBody);
  expect([missing.status, missingBody.reason]).toEqual([404, "unavailable"]);
  // An agent the owner created holds no owner authority over its chats.
  const agent = await w.remove(w.agent, "voyage");
  expect([agent.status, (await agent.json()).reason], "AGENT_CANNOT_DELETE").toEqual([403, "unauthorized"]);
  expect(w.db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get(), "NOTHING_RETIRED_BY_OTHERS").toEqual({ n: 0 });

  // A binding naming a different principal than a recorded voice owner is ambiguous, never resolved for either.
  await w.catalog.saveConversationEpoch!({ id: "sirens", principalId: w.other, epoch: 1, sessionId: "scylla" });
  await w.catalog.settled!();
  for (const principal of [w.owner.id, w.other]) {
    const conflict = await w.remove(principal, "scylla");
    expect([conflict.status, (await conflict.json()).reason], "CONFLICTING_OWNERS_UNAVAILABLE").toEqual([404, "unavailable"]);
  }

  expect((await w.remove(w.owner.id, "voyage")).status, "OWNER_STILL_DELETES").toBe(200);
});
