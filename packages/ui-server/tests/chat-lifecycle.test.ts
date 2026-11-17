/**
 * Chat identity retirement (#3228) on an actual file-backed SQLite write
 * worker. Synthetic Odysseus fixtures only: no provider, backend or network.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationWorkReceipt, DialogueEvidence } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createSessionCatalog, type SessionCatalog } from "../src/ws/session-catalog.js";
import type { RetireChatInput, RetiredChatIdentities } from "../src/ws/chat-lifecycle.js";
import * as controls from "./helpers/dialogue-test-writes.js";

const MARKER = "Odysseus hid the oar under the olive root";
const CONTROL = "Penelope kept the loom unfinished";
const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Resolves once a write procedure has been posted to the real write worker,
 * where it queues behind any hold: the step after it is ordered behind it.
 */
function posted(name: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage")!, send = Worker.prototype.postMessage;
  let seen!: () => void;
  const sent = new Promise<void>(resolve => { seen = resolve; });
  const spy = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: [message: unknown, options?: StructuredSerializeOptions | Transferable[]]) {
    const message = args[0] as { kind?: string; name?: string };
    if (message.kind === "call" && message.name === name) seen();
    return Reflect.apply(send, this, args);
  });
  restores.push(() => { spy.mockRestore(); Object.defineProperty(Worker.prototype, "postMessage", descriptor); });
  return sent;
}

function voice(conversationId: string, sequence: number, text: string): Extract<DialogueEvidence, { kind: "voice" }> {
  return { kind: "voice", conversationId, epoch: 1, providerId: "gemini-live", event: {
    kind: "unassigned_input_fragment", sequence, text, timing: { kind: "unavailable" }, finalization: "unknown" } };
}
function task(conversationId: string, index: number, sessionId?: string): Extract<ConversationWorkReceipt, { provenance: "contextual" }> {
  return { conversationId, epoch: 1, provenance: "contextual", taskId: `${conversationId}-task-${index}`, requestId: `${conversationId}-request-${index}`,
    nativeHandle: `${conversationId}-native-${index}`, state: "completed", delivery: "returned", turnId: `${conversationId}-turn-${index}`,
    recognized: MARKER, submitted: MARKER, ...(sessionId ? { sessionId } : {}) };
}

function open(path: string) {
  const db = createUiDb(path), writer = openSqliteWriter(db);
  const catalog = createSessionCatalog(() => db, undefined, undefined, {
    writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(db, writer),
  });
  const control = writer.channel({ url: controls.url, setup: controls.setup }, {});
  const holds: { gate: Int32Array; done: Promise<unknown> }[] = [];
  return { db, writer, catalog,
    async hold() {
      const gate = new Int32Array(new SharedArrayBuffer(8));
      holds.push({ gate, done: control.call("holdUntilReleased", gate) });
      const deadline = Date.now() + 2000;
      while (!Atomics.load(gate, 1)) { if (Date.now() > deadline) throw Error("Ithaca writer did not hold"); await Bun.sleep(1); }
    },
    release() { for (const { gate } of holds) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } },
    async close() {
      this.release(); await Promise.all(holds.map(h => h.done));
      await catalog.settled!(); await control.close(); await writer.close(); db.close();
    },
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-chat-lifecycle-")); roots.push(root);
  const path = join(root, "ui.db");
  const host = open(path);
  const owner = createPrincipal(host.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 86_400 }).id;
  const other = createPrincipal(host.db, { authMethod: "passkey", label: "Penelope tablet", ttlSeconds: 86_400 }).id;
  const agent = createPrincipal(host.db, { authMethod: "delegated", label: "Mentor agent", createdBy: owner, ttlSeconds: 86_400 }).id;
  await seedChat(host.catalog, owner, "voyage", "ithaca", MARKER);
  await seedChat(host.catalog, other, "aeaea", "circe", CONTROL);
  return { root, path, host, owner, other, agent };
}
async function seedChat(catalog: SessionCatalog, principalId: string, sessionId: string, conversationId: string, text: string) {
  catalog.persistSessionStub(sessionId, "Plan the voyage home", null, "claude");
  const owner = await catalog.dialogueOpen!({ conversationId, principalId, epoch: 1, providerId: "gemini-live", sessionId });
  await catalog.dialogueAppend!({ ownerId: owner.id, principalId, generation: owner.generation, identity: `voice:${conversationId}:0`, evidence: voice(conversationId, 0, text) });
  await catalog.saveConversationEpoch!({ id: conversationId, principalId, epoch: 1, sessionId });
  await catalog.saveConversationTask!(principalId, task(conversationId, 1, sessionId), text);
}
const request = (principalId: string, overrides: Partial<RetireChatInput> = {}): RetireChatInput => ({
  operationId: "retire-voyage", principalId, target: { sessionId: "voyage" },
  expected: { backendId: "claude", generation: 1 }, removableBackends: ["claude"], at: Date.now(), ...overrides,
});
const idle = () => false;
const RETIRED = "This chat has been retired and cannot be used again.";
/** Settle to a comparable value; the writer's errors cross a thread boundary. */
const settle = (p: Promise<unknown>) => p.then(() => "written", (e: Error) => e.message);
const fences = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get() as { n: number }).n;
async function readable(catalog: SessionCatalog, principalId: string, sessionId: string): Promise<string[]> {
  const page = await catalog.dialogueRead!(principalId, { sessionId });
  return (page?.records ?? []).map(r => r.evidence.kind === "voice" && "text" in r.evidence.event ? String(r.evidence.event.text) : "");
}

