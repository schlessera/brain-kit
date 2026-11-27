import type { Database, Statement } from "bun:sqlite";

/**
 * Count every statement execution on `db`: each `get`, `all`, `run`,
 * `values` and `iterate` of a prepared or cached statement, and each direct
 * `run`/`exec`. Counting `prepare` alone would miss a statement prepared once
 * and executed per row. Call `restore` in teardown.
 */
export function countExecutions(db: Database): { count: () => number; restore: () => void } {
  let executions = 0;
  const { prepare, query, run, exec } = db;
  const counted = (statement: Statement) => {
    for (const method of ["get", "all", "run", "values", "iterate"] as const) {
      const original = (statement as any)[method];
      (statement as any)[method] = function (this: unknown, ...args: unknown[]) { executions++; return original.apply(statement, args); };
    }
    return statement;
  };
  db.prepare = ((...args: Parameters<typeof prepare>) => counted(prepare.apply(db, args) as Statement)) as typeof prepare;
  db.query = ((...args: Parameters<typeof query>) => counted(query.apply(db, args) as Statement)) as typeof query;
  db.run = ((...args: Parameters<typeof run>) => { executions++; return run.apply(db, args); }) as typeof run;
  db.exec = ((...args: Parameters<typeof exec>) => { executions++; return exec.apply(db, args); }) as typeof exec;
  return {
    count: () => executions,
    restore: () => { db.prepare = prepare; db.query = query; db.run = run; db.exec = exec; },
  };
}
