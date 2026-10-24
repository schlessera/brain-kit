/**
 * The write worker's thread (#2814): one write connection, opened at
 * `synchronous=FULL`, running registered procedures one at a time in the
 * order their calls arrived. Nothing here decides what is written.
 */
import { Database } from "bun:sqlite";

import { encodeError, WORKER_TURN, type WriteModule, type WriteProcedures } from "./write-worker.js";

declare const self: Worker;


const FULL = 2;
let db: Database | undefined;
/** Shared with the app connection: see `takeTurns` in write-worker.ts. */
let turn: Int32Array | undefined;
/** Runs `work` while the app connection is outside any transaction; a waiting app transaction goes first. */
function inTurn<T>(work: () => T): T {
  if (!turn) return work();
  while (Atomics.load(turn, 1) !== 0 || Atomics.compareExchange(turn, 0, 0, WORKER_TURN) !== 0) Atomics.wait(turn, 0, Atomics.load(turn, 0), 10);
  try { return work(); } finally { Atomics.store(turn, 0, 0); Atomics.notify(turn, 0); }
}
const channels = new Map<number, WriteProcedures | { failed: unknown }>();

/** Every database file this connection writes: `main` and each attached schema. */
let schemas = ["main"];

/** A commit below FULL, in any of the connection's files, is refused before it happens: the transaction rolls back. */
function assertFull(connection: Database) {
  for (const schema of schemas) {
    const level = (connection.query(`PRAGMA "${schema}".synchronous`).get() as { synchronous: number }).synchronous;
    if (level !== FULL) throw new Error(`SQLITE_WRITE_BELOW_FULL: a write-worker commit would run at synchronous=${level} in ${schema}.`);
  }
}

function open(path: string, attach: { schema: string; path: string }[]): Database {
  const connection = new Database(path, { readwrite: true, create: false });
  try {
    connection.exec("PRAGMA busy_timeout = 5000");
    for (const database of attach) {
      if (!/^[a-z_][a-z0-9_]*$/.test(database.schema) || ["main", "temp"].includes(database.schema)) throw new Error("Invalid attached schema name.");
      connection.query(`ATTACH DATABASE ? AS "${database.schema}"`).run(database.path);
    }
    schemas = ["main", ...attach.map(database => database.schema)];
    for (const schema of schemas) {
      connection.exec(`PRAGMA "${schema}".journal_mode = WAL`);
      connection.exec(`PRAGMA "${schema}".synchronous = FULL`);
    }
    connection.exec("PRAGMA foreign_keys = ON");
    assertFull(connection);
    // Every transaction checks its level last, just before COMMIT.
    const transaction = connection.transaction.bind(connection);
    connection.transaction = ((run: (...args: unknown[]) => unknown) => transaction(function (this: unknown, ...args: unknown[]) {
      const value = run.apply(this, args);
      assertFull(connection);
      return value;
    })) as Database["transaction"];
  } catch (error) { connection.close(); throw error; }
  return connection;
}

async function handle(message: { id: number; kind: string; [key: string]: unknown }): Promise<unknown> {
  switch (message.kind) {
    case "open":
      turn = message.turn as Int32Array | undefined;
      db = inTurn(() => open(message.path as string, (message.attach as { schema: string; path: string }[] | undefined) ?? []));
      return undefined;
    case "register": {
      try {
        if (!db) throw new Error("The SQLite write worker has no open database.");
        const module = await import(message.module as string) as { default?: WriteModule<unknown> } & Partial<WriteModule<unknown>>;
        const setup = module.setup ?? module.default?.setup;
        if (typeof setup !== "function") throw new Error("A write procedure module must export setup().");
        const connection = db;
        channels.set(message.channel as number, inTurn(() => setup(connection, message.options)));
      } catch (error) { channels.set(message.channel as number, { failed: error }); throw error; }
      return undefined;
    }
    case "call": {
      const procedures = channels.get(message.channel as number);
      if (!procedures) throw new Error("Unknown write channel.");
      if ("failed" in procedures) throw procedures.failed;
      const name = message.name as string, procedure = (procedures as WriteProcedures)[name];
      if (typeof procedure !== "function" || name === "close") throw new Error(`Unknown write procedure ${name}.`);
      let value: unknown, failure: { error: unknown } | undefined;
      try { value = inTurn(() => (procedure as (...args: unknown[]) => unknown)(...(message.args as unknown[]))); }
      catch (error) { failure = { error }; }
      // An autocommit statement has no transaction wrapper to check; a
      // procedure that lowered the level fails and the next call is FULL again.
      try { assertFull(db!); } catch (error) { if (!db!.inTransaction) for (const schema of schemas) db!.exec(`PRAGMA "${schema}".synchronous = FULL`); throw error; }
      if (failure) throw failure.error;
      if (value instanceof Promise) throw new Error(`Write procedure ${name} must complete synchronously.`);
      if (db!.inTransaction) throw new Error(`Write procedure ${name} left a transaction open.`);
      return value;
    }
    case "release": {
      const procedures = channels.get(message.channel as number);
      channels.delete(message.channel as number);
      if (procedures && !("failed" in procedures)) procedures.close?.();
      return undefined;
    }
    case "idle":
      return undefined;
    case "close":
      for (const procedures of channels.values()) if (!("failed" in procedures)) { try { procedures.close?.(); } catch { /* Closing continues. */ } }
      channels.clear();
      db?.close(); db = undefined;
      return undefined;
    default:
      throw new Error(`Unknown write worker message ${message.kind}.`);
  }
}

// One message at a time, in arrival order; a registration's import finishes
// before any later call starts.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; kind: string }>) => {
  const message = event.data;
  queue = queue.then(async () => {
    try { postMessage({ id: message.id, ok: true, value: await handle(message) }); }
    catch (error) { postMessage({ id: message.id, ok: false, error: encodeError(error) }); }
  });
};
