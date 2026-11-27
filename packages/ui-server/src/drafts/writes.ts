/** Composer mutations share one FIFO channel; reads stay on the app connection. */
import type { Database } from "bun:sqlite";
import { procedureCaller, trackedCaller, type SqliteWriter, type WireError } from "../db/write-worker.js";
import { DraftAuthError, DraftError } from "./errors.js";
import { createDraftStore, DRAFT_WRITE_METHODS, type AwaitableDraftStore, type DraftStoreOptions, type DraftWrite } from "./store.js";

export const url = import.meta.url;
export function setup(db: Database, options: { limits?: DraftStoreOptions["limits"]; attachmentPoolBytes?: number }) {
  let at: number | undefined;
  const store = createDraftStore(db, { ...options, now: () => at ?? Date.now() });
  return {
    write(method: DraftWrite, args: unknown[], clock?: number) {
      at = clock;
      return Reflect.apply(store[method], store, args);
    },
  };
}
function revive(error: WireError): Error | undefined {
  if (error.name === "DraftError") return new DraftError(error.fields.status as DraftError["status"], JSON.parse(error.fields.bodyJson as string));
  if (error.name === "DraftAuthError") return new DraftAuthError();
  return undefined;
}
export function createDraftWrites(db: Database, options: DraftStoreOptions, writer: SqliteWriter): AwaitableDraftStore {
  const reads = createDraftStore(db, options);
  // A refused mutation must not poison later reads. FIFO means the last
  // submitted reply also settles all earlier mutations on this channel.
  const writes = trackedCaller(procedureCaller(db, { url, setup }, {
    limits: options.limits,
    ...(options.attachmentPoolBytes !== undefined ? { attachmentPoolBytes: options.attachmentPoolBytes } : {}),
  }, writer, revive));
  const forwarded = Object.fromEntries(DRAFT_WRITE_METHODS.map(method =>
    [method, (...args: unknown[]) => writes.call("write", method, args, options.now?.())])) as Pick<AwaitableDraftStore, DraftWrite>;
  return {
    limits: reads.limits, list: reads.list, get: reads.get,
    attachmentPoolBytes: reads.attachmentPoolBytes,
    attachments: reads.attachments, attachmentRef: reads.attachmentRef,
    attachmentReferenced: reads.attachmentReferenced, attachmentInventory: reads.attachmentInventory,
    attachmentReads: reads.attachmentReads,
    ...forwarded,
    settled: writes.settled,
  };
}
