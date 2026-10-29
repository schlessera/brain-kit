import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationWorkReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import { MAX_RETAINED_RESULT_CHARS } from "../src/ws/conversation-storage";
import { createUiDb } from "../src/db/client.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";

const task = (index: number): Extract<ConversationWorkReceipt, { provenance: "contextual" }> => ({ conversationId: "ithaca", epoch: 1, provenance: "contextual", taskId: `task-${index}`, requestId: `request-${index}`, nativeHandle: `native-${index}`, state: "queued", delivery: "pending", recognized: "Find the note.", submitted: "Find the note from uncertain conversation context." });
test("file-backed host identity precedes dispatch and restart exposes unknown work without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-context-storage-"));
  let db = createUiDb(join(root, "ui.db"));
  try {
    let catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    await catalog.saveConversationTask!("odysseus", task(1));
    db.close(); db = createUiDb(join(root, "ui.db")); catalog = createSessionCatalog(() => db);
    expect(await catalog.loadConversation!("ithaca", "other")).toBeNull();
    const recovered = await catalog.loadConversation!("ithaca", "odysseus");
    expect(recovered?.requestIds).toEqual(["request-1"]);
    expect(recovered?.receipts[0]).toMatchObject({ provenance: "contextual", taskId: "task-1", state: "unknown", delivery: "unknown" });
    expect(recovered?.receipts[0]?.reason).toContain("will not be replayed");
    await expect(catalog.saveConversationTask!("odysseus", { ...task(2), nativeHandle: "native-1" })).rejects.toThrow("already consumed");
    await expect(catalog.saveConversationTask!("other", task(2))).rejects.toThrow("ownership");
    await catalog.saveConversationTask!("odysseus", { ...task(1), state: "completed", delivery: "pending", turnId: "host-turn", sessionId: "voyage" });
    const completed = await catalog.loadConversation!("ithaca", "odysseus");
    expect(completed?.sessionId).toBe("voyage");
    expect(completed?.receipts[0]).toMatchObject({ state: "completed", delivery: "unknown" });
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 3 });
    expect((await catalog.loadConversation!("ithaca", "odysseus"))?.epoch).toBe(3);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("receipt eviction preserves native and request tombstones", async () => {
  const db = createUiDb(":memory:");
  try {
    const catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    for (let i = 0; i < 66; i++) await catalog.saveConversationTask!("odysseus", { ...task(i), state: "completed", delivery: "returned" });
    const recovered = await catalog.loadConversation!("ithaca", "odysseus");
    expect(recovered?.requestIds).toHaveLength(66);
    expect(recovered?.receipts).toHaveLength(64);
    expect(recovered?.receipts.some(r => r.requestId === "request-0")).toBe(false);
    await expect(catalog.saveConversationTask!("odysseus", { ...task(100), nativeHandle: "native-0" })).rejects.toThrow("already consumed");
  } finally { db.close(); }
});

test("corrupt stored identity refuses recovery instead of attaching another task", async () => {
  const db = createUiDb(":memory:");
  try {
    const catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    await catalog.saveConversationTask!("odysseus", task(1));
    db.prepare("UPDATE conversation_tasks SET receipt=? WHERE request_id=?").run(JSON.stringify({ ...task(1), taskId: "another-task" }), "request-1");
    await expect(catalog.loadConversation!("ithaca", "odysseus")).rejects.toThrow("inconsistent");
  } finally { db.close(); }
});


