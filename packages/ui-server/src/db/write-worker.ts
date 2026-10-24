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
  writeLockUpFront(db);
  return workerWriter(path, options.attach ?? []);
}

/**
 * With the worker as a second writer on the same file, a deferred transaction
 * on `db` that reads and then writes can lose its snapshot upgrade to a worker
 * commit and fail at once with SQLITE_BUSY, which no busy timeout retries. So
 * every transaction on `db` takes the write lock when it begins, and waits its
 * turn like any other writer. In the native hosted proof under fsync load, a
 * BEGIN IMMEDIATE beside a committing worker also returned SQLITE_BUSY after
 * about 37 ms with a 5 s busy timeout; nothing has run at that point, so the
 * BEGIN is retried until the connection's busy timeout has passed.
 */
function writeLockUpFront(db: Database) {
  const transaction = db.transaction.bind(db);
  const timeout = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  db.transaction = ((run: (...args: never[]) => unknown) => {
    let entered = false;
    const modes = transaction(function (this: unknown, ...args: never[]) { entered = true; return run.apply(this, args); });
    const immediate = (...args: unknown[]) => {
      const deadline = performance.now() + timeout;
      for (let delay = 1; ; delay = Math.min(delay * 2, 50)) {
        entered = false;
        try { return Reflect.apply(modes.immediate, modes, args); }
        catch (error) {
          const busy = String((error as { code?: unknown }).code ?? "").startsWith("SQLITE_BUSY") || (error as { errno?: unknown }).errno === 5;
          if (!busy || entered || db.inTransaction || performance.now() + delay > deadline) throw error;
          Bun.sleepSync(delay);
        }
      }
    };
    return Object.assign(immediate, { deferred: immediate, immediate, exclusive: modes.exclusive });
  }) as Database["transaction"];
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

function workerWriter(path: string, attach: readonly AttachedDatabase[]): SqliteWriter {
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
  const opened = send<void>({ kind: "open", path, attach: [...attach] });
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
