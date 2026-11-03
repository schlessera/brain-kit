/**
 * Explicit local chat deletion (#3230) on an actual file-backed SQLite write
 * worker: per-store removal, honest partial/unknown outcomes, restart
 * reconciliation, the authenticated endpoint and the read gates that keep a
 * retired chat absent. Backends are minimal seam doubles; concrete native
 * removal is proven against the installed runtimes in the backend packages.
 * Synthetic Odysseus fixtures only: no provider, network or real transcript.
 */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ChatDeletionRetained, ConversationWorkReceipt, DialogueEvidence, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, SessionHistoryRemovalOutcome, SessionHistoryRemovalRequest } from "@schlessera/brain-ui-sdk/server";
import type { AppEnv } from "../src/app-env.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, isUsablePrincipal, resolveAmbientPrincipal, resolvePrincipal, revokePrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createDraftStore, DraftError } from "../src/drafts/store.js";
import { createSessionCatalog, type SessionCatalog } from "../src/ws/session-catalog.js";
import { ChatRetiredError, type RetiredChatIdentities } from "../src/ws/chat-lifecycle.js";
import { createChatDeletion, type ChatDeletionDeps } from "../src/ws/chat-deletion.js";
import { createChatDeletionRoutes } from "../src/routes/chat-deletions.js";
import { createSessionRoutes } from "../src/routes/sessions.js";
import { readLiveHistory } from "../src/ws/live-history.js";
import type { BackendRegistry } from "../src/agent/backend.js";
import type { WsHost } from "../src/ws/host.js";

const MARKER = "Odysseus hid the oar under the olive root";
const CONTROL = "Penelope kept the loom unfinished";
const UNBOUND = "Telemachus drafted a letter to Nestor";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const capabilities = { resume: true, permissions: true, thinking: true, attachments: true, askUser: true, costReporting: true, concurrentSessions: true, followUp: true };
function backend(outcomes: Array<SessionHistoryRemovalOutcome | Error>, calls: SessionHistoryRemovalRequest[] = [], history: () => Promise<SessionHistoryMessage[]> = async () => []): AgentBackend {
  return { id: "claude", capabilities: { ...capabilities, historyRemoval: true }, async removeSessionHistory(req: SessionHistoryRemovalRequest) {
    calls.push(req);
    const next = outcomes.shift() ?? "removed";
    if (next instanceof Error) throw next;
    return { outcome: next };
  }, async listSessions() { return [{ id: "voyage", title: null, createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 0 }, { id: "aeaea", title: null, createdAt: 1, lastActiveAt: 1, totalCostUsd: 0, numTurns: 0 }]; },
  getHistory: history } as unknown as AgentBackend;
}

function open(path: string) {
  const db = createUiDb(path), writer = openSqliteWriter(db);
  const catalog = createSessionCatalog(() => db, undefined, undefined, { writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(db, writer) });
  return { db, catalog, async close() { await catalog.settled!(); await writer.close(); db.close(); } };
}

function voice(conversationId: string, text: string): DialogueEvidence {
  return { kind: "voice", conversationId, epoch: 1, providerId: "gemini-live", event: {
    kind: "unassigned_input_fragment", sequence: 0, text, timing: { kind: "unavailable" }, finalization: "unknown" } };
}
function task(conversationId: string, sessionId: string, text: string): ConversationWorkReceipt {
  return { conversationId, epoch: 1, provenance: "contextual", taskId: `${conversationId}-task`, requestId: `${conversationId}-request`,
    nativeHandle: `${conversationId}-native`, state: "completed", delivery: "returned", turnId: `${conversationId}-turn`, recognized: text, submitted: text, sessionId };
}

