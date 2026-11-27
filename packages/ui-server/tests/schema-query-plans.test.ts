/** Lookups on append-only tables search an index, and no index repeats another (#4798). */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createUiDb } from "../src/db/client.js";

/** Each statement as its call site issues it, with the table that must not be scanned. */
const LOOKUPS: Array<{ table: string; sql: string; params: unknown[] }> = [
  // `unfinished` and `unclosed`, ws/dialogue-storage.ts
  { table: "dialogue_conversations", sql: "SELECT id,epoch,provider_id FROM dialogue_conversations WHERE owner_id=? AND closed=0 LIMIT ?", params: ["ithaca", 2] },
  { table: "dialogue_conversations", sql: "SELECT id,epoch FROM dialogue_conversations WHERE owner_id=? AND closed=0 LIMIT ?", params: ["ithaca", 2] },
  // Owner merge (ws/dialogue-storage.ts) and the owner walk (ws/chat-lifecycle.ts)
  { table: "dialogue_conversations", sql: "SELECT id FROM dialogue_conversations WHERE owner_id=?", params: ["ithaca"] },
  { table: "dialogue_conversations", sql: "UPDATE dialogue_conversations SET owner_id=? WHERE owner_id=?", params: ["ithaca", "ogygia"] },
  { table: "dialogue_aliases", sql: "SELECT id FROM dialogue_aliases WHERE owner_id=?", params: ["ithaca"] },
  { table: "dialogue_aliases", sql: "UPDATE dialogue_aliases SET owner_id=? WHERE owner_id=?", params: ["ithaca", "ogygia"] },
  // `executed` and `approver`, inbox/dispatcher.ts
  { table: "inbox_budget_reservations", sql: "SELECT 1 FROM inbox_budget_reservations WHERE item_id = ? AND purpose IN ('execute', 'retry') LIMIT 1", params: ["loom"] },
  { table: "inbox_resolutions", sql: "SELECT item_id, option_id, principal_id FROM inbox_resolutions WHERE thread_id = ?", params: ["shroud"] },
  // inbox/interactive-share-writes.ts
  { table: "inbox_interactive_shares", sql: "SELECT * FROM inbox_interactive_shares WHERE run_id = ?", params: ["voyage"] },
  { table: "inbox_interactive_shares", sql: "SELECT item_id FROM inbox_interactive_shares WHERE run_id = ?", params: ["voyage"] },
  { table: "inbox_interactive_shares", sql: "SELECT 1 FROM inbox_interactive_shares WHERE run_id = ?", params: ["voyage"] },
  // activity/notify.ts
  { table: "notification_intents", sql: "SELECT id FROM notification_intents WHERE run_id = ? AND kind = ? LIMIT 1", params: ["voyage", "run_failed"] },
];

const plan = (db: Database, sql: string, params: unknown[]) => {
  const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try { return (explain.all(...(params as never[])) as Array<{ detail: string }>).map(row => row.detail); } finally { explain.finalize(); }
};

test("each append-only lookup searches an index instead of scanning its table (#4798)", () => {
  const db = createUiDb(":memory:");
  try {
    const scans = LOOKUPS.flatMap(({ table, sql, params }) => plan(db, sql, params)
      .filter(step => new RegExp(`^SCAN ${table}\\b`).test(step)).map(step => ({ sql, step })));
    expect(scans).toEqual([]);
    for (const { table, sql, params } of LOOKUPS)
      expect({ sql, searched: plan(db, sql, params).some(step => new RegExp(`^SEARCH ${table} USING (COVERING )?INDEX `).test(step)) }).toEqual({ sql, searched: true });
  } finally { db.close(); }
});

test("no two full indexes on one table cover the same columns, automatic indexes included (#4798)", () => {
  const db = createUiDb(":memory:");
  try {
    const tables = (db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name);
    const duplicates: string[] = [];
    for (const table of tables) {
      const seen = new Map<string, string>();
      for (const index of db.query(`SELECT name, partial FROM pragma_index_list(?)`).all(table) as Array<{ name: string; partial: number }>) {
        if (index.partial) continue;
        const columns = db.query("SELECT cid, name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as Array<{ cid: number; name: string | null }>;
        // An expression column has no name; two expression indexes are not comparable by column list.
        if (columns.some(column => column.cid === -2)) continue;
        const key = columns.map(column => column.cid === -1 ? "rowid" : column.name).join(",");
        const other = seen.get(key);
        if (other) duplicates.push(`${table}(${key}): ${other} and ${index.name}`);
        else seen.set(key, index.name);
      }
    }
    expect(duplicates).toEqual([]);
    expect(indexNames(db, "inbox_changes")).toContain("sqlite_autoindex_inbox_changes_1");
  } finally { db.close(); }
});

function indexNames(db: Database, table: string) {
  return (db.query("SELECT name FROM pragma_index_list(?)").all(table) as Array<{ name: string }>).map(row => row.name);
}

test("inbox_changes still refuses a repeated (thread_id, seq) once its duplicate index is gone (#4798)", () => {
  const db = createUiDb(":memory:");
  try {
    const insert = db.query("INSERT INTO inbox_changes(thread_id, seq, kind, data_json) VALUES ('shroud', 1, 'upsert_thread', '{}')");
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE constraint failed: inbox_changes\.thread_id, inbox_changes\.seq/);
  } finally { db.close(); }
});
