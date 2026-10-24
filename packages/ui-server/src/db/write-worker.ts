/**
 * SQLite commits off the event loop (#2814).
 *
 * A writer owns one dedicated write connection to a database file, opened in
 * a worker thread at `synchronous=FULL`. Each writing component registers a
 * procedure module there and calls its procedures by name. The worker runs
 * every call to completion, commit included, strictly in submission order, so
 * the event loop awaits a commit's outcome instead of blocking in its fsync.
 * Reads stay on the caller's own connection; WAL lets them proceed while the
 * worker commits.
 *
 * An in-memory database has no file a second connection could open, so its
 * writer runs the same procedures inline on the caller's connection, in the
 * same order, behind the same asynchronous calls.
 */
import type { Database } from "bun:sqlite";

/** Every procedure is synchronous: it runs and commits before the next call starts. */
export type WriteProcedures = Record<string, (...args: never[]) => unknown> & { close?: () => void };

/**
 * A procedure module: `url` is its own `import.meta.url`, which the worker
 * imports; `setup` runs once per channel on the write connection.
 */
export interface WriteModule<O> {
  url: string;
  setup(db: Database, options: O): WriteProcedures;
}

/** An error crossing the thread boundary: its class name and own fields. */
export interface WireError { name: string; message: string; fields: Record<string, unknown> }

export interface WriteChannel {
  /** Settles once the module's setup has run on the write connection. */
  readonly ready: Promise<void>;
  call<T>(name: string, ...args: unknown[]): Promise<T>;
  close(): Promise<void>;
}

