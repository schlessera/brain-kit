import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationWorkReceipt } from "@schlessera/brain-ui-sdk/protocol";
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
