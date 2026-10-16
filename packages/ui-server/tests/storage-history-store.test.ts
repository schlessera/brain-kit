import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createUiDb } from "../src/db/client.js";
import { createStorageHistory, invalidateRestoredStorage, parseStoredHistory } from "../src/storage/history-store.js";
import { hashScope, RECENT, type Aggregate } from "../src/storage/history-model.js";
const roots: string[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const start = Date.UTC(2026, 6, 12, 9, 41), identity = hashScope("Odysseus volume"), scope = hashScope("Odysseus stores");
const aggregate = (at: number, available = 500_000_000): Aggregate => ({ at, startedAt: at - 10, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0, capacities: [{ descriptor: [identity, scope], values: [1_000_000_000, 1_000_000_000 - available, available, available, 0, 1, 4096, 2, 8192, 0, 0, 3, 12288] }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-history-")); roots.push(root);
  const path = join(root, "operations.sqlite"), db = createUiDb(path); databases.push(db);
  let now = start;
  const history = createStorageHistory(db, root, { now: () => now });
  return { root, path, db, history, advance(value: number) { now = value; } };
}
test("SQLite migrations retain tiers and stable opaque identity across reopen; only newest pending aggregate survives", () => {
  const f = fixture(), salt = f.history.read()!.metadata.state.salt;
  f.history.offer(aggregate(start));
  const first = f.history.read()!, revision = () => (f.db.query("SELECT revision FROM storage_history").get() as { revision: number }).revision;
  expect(first.samples).toHaveLength(3); expect(revision()).toBe(1);
  for (let index = 1; index < 60; index++) { f.advance(start + index * 1000); f.history.offer(aggregate(start + index * 1000, 500_000_000 - index)); }
  expect(revision(), "STORAGE_HISTORY_ONE_TRANSACTION_PER_MINUTE").toBe(1);
  expect(f.history.status().pending).toBe(true);
  f.advance(start + 60_000); expect(f.history.flush()).toBe(true); expect(revision()).toBe(2);
  expect(f.history.read()!.samples.every(row => row[3] === start + 59_000)).toBe(true);
  f.history.close();
  const db = createUiDb(f.path); databases.push(db);
  const reopened = createStorageHistory(db, f.root, { now: () => start + 60_001 });
  expect(reopened.read()!.metadata.state.salt, "STORAGE_HISTORY_STABLE_IDENTITY").toBe(salt);
  expect(reopened.status().pending).toBe(false); expect(reopened.read()!.samples).toEqual(f.history.read()!.samples);
});
test("an actual SQLite page quota preserves the previous valid payload when a history write fails", () => {
  const f = fixture();
  const before = (f.db.query("SELECT payload_json FROM storage_history").get() as { payload_json: string }).payload_json;
  f.db.exec("CREATE TABLE storage_test_ballast (value BLOB)");
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const pages = (f.db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  f.db.exec(`PRAGMA max_page_count = ${pages}`);
  // Fill any already-free pages, so the next new history overflow page hits
  // SQLite's real SQLITE_FULL boundary instead of a mocked database method.
  for (;;) { try { f.db.query("INSERT INTO storage_test_ballast VALUES (zeroblob(4096))").run(); } catch { break; } }
  const input = aggregate(start);
  input.capacities = Array.from({ length: 4 }, (_, index) => ({ descriptor: [hashScope(index), scope], values: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, 0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] }));
  f.history.offer(input);
  expect(f.history.status().paused, "STORAGE_HISTORY_SQLITE_FULL_PRESERVES_EVIDENCE").toBe("history-write-unavailable");
  expect((f.db.query("SELECT payload_json FROM storage_history").get() as { payload_json: string }).payload_json).toBe(before);
  expect(f.history.status().pending).toBe(true);
});
test("failed refresh and clock reversal never manufacture new endpoints or clear warning causes", () => {
  const f = fixture(); f.history.offer(aggregate(start, 50_000_000));
  expect(f.history.read()!.metadata.state.pressures[0]!.severity).toBe("critical");
  f.advance(start + 60_000); f.history.failure();
  const after = f.history.read()!;
  expect(after.samples.every(row => row[3] === start && row[2] === 1)).toBe(true);
  expect(after.metadata.state.pressures[0]!.severity).toBe("critical");
  expect(after.metadata.state.pressures[0]!.supportAt).toBeNull();
  f.advance(start - 1); f.history.offer(aggregate(start - 1));
  expect(f.history.status().paused).toBe("history-clock-reversal");
  expect(f.history.read()).toEqual(after);
});
test("operational restore suppresses every old active episode before fresh observations can dispatch", () => {
  const f = fixture(); f.history.offer(aggregate(start, 50_000_000));
  const episode = f.history.read()!.metadata.state.pressures[0]!.episode!;
  f.db.transaction(() => invalidateRestoredStorage(f.db, start + 60_000)).immediate();
  const restored = f.history.read()!;
  expect(restored.metadata.state.suppressedEpisodes, "STORAGE_RESTORE_INVALIDATES_DELIVERY_AUTHORITY").toContain(episode);
  expect(restored.metadata.state.pressures[0]!.supportAt).toBeNull();
  f.advance(start + 120_000); f.history.offer(aggregate(start + 120_000, 40_000_000));
  expect(f.history.read()!.metadata.state.suppressedEpisodes).toContain(episode);
  expect(f.history.read()!.metadata.state.pressures[0]!.episode).toBe(episode);
});
test("186 four-capacity observations charge serialized history separately from actual database and WAL allocation", () => {
  const f = fixture();
  const physical = () => ([f.path, f.path + "-wal", f.path + "-shm"] as const).map(path => { try { const value = statSync(path); return { file: path.slice(f.root.length + 1), logical: value.size, allocated: value.blocks * 512 }; } catch { return { file: path.slice(f.root.length + 1), logical: 0, allocated: 0 }; } });
  const before = physical();
  for (let index = 0; index < 230 * 4; index++) {
    const at = start + index * RECENT, input = aggregate(at);
    input.capacities = Array.from({ length: 4 }, (_, slot) => ({ descriptor: [hashScope(`Odysseus ${slot}`), scope], values: [...input.capacities[0]!.values] }));
    f.advance(at); f.history.offer(input);
  }
  const result = f.history.status(), after = physical();
  expect(result.history!.samples.length, "STORAGE_HISTORY_SQLITE_186_RECORDS").toBe(186);
  expect(result.payloadBytes).toBeLessThanOrEqual(262144);
  expect(after.reduce((sum, row) => sum + row.allocated, 0)).toBeGreaterThan(result.payloadBytes!);
  // This is a measured fixture receipt, never a production byte-size promise.
  console.log("STORAGE_HISTORY_PHYSICAL_RECEIPT", JSON.stringify({ samples: 186, capacities: 4, payloadBytes: result.payloadBytes, before, after }));
});
test("malformed persisted warning authority is rejected instead of interpreted as Critical", () => {
  const f = fixture(); f.history.offer(aggregate(start));
  const payload = f.history.read()!;
  (payload.metadata.state.pressures[0] as unknown as { severity: string }).severity = "unrecognised";
  expect(() => parseStoredHistory(JSON.stringify(payload))).toThrow();
});