export interface SqliteWriter {
  /** True when commits run in the worker thread, false for an inline in-memory writer. */
  readonly offloop: boolean;
  channel<O>(module: WriteModule<O>, options: O, revive?: (error: WireError) => Error | undefined): WriteChannel;
  /** Settles once every call submitted before it has settled. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export class SqliteWriterClosed extends Error {
  constructor(message = "The SQLite write worker is closed.") { super(message); }
}

export function encodeError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error), fields: {} };
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) if (["string", "number", "boolean"].includes(typeof value) || value === null) fields[key] = value;
  return { name: error.constructor?.name || error.name, message: error.message, fields };
}

function decodeError(wire: WireError, revive?: (error: WireError) => Error | undefined): Error {
  const error = revive?.(wire) ?? Object.assign(new Error(wire.message), { name: wire.name });
  for (const [key, value] of Object.entries(wire.fields)) {
    if (!(key in error)) Object.defineProperty(error, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return error;
}

const THREAD = new URL(`./write-worker-thread${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).href;

/** A further database file the write connection owns, attached under `schema` (#2789's `journal.db`). */
export interface AttachedDatabase { schema: string; path: string }

/**
 * Opens the writer for `db`'s file, or an inline writer when `db` is in
 * memory. The worker connection attaches each `attach` file and commits it at
 * FULL as well; an inline writer uses `db`'s own attachments.
 */
export function openSqliteWriter(db: Database, options: { attach?: readonly AttachedDatabase[] } = {}): SqliteWriter {
  const path = db.filename;
  if (!path || path === ":memory:") return inlineWriter(db);
  const turn = new Int32Array(new SharedArrayBuffer(8));
  takeTurns(db, turn);
  return workerWriter(path, options.attach ?? [], turn);
}

/** `turn[0]`: who is writing now. `turn[1]`: app writes waiting for their turn. */
const FREE = 0, APP = 1;
export const WORKER_TURN = 2;

/**
 * The app connection and the worker never write at the same time (#2814).
 * Two connections in one process, both writing one WAL file, were measured failing an app `BEGIN IMMEDIATE` with SQLITE_BUSY after about
 * 37 ms despite a 5 s busy timeout, and a deferred transaction that reads and
 * then writes can lose its snapshot upgrade to a worker commit. So each
 * outermost transaction on `db` waits until the worker is between procedures,
 * then holds the turn until it ends, and so does every autocommit write; the
 * worker waits for its turn the same way, and lets a waiting app write go
 * first. A transaction keeps its own mode: a read-only deferred snapshot never
 * takes the write lock.
 */
function takeTurns(db: Database, turn: Int32Array) {
  // The app thread holds its turn once, however deeply its SQLite calls nest.
  let depth = 0;
  const taking = <A extends unknown[], R>(work: (...args: A) => R) => (...args: A): R => {
    if (depth > 0 || db.inTransaction) return work(...args);
    Atomics.add(turn, 1, 1);
    try { while (Atomics.compareExchange(turn, 0, FREE, APP) !== FREE) Atomics.wait(turn, 0, WORKER_TURN, 50); }
    finally { Atomics.sub(turn, 1, 1); }
    depth++;
    try { return work(...args); }
    finally { depth--; Atomics.store(turn, 0, FREE); Atomics.notify(turn, 0); }
  };
  const transaction = db.transaction.bind(db);
  db.transaction = ((run: (...args: never[]) => unknown) => {
    const modes = transaction(run);
    const mode = (call: (...args: never[]) => unknown) => taking((...args: unknown[]) => Reflect.apply(call, modes, args));
    return Object.assign(mode(modes), { deferred: mode(modes.deferred), immediate: mode(modes.immediate), exclusive: mode(modes.exclusive) });
  }) as Database["transaction"];
  // An autocommit write is a transaction of its own: it takes its turn too.
  for (const name of ["run", "exec"] as const) {
    const direct = (db[name] as (...args: unknown[]) => unknown).bind(db);
    Object.defineProperty(db, name, { configurable: true, writable: true, value: taking(direct) });
  }
  const statements = new WeakSet<object>();
  for (const name of ["query", "prepare"] as const) {
    const make = (db[name] as unknown as (sql: string, ...rest: unknown[]) => Record<string, unknown>).bind(db);
    Object.defineProperty(db, name, { configurable: true, writable: true, value: (sql: string, ...rest: unknown[]) => {
      const statement = make(sql, ...rest);
      if (statements.has(statement)) return statement;
      statements.add(statement);
      // Reads need no turn; a RETURNING write runs through the readers too.
      for (const step of /\bRETURNING\b/i.test(sql) ? ["run", "get", "all", "values"] : ["run"]) {
        const call = (statement[step] as (...args: unknown[]) => unknown).bind(statement);
        Object.defineProperty(statement, step, { configurable: true, writable: true, value: taking(call) });
      }
      return statement;
    } });
  }
}

function inlineWriter(db: Database): SqliteWriter {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  return {
    offloop: false,
    channel(module, options) {
      let procedures: WriteProcedures | undefined, failure: unknown;
      try { procedures = module.setup(db, options); } catch (error) { failure = error; }
      const ready = failure === undefined ? Promise.resolve() : Promise.reject(failure);
      ready.catch(() => {});
      return {
        ready,
        call<T>(name: string, ...args: unknown[]): Promise<T> {
          // Run at submission, exactly as a synchronous write did; errors keep
          // their class because nothing crosses a thread.
          let result: Promise<T>;
          try {
            if (closed) throw new SqliteWriterClosed();
            if (!procedures) throw failure;
            const procedure = procedures[name];
            if (typeof procedure !== "function" || name === "close") throw new Error(`Unknown write procedure ${name}.`);
            result = Promise.resolve((procedure as (...values: unknown[]) => T)(...args));
          } catch (error) { result = Promise.reject(error); }
          tail = result.catch(() => {});
          return result;
        },
        async close() { procedures?.close?.(); procedures = undefined; failure ??= new SqliteWriterClosed(); },
      };
    },
    async idle() { await tail; },
    async close() { closed = true; await tail; },
  };
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; revive?: (error: WireError) => Error | undefined };

function workerWriter(path: string, attach: readonly AttachedDatabase[], turn: Int32Array): SqliteWriter {
  const worker = new Worker(THREAD) as Worker & { ref(): void; unref(): void };
  const pending = new Map<number, Pending>();
  let next = 0, channels = 0, closed = false, stopped: Error | undefined;
  // An idle writer never keeps the process alive; a pending commit does.
  const reference = () => { if (pending.size) worker.ref(); else worker.unref(); };
  const stop = (error: Error) => {
    stopped ??= error;
    for (const [id, waiter] of pending) { pending.delete(id); waiter.reject(stopped); }
    reference();
  };
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: WireError }>) => {
    const waiter = pending.get(event.data.id);
    if (!waiter) return;
    pending.delete(event.data.id);
    if (event.data.ok) waiter.resolve(event.data.value);
    else waiter.reject(decodeError(event.data.error!, waiter.revive));
    reference();
  };
  worker.onerror = event => { event.preventDefault?.(); stop(new SqliteWriterClosed(`The SQLite write worker failed: ${event.message}`)); };
  worker.addEventListener("close", () => stop(new SqliteWriterClosed()));
  function send<T>(message: Record<string, unknown>, revive?: Pending["revive"]): Promise<T> {
    if (stopped) return Promise.reject(stopped);
    const id = ++next;
    const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (value: unknown) => void, reject, revive }));
    worker.postMessage({ ...message, id });
    reference();
    return result;
  }
  const opened = send<void>({ kind: "open", path, attach: [...attach], turn });
  opened.catch(() => {});
  return {
    offloop: true,
    channel(module, options, revive) {
      const channel = ++channels;
      let open = true;
      const ready = send<void>({ kind: "register", channel, module: module.url, options }, revive);
      ready.catch(() => {});
      return {
        ready,
        call<T>(name: string, ...args: unknown[]) {
          if (!open) return Promise.reject(new SqliteWriterClosed());
          return send<T>({ kind: "call", channel, name, args }, revive);
        },
        async close() {
          if (!open) return;
          open = false;
          await send({ kind: "release", channel }).catch(() => {});
        },
      };
    },
    async idle() { await send({ kind: "idle" }).catch(() => {}); },
    async close() {
      if (closed) return;
      closed = true;
      await send({ kind: "close" }).catch(() => {});
      stop(new SqliteWriterClosed());
      worker.terminate();
    },
  };
}