test("completed facts survive file-backed recovery with unknown delivery and old nullable rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-result-storage-"));
  let db = createUiDb(join(root, "ui.db"));
  try {
    let catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    await catalog.saveConversationTask!("odysseus", { ...task(1), state: "completed", turnId: "turn-1" }, "The signal is a bronze owl.");
    await catalog.saveConversationTask!("odysseus", { ...task(2), state: "completed", turnId: "turn-2", delivery: "returned" });
    // Old hosts stored no result column. No backend history is consulted.
    expect(db.query("SELECT result_facts FROM conversation_tasks WHERE request_id='request-2'").get()).toEqual({ result_facts: null });
    db.close(); db = createUiDb(join(root, "ui.db")); catalog = createSessionCatalog(() => db);
    const recovered = await catalog.loadConversation!("ithaca", "odysseus");
    expect(recovered?.results).toEqual([{ requestId: "request-1", facts: "The signal is a bronze owl." }]);
    expect(recovered?.receipts[0]).toMatchObject({ state: "completed", delivery: "unknown" });
    expect(await catalog.loadConversation!("ithaca", "other")).toBeNull();
    await catalog.saveConversationEpoch!({ id: "troy", principalId: "odysseus", epoch: 1 });
    expect((await catalog.loadConversation!("troy", "odysseus"))?.results).toEqual([]);
    await expect(catalog.saveConversationTask!("odysseus", { ...task(3), nativeHandle: "native-1", state: "completed", turnId: "turn-3" }, "Foreign facts.")).rejects.toThrow("already consumed");
    // Reusing a native id in a later epoch keeps distinct host identities.
    await catalog.saveConversationTask!("odysseus", { ...task(3), epoch: 2, nativeHandle: "native-1", state: "completed", turnId: "turn-3", delivery: "discarded" }, "The sail is blue.");
    expect((await catalog.loadConversation!("ithaca", "odysseus"))?.results).toHaveLength(2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("durable result bounds evict oldest admissions without deleting identity tombstones", async () => {
  const db = createUiDb(":memory:");
  try {
    const catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    for (let i = 0; i < 6; i++) await catalog.saveConversationTask!("odysseus", { ...task(i), state: "completed", delivery: "unknown", turnId: `turn-${i}` }, String(i).repeat(CONVERSATION_LIMITS.maxFactChars + 50));
    let recovered = await catalog.loadConversation!("ithaca", "odysseus");
    expect(recovered?.results.map(r => r.requestId)).toEqual(["request-2", "request-3", "request-4", "request-5"]);
    expect(recovered?.results.reduce((n, r) => n + r.facts.length, 0)).toBe(MAX_RETAINED_RESULT_CHARS);
    // A late delivery update cannot restore evicted old facts or reorder them.
    await catalog.saveConversationTask!("odysseus", { ...task(0), state: "completed", delivery: "returned", turnId: "turn-0" }, "Evicted facts.");
    recovered = await catalog.loadConversation!("ithaca", "odysseus");
    expect(recovered?.results.some(r => r.requestId === "request-0")).toBe(false);
    expect(recovered?.requestIds).toHaveLength(6);
    await catalog.saveConversationTask!("odysseus", { ...task(8), state: "error", delivery: "discarded", turnId: "turn-8", reason: "Could not read." }, "Partial output must not imply success.");
    expect((await catalog.loadConversation!("ithaca", "odysseus"))?.results.some(r => r.requestId === "request-8")).toBe(false);
  } finally { db.close(); }
});


test("the result migration upgrades a real legacy database without inventing facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-legacy-results-"));
  let db = createUiDb(join(root, "ui.db"));
  try {
    const catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    await catalog.saveConversationTask!("odysseus", { ...task(1), state: "completed", delivery: "returned", turnId: "turn-1" });
    // Reconstruct the exact pre-070 table shape and migration ledger, retaining
    // the existing completed row. Reopening must run the shipped migration.
    db.exec("ALTER TABLE conversation_tasks DROP COLUMN result_facts");
    db.exec("DELETE FROM _migrations WHERE filename='070_conversation_result_facts.sql'");
    db.close(); db = createUiDb(join(root, "ui.db"));
    const upgraded = createSessionCatalog(() => db);
    expect((await upgraded.loadConversation!("ithaca", "odysseus"))?.results).toEqual([]);
    expect((await upgraded.loadConversation!("ithaca", "odysseus"))?.receipts[0]).toMatchObject({ state: "completed", delivery: "returned" });
    await upgraded.saveConversationTask!("odysseus", { ...task(2), state: "completed", delivery: "discarded", turnId: "turn-2" }, "The signal is a bronze owl.");
    expect((await upgraded.loadConversation!("ithaca", "odysseus"))?.results).toEqual([{ requestId: "request-2", facts: "The signal is a bronze owl." }]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});


test("delivery-only writes cannot replace completed facts or reattach them to another turn", async () => {
  const db = createUiDb(":memory:");
  try {
    const catalog = createSessionCatalog(() => db);
    await catalog.saveConversationEpoch!({ id: "ithaca", principalId: "odysseus", epoch: 1 });
    const completed = { ...task(1), state: "completed" as const, turnId: "turn-1" };
    await catalog.saveConversationTask!("odysseus", completed, "The signal is a bronze owl.");
    await catalog.saveConversationTask!("odysseus", { ...completed, delivery: "unknown" }, "A late paraphrase.");
    expect((await catalog.loadConversation!("ithaca", "odysseus"))?.results).toEqual([{ requestId: "request-1", facts: "The signal is a bronze owl." }]);
    await expect(catalog.saveConversationTask!("odysseus", { ...completed, turnId: "another-turn" }, "Foreign facts.")).rejects.toThrow("turn identity");
  } finally { db.close(); }
});