/** Every host copy the selected stores own, each carrying the chat's marker. */
async function seedChat(host: ReturnType<typeof open>, principalId: string, sessionId: string, conversationId: string, text: string) {
  const { catalog, db } = host;
  catalog.persistSessionStub(sessionId, text, null, "claude");
  const owner = await catalog.dialogueOpen!({ conversationId, principalId, epoch: 1, providerId: "gemini-live", sessionId });
  await catalog.dialogueAppend!({ ownerId: owner.id, principalId, generation: owner.generation, identity: `voice:${conversationId}:0`, evidence: voice(conversationId, text) });
  await catalog.saveConversationEpoch!({ id: conversationId, principalId, epoch: 1, sessionId });
  await catalog.saveConversationTask!(principalId, task(conversationId, sessionId, text), text);
  await catalog.settled!();
  const at = Date.now();
  db.prepare("UPDATE sessions SET title=?,label=?,label_source='labeller',total_cost_usd=1.5,num_turns=3 WHERE id=?").run(text, text, sessionId);
  db.prepare("INSERT INTO message_blocks VALUES(?,?,?,?)").run(sessionId, `hash:${text}`, JSON.stringify([{ type: "text", text }]), at);
  db.prepare("INSERT INTO classification_confidence(session_id,pass_id,candidate_id,recorded_at,candidate_kind,question,answer_type,choice,confidence,threshold,cleared,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(sessionId, "p", "c", at, "table", text, "choice", text, 0.9, 0.5, 1, "kept");
  db.prepare("INSERT INTO message_sources(session_id,text_hash,ordinal,source,created_at,turn_id,track_files) VALUES(?,?,?,?,?,?,?)").run(sessionId, `hash:${text}`, 0, "typed", at, "t1", JSON.stringify([text]));
  db.prepare("INSERT INTO local_exchanges(session_id,exchange_id,command,prompt,answer,context,created_at) VALUES(?,?,?,?,?,?,?)").run(sessionId, "x1", "/note", text, text, text, at);
  db.prepare("INSERT INTO retry_requests VALUES(?,?,?,?,?,?)").run(sessionId, "t1", principalId, JSON.stringify({ text }), text, text);
  db.prepare("INSERT INTO retry_receipts VALUES(?,?,?,?)").run(`${sessionId}-retry`, sessionId, principalId, "accepted");
  db.prepare("INSERT INTO turn_failures VALUES(?,?,?,?,?,?)").run(sessionId, "claude", 0, "t1", `digest:${text}`, JSON.stringify({ message: text }));
  db.prepare("INSERT INTO turn_boundaries VALUES(?,?,?,?,?)").run(sessionId, "claude", 0, `digest:${text}`, "t1");
  db.prepare("INSERT INTO session_state_room VALUES(?,?)").run(sessionId, JSON.stringify({ note: text }));
  const drafts = createDraftStore(db);
  drafts.save(principalId, `${sessionId}-draft`, { ifMatch: 0, idempotencyKey: `${sessionId}-save`, sessionId, text, attachmentIds: [] });
  const { attachmentId } = drafts.upload(principalId, `${sessionId}-draft`, { idempotencyKey: `${sessionId}-upload`, mime: "image/png", name: text,
    bytes: new Uint8Array([...PNG, ...new TextEncoder().encode(text)]) });
  drafts.save(principalId, `${sessionId}-draft`, { ifMatch: 1, idempotencyKey: `${sessionId}-save-2`, sessionId, text, attachmentIds: [attachmentId] });
}

/** Every table and column, including BLOBs, that still holds `needle`. */
function holding(db: Database, needle: string): string[] {
  const hits: string[] = [];
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    for (const { name: column } of db.query(`PRAGMA table_info("${name}")`).all() as { name: string }[]) {
      const row = db.query(`SELECT COUNT(*) AS n FROM "${name}" WHERE instr(CAST("${column}" AS BLOB), CAST(? AS BLOB)) > 0`).get(needle) as { n: number };
      if (row.n) hits.push(`${name}.${column}`);
    }
  }
  return hits;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-chat-deletion-")); roots.push(root);
  const path = join(root, "ui.db");
  const host = open(path);
  const owner = createPrincipal(host.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 86_400 }).id;
  const other = createPrincipal(host.db, { authMethod: "passkey", label: "Penelope tablet", ttlSeconds: 86_400 }).id;
  const agent = createPrincipal(host.db, { authMethod: "delegated", label: "Mentor agent", createdBy: owner, ttlSeconds: 86_400 }).id;
  await seedChat(host, owner, "voyage", "ithaca", MARKER);
  await seedChat(host, other, "aeaea", "circe", CONTROL);
  createDraftStore(host.db).save(owner, "unbound-draft", { ifMatch: 0, idempotencyKey: "unbound", sessionId: null, text: UNBOUND, attachmentIds: [] });
  return { root, path, host, owner, other, agent };
}

