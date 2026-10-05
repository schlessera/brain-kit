import type { Database } from "bun:sqlite";

import { createInboxStore } from "../inbox/store.js";

/**
 * Drop every Queue item still waiting for a claim on this task's ended
 * occurrences (cancelled, expired, failed or unknown), in the caller's
 * transaction. A claimed item is left alone: admission refuses to start it.
 */
export function dropUnstartedItems(db: Database, taskId: string, at: number): void {
  const store = createInboxStore(db, { now: () => at });
  const rows = db.query(`SELECT l.item_id FROM schedule_occurrence_items l
    JOIN schedule_occurrences o ON o.id = l.occurrence_id
    JOIN inbox_items i ON i.id = l.item_id
    WHERE o.task_id = ? AND o.state IN ('cancelled', 'expired', 'failed', 'unknown')
      AND i.deleted_at IS NULL AND i.status IN ('scheduled', 'ready', 'failed')
    ORDER BY l.item_id`).all(taskId) as { item_id: string }[];
  for (const { item_id } of rows) {
    const item = store.getItem(item_id)!;
    store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "dropped" }]);
  }
}
