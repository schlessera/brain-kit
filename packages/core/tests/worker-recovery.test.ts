import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../src/lib/db.js";
import { withSnapshot } from "../src/queries/snapshot.js";

const codes = ["SQLITE_READONLY_RECOVERY", "SQLITE_BUSY_RECOVERY"] as const;
const methods = ["all", "get", "run", "values"] as const;
const restores: (() => void)[] = [];
const connections: Database[] = [];
let saved: string | undefined, directory: string, path: string;
beforeEach(() => {
  saved = process.env.BRAIN_WORKER_DATA_ROOT;
  directory = mkdtempSync(join(tmpdir(), "brain-worker-recovery-"));
  path = join(directory, ".brain-index/brain.db");
  openDatabase(path).close();
  process.env.BRAIN_WORKER_DATA_ROOT = directory;
  const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {});
  restores.push(() => sleep.mockRestore());
});
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const restore of restores.splice(0).reverse()) restore();
  if (saved === undefined) delete process.env.BRAIN_WORKER_DATA_ROOT; else process.env.BRAIN_WORKER_DATA_ROOT = saved;
  rmSync(directory, { recursive: true, force: true });
});

function failure(code: string) { return Object.assign(new Error("Ithaca index recovery"), { code }); }
function attempt<T>(fn: () => T): { value?: T; error?: unknown } {
  try { return { value: fn() }; } catch (error) { return { error }; }
}

// Inject below the connection wrapper, but still execute real SQLite after recovery.
function injectStatement(factory: "prepare" | "query", method: typeof methods[number], errors: Error[]) {
  const original: Database["prepare"] = Database.prototype[factory];
  const seen = new WeakSet<object>();
  let calls = 0;
  const spy = spyOn(Database.prototype, factory).mockImplementation(function (this: Database, sql: string) {
    const statement = original.call(this, sql);
    if (sql.includes("AS ithaca") && !seen.has(statement)) {
      seen.add(statement);
      const execute = statement[method].bind(statement);
      Object.assign(statement, { [method]: (...args: any[]) => {
        const error = errors[calls++];
        if (error) throw error;
        return execute(...args);
      } });
    }
    return statement;
  } as typeof original);
  restores.push(() => spy.mockRestore());
  return () => calls;
}

describe("hosted worker recovery", () => {
  for (const factory of ["prepare", "query"] as const) {
    for (const method of methods) {
      test(`${factory}.${method} retries both recovery codes and preserves bindings`, () => {
        const calls = injectStatement(factory, method, codes.map(failure));
        const db = openDatabase(path, { readonly: true }); connections.push(db);
        const statement = db[factory]("SELECT ? AS ithaca");
        const expected = method === "all" ? [{ ithaca: 7 }] : method === "get" ? { ithaca: 7 }
          : method === "values" ? [[7]] : { changes: 0, lastInsertRowid: 0 };
        expect(attempt(() => statement[method](7))).toEqual({ value: expected });
        expect(calls()).toBe(3);
        if (factory === "query") {
          const wrapped = statement[method];
          expect(db.query("SELECT ? AS ithaca")).toBe(statement);
          expect(statement[method]).toBe(wrapped);
        }
      });
    }
  }

  test.each([...codes])("%s stops at 40 attempts and throws the first error", code => {
    const original = failure(code);
    const calls = injectStatement("query", "get", [original, ...Array.from({ length: 40 }, () => failure(code))]);
    const db = openDatabase(path, { readonly: true }); connections.push(db);
    expect(attempt(() => db.query("SELECT 1 AS ithaca").get()).error).toBe(original);
    expect(calls()).toBe(40);
    expect(Bun.sleepSync).toHaveBeenCalledTimes(39);
    expect(Bun.sleepSync).toHaveBeenNthCalledWith(1, 5);
    expect(Bun.sleepSync).toHaveBeenLastCalledWith(25);
  });

  test("other SQLite errors are never retried", () => {
    const error = failure("SQLITE_READONLY");
    const calls = injectStatement("prepare", "all", [error]);
    const db = openDatabase(path, { readonly: true }); connections.push(db);
    expect(attempt(() => db.prepare("SELECT 1 AS ithaca").all()).error).toBe(error);
    expect(calls()).toBe(1);
    expect(Bun.sleepSync).not.toHaveBeenCalled();
  });

  test("ordinary connections and statements are not wrapped", () => {
    delete process.env.BRAIN_WORKER_DATA_ROOT;
    const error = failure(codes[0]);
    const calls = injectStatement("query", "get", [error]);
    const db = openDatabase(path, { readonly: true }); connections.push(db);
    for (const method of ["prepare", "query", "run", "exec"] as const) expect(db[method]).toBe(Database.prototype[method]);
    const statement = db.query("SELECT 1 AS ithaca");
    expect(attempt(() => statement.get()).error).toBe(error);
    expect(calls()).toBe(1);
  });

  for (const method of ["run", "exec"] as const) {
    test(`${method} retries recovery on the connection`, () => {
      const original = Database.prototype[method];
      let calls = 0;
      const spy = spyOn(Database.prototype, method).mockImplementation(function (this: Database, ...args: Parameters<typeof original>) {
        if (args[0].includes("AS ithaca") && calls++ < 2) throw failure(codes[calls - 1]!);
        return original.apply(this, args);
      });
      restores.push(() => spy.mockRestore());
      const db = openDatabase(path, { readonly: true }); connections.push(db);
      expect(attempt(() => db[method]("SELECT ? AS ithaca", [7])).error).toBeUndefined();
      expect(calls).toBe(3);
    });
  }

  test.each([true, false])("openDatabase retries setup PRAGMAs (readonly=%s)", readonly => {
    const original = Database.prototype.run;
    let calls = 0;
    const spy = spyOn(Database.prototype, "run").mockImplementation(function (this: Database, ...args: Parameters<typeof original>) {
      if (args[0].includes("busy_timeout") && calls++ < 2) throw failure(codes[calls - 1]!);
      return original.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
    const result = attempt(() => { const db = openDatabase(path, { readonly }); connections.push(db); return db; });
    expect(result.error).toBeUndefined();
    expect(calls).toBe(3);
  });

  test("writable schema setup retries recovery before applying migrations", () => {
    const original = Database.prototype.run;
    let calls = 0;
    const spy = spyOn(Database.prototype, "run").mockImplementation(function (this: Database, ...args: Parameters<typeof original>) {
      if (args[0].includes("CREATE TABLE IF NOT EXISTS index_metadata") && calls++ < 2) throw failure(codes[calls - 1]!);
      return original.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
    const result = attempt(() => {
      const db = openDatabase(join(directory, "fresh.db")); connections.push(db);
      return db.query("SELECT value FROM index_metadata WHERE key = 'schema_version'").get();
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ value: String(SCHEMA_VERSION) });
    expect(calls).toBe(3);
  });

  test("query snapshots retry statement recovery within their read transaction", () => {
    const calls = injectStatement("query", "get", codes.map(failure));
    const result = withSnapshot({ brainPath: directory }, "find", () => {}, db => db.query("SELECT 7 AS ithaca").get());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ ithaca: 7 });
    expect(calls()).toBe(3);
  });

});