function deletionFor(catalog: SessionCatalog, native: AgentBackend, overrides: Partial<ChatDeletionDeps> = {}) {
  const retired: Array<{ principalId: string; identities: RetiredChatIdentities }> = [];
  const deletion = createChatDeletion({ catalog, backends: async () => [native], busy: () => false,
    retired: (principalId, retirement) => { retired.push({ principalId, identities: retirement.identities }); }, ...overrides });
  return { deletion, retired };
}
const voyage = (principalId: string, operationId = "delete-voyage") => ({ operationId, principalId, target: { sessionId: "voyage" }, expected: { backendId: "claude", generation: 1 } });
const RETAINED: ChatDeletionRetained[] = ["independent_content", "effects_and_audit", "provider_copies", "backups", "offline_devices"];

test("deletion removes every selected host copy, keeps minimized fences and leaves unrelated chats and drafts intact", async () => {
  const f = await fixture();
  try {
    const { db, catalog } = f.host;
    expect(holding(db, MARKER).length, "MARKER_SEEDED_IN_EVERY_STORE").toBeGreaterThanOrEqual(15);
    const calls: SessionHistoryRemovalRequest[] = [];
    const { deletion, retired } = deletionFor(catalog, backend(["removed"], calls));
    const result = await deletion.delete(voyage(f.owner));
    expect(result).toEqual({ status: "retired", receipt: { operationId: "delete-voyage", generation: 2, status: "removed",
      stores: { dialogue: "removed", drafts: "removed", native: "removed", projections: "removed", tasks: "removed" }, retained: RETAINED } });
    expect(calls, "NATIVE_REMOVED_UNDER_THE_SAME_OPERATION").toEqual([{ operationId: "delete-voyage", sessionId: "voyage" }]);
    expect(retired.map(r => r.principalId), "LIVE_HOLDERS_RETIRED_ONCE").toEqual([f.owner]);
    expect(holding(db, MARKER), "NO_SELECTED_COPY_REMAINS").toEqual([]);
    // The unrelated chat, the unbound draft and the retired chat's accounting stay.
    expect(holding(db, CONTROL).length, "CONTROL_CHAT_INTACT").toBeGreaterThanOrEqual(15);
    expect(holding(db, UNBOUND), "UNBOUND_DRAFT_INTACT").toEqual(["session_drafts.text"]);
    expect(db.query("SELECT total_cost_usd AS cost,num_turns AS turns,backend_id AS backend FROM sessions WHERE id='voyage'").get(), "ACCOUNTING_KEPT")
      .toEqual({ cost: 1.5, turns: 3, backend: "claude" });
    // Minimized replay fences survive without their text.
    expect(db.query("SELECT task_id,request_id,receipt,result_facts FROM conversation_tasks WHERE conversation_id='ithaca'").all(), "TASK_KEYS_STAY_CONSUMED")
      .toEqual([{ task_id: "ithaca-task", request_id: "ithaca-request", receipt: null, result_facts: null }]);
    expect(db.query("SELECT state FROM retry_receipts WHERE request_id='voyage-retry'").get()).toEqual({ state: "accepted" });
    expect(db.query("SELECT kind,id FROM chat_retired_identities ORDER BY kind,id").all()).toEqual([
      { kind: "conversation", id: "ithaca" }, { kind: "dialogue_owner", id: "ithaca" }, { kind: "native_task", id: JSON.stringify(["ithaca", 1, "ithaca-native"]) },
      { kind: "request", id: "ithaca-request" }, { kind: "session", id: "voyage" }, { kind: "task", id: "ithaca-task" }]);
    // Replays refuse: an old task key, a draft save under the retired chat, and the old idempotency key.
    expect(await catalog.saveConversationTask!(f.owner, task("ithaca", "voyage", MARKER), MARKER).then(() => "written", (e: Error) => e.message), "TASK_REPLAY_REFUSED")
      .toBe("This chat has been retired and cannot be used again.");
    const drafts = createDraftStore(db);
    const refusal = (fn: () => unknown) => { try { fn(); return "stored"; } catch (e) { return e instanceof DraftError ? `${e.status} ${e.body.error}` : String(e); } };
    expect(refusal(() => drafts.save(f.owner, "voyage-draft", { ifMatch: 1, idempotencyKey: "voyage-save", sessionId: "voyage", text: MARKER, attachmentIds: [] })), "DRAFT_REPLAY_REFUSED")
      .toBe("410 DRAFT_CHAT_RETIRED");
    expect(refusal(() => drafts.save(f.owner, "new-draft", { ifMatch: 0, idempotencyKey: "new", sessionId: "voyage", text: MARKER, attachmentIds: [] })), "NEW_BOUND_DRAFT_REFUSED")
      .toBe("410 DRAFT_CHAT_RETIRED");
    expect(drafts.list(f.owner).drafts.map(d => d.draftId).sort(), "LISTS_ONLY_LIVE_CHATS").toEqual(["aeaea-draft", "unbound-draft"]);
    expect(holding(db, MARKER), "REFUSED_REPLAYS_WROTE_NOTHING").toEqual([]);
    // A repeat returns the same operation; another key for the same chat reveals nothing.
    expect(await deletion.delete(voyage(f.owner)), "REPEAT_IS_THE_SAME_OPERATION").toEqual(result);
    expect(calls.length, "REPEAT_DOES_NOT_REMOVE_AGAIN").toBe(1);
    expect(await deletion.delete(voyage(f.owner, "another-key"))).toEqual({ status: "refused", reason: "unavailable" });
  } finally { await f.host.close(); }
});

