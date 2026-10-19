/** Real filesystem/journal/gate harness; the evaluation boundary is replaced at its shared request method. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectStorageAttachmentFacts } from "@schlessera/brain/storage";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../../src/db/client.js";
import { createTurnJournal } from "../../src/brain/turn-journal.js";
import { createWriterGate } from "../../src/brain/writer-gate.js";
import { createStorageCoordinator } from "../../src/storage/coordinator.js";
import { createStorageRemoval } from "../../src/storage/removal.js";
import type { BrainExecution, HostBoundary } from "../../src/brain/host-boundary.js";
import { createNativeJournalFixture } from "./native-journal-fixture.js";

export function storageRemovalFixture(existingRoot?: string, journalOptions: { capBytes?: number; now?: () => number } = {}) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "odysseus-removal-")), brain = join(root, "brain"), dbPath = join(root, "ui.db");
  mkdirSync(join(brain, "attachments"), { recursive: true });
  const original = Buffer.from([37, 80, 68, 70, 0, 255, 13, 10]);
  if (!existingRoot) { writeFileSync(join(brain, "attachments/chart.pdf"), original); writeFileSync(join(brain, "attachments/score.pdf"), original); writeFileSync(join(brain, "voyage.md"), "[Harbor](attachments/chart.pdf)\n"); }
  const db = createUiDb(dbPath), native = createNativeJournalFixture(brain, root), journal = createTurnJournal(db, { brainPath: brain, dbPath, objectsRoot: join(root, "objects"), nativeManager: native.manager, ...journalOptions }), gate = createWriterGate(db, brain, { pollMs: 1 });
  let allowed = true; const authorized = (principal: string) => allowed && principal === "odysseus";
  const calls: BrainExecution[] = [];
  const boundary = { isolated: () => true, status: () => ({ hostExecution: "worker", available: true, profile: "strict", protectedPaths: [], identity: "shared_uid", configurationView: "startup" }), async run(execution: BrainExecution) {
    calls.push(execution); execution.assertAuthorized?.(); execution.signal?.throwIfAborted();
    const request = JSON.parse(execution.stdin!) as {op: string; paths?: string[]};
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(request.op === "storage-facts" ? { ok: true, facts: inspectStorageAttachmentFacts(brain, request.paths!, execution.signal) } : { ok: true }) };
  } } satisfies Pick<HostBoundary, "isolated" | "status" | "run">;
  const storage = createStorageCoordinator({ brainPath: brain, stores: [{path:join(root,"objects"),label:"Retained history",category:"journal",owner:"app",recursive:true}], authorized });
  const options = { brainPath: brain, boundary, journal, gate, lock: createKeyedLock(), storage, authorized, protectedPaths: [] as string[] };
  const removal = createStorageRemoval(db, options);
  return { root, brain, dbPath, original, db, native, journal, gate, storage, options, removal, calls, revoke() { allowed = false; }, allow() { allowed = true; }, async close() { await removal.close(); await storage.close(); await journal.close(); await native.close(); db.close(); if (!existingRoot) rmSync(root, {recursive:true,force:true}); } };
}
