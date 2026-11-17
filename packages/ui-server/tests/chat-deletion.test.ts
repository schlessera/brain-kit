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
    expect(text, "RECEIPT_CARRIES_NO_TEXT").not.toContain(MARKER);
    expect(text, "RECEIPT_CARRIES_NO_IDENTITIES").not.toContain("ithaca");
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
    expect(body, "HELD_READ_PUBLISHES_NO_MARKER").not.toContain(MARKER);
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
    expect((outcome as { error?: unknown }).error, "STARTUP_SEED_REFUSED_AFTER_RETIREMENT").toBeInstanceOf(ChatRetiredError);
    expect(JSON.stringify(outcome)).not.toContain(MARKER);
  } finally { await f.host.close(); }
});

// ---- GET /api/chat-deletions/:operationId (#3455): a read that adds no authority ----

const read = (app: Hono<AppEnv>, principalId: string | undefined, operationId: string) => app.request(`/api/chat-deletions/${encodeURIComponent(operationId)}`,
  { headers: principalId ? { "x-odysseus-principal": principalId } : {} });
const NOT_ADMITTED = { error: "CHAT_DELETION_NOT_ADMITTED", reason: "not_admitted",
  message: "Nothing is deleted under this operation. A request still on its way can be admitted later." };

/** The catalog with every mutating deletion method counted; reads pass through. */
function counting(catalog: SessionCatalog) {
  const calls = { retireChat: 0, cleanChatStore: 0, recordChatCleanup: 0, chatRetirement: 0 };
  const counted = new Proxy(catalog, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof key !== "string" || !(key in calls) || typeof value !== "function") return value;
    return (...args: unknown[]) => { calls[key as keyof typeof calls]++; return Reflect.apply(value, target, args); };
  } });
  return { counted, calls };
}
const validIn = (db: Database) => (p: { id: string }) => { const current = resolvePrincipal(db, p.id); return !!current && isUsablePrincipal(current, Date.now()); };
const storeRows = (db: Database) => db.query("SELECT lifecycle_id,store,outcome,updated_at FROM chat_retirement_stores ORDER BY lifecycle_id,store").all();

test("the read answers the caller's receipt, and one byte-identical not_admitted for unknown, foreign, refused and non-owner callers", async () => {
  const f = await fixture();
  try {
    const { db } = f.host;
    const { counted, calls } = counting(f.host.catalog);
    const removals: SessionHistoryRemovalRequest[] = [];
    const { deletion } = deletionFor(counted, backend(["removed"], removals));
    const app = routesApp(db, createChatDeletionRoutes({ deletion, principalValid: validIn(db) }));
    const ambient = resolveAmbientPrincipal(db, "tailscale", "odysseus@ithaca.example", "Ithaca tailnet").id;
    expect((await read(app, undefined, "delete-voyage")).status, "READ_UNAUTHENTICATED").toBe(401);
    expect((await read(app, f.owner, "x".repeat(2049))).status, "READ_ID_BOUNDED").toBe(400);

    // Unknown first: nothing is admitted, cleaned or written by asking.
    const unknown = await read(app, f.owner, "delete-voyage");
    const missBytes = await unknown.text();
    expect([unknown.status, unknown.headers.get("cache-control")], "UNKNOWN_IS_NOT_ADMITTED").toEqual([404, "no-store"]);
    expect(JSON.parse(missBytes)).toEqual(NOT_ADMITTED);
    expect({ ...calls, lifecycles: db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get(), removals: removals.length }, "READ_ADMITS_NOTHING")
      .toEqual({ retireChat: 0, cleanChatStore: 0, recordChatCleanup: 0, chatRetirement: 1, lifecycles: { n: 0 }, removals: 0 });

    // The same operation then POSTs exactly like a first POST.
    const posted = await post(app, f.owner, requestBody());
    const receipt = { operationId: "delete-voyage", generation: 2, status: "removed",
      stores: { dialogue: "removed", drafts: "removed", native: "removed", projections: "removed", tasks: "removed" }, retained: RETAINED };
    expect([posted.status, await posted.json()], "POST_AFTER_READ_IS_A_FIRST_POST").toEqual([200, receipt]);
    expect(removals, "POST_AFTER_READ_REMOVES_ONCE").toEqual([{ operationId: "delete-voyage", sessionId: "voyage" }]);

    const own = await read(app, f.owner, "delete-voyage");
    const ownText = await own.text();
    expect([own.status, own.headers.get("cache-control"), JSON.parse(ownText)], "OWNER_READS_ITS_RECEIPT").toEqual([200, "no-store", receipt]);
    expect([MARKER, '"voyage"', "ithaca", "claude", "sessionId"].filter(s => ownText.includes(s)), "RECEIPT_READ_IS_CONTENT_FREE").toEqual([]);

    // A refused attempt records nothing to read.
    expect((await post(app, f.other, requestBody("penelope-attempt"))).status).toBe(404);
    const answers: Record<string, string> = {};
    for (const [label, principal, operation] of [["foreign", f.other, "delete-voyage"], ["agent", f.agent, "delete-voyage"],
      ["ambient", ambient, "delete-voyage"], ["refused", f.other, "penelope-attempt"], ["unknown", f.owner, "never-sent"]] as const) {
      const response = await read(app, principal, operation);
      answers[label] = `${response.status} ${response.headers.get("cache-control")} ${await response.text()}`;
    }
    const miss = `404 no-store ${missBytes}`;
    expect(answers, "EVERY_MISS_IS_BYTE_IDENTICAL").toEqual({ foreign: miss, agent: miss, ambient: miss, refused: miss, unknown: miss });
    expect({ retireChat: calls.retireChat, cleanChatStore: calls.cleanChatStore, removals: removals.length }, "READS_STARTED_NO_CLEANUP")
      .toEqual({ retireChat: 2, cleanChatStore: 4, removals: 1 });
  } finally { await f.host.close(); }
});