test("unsupported backends, busy work and other principals refuse before anything is retired", async () => {
  const f = await fixture();
  try {
    const { db, catalog } = f.host;
    const unsupported = { ...backend([]), capabilities };
    expect(await deletionFor(catalog, unsupported).deletion.delete(voyage(f.owner)), "UNSUPPORTED_REFUSES").toEqual({ status: "refused", reason: "unsupported" });
    const busy = deletionFor(catalog, backend([]), { busy: identities => identities.sessions.includes("voyage") });
    expect(await busy.deletion.delete(voyage(f.owner)), "BUSY_REFUSES").toEqual({ status: "refused", reason: "busy" });
    const { deletion, retired } = deletionFor(catalog, backend([]));
    expect(await deletion.delete(voyage(f.agent)), "AGENT_REFUSES").toEqual({ status: "refused", reason: "unauthorized" });
    expect(await deletion.delete(voyage(f.other)), "FOREIGN_REFUSES_AS_ABSENT").toEqual({ status: "refused", reason: "unavailable" });
    expect(retired, "NOTHING_RETIRED_LIVE").toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get()).toEqual({ n: 0 });
    expect(holding(db, MARKER).length).toBeGreaterThanOrEqual(15);
  } finally { await f.host.close(); }
});

test("a failed store stays partial or unknown, and restart reconciliation completes it under the same operation", async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof open> | undefined;
  try {
    const { db, catalog } = f.host;
    // The dialogue owner cannot remove its records yet: an interrupted cleanup.
    db.exec("CREATE TRIGGER hold_dialogue BEFORE DELETE ON dialogue_records BEGIN SELECT RAISE(ABORT,'Ithaca dialogue cleanup interrupted'); END");
    const first = await deletionFor(catalog, backend([new Error("Scylla took the transcript")])).deletion.delete(voyage(f.owner));
    expect(first, "UNKNOWN_AND_PARTIAL_ARE_HONEST").toEqual({ status: "retired", receipt: { operationId: "delete-voyage", generation: 2, status: "unknown",
      stores: { dialogue: "partial", drafts: "removed", native: "unknown", projections: "removed", tasks: "removed" }, retained: RETAINED } });
    expect(holding(db, MARKER), "ONLY_THE_FAILED_STORE_HOLDS_TEXT").toEqual(["dialogue_records.payload"]);
    const second = await deletionFor(catalog, backend(["partial"])).deletion.delete(voyage(f.owner));
    expect(second.status === "retired" && second.receipt.stores.native, "NATIVE_PARTIAL_IS_NOT_COMPLETE").toBe("partial");
    expect(second.status === "retired" && second.receipt.status).toBe("partial");
    db.exec("DROP TRIGGER hold_dialogue");
    await f.host.close();
    // A new process: the fences held, and reconciliation finishes the same operation.
    reopened = open(f.path);
    expect(reopened.catalog.chatRetired!({ sessionId: "voyage" }), "FENCE_SURVIVES_RESTART").toBe(true);
    const calls: SessionHistoryRemovalRequest[] = [];
    const { deletion, retired } = deletionFor(reopened.catalog, backend(["removed"], calls));
    await deletion.reconcile();
    expect(calls, "RECONCILED_UNDER_THE_ORIGINAL_OPERATION").toEqual([{ operationId: "delete-voyage", sessionId: "voyage" }]);
    expect(retired.map(r => r.principalId)).toEqual([f.owner]);
    expect(await reopened.catalog.chatRetirement!("delete-voyage", f.owner)).toMatchObject({ cleanup: "removed",
      stores: { dialogue: "removed", drafts: "removed", native: "removed", projections: "removed", tasks: "removed" } });
    expect(holding(reopened.db, MARKER), "RECONCILED_NOTHING_REMAINS").toEqual([]);
    expect(holding(reopened.db, CONTROL).length).toBeGreaterThanOrEqual(15);
    // Nothing left to do: a further reconciliation touches no backend.
    await deletion.reconcile();
    expect(calls.length).toBe(1);
  } finally { await (reopened ?? f.host).close(); }
});

