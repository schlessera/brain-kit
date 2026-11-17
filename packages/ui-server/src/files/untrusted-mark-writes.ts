/** Untrusted-mark writes commit on the hosted server's write worker (#2850). */
import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import { untrustedMarkOperations } from "./untrusted-marks.js";

export const url = import.meta.url;
export function setup(db: Database) {
  return untrustedMarkOperations(db);
}
type Operations = ReturnType<typeof untrustedMarkOperations>;
export type UntrustedMarkWrites = { [K in keyof Operations]: (...args: Parameters<Operations[K]>) => Promise<ReturnType<Operations[K]>> };

export function createUntrustedMarkWrites(db: Database, writer?: SqliteWriter): UntrustedMarkWrites {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  return {
    mark: (...args) => call("mark", ...args),
    clear: (...args) => call("clear", ...args),
  };
}