test("unauthorized, foreign, unknown, stale, unsupported and busy chats refuse before retirement without revealing existence", async () => {
  const f = await fixture();
  try {
    const { catalog, db } = f.host;
    let consulted = 0;
    const busyProbe = (identities: RetiredChatIdentities) => { consulted++; return identities.conversations.includes("ithaca"); };
    expect(await catalog.retireChat!(request(f.agent), idle), "AGENT_CANNOT_RETIRE").toEqual({ status: "refused", reason: "unauthorized" });
    // A foreign owner and a target that does not exist receive the same answer.
    const foreign = await catalog.retireChat!(request(f.other), busyProbe);
    const missing = await catalog.retireChat!(request(f.other, { target: { sessionId: "nowhere" } }), busyProbe);
    expect(foreign, "FOREIGN_REFUSAL_LEAKS_NOTHING").toEqual({ status: "refused", reason: "unavailable" });
    expect(missing).toEqual(foreign);
    expect(consulted, "BUSY_NOT_ASKED_FOR_FOREIGN_CHAT").toBe(0);
    // A typed native-only chat with no recorded owner: ownership is never guessed.
    catalog.persistSessionStub("scheria", "Ask the Phaeacians for a ship", null, "claude");
    await catalog.settled!();
    expect(await catalog.retireChat!(request(f.owner, { target: { sessionId: "scheria" } }), idle), "UNKNOWN_OWNERSHIP_REFUSES").toEqual({ status: "refused", reason: "unavailable" });
    expect(await catalog.retireChat!(request(f.owner, { expected: { backendId: "claude", generation: 2 } }), idle), "STALE_GENERATION_REFUSES").toEqual({ status: "refused", reason: "stale" });
    expect(await catalog.retireChat!(request(f.owner, { expected: { backendId: "pi", generation: 1 } }), idle), "STALE_BACKEND_REFUSES").toEqual({ status: "refused", reason: "stale" });
    expect(await catalog.retireChat!(request(f.owner, { removableBackends: [] }), idle), "UNSUPPORTED_BACKEND_REFUSES").toEqual({ status: "refused", reason: "unsupported" });
    expect(await catalog.retireChat!(request(f.owner), busyProbe), "BUSY_HOLDER_REFUSES").toEqual({ status: "refused", reason: "busy" });
    expect(consulted).toBe(1);
    revokePrincipal(db, f.owner, Date.now());
    expect(await catalog.retireChat!(request(f.owner), idle), "REVOKED_OWNER_REFUSES").toEqual({ status: "refused", reason: "unauthorized" });
    expect(fences(db), "NO_RETIREMENT_AFTER_REFUSAL").toBe(0);
    expect(await readable(catalog, f.owner, "voyage")).toEqual([MARKER]);
  } finally { await f.host.close(); }
});