test("the read reports unfinished cleanup, never resumes it, survives a restart and shows a retry's progress", async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof open> | undefined;
  try {
    const { db } = f.host;
    db.exec("CREATE TRIGGER hold_dialogue BEFORE DELETE ON dialogue_records BEGIN SELECT RAISE(ABORT,'Ithaca dialogue cleanup interrupted'); END");
    const removals: SessionHistoryRemovalRequest[] = [];
    const { counted, calls } = counting(f.host.catalog);
    const app = routesApp(db, createChatDeletionRoutes({ deletion: deletionFor(counted, backend([new Error("Scylla took the transcript")], removals)).deletion, principalValid: validIn(db) }));
    const first = await (await post(app, f.owner, requestBody())).json();
    expect([first.status, first.stores.dialogue, first.stores.native]).toEqual(["unknown", "partial", "unknown"]);
    db.exec("DROP TRIGGER hold_dialogue");
    const before = { calls: { ...calls }, removals: removals.length, stores: storeRows(db) };
    for (let i = 0; i < 3; i++) expect(await (await read(app, f.owner, "delete-voyage")).json(), "READ_SHOWS_UNFINISHED_CLEANUP").toEqual(first);
    expect({ calls: { ...calls, chatRetirement: before.calls.chatRetirement }, removals: removals.length, stores: storeRows(db) }, "READ_NEVER_RESUMES_CLEANUP").toEqual(before);
    expect(holding(db, MARKER), "UNFINISHED_STORE_STILL_HOLDS_TEXT").toEqual(["dialogue_records.payload"]);
    await f.host.close();

    // A new process, before any reconciliation: the ledger is durable and reading it resumes nothing.
    reopened = open(f.path);
    const later = deletionFor(reopened.catalog, backend(["removed"], removals));
    const restarted = routesApp(reopened.db, createChatDeletionRoutes({ deletion: later.deletion, principalValid: validIn(reopened.db) }));
    expect(await (await read(restarted, f.owner, "delete-voyage")).json(), "READ_AFTER_RESTART").toEqual(first);
    expect({ removals: removals.length, retired: later.retired.length, stores: storeRows(reopened.db) }, "RESTART_READ_RESUMES_NOTHING")
      .toEqual({ removals: 1, retired: 0, stores: before.stores });

    // Retry (the same operation POSTed again) makes progress the read then shows.
    const retried = await (await post(restarted, f.owner, requestBody())).json();
    expect(retried.status, "RETRY_COMPLETES").toBe("removed");
    expect(await (await read(restarted, f.owner, "delete-voyage")).json(), "READ_SHOWS_RETRY_PROGRESS").toEqual(retried);
    expect(holding(reopened.db, MARKER)).toEqual([]);
  } finally { await (reopened ?? f.host).close(); }
});

test("a principal revoked during the read gets 401, never the receipt", async () => {
  const f = await fixture();
  try {
    const { db } = f.host;
    const { deletion } = deletionFor(f.host.catalog, backend(["removed"]));
    await deletion.delete(voyage(f.owner));
    const revoking = { ...deletion, async read(operationId: string, principalId: string) {
      const receipt = await deletion.read(operationId, principalId);
      revokePrincipal(db, f.owner, Date.now());
      return receipt;
    } };
    const app = routesApp(db, createChatDeletionRoutes({ deletion: revoking, principalValid: validIn(db) }));
    const response = await read(app, f.owner, "delete-voyage");
    const text = await response.text();
    expect([response.status, JSON.parse(text)], "REVOKED_MID_READ").toEqual([401, { error: "Authentication required", authRequired: true }]);
    expect(text, "REVOKED_LEARNS_NOTHING").not.toContain("delete-voyage");
    expect(text, "REVOKED_LEARNS_NOTHING").not.toContain("removed");
  } finally { await f.host.close(); }
});
