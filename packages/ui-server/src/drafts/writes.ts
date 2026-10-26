/** Composer mutations share one FIFO channel; reads stay on the app connection. */
import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter, type WireError } from "../db/write-worker.js";
import { createDraftStore, DraftAuthError, DraftError, type AwaitableDraftStore, type DraftStore, type DraftStoreOptions } from "./store.js";

export const url = import.meta.url;
export function setup(db: Database, options: { limits?: DraftStoreOptions["limits"] }) {
  let at: number | undefined;
  const store = createDraftStore(db, { ...options, now: () => at ?? Date.now() });
  return {
    write(method: "save" | "upload" | "remove" | "bind" | "accept", args: unknown[], clock?: number) {
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
  const call = procedureCaller(db, { url, setup }, { limits: options.limits }, writer, revive);
  let pending: Promise<unknown> = Promise.resolve();
  const write = <K extends "save" | "upload" | "remove" | "bind" | "accept">(method: K, args: Parameters<DraftStore[K]>) => {
    const done = call<ReturnType<DraftStore[K]>>("write", method, args, options.now?.());
    // A refused mutation must not poison later reads. FIFO means the last
    // submitted reply also settles all earlier mutations on this channel.
    pending = done.catch(() => {});
    return done;
  };
  return {
    limits: reads.limits, list: reads.list, get: reads.get,
    save: (...args) => write("save", args),
    upload: (...args) => write("upload", args),
    remove: (...args) => write("remove", args),
    bind: (...args) => write("bind", args),
    accept: (...args) => write("accept", args),
    async settled() { await pending; },
  };
}