test("revocation while admission waits on the writer refuses at commit", async () => {
  const f = await fixture();
  try {
    await f.host.hold();
    const submitted = posted("retireChat");
    const pending = f.host.catalog.retireChat!(request(f.owner), idle);
    // Admission passed the preflight and the retirement waits on the held writer.
    await submitted;
    // Another connection, as a revocation request on another worker would be:
    // the held app writer cannot take its turn until the release.
    const other = new Database(f.path); other.exec("PRAGMA busy_timeout = 5000");
    try { revokePrincipal(other, f.owner, Date.now()); } finally { other.close(); }
    f.host.release();
    expect(await pending, "COMMIT_RECHECKS_AUTHORITY").toEqual({ status: "refused", reason: "unauthorized" });
    expect(fences(f.host.db)).toBe(0);
  } finally { await f.host.close(); }
});

test("retirement fences every identity, refuses late writes and keeps unrelated chats and accounting", async () => {
  const f = await fixture();
  try {
    const { catalog, db } = f.host;
    const owner = catalog.dialogueOwnerForSession!("voyage")!;
    const cost = db.query("SELECT id,total_cost_usd,num_turns FROM sessions ORDER BY id").all();
    // Late callbacks already in flight when the retirement is submitted.
    await f.host.hold();
    const submitted = posted("retireChat");
    const retired = catalog.retireChat!(request(f.owner), idle);
    await submitted;
    const late = [
      catalog.dialogueAppend!({ ownerId: owner.id, principalId: f.owner, generation: owner.generation, identity: "voice:ithaca:1", evidence: voice("ithaca", 1, MARKER) }),
      catalog.saveConversationTask!(f.owner, { ...task("ithaca", 1, "voyage"), delivery: "unknown" }, "replaced facts"),
      catalog.saveConversationTask!(f.owner, task("ithaca", 2, "voyage"), MARKER),
      catalog.dialogueOpen!({ conversationId: "ithaca", principalId: f.owner, epoch: 2, providerId: "gemini-live", sessionId: "voyage" }),
      catalog.dialogueOpen!({ conversationId: "troy", principalId: f.owner, epoch: 1, providerId: "gemini-live", sessionId: "voyage" }),
      catalog.saveConversationEpoch!({ id: "ithaca", principalId: f.owner, epoch: 2 }),
    ].map(settle);
    const control = catalog.dialogueAppend!({ ownerId: "circe", principalId: f.other, generation: 1, identity: "voice:circe:1", evidence: voice("circe", 1, CONTROL) });
    f.host.release();
    const result = await retired;
    expect(result).toMatchObject({ status: "retired", lifecycleId: "voyage", operationId: "retire-voyage", generation: 2, cleanup: "pending",
      stores: { native: "pending", dialogue: "pending", tasks: "pending", projections: "pending", drafts: "pending" } });
    if (result.status !== "retired") throw Error("unreachable");
    expect(result.identities).toEqual({ sessions: ["voyage"], dialogueOwners: ["ithaca"], conversations: ["ithaca"],
      tasks: ["ithaca-task-1"], requests: ["ithaca-request-1"], nativeTasks: [JSON.stringify(["ithaca", 1, "ithaca-native-1"])] });
    const outcomes = await Promise.all(late);
    expect(outcomes, "LATE_WRITES_REFUSED").toEqual(Array(6).fill(RETIRED));
    await control;
    // No content was written or replaced under the retired identity.
    expect(db.query("SELECT COUNT(*) AS n FROM dialogue_records WHERE owner_id='ithaca'").get()).toEqual({ n: 1 });
    expect(db.query("SELECT receipt IS NOT NULL AS kept, result_facts FROM conversation_tasks WHERE task_id='ithaca-task-1'").get()).toEqual({ kept: 1, result_facts: MARKER });
    expect(db.query("SELECT COUNT(*) AS n FROM conversation_tasks WHERE conversation_id='ithaca'").get()).toEqual({ n: 1 });
    // Readers treat it as absent; the unrelated chat is intact.
    expect(await readable(catalog, f.owner, "voyage"), "RETIRED_READS_ABSENT").toEqual([]);
    expect(await catalog.loadConversation!("ithaca", f.owner)).toBeNull();
    expect(catalog.dialogueOwnerForSession!("voyage")).toBeNull();
    expect(catalog.chatRetired!({ sessionId: "voyage" })).toBe(true);
    expect(catalog.chatRetired!({ sessionId: "aeaea" })).toBe(false);
    expect(await readable(catalog, f.other, "aeaea")).toEqual([CONTROL, CONTROL]);
    expect((await catalog.loadConversation!("circe", f.other))?.results).toEqual([{ requestId: "circe-request-1", facts: CONTROL }]);
    expect(db.query("SELECT id,total_cost_usd,num_turns FROM sessions ORDER BY id").all(), "ACCOUNTING_UNCHANGED").toEqual(cost);
    // Retirement is not deletion: content stays for its owners to remove, and nothing claims completion.
    expect(db.query("SELECT COUNT(*) AS n FROM dialogue_records WHERE payload LIKE ?").get(`%${MARKER}%`)).toEqual({ n: 1 });
    // The same key is the same operation; a new key or another principal learns nothing.
    expect(await catalog.retireChat!(request(f.owner), idle)).toEqual(result);
    expect(await catalog.retireChat!(request(f.owner, { operationId: "retire-again" }), idle)).toEqual({ status: "refused", reason: "unavailable" });
    expect(await catalog.retireChat!(request(f.other), idle)).toEqual({ status: "refused", reason: "unavailable" });
    expect(await catalog.chatRetirement!("retire-voyage", f.other)).toBeNull();
    // Cleanup outcomes are durable and honest: only every store confirming removal completes.
    expect(await catalog.recordChatCleanup!("voyage", "native", "partial")).toBe("partial");
    expect(await catalog.recordChatCleanup!("voyage", "native", "unknown")).toBe("unknown");
    for (const store of ["native", "dialogue", "tasks", "projections"] as const) await catalog.recordChatCleanup!("voyage", store, "removed");
    expect(await catalog.recordChatCleanup!("voyage", "projections", "removed"), "PENDING_STORE_IS_NOT_COMPLETION").toBe("pending");
    expect(await catalog.recordChatCleanup!("voyage", "drafts", "removed")).toBe("removed");
    expect(await catalog.recordChatCleanup!("voyage", "native", "unknown"), "REMOVAL_IS_FINAL").toBe("removed");
    expect(() => db.exec("DELETE FROM chat_retired_identities"), "FENCES_ARE_PERMANENT").toThrow("permanent");
  } finally { await f.host.close(); }
});

