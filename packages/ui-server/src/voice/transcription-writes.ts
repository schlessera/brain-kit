/** Claims and their account authorization run on the write connection. */
import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter, type WireError } from "../db/write-worker.js";
import { createAccountPartitionKeys } from "../middleware/account-partition.js";
import type { AuthMode } from "../middleware/auth.js";
import { createTranscriptionStore, transcriptionOperations, TranscriptionError, type TranscriptionStore } from "./transcription-store.js";

export const url = import.meta.url;
type Options = { brainPath: string; authMode: AuthMode };
export function setup(db: Database, options: Options) {
  // Do not replay the boot sweep when registering the worker's procedures.
  return transcriptionOperations(db, createAccountPartitionKeys(db, options.brainPath, options.authMode));
}
function revive(error: WireError): Error | undefined {
  if (error.name === "TranscriptionError") return new TranscriptionError(error.fields.status as TranscriptionError["status"], JSON.parse(error.fields.bodyJson as string));
  return undefined;
}
export type AwaitableTranscriptionStore = {
  [K in keyof TranscriptionStore]: (...args: Parameters<TranscriptionStore[K]>) => ReturnType<TranscriptionStore[K]> | Promise<ReturnType<TranscriptionStore[K]>>;
};
export function createTranscriptionWrites(db: Database, options: Options, writer?: SqliteWriter): AwaitableTranscriptionStore {
  // Recovery of an interrupted provider dispatch remains a boot-only write.
  const inline = createTranscriptionStore(db, createAccountPartitionKeys(db, options.brainPath, options.authMode));
  if (!writer) return inline;
  const call = procedureCaller(db, { url, setup }, options, writer, revive);
  const invoke = <K extends keyof TranscriptionStore>(name: K, args: Parameters<TranscriptionStore[K]>) => call<ReturnType<TranscriptionStore[K]>>(name, ...args);
  return {
    authorize: (...args) => invoke("authorize", args),
    // Authorization can lazily create the account seed, even for a GET.
    get: (...args) => invoke("get", args),
    claim: (...args) => invoke("claim", args),
    complete: (...args) => invoke("complete", args),
    remove: (...args) => invoke("remove", args),
  };
}
