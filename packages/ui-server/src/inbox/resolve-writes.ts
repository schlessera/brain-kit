/** An inbox decision and all its change records commit together. */
import type { Database } from "bun:sqlite";
import type { ClientInboxResolve, InboxOperation } from "@schlessera/brain-ui-sdk/protocol";
import { procedureCaller, type WriteProcedures } from "../db/write-worker.js";
import { inboxWriter } from "./write-runtime.js";
import { createInboxResolver } from "./resolve.js";

export const url = import.meta.url;
export function setup(db: Database, options: { timeZone: string }): WriteProcedures {
  function resolver(at: number, threadId: string, allowed: readonly InboxOperation[]) {
    return createInboxResolver(db, { now: () => at, timeZone: options.timeZone, allowedOperations: (_principal, thread) => thread.id === threadId ? allowed : [] });
  }
  return {
    resolve(principalId: string, request: ClientInboxResolve, expectedVersion: number | undefined, at: number,
      threadId: string, allowed: readonly InboxOperation[], expectedEffect: string) {
      return db.transaction(() => {
        const current = resolver(at, threadId, allowed);
        const inspected = current.inspect(principalId, request);
        if (inspected.thread.id !== threadId || JSON.stringify(inspected.effect) !== expectedEffect) throw new Error("Action effect no longer matches the exact approved binding");
        return current.resolve(principalId, request, expectedVersion);
      }).immediate();
    },
    snooze(principalId: string, itemId: string, expectedVersion: number | undefined, at: number, threadId: string, allowed: readonly InboxOperation[]) {
      return resolver(at, threadId, allowed).snooze(principalId, itemId, expectedVersion);
    },
  };
}

export function inboxResolutionWrites(db: Database, timeZone: string) {
  return procedureCaller(db, { url, setup }, { timeZone }, inboxWriter(db));
}