test("fences survive content cascades and restart; consumed identities never execute again", async () => {
  const f = await fixture();
  let host: ReturnType<typeof open> | undefined;
  try {
    expect((await f.host.catalog.retireChat!(request(f.owner), idle)).status).toBe("retired");
    // What later content owners may remove, including the cascading task ledger.
    f.host.db.exec(`DELETE FROM conversation_epochs WHERE id='ithaca';
      DELETE FROM dialogue_records WHERE owner_id='ithaca'; DELETE FROM dialogue_conversations WHERE owner_id='ithaca';
      DELETE FROM dialogue_owners WHERE id='ithaca'; DELETE FROM sessions WHERE id='voyage'`);
    expect(f.host.db.query("SELECT COUNT(*) AS n FROM conversation_tasks WHERE conversation_id='ithaca'").get()).toEqual({ n: 0 });
    await f.host.close();
    host = open(f.path);
    {
      const { catalog } = host;
      // Without the fence each of these would succeed against the scrubbed rows.
      await catalog.saveConversationEpoch!({ id: "odyssey-new", principalId: f.owner, epoch: 1 });
      expect(await settle(catalog.saveConversationTask!(f.owner, { ...task("odyssey-new", 8), taskId: "ithaca-task-1" })), "CONSUMED_TASK_NEVER_REPLAYS").toBe(RETIRED);
      expect(await settle(catalog.saveConversationTask!(f.owner, { ...task("odyssey-new", 9), requestId: "ithaca-request-1" })), "CONSUMED_REQUEST_NEVER_REPLAYS").toBe(RETIRED);
      expect(await settle(catalog.saveConversationEpoch!({ id: "ithaca", principalId: f.owner, epoch: 1 }))).toBe(RETIRED);
      expect(await settle(catalog.dialogueOpen!({ conversationId: "ithaca", principalId: f.owner, epoch: 1, providerId: "gemini-live" }))).toBe(RETIRED);
      expect(await settle(catalog.dialogueOpen!({ conversationId: "troy", principalId: f.owner, epoch: 1, providerId: "gemini-live", sessionId: "voyage" })), "RETIRED_SESSION_NEVER_REOPENS").toBe(RETIRED);
      expect(await catalog.loadConversation!("odyssey-new", f.owner)).toMatchObject({ requestIds: [] });
      // The session accepts no new revision, retry or projection, and its scrubbed row is not recreated.
      const accepted: boolean[] = [];
      catalog.acceptWork!("voyage", "request-after", "claude", stored => accepted.push(stored));
      catalog.acceptWork!("aeaea", "request-control", "claude", stored => accepted.push(stored));
      catalog.persistSessionStub("voyage", MARKER, null, "claude");
      expect(await settle(catalog.reserveRetry!("voyage", "voyage-turn", "retry-after", f.owner)), "RETIRED_SESSION_NEVER_RETRIES").toBe(RETIRED);
      await catalog.settled!();
      expect(accepted, "RETIRED_SESSION_ACCEPTS_NO_REVISION").toEqual([false, true]);
      expect(host.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id='voyage'").get(), "RETIRED_SESSION_ROW_NOT_RECREATED").toEqual({ n: 0 });
      expect(await readable(catalog, f.other, "aeaea")).toEqual([CONTROL]);
      expect(await catalog.chatRetirement!("retire-voyage", f.owner)).toMatchObject({ status: "retired", generation: 2, cleanup: "pending" });
    }
  } finally { await (host ?? f.host).close(); }
});

for (const order of ["adoption-first", "retirement-first"] as const) test(`racing adoption is decided on one side of the retirement (${order})`, async () => {
  const f = await fixture();
  try {
    const { catalog } = f.host;
    // A provisional chat (no backend session yet) about to be adopted into voyage.
    const provisional = await catalog.dialogueOpen!({ conversationId: "ogygia", principalId: f.owner, epoch: 1, providerId: "gemini-live" });
    await catalog.dialogueAppend!({ ownerId: provisional.id, principalId: f.owner, generation: 1, identity: "voice:ogygia:0", evidence: voice("ogygia", 0, MARKER) });
    await f.host.hold();
    let bound: Promise<string>, retired: ReturnType<NonNullable<SessionCatalog["retireChat"]>>;
    if (order === "adoption-first") {
      bound = settle(catalog.dialogueBind!("ogygia", f.owner, "voyage"));
      retired = catalog.retireChat!(request(f.owner), idle);
    } else {
      const submitted = posted("retireChat");
      retired = catalog.retireChat!(request(f.owner), idle);
      await submitted;
      bound = settle(catalog.dialogueBind!("ogygia", f.owner, "voyage"));
    }
    f.host.release();
    const result = await retired;
    if (result.status !== "retired") throw Error(`not retired: ${JSON.stringify(result)}`);
    if (order === "adoption-first") {
      expect(await bound).toBe("written");
      expect(result.identities.conversations, "EARLIER_ADOPTION_EXPANDS_SET").toEqual(["ithaca", "ogygia"]);
      expect(result.identities.dialogueOwners).toEqual(["ithaca", "ogygia"]);
      expect(await settle(catalog.dialogueOpen!({ conversationId: "calypso", principalId: f.owner, epoch: 1, providerId: "gemini-live", historyOwnerId: "ogygia" })),
        "ADOPTED_ALIAS_NEVER_REOPENS").toBe(RETIRED);
    } else {
      expect(await bound, "LATER_ADOPTION_REFUSED").toBe(RETIRED);
      expect(result.identities.conversations).toEqual(["ithaca"]);
      // The provisional chat stays its owner's own separate, unretired chat.
      expect(catalog.dialogueOwnerForId!("ogygia", f.owner)).toMatchObject({ id: "ogygia", session_id: null, generation: 1 });
      expect((await catalog.dialogueRead!(f.owner, { ownerId: "ogygia" }))?.records).toHaveLength(1);
    }
  } finally { await f.host.close(); }
});

test("a provisional chat retires by its owner identity without a native store", async () => {
  const f = await fixture();
  try {
    const { catalog } = f.host;
    await catalog.dialogueOpen!({ conversationId: "ogygia", principalId: f.owner, epoch: 1, providerId: "gemini-live" });
    const result = await catalog.retireChat!(request(f.owner, { operationId: "retire-ogygia", target: { ownerId: "ogygia" }, expected: { backendId: null, generation: 1 }, removableBackends: [] }), idle);
    expect(result).toMatchObject({ status: "retired", lifecycleId: "ogygia", stores: { dialogue: "pending", tasks: "pending", projections: "pending", drafts: "pending" } });
    if (result.status === "retired") expect(result.stores.native).toBeUndefined();
    expect(await settle(catalog.recordChatCleanup!("ogygia", "native", "removed"))).toContain("not selected");
    expect(await settle(catalog.dialogueBind!("ogygia", f.owner, "voyage"))).toContain("retired");
    expect(await catalog.dialogueRead!(f.owner, { ownerId: "ogygia" })).toBeNull();
    // An adopted provisional ID is now the session's chat: the reviewed target is stale, for its owner only.
    await catalog.dialogueOpen!({ conversationId: "calypso", principalId: f.owner, epoch: 1, providerId: "gemini-live" });
    await catalog.dialogueBind!("calypso", f.owner, "voyage");
    const adopted = request(f.owner, { operationId: "retire-calypso", target: { ownerId: "calypso" }, expected: { backendId: null, generation: 1 } });
    expect(await catalog.retireChat!(adopted, idle)).toEqual({ status: "refused", reason: "stale" });
    expect(await catalog.retireChat!({ ...adopted, principalId: f.other }, idle)).toEqual({ status: "refused", reason: "unavailable" });
  } finally { await f.host.close(); }
});

async function inbox(args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/bin/brain-ui-inbox.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { value: JSON.parse(out) as { ok: boolean }, err, code };
}
test("a post-retirement backup restores its fences; an older backup restores text, the accepted recovery-point limit", async () => {
  const f = await fixture();
  const brain = join(f.root, "brain"); mkdirSync(brain);
  const before = join(f.root, "before.json"), after = join(f.root, "after.json");
  await f.host.close();
  expect(await inbox(["export", "--db", f.path, "--brain-root", brain, "--file", before, "--json"])).toMatchObject({ code: 0, err: "", value: { ok: true } });
  let host = open(f.path);
  try { expect((await host.catalog.retireChat!(request(f.owner), idle)).status).toBe("retired"); }
  finally { await host.close(); }
  expect(await inbox(["export", "--db", f.path, "--brain-root", brain, "--file", after, "--json"])).toMatchObject({ code: 0, err: "", value: { ok: true } });
  const restore = async (file: string, name: string) => {
    const dir = join(f.root, name), target = join(dir, "brain"); mkdirSync(target, { recursive: true });
    expect(await inbox(["restore", "--db", join(dir, "ui.db"), "--brain-root", target, "--file", file, "--json"])).toMatchObject({ code: 0, err: "", value: { ok: true } });
    return join(dir, "ui.db");
  };
  host = open(await restore(after, "after"));
  try {
    const { catalog } = host;
    expect(catalog.chatRetired!({ sessionId: "voyage" }), "POST_RETIREMENT_IMAGE_KEEPS_FENCES").toBe(true);
    expect(await readable(catalog, f.owner, "voyage")).toEqual([]);
    expect(await settle(catalog.saveConversationTask!(f.owner, task("ithaca", 1, "voyage")))).toContain("retired");
    expect(await settle(catalog.dialogueOpen!({ conversationId: "ithaca", principalId: f.owner, epoch: 2, providerId: "gemini-live" }))).toContain("retired");
    expect(await readable(catalog, f.other, "aeaea")).toEqual([CONTROL]);
  } finally { await host.close(); }
  host = open(await restore(before, "before"));
  try {
    // Disclosed limitation, not a no-resurrection result: the older image predates the fence.
    expect(host.catalog.chatRetired!({ sessionId: "voyage" })).toBe(false);
    expect(await readable(host.catalog, f.owner, "voyage"), "OLDER_IMAGE_RESTORES_TEXT").toEqual([MARKER]);
  } finally { await host.close(); }
});