function routesApp(db: Database, ...routes: Hono<AppEnv>[]) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { const id = c.req.header("x-odysseus-principal"); const p = id ? resolvePrincipal(db, id) : null; if (p) c.set("principal", p); await next(); });
  for (const route of routes) app.route("/api", route);
  return app;
}
const post = (app: Hono<AppEnv>, principalId: string | undefined, body: unknown) => app.request("/api/chat-deletions", { method: "POST",
  headers: { "content-type": "application/json", ...(principalId ? { "x-odysseus-principal": principalId } : {}) }, body: JSON.stringify(body) });
const requestBody = (operationId = "delete-voyage") => ({ operationId, target: { sessionId: "voyage" }, expected: { backendId: "claude", generation: 1 } });

test("the endpoint admits only the authenticated owner and answers with content-free categories", async () => {
  const f = await fixture();
  try {
    const { db, catalog } = f.host;
    const { deletion } = deletionFor(catalog, backend([]));
    const app = routesApp(db, createChatDeletionRoutes({ deletion, principalValid: p => { const current = resolvePrincipal(db, p.id); return !!current && isUsablePrincipal(current, Date.now()); } }));
    const ambient = resolveAmbientPrincipal(db, "tailscale", "odysseus@ithaca.example", "Ithaca tailnet").id;
    expect((await post(app, undefined, requestBody())).status, "UNAUTHENTICATED").toBe(401);
    expect((await post(app, f.owner, { operationId: "x", target: { sessionId: "voyage", historyOwnerId: "ithaca" }, expected: { backendId: "claude", generation: 1 } })).status, "AMBIGUOUS_TARGET").toBe(400);
    const refusals = [];
    for (const principal of [f.agent, ambient, f.other]) {
      const response = await post(app, principal, requestBody(`by-${principal}`));
      refusals.push([response.status, (await response.json()).reason]);
    }
    expect(refusals, "AGENT_AMBIENT_FOREIGN_REFUSED").toEqual([[403, "unauthorized"], [403, "unauthorized"], [404, "unavailable"]]);
    const stale = await post(app, f.owner, { ...requestBody(), expected: { backendId: "claude", generation: 5 } });
    expect([stale.status, (await stale.json()).reason]).toEqual([409, "stale"]);
    expect(db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get()).toEqual({ n: 0 });
    const accepted = await post(app, f.owner, requestBody());
    const text = await accepted.text();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({ operationId: "delete-voyage", generation: 2, status: "removed",
      stores: { dialogue: "removed", drafts: "removed", native: "removed", projections: "removed", tasks: "removed" }, retained: RETAINED });
    expect(text.includes(MARKER) || text.includes("ithaca"), "RECEIPT_CARRIES_NO_TEXT_OR_IDENTITIES").toBe(false);
    // Revoked after the retirement: the operation's outcome is not disclosed.
    revokePrincipal(db, f.owner, Date.now());
    expect((await post(app, f.owner, requestBody())).status, "REVOKED_CALLER_LEARNS_NOTHING").toBe(401);
  } finally { await f.host.close(); }
});

