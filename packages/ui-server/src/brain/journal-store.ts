/**
 * The turn journal's writes, run on the write worker's connection (#2814).
 * Each procedure is one accounted transaction of `createJournalAccounting`,
 * committed at `synchronous=FULL` before its call resolves on the event loop.
 * The host journal (`turn-journal.ts`) keeps everything else: observation,
 * in-memory turn state and every read.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { JournalObservationReference, JournalVersion } from "@schlessera/brain-ui-sdk/protocol";

import type { WireError, WriteProcedures } from "../db/write-worker.js";
import { recordGovernanceEvent } from "../governance/events.js";
import { createJournalAccounting, JournalStorageUnavailable } from "./journal-accounting.js";
import { createJournalObjects, JournalCapacityError, type JournalObjectReservation } from "./journal-objects.js";
import { INDEX_FAMILY_PATHS, INDEX_PUBLICATION_COPY } from "./native-journal-policy.js";

export const url = import.meta.url;

export interface JournalStoreOptions { dbPath: string; objectsRoot: string; capBytes?: number }

/**
 * One statement of an accounted write. A `check` entry refuses the whole
 * write with `refusal` unless its query returns a row.
 */
export type JournalStatement = { sql: string; params?: SQLQueryBindings[] } | { check: string; params?: SQLQueryBindings[]; refusal: string };

/** A `check` statement found no row: the write rolled back. */
export class JournalStatementRefused extends Error {}

export const journalStatement = (sql: string, ...params: SQLQueryBindings[]): JournalStatement => ({ sql, params });
/** A `check` statement: the whole write is refused with `refusal` unless `sql` returns a row. */
export const journalCheck = (sql: string, refusal: string, ...params: SQLQueryBindings[]): JournalStatement => ({ check: sql, params, refusal });

/** Journal refusals keep their class and message across the worker boundary. */
export function reviveJournalError(wire: WireError): Error | undefined {
  const error = wire.name === "JournalCapacityError" ? new JournalCapacityError(wire.message)
    : wire.name === "JournalStorageUnavailable" ? new JournalStorageUnavailable("")
    : wire.name === "JournalStatementRefused" ? new JournalStatementRefused(wire.message) : undefined;
  if (error) error.message = wire.message;
  return error;
}

/** What one open's index purge step did (#2903); `null` when it had nothing left to do. */
export interface IndexPurgeResult { step: "versions" | "objects"; versions: number; pins: number; objects: number; bytes: number }

/**
 * A recorded change of the brain root's index family, as SQL over
 * `turn_journal_changes` or `turn_journal_revert_paths`, bound to the exact
 * family paths (`?1`, JSON) and the publication-copy GLOB (`?2`): the same
 * set `journalMetadataOnlyPath` names.
 */
const INDEX_PATH = "(path IN (SELECT value FROM json_each(?1)) OR path GLOB ?2)";
/** A version recorded before #2873 with its content facts, as SQL over one JSON column. */
const legacy = (column: string) => `(${column} IS NOT NULL AND json_extract(${column},'$.metadataOnly') IS NOT 1)`;
/** That version without its hash or symlink target, marked metadata-only like a new one. */
const metadataOnly = (column: string) => `CASE WHEN ${legacy(column)} THEN json_set(json_remove(${column},'$.hash','$.target'),'$.metadataOnly',json('true')) ELSE ${column} END`;
const hashes = (table: string, where = "1") => ["before_json", "after_json"]
  .map(column => `SELECT json_extract(${column},'$.hash') AS hash FROM ${table} WHERE ${where} AND json_extract(${column},'$.hash') IS NOT NULL`).join(" UNION ALL ");
/** Each turn that recorded an index-family version with a hash, with that hash. */
const indexPins = ["before_json", "after_json"].flatMap(column => [
  `SELECT turn_id,json_extract(${column},'$.hash') FROM turn_journal_changes WHERE ${INDEX_PATH} AND json_extract(${column},'$.hash') IS NOT NULL`,
  `SELECT o.journal_turn_id,json_extract(p.${column},'$.hash') FROM turn_journal_revert_paths p JOIN turn_journal_revert_operations o ON o.id=p.operation_id
    WHERE ${INDEX_PATH.replaceAll("path", "p.path")} AND json_extract(p.${column},'$.hash') IS NOT NULL`,
]).join(" UNION ALL ");
/**
 * Every hash a record other than an index-family version still names once
 * those are rewritten: any path's version in history, a revert record or an
 * external memory note, and an attachment removal's retained original, which
 * its Undo restores through the removal turn's pin.
 */
