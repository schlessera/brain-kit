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
import { recordGovernanceEvent, type GovernanceEventInput } from "../governance/events.js";
import { createJournalAccounting, JournalStorageUnavailable } from "./journal-accounting.js";
import { createJournalObjects, JournalCapacityError, type JournalObjectReservation } from "./journal-objects.js";

export const url = import.meta.url;

export interface JournalStoreOptions { dbPath: string; objectsRoot: string; capBytes?: number }

/**
 * One statement of an accounted write. A `governance` entry records that
 * event in the same transaction; a `check` entry refuses the whole write with
 * `refusal` unless its query returns a row.
 */
export type JournalStatement = { sql: string; params?: SQLQueryBindings[] } | { governance: GovernanceEventInput }
  | { check: string; params?: SQLQueryBindings[]; refusal: string };

/** A `check` statement found no row: the write rolled back. */
export class JournalStatementRefused extends Error {}

export const journalStatement = (sql: string, ...params: SQLQueryBindings[]): JournalStatement => ({ sql, params });

/** Journal refusals keep their class and message across the worker boundary. */
export function reviveJournalError(wire: WireError): Error | undefined {
  const error = wire.name === "JournalCapacityError" ? new JournalCapacityError(wire.message)
    : wire.name === "JournalStorageUnavailable" ? new JournalStorageUnavailable("")
    : wire.name === "JournalStatementRefused" ? new JournalStatementRefused(wire.message) : undefined;
  if (error) error.message = wire.message;
  return error;
}

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
  const objects = createJournalObjects(options.objectsRoot, accounting);
  const reservations = new Map<string, JournalObjectReservation>();
  const temporary = new Map<string, { release(): void }>();
  const pin = (turnId: string, entry: JournalVersion | null) => {
    if (entry?.hash) db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, entry.hash);
  };
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
        if ("governance" in statement) { recordGovernanceEvent(db, statement.governance); return 0; }
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
      accounting.write(() => {
        const unused = db.query("SELECT hash FROM turn_journal_objects WHERE state='present' AND NOT EXISTS(SELECT 1 FROM turn_journal_object_refs r WHERE r.hash=turn_journal_objects.hash) AND NOT EXISTS(SELECT 1 FROM turn_journal_reservations r WHERE r.hash=turn_journal_objects.hash)").all() as { hash: string }[];
        for (const row of unused) {
          if (objects.has(row.hash)) objects.remove(row.hash);
          db.query("DELETE FROM turn_journal_objects WHERE hash=?").run(row.hash);
        }
      });
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