test("a session read held across retirement publishes nothing, and lists omit the retired chat", async () => {
  const f = await fixture();
  try {
    const { db, catalog } = f.host;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const native = backend([], [], async () => { reads++; await held; return [{ role: "user", content: MARKER }] as SessionHistoryMessage[]; });
    const registry = { getBackends: async () => [native], getBackendForSession: async () => native } as unknown as BackendRegistry;
    const retired = (target: { sessionId: string } | { ownerId: string }) => catalog.chatRetired!(target);
    const app = routesApp(db, createSessionRoutes({ registry, db, settled: () => catalog.settled!(), retired, prepareHistory: (_, messages) => messages }));
    const reading = app.request("/api/sessions/voyage", { headers: { "x-odysseus-principal": f.owner } });
    while (!reads) await Bun.sleep(1);
    await deletionFor(catalog, native).deletion.delete(voyage(f.owner));
    release();
    const response = await reading;
    const body = await response.text();
    expect(response.status, "HELD_READ_REFUSED_AFTER_RETIREMENT").toBe(404);
    expect(body.includes(MARKER), "HELD_READ_PUBLISHES_NO_MARKER").toBe(false);
    const list = await (await app.request("/api/sessions?includeRetainedConversations=true", { headers: { "x-odysseus-principal": f.owner } })).json();
    expect(list.sessions.map((s: { id: string }) => s.id), "LIST_OMITS_RETIRED").toEqual(["aeaea"]);
  } finally { await f.host.close(); }
});

test("live startup history held across retirement never seeds a provider", async () => {
  const f = await fixture();
  try {
    const { catalog } = f.host;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const native = backend([], [], async () => { reads++; await held; return [{ role: "user", content: MARKER }] as SessionHistoryMessage[]; });
    // The host's own synchronous gate is exercised elsewhere; this one has none, so the startup gate alone must refuse.
    const host = { catalog, historySettled: () => catalog.settled!(), registry: { getBackendForSession: async () => native },
      prepareHistory: (_: string, messages: SessionHistoryMessage[]) => messages } as unknown as WsHost;
    const reading = readLiveHistory(host, f.owner, { sessionId: "voyage" }, () => true).then(seed => ({ seed }), (error: unknown) => ({ error }));
    while (!reads) await Bun.sleep(1);
    await deletionFor(catalog, native).deletion.delete(voyage(f.owner));
    release();
    const outcome = await reading;
    expect("error" in outcome && outcome.error instanceof ChatRetiredError, "STARTUP_SEED_REFUSED_AFTER_RETIREMENT").toBe(true);
    expect(JSON.stringify(outcome).includes(MARKER)).toBe(false);
  } finally { await f.host.close(); }
});