const namedHashes = `${hashes("turn_journal_changes")} UNION ALL ${hashes("turn_journal_revert_paths")} UNION ALL ${hashes("turn_journal_claude_memory")}
  UNION ALL SELECT json_extract(file.value,'$.retained.hash') FROM turn_journal_storage_operations s, json_each(s.private_versions) file`;

type TurnRow = { session_id: string | null; actor: "interactive" | "voice" | "user"; kind: "turn" | "revert"; model: string | null; profile: "strict" | "governed"; steering_inventory_missing: string; missing: string };

/** One observed change of a turn, as `observe()` classified it before admission. */
export interface ObservedChange { path: string; scope: string; before: JournalVersion | null; after: JournalVersion | null }

export interface ObservationRecord {
  turnId: string;
  /** The turn's last used change sequence; each recorded change takes the next. */
  sequence: number;
  at: number;
  userPolicy: boolean;
  changed: ObservedChange[];
  steeringPaths: string[];
  /** Every turn observing this window, this one included. */
  overlaps: string[];
  /** Changes of this turn's managed worktrees, already in journal path form. */
  worktree: { path: string; scope: string; before: JournalVersion | null; after: JournalVersion | null }[];
  steeringUnavailable: string[];
  unreadable: { path: string; kind?: string; bytes?: number; ms: number; [key: string]: unknown }[];
}

