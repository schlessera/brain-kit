import type { Logger } from "@opentelemetry/api-logs";
import { ATTACHMENT_DIR } from "@schlessera/brain-ui-sdk/protocol";
import type { AwaitableDraftStore } from "../drafts/store.js";
import { describeOrphan, listAttachmentDirs, removePartial, unlinkAttachment } from "./files.js";

/** How often the sweep runs while the server is up (§6.7). */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

type SweepStore = Pick<AwaitableDraftStore, "sweepMark" | "sweepForget">;

/**
 * Delete unreferenced originals in two steps (docs/plans/chat-attachments.md
 * §6.7). Step 1 marks, in one immediate transaction, files with no reference
 * whose window has passed; a marked file can never be bound again, so a
 * rebind that loses the race is refused instead of binding a deleted file.
 * Step 2 unlinks each marked directory and only then forgets its row. A
 * restart between the two finds the `deleting` rows again. If the reference
 * state cannot be read, nothing is deleted: the error propagates.
 */
export async function sweepAttachments(brainRoot: string, store: SweepStore, log?: Logger): Promise<string[]> {
  const marked = await store.sweepMark();
  const gone: string[] = [];
  for (const { fileId, state } of marked) {
    try {
      if (state === "deleting") await unlinkAttachment(brainRoot, fileId);
      gone.push(fileId);
    } catch (error) {
      // Left `deleting`: the next run tries again; it stays charged meanwhile.
      log?.emit({ severityText: "WARN", body: "attachment original could not be removed", attributes: { "attachment.id": fileId, error: error instanceof Error ? error.message : String(error) } });
    }
  }
  if (gone.length) await store.sweepForget(gone);
  return gone;
}

type ReconcileStore = Pick<AwaitableDraftStore, "attachmentInventory" | "markMissing" | "adoptOrphan" | "discardReservations">;

/**
 * Boot reconciliation (§6.6, §6.7): discard reservations and partial uploads
 * of earlier instances, record a row whose directory is gone as `missing`,
 * and adopt a directory with no row as formerly referenced, charged, with a
 * fresh seven-day clock. Neither drift is deleted outright.
 */
export async function reconcileAttachments(brainRoot: string, store: ReconcileStore, instanceId: string, log?: Logger): Promise<{ adopted: string[]; missing: string[] }> {
  await store.discardReservations(instanceId);
  const { published, partials } = await listAttachmentDirs(brainRoot);
  for (const name of partials) await removePartial(brainRoot, name);
  const inventory = new Map(store.attachmentInventory().map((r) => [r.fileId, r.state]));
  const present = new Set(published);
  const missing = [...inventory].filter(([id, state]) => state === "stored" && !present.has(id)).map(([id]) => id);
  if (missing.length) await store.markMissing(missing);
  const adopted: string[] = [];
  for (const id of published) {
    if (inventory.has(id)) continue;
    const orphan = await describeOrphan(brainRoot, id).catch(() => null);
    if (!orphan) {
      log?.emit({ severityText: "WARN", body: `an unrecognized directory under ${ATTACHMENT_DIR} was left in place`, attributes: { "attachment.id": id } });
      continue;
    }
    await store.adoptOrphan(orphan);
    adopted.push(id);
  }
  return { adopted, missing };
}
