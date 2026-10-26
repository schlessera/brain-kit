/**
 * Action notices on the shared ui.db write worker (#3000). The same notifier
 * runs each original transaction on the write connection; clocks are taken
 * at submission, and every result follows its commit. Episodes stay inside
 * the inbox store's own transactions (#3001).
 */
import type { Database } from "bun:sqlite";

import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import { createActionNotifier, noticeTimeZone, type ActionNotifier } from "./notify.js";

export const url = import.meta.url;

export type AwaitableActionNotifier = {
  [K in keyof ActionNotifier]: (...args: Parameters<ActionNotifier[K]>) => ReturnType<ActionNotifier[K]> | Promise<ReturnType<ActionNotifier[K]>>;
};

export function setup(db: Database) {
  const notices = createActionNotifier(db);
  return {
    ...notices,
    tick(enrollAt: number, generateAt: number) {
      notices.enroll(enrollAt);
      notices.generateDue(generateAt);
    },
  };
}

/** A slow tick is not submitted again; its original transaction boundaries stay intact. */
export function createOffloopActionNotifier(db: Database, writer: SqliteWriter): {
  notices: AwaitableActionNotifier;
  tick(): Promise<void>;
} {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  let ticking: Promise<void> | undefined;
  return {
    notices: {
      enroll: at => call<number>("enroll", at ?? Date.now()),
      beginAttempt: (destination, at) => call("beginAttempt", destination, at ?? Date.now()),
      finishAttempt: (id, outcome, at) => call<void>("finishAttempt", id, outcome, at ?? Date.now()),
      // Normalize unknown input before structured cloning: unusable metadata
      // remains missing, including values a worker message cannot carry.
      reportZone: (client, zone, endpoint, at) => call("reportZone", client, noticeTimeZone(zone), endpoint, at ?? Date.now()),
      reportDeviceZone: (principal, endpoint, zone, at) => call("reportDeviceZone", principal, endpoint, noticeTimeZone(zone), at ?? Date.now()),
      digest: (client, at) => call("digest", client, at ?? Date.now()),
      dismiss: (client, through, at) => call<void>("dismiss", client, through, at ?? Date.now()),
      generateDue: at => call<number>("generateDue", at ?? Date.now()),
    },
    tick() {
      if (ticking) return ticking;
      ticking = call<void>("tick", Date.now(), Date.now()).finally(() => { ticking = undefined; });
      return ticking;
    },
  };
}
