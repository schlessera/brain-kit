import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_LIMITS, type DialogueEvidence, type DialoguePage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { DialogueJournal } from "../src/ws/dialogue.js";
import type { DialogueOwner } from "../src/ws/dialogue-storage.js";
import * as controls from "./helpers/dialogue-test-writes.js";

type Queue = { count: number; bytes: number };
function queues(journal: DialogueJournal): Map<DialogueOwner, Queue> {
  // Observe retirement without adding a production diagnostic or admission seam.
  return (journal as unknown as { queues: Map<DialogueOwner, Queue> }).queues;
}
const opening = { conversationId: "ithaca", principalId: "odysseus", epoch: 1, providerId: "gemini-live" };
function evidence(sequence: number, text = "The mast is ready."): Extract<DialogueEvidence, { kind: "voice" }> {
  return { kind: "voice", conversationId: "ithaca", epoch: 1, providerId: "gemini-live", event: {
    kind: "unassigned_input_fragment", sequence, text, timing: { kind: "unavailable" }, finalization: "unknown",
  } };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-queue-adoption-"));
  const db = createUiDb(join(dir, "ui.db")), writer = openSqliteWriter(db);
  const catalog = createSessionCatalog(() => db, undefined, undefined, {
    writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(db, writer),
  });
  const control = writer.channel({ url: controls.url, setup: controls.setup }, {});
  const failures: string[] = [], pages: DialoguePage[] = [];
  const journal = new DialogueJournal(catalog, page => pages.push(page), (_owner, cause) => failures.push(cause));
  const holds: { gate: Int32Array; done: Promise<unknown> }[] = [];
  const release = () => { for (const { gate } of holds) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } };
  return { db, writer, catalog, journal, failures, pages, release,
    async hold() {
      const gate = new Int32Array(new SharedArrayBuffer(8));
      const done = control.call("hold", gate);
      holds.push({ gate, done });
      const deadline = Date.now() + 2000;
      while (!Atomics.load(gate, 1)) {
        if (Date.now() > deadline) throw Error("native writer did not hold");
        await Bun.sleep(1);
      }
      expect(writer.offloop).toBe(true);
    },
    async close() {
      release(); await Promise.all(holds.map(h => h.done)); await journal.settled();
      await catalog.settled!(); await control.close(); await writer.close(); db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const merge of [false, true]) test(`native adoption retires idle queue bookkeeping merge=${merge}`, async () => {
  const f = await fixture();
  try {
    if (merge) {
      await f.catalog.dialogueOpen!({ ...opening, conversationId: "troy", sessionId: "voyage" });
      await f.catalog.dialogueClose!("troy", "odysseus", 1, false);
    }
    const owner = (await f.journal.open(opening))!;
    await f.hold();
    f.journal.bind("ithaca", "odysseus", "voyage");
    const saved: boolean[] = [];
    expect(f.journal.voice("ithaca", evidence(0), value => saved.push(value))).toBe(true);
    expect(owner.id).toBe("ithaca");
    f.release(); await f.journal.settled(true);
    expect(owner.id).toBe(merge ? "troy" : "ithaca");
    expect(saved).toEqual([true]);
    expect(queues(f.journal).size, "DRAINED_QUEUE_RETIRES_AFTER_ADOPTION").toBe(0);
    expect(f.pages[0]!.ownerId).toBe(owner.id);
    expect(f.pages[0]!.records[0]!.evidence).toEqual(evidence(0));
    expect((await f.catalog.dialogueRead!("odysseus", { sessionId: "voyage" }))!.records).toHaveLength(1);
    expect(f.failures).toEqual([]);
    // A new batch has fresh capacity; the bound is never a lifetime capture cap.
    f.journal.voice("ithaca", evidence(1), value => saved.push(value));
    f.journal.close("ithaca", "odysseus", 1);
    await f.journal.settled(true);
    expect(saved).toEqual([true, true]);
    expect(queues(f.journal).size).toBe(0);
    expect(f.db.query("SELECT closed FROM dialogue_conversations WHERE id='ithaca'").get()).toEqual({ closed: 1 });
  } finally { await f.close(); }
});

for (const bound of ["count", "bytes"] as const) test(`native alias adoption cannot split active ${bound} admission`, async () => {
  const f = await fixture();
  let releaseCallbacks!: () => void;
  const callbacks = new Promise<void>(resolve => { releaseCallbacks = resolve; });
  const append = f.catalog.dialogueAppend!;
  // Keep genuinely committed callbacks pending while adoption's acknowledgement
  // changes the shared owner ID. The second hold keeps new native writes pending.
  f.catalog.dialogueAppend = async input => { const row = await append(input); await callbacks; return row; };
  try {
    await f.catalog.dialogueOpen!({ ...opening, conversationId: "troy", sessionId: "voyage" });
    await f.catalog.dialogueClose!("troy", "odysseus", 1, false);
    const owner = (await f.journal.open(opening))!;
    await f.hold(); f.journal.bind("ithaca", "odysseus", "voyage");
    const text = bound === "bytes" ? "船".repeat(2000) : "mast";
    let count = 0, bytes = 0;
    const expected: DialogueEvidence[] = [], saved: boolean[] = [];
    const submit = () => {
      const e = evidence(count++, text); expected.push(e);
      bytes += Buffer.byteLength(JSON.stringify(e));
      expect(f.journal.voice("ithaca", e, value => saved.push(value))).toBe(true);
    };
    // Both halves of this batch must be charged to one stable owner.
    for (let i = 0; i < 100; i++) submit();
    f.release(); await f.catalog.settled!();
    expect(owner.id).toBe("troy");
    await f.hold();
    while (count < CONVERSATION_LIMITS.maxPendingDialogueObservations &&
      bytes + Buffer.byteLength(JSON.stringify(evidence(count, text))) <= CONVERSATION_LIMITS.maxPendingDialogueBytes) submit();
    f.journal.voice("ithaca", evidence(count, text), value => saved.push(value));
    expect(f.failures, "ADOPTION_CANNOT_RESET_PENDING_ADMISSION").toEqual(["queue_pressure"]);
    expect(queues(f.journal).size, "ONE_ACTIVE_QUEUE_ACROSS_ALIAS").toBe(1);
    expect(queues(f.journal).get(owner)).toEqual({ count, bytes });
    if (bound === "count") expect(count).toBe(CONVERSATION_LIMITS.maxPendingDialogueObservations);
    if (bound === "bytes") expect(count).toBeLessThan(CONVERSATION_LIMITS.maxPendingDialogueObservations);
    expect(bytes).toBeLessThanOrEqual(CONVERSATION_LIMITS.maxPendingDialogueBytes);
    f.journal.close("ithaca", "odysseus", 1);
    f.release(); releaseCallbacks(); await f.journal.settled();
    expect(saved).toEqual([...Array(count).fill(true), false]);
    expect(queues(f.journal).size, "PRESSURED_QUEUE_RETIRES").toBe(0);
    expect(f.pages.flatMap(page => page.records).map(row => row.evidence)).toEqual(expected);
    expect(f.db.query("SELECT COUNT(*) AS n FROM dialogue_records").get()).toEqual({ n: count });
    expect(f.db.query("SELECT coverage FROM dialogue_owners").get()).toEqual({ coverage: "partial" });
    expect((await f.catalog.dialogueRead!("odysseus", { sessionId: "voyage" }))!.coverage).toBe("partial");
    await expect(f.journal.settled(true)).rejects.toThrow("pending writes exceeded");
  } finally { f.release(); releaseCallbacks(); await f.close(); }
});