export function setup(db: Database, options: JournalStoreOptions): WriteProcedures {
  const accounting = createJournalAccounting(db, options.dbPath, { capBytes: options.capBytes });
  // Refusing this optional migration must never prevent recovery/expiry.
  accounting.ensureObjectRefIndex();
  const objects = createJournalObjects(options.objectsRoot, accounting);
  const reservations = new Map<string, JournalObjectReservation>();
  const temporary = new Map<string, { release(): void }>();
  const pin = (turnId: string, entry: JournalVersion | null) => {
    if (entry?.hash) db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, entry.hash);
  };
  /**
   * Removes every present object nothing pins or reserves; what it freed.
   * Each list is read once: pins are keyed by turn, so searching them per
   * object scanned every pin for every object.
   */
  const collect = () => {
    const unused = db.query("SELECT hash,bytes FROM turn_journal_objects WHERE state='present' AND hash NOT IN (SELECT hash FROM turn_journal_object_refs) AND hash NOT IN (SELECT hash FROM turn_journal_reservations WHERE hash IS NOT NULL)").all() as { hash: string; bytes: number }[];
    for (const row of unused) {
      if (objects.has(row.hash)) objects.remove(row.hash);
      db.query("DELETE FROM turn_journal_objects WHERE hash=?").run(row.hash);
    }
    return { objects: unused.length, bytes: unused.reduce((sum, row) => sum + row.bytes, 0) };
  };
  const purgeState = () => (db.query("SELECT index_purge FROM turn_journal_allocation WHERE id=1").get() as { index_purge: number }).index_purge;
  const turnContext = (turnId: string) => {
    const row = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=?").get(turnId) as TurnRow;
    const taint = db.query("SELECT id FROM governance_events WHERE kind='taint' AND (turn_id=? OR (? IS NOT NULL AND session_id=?)) ORDER BY id LIMIT 1")
      .get(turnId, row.session_id, row.session_id) as { id: number } | null;
    return { row, taint };
  };
  return {
    /** Statements in order, as one accounted transaction; the changes each made. */
    statements(list: JournalStatement[]): number[] {
      return accounting.write(() => list.map(statement => {
        if ("check" in statement) {
          if (!db.query(statement.check).get(...(statement.params ?? []))) throw new JournalStatementRefused(statement.refusal);
          return 0;
        }
        return db.query(statement.sql).run(...(statement.params ?? [])).changes;
      }));
    },
    bindModel(turnId: string, sessionId: string | null, model: string): boolean {
      return accounting.write(() => {
        const row = db.query("SELECT session_id,ended_at FROM turn_journal_turns WHERE turn_id=?").get(turnId) as { session_id: string | null; ended_at: number | null } | null;
        if (!row || row.ended_at !== null || row.session_id !== sessionId) return false;
        db.query("UPDATE turn_journal_turns SET model=? WHERE turn_id=? AND ended_at IS NULL").run(model, turnId);
        return true;
      });
    },
    collectObjects(): void {
      const indexed = accounting.ensureObjectRefIndex();
      accounting.write(collect);
      // A near-cap journal may only have room once this collection freed
      // object bytes. Retry without making that space depend on the index.
      if (!indexed) accounting.ensureObjectRefIndex();
    },
    /**
     * One step of the one-time purge of index-family bytes that releases
     * before #2873 retained (#2903), run at each open until it is done. Each
     * step is one accounted commit, so a crash leaves the previous step's
     * state and the next open resumes from it.
     *
     * The first step rewrites every recorded index-family version, in history
     * and in revert records, to the metadata-only form a new one has, without
     * its hash or symlink target, so no row names an object any more. It then
     * drops the pin each ended turn holds on an object its own index version
     * named. A hash any other record still names (`namedHashes`), at any path
     * or in any turn, keeps every pin: its object holds authoritative content
     * too. A turn that has not ended keeps its pins, since its process may
     * still be recording, and so does any other turn's pin.
     *
     * The second step collects the objects that left unreferenced, as an
     * ordinary collection does: a crash between removing a file and
     * committing leaves only an unreferenced row, which the step removes on
     * resume.
     */
    purgeIndexVersions(): IndexPurgeResult | null {
      if (purgeState() === 0) {
        const result = accounting.write(() => {
          // Under the write lock: another process opening the same journal may have run it.
          if (purgeState() !== 0) return null;
          const family = JSON.stringify(INDEX_FAMILY_PATHS);
          db.exec("CREATE TEMP TABLE IF NOT EXISTS journal_index_purge (turn_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (turn_id, hash)) WITHOUT ROWID");
          db.exec("DELETE FROM temp.journal_index_purge");
          db.query(`INSERT OR IGNORE INTO temp.journal_index_purge ${indexPins}`).run(family, INDEX_PUBLICATION_COPY);
          let versions = 0;
          for (const table of ["turn_journal_changes", "turn_journal_revert_paths"]) versions += db.query(`UPDATE ${table} SET before_json=${metadataOnly("before_json")},after_json=${metadataOnly("after_json")}
            WHERE ${INDEX_PATH} AND (${legacy("before_json")} OR ${legacy("after_json")})`).run(family, INDEX_PUBLICATION_COPY).changes;
          // Index versions name no hash any more: whatever still does is another record's content.
          db.exec(`DELETE FROM temp.journal_index_purge WHERE hash IN (${namedHashes})`);
          // Only the pin of the turn that recorded the index version: a pin
          // any other turn holds, for whatever reason, keeps its object.
          const pins = db.query(`DELETE FROM turn_journal_object_refs WHERE (turn_id,hash) IN (SELECT turn_id,hash FROM temp.journal_index_purge)
            AND EXISTS (SELECT 1 FROM turn_journal_turns t WHERE t.turn_id=turn_journal_object_refs.turn_id AND t.ended_at IS NOT NULL)`).run().changes;
          db.exec("DROP TABLE temp.journal_index_purge");
          db.query("UPDATE turn_journal_allocation SET index_purge=? WHERE id=1").run(pins ? 1 : 2);
          return { step: "versions" as const, versions, pins, objects: 0, bytes: 0 };
        });
        if (result) return result;
      }
      if (purgeState() !== 1) return null;
      // Removing an object row checks the pins' foreign key, which also
      // scans every pin per object. This commit removes only objects it found
      // unpinned under the same write lock, so it runs without enforcement,
      // a connection setting that changes only outside a transaction.
      const enforced = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        return accounting.write(() => {
          if (purgeState() !== 1) return null;
          const freed = collect();
          db.query("UPDATE turn_journal_allocation SET index_purge=2 WHERE id=1").run();
          return { step: "objects" as const, versions: 0, pins: 0, ...freed };
        });
      } finally { db.exec(`PRAGMA foreign_keys = ${enforced ? "ON" : "OFF"}`); }
    },
    /** The changes of one turn's observation window; the turn's last sequence after them. */
    recordObservation(record: ObservationRecord): number {
      const { turnId, at } = record;
      const steering = new Set(record.steeringPaths);
      let sequence = record.sequence;
      accounting.write(() => {
        const { row: metadata, taint } = turnContext(turnId);
        for (const item of record.changed) {
          sequence++;
          const approvedPolicy = record.userPolicy && item.path === "context/policies/governance.md";
          const classification = approvedPolicy ? "policy" : steering.has(item.path) ? "steering" : "content";
          const actor = approvedPolicy || metadata.kind === "revert" ? "user" : "agent";
          const source = classification === "steering" && actor === "agent" && taint ? taint.id : null;
          const overlappingTurnIds = record.overlaps.filter(id => id !== turnId);
          db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps,taint_source_event_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(turnId, sequence, item.path, item.scope, item.before ? JSON.stringify(item.before) : null, item.after ? JSON.stringify(item.after) : null, classification, actor, JSON.stringify(overlappingTurnIds), source);
          if (classification === "steering") recordGovernanceEvent(db, { kind: "steering_change", sessionId: metadata.session_id, turnId,
            actor: actor === "user" ? "user" : metadata.actor, model: metadata.model, profile: metadata.profile, at, dedupeKey: `${turnId}:${sequence}`,
            payload: { path: item.path, sequence, beforeHash: item.before?.hash ?? null, afterHash: item.after?.hash ?? null, taintSourceEventId: source, overlappingTurnIds } });
          pin(turnId, item.before); pin(turnId, item.after);
          const observed = db.query("SELECT sequence,after_json,overlaps FROM turn_journal_changes WHERE turn_id=? AND path=? ORDER BY sequence").all(turnId, item.path) as {sequence:number;after_json:string|null;overlaps:string}[];
          const participants = new Set(observed.flatMap(row => JSON.parse(row.overlaps) as string[]));
          const conflicting = new Map<number, JournalObservationReference>();
          for (const other of participants) {
            const shared = observed.filter(row => (JSON.parse(row.overlaps) as string[]).includes(other));
            if (new Set(shared.map(row => row.after_json ?? "null")).size < 2) continue;
            for (const row of shared) conflicting.set(row.sequence, {turnId, sequence:row.sequence, side:"after"});
          }
          if (conflicting.size) db.query("UPDATE turn_journal_changes SET conflict_observations=? WHERE turn_id=? AND path=?")
            .run(JSON.stringify([...conflicting.values()].sort((a,b)=>a.sequence-b.sequence)),turnId,item.path);
        }
        // Intentional worktree edits are editable workspace content of their holding turn only.
        for (const change of record.worktree) {
          sequence++;
          db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps,taint_source_event_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(turnId, sequence, change.path, change.scope, change.before ? JSON.stringify(change.before) : null,
              change.after ? JSON.stringify(change.after) : null, "content", metadata.kind === "revert" ? "user" : "agent", "[]", null);
          pin(turnId, change.before); pin(turnId, change.after);
        }
        db.query("UPDATE turn_journal_turns SET steering_inventory_missing=? WHERE turn_id=?").run(JSON.stringify([...new Set([...(JSON.parse(metadata.steering_inventory_missing) as string[]), ...record.steeringUnavailable])]), turnId);
        if (record.unreadable.length) {
          const missing = new Map<string, object>((JSON.parse(metadata.missing) as { path: string; reason: string }[]).map(item => [item.path, item]));
          for (const item of record.unreadable) {
            const { ms, ...known } = item;
            missing.set(item.path, known);
            const signature = `journal_reader:${item.kind ?? "unknown"}:${item.bytes ?? "unknown"}:${item.path}`.slice(0, 1000);
            recordGovernanceEvent(db, { kind: "roadblock", sessionId: metadata.session_id, turnId, actor: metadata.actor,
              model: metadata.model, profile: metadata.profile, at, dedupeKey: `journal-reader:${turnId}:${item.path}`,
              payload: { category: "permission_denied", family: "journal_reader", signature,
                failures: [{ toolCallId: null, signature, category: "permission_denied" }], resolution: null,
                remedy: "capability", waste: { tokens: null, costUsd: null, ms }, eventIds: [] } });
          }
          db.query("UPDATE turn_journal_turns SET state='partial',missing=? WHERE turn_id=?").run(JSON.stringify([...missing.values()]), turnId);
        }
      });
      return sequence;
    },
    /** A saved or recovered native memory note, as one steering change at `sequence`. */
    recordClaudeMemory(turnId: string, sequence: number, path: string, target: { directory: string; device: string; inode: string; note: string },
      before: JournalVersion | null, after: JournalVersion | null, at: number): void {
      accounting.write(() => {
        const { row: metadata, taint: found } = turnContext(turnId);
        const actor = metadata.actor === "user" ? "user" : "agent";
        const taint = actor === "agent" ? found : null;
        db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps,taint_source_event_id) VALUES (?,?,?,?,?,?,'steering',?,'[]',?)")
          .run(turnId, sequence, path, "claude_memory", before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor, taint?.id ?? null);
        db.query("INSERT OR REPLACE INTO turn_journal_claude_memory VALUES (?,?,?,?,?,?,?,?,?)").run(turnId, path, target.directory, target.device, target.inode, target.note, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, "saved");
        pin(turnId, before); pin(turnId, after);
        recordGovernanceEvent(db, { kind: "steering_change", sessionId: metadata.session_id, turnId, actor: metadata.actor, model: metadata.model, profile: metadata.profile, at, dedupeKey: `${turnId}:${sequence}`,
          payload: { path, sequence, beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null, taintSourceEventId: taint?.id ?? null, overlappingTurnIds: [] } });
      });
    },
    /** False when the turn has no record to mark. */
    markMemoryUnconfirmed(turnId: string, path: string): boolean {
      return accounting.write(() => {
        const row = db.query("SELECT missing FROM turn_journal_turns WHERE turn_id=?").get(turnId) as {missing:string} | null;
        if (!row) return false;
        const missing = (JSON.parse(row.missing) as {path:string;reason:string}[]).filter(item => item.path !== path);
        missing.push({path,reason:"memory_persistence_unconfirmed"});
        db.query("UPDATE turn_journal_turns SET state='partial',missing=? WHERE turn_id=?").run(JSON.stringify(missing),turnId);
        return true;
      });
    },
    reserve(bytes: number, hash: string): string {
      // This ledger commits on this connection: its reservation is synchronous.
      const reservation = accounting.reserve(bytes, hash) as JournalObjectReservation;
      reservations.set(reservation.id!, reservation);
      return reservation.id!;
    },
    finishReservation(id: string, hash: string, bytes: number, duplicate: boolean): void {
      const reservation = reservations.get(id);
      if (!reservation) throw new JournalStorageUnavailable("the content reservation is unknown");
      reservation.finish(hash, bytes, duplicate); reservations.delete(id);
    },
    cancelReservation(id: string): void {
      const reservation = reservations.get(id);
      if (!reservation) throw new JournalStorageUnavailable("the content reservation is unknown");
      reservation.cancel(); reservations.delete(id);
    },
    reserveTemporary(bytes: number): string {
      const reservation = accounting.reserveTemporary(bytes);
      temporary.set(reservation.id, reservation);
      return reservation.id;
    },
    releaseTemporary(id: string): void {
      temporary.get(id)?.release(); temporary.delete(id);
    },
    /** A read lease; with `ownerTurnId`, only while that ended turn still owns the object. */
    openRead(hash: string, ownerTurnId?: string): string {
      return accounting.openRead(hash, ownerTurnId === undefined ? undefined : () => {
        if (!db.query("SELECT 1 FROM turn_journal_object_refs r JOIN turn_journal_turns t ON t.turn_id=r.turn_id WHERE r.turn_id=? AND r.hash=? AND t.state IN ('complete','partial') AND t.ended_at IS NOT NULL").get(ownerTurnId, hash)) throw new JournalStorageUnavailable("original retention ownership expired before admission");
      });
    },
    releaseRead(id: string): void { accounting.releaseRead(id); },
    recover(): void { accounting.recover(objects); },
    usage(): number { return accounting.usage(); },
    close(): void { objects.close(); },
  };
}

