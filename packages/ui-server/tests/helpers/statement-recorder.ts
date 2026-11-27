/**
 * Records every statement a store executes, for plan and statement-count
 * proofs (#4665): the returned `db` hands out statements whose `all`, `get`,
 * `run`, `values` and `iterate` calls are logged with their SQL, bound
 * parameters and, for `all` and `get`, the rows they returned. Everything
 * else, transactions included, runs on the real connection unrecorded.
 */
import type { Database, Statement } from "bun:sqlite";

/** `rows` is how many rows an `all` or `get` handed back. */
export interface RecordedStatement { sql: string; params: unknown[]; rows?: number }
const EXECUTE = new Set<PropertyKey>(["all", "get", "run", "values", "iterate"]);

export function recordStatements(db: Database) {
  const statements: RecordedStatement[] = [];
  const statement = (sql: string, compiled: Statement) => new Proxy(compiled, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!EXECUTE.has(key)) return value.bind(target);
      return (...params: unknown[]) => {
        const recorded: RecordedStatement = { sql, params };
        statements.push(recorded);
        const result = value.apply(target, params);
        if (key === "all") recorded.rows = (result as unknown[]).length;
        else if (key === "get") recorded.rows = result == null ? 0 : 1;
        return result;
      };
    },
  });
  const recorded = new Proxy(db, {
    get(target, key) {
      if (key === "query" || key === "prepare") return (sql: string) => statement(sql, target[key](sql));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: recorded, statements };
}

/** The plan steps of one recorded statement, run against the real connection. */
export function queryPlan(db: Database, { sql, params }: RecordedStatement): string[] {
  const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try { return (explain.all(...(params as never[])) as Array<{ detail: string }>).map(row => row.detail); } finally { explain.finalize(); }
}
