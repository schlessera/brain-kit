/**
 * Reference effects share the hosted database's worker FIFO (#2999).
 * Without registration, the same procedures commit inline at submission.
 */
import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter, type WriteProcedures } from "../db/write-worker.js";
import { worktreeWrites } from "./reference-worktree-writes.js";
import { sourceWrites } from "./reference-source-writes.js";
import { hygieneWrites } from "./reference-worktree-hygiene-writes.js";

export const url = import.meta.url;
export function setup(db: Database): WriteProcedures {
  return { ...worktreeWrites(db), ...sourceWrites(db), ...hygieneWrites(db) };
}

type Call = {
  <T = void>(name: string, ...args: unknown[]): Promise<T>;
  settled(): Promise<void>;
};
const registered = new WeakMap<Database, Call>();

function caller(db: Database, writer?: SqliteWriter): Call {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  let tail: Promise<void> = Promise.resolve();
  return Object.assign(<T = void>(name: string, ...args: unknown[]): Promise<T> => {
    const result = call<T>(name, ...args);
    tail = result.then(() => {}, () => {});
    return result;
  }, { settled: () => tail });
}

/** Register before constructing the reference services or their checkpoint ledger. */
export function registerReferenceWrites(db: Database, writer: SqliteWriter): void {
  registered.set(db, caller(db, writer));
}
export function referenceWrites(db: Database): Call {
  let call = registered.get(db);
  if (!call) { call = caller(db); registered.set(db, call); }
  return call;
}
