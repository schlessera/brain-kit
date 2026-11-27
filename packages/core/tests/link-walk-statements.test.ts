/**
 * The link walk compiles its statements once (#4714): `walkLinks` runs the
 * query API's `linkWalk`, whose three statements come from the connection's
 * `db.query` cache, instead of a `db.prepare` per visited node and direction.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDatabase } from "../src/lib/db";
import { walkLinks } from "../src/lib/link-walk";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;
let db: Database;

beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  db = openDatabase(`${root}/.brain-index/brain.db`, { readonly: true });
});

afterAll(() => {
  db?.close();
  cleanup(root);
});

test("a depth-3 walk makes no db.prepare call and passes at most three distinct texts to db.query", () => {
  const prepared: string[] = [];
  const queried = new Set<string>();
  const prepare = db.prepare;
  const query = db.query;
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    prepared.push(sql);
    return (prepare as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.prepare;
  db.query = ((sql: string) => {
    queried.add(sql);
    return query.call(db, sql);
  }) as typeof db.query;
  let walk: ReturnType<typeof walkLinks>;
  try {
    walk = walkLinks(db, { path: "me/identity.md", depth: 3, direction: "both" });
  } finally {
    db.prepare = prepare;
    db.query = query;
  }
  // The walk is wide enough that a per-node statement would show many times over.
  expect(walk.nodes.length).toBeGreaterThan(10);
  expect(prepared).toEqual([]);
  expect(queried.size).toBeLessThanOrEqual(3);
});
