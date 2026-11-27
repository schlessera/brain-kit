import type { Database, Statement } from "bun:sqlite";

const METHODS = ["get", "all", "run", "values", "iterate"] as const;

/**
 * Count every statement execution on `db`: each `get`, `all`, `run`,
 * `values` and `iterate` of a prepared or cached statement, and each direct
 * `run`/`exec`. Counting `prepare` alone would miss a statement prepared once
 * and executed per row. `db.query` hands back one cached statement per SQL
 * text, so each statement is wrapped once. Call `restore` in teardown: it
 * unwraps every statement it wrapped, so nothing counts after it.
 */
export function countExecutions(db: Database): { count: () => number; restore: () => void } {
  let executions = 0;
  const { prepare, query, run, exec } = db;
  const wrapped = new Map<Statement, Record<string, unknown>>();
  const counted = (statement: Statement) => {
    if (wrapped.has(statement)) return statement;
    const originals: Record<string, unknown> = {};
    for (const method of METHODS) {
      const original = (statement as any)[method];
      originals[method] = original;
      (statement as any)[method] = function (this: unknown, ...args: unknown[]) { executions++; return original.apply(statement, args); };
    }
    wrapped.set(statement, originals);
    return statement;
  };
  db.prepare = ((...args: Parameters<typeof prepare>) => counted(prepare.apply(db, args) as Statement)) as typeof prepare;
  db.query = ((...args: Parameters<typeof query>) => counted(query.apply(db, args) as Statement)) as typeof query;
  db.run = ((...args: Parameters<typeof run>) => { executions++; return run.apply(db, args); }) as typeof run;
  db.exec = ((...args: Parameters<typeof exec>) => { executions++; return exec.apply(db, args); }) as typeof exec;
  return {
    count: () => executions,
    restore: () => {
      db.prepare = prepare; db.query = query; db.run = run; db.exec = exec;
      for (const [statement, originals] of wrapped) for (const method of METHODS) (statement as any)[method] = originals[method];
      wrapped.clear();
    },
  };
}
