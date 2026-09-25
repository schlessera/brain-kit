/**
 * walkLinks reads the edges and their nodes from one snapshot, so another
 * process rewriting the index in between cannot split them apart.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDatabase } from "../src/lib/db";
import { walkLinks } from "../src/lib/link-walk";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;
let reader: Database;
let writer: Database;

beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  reader = openDatabase(`${root}/brain.db`);
  writer = openDatabase(`${root}/brain.db`);
});

afterAll(() => {
  reader?.close();
  writer?.close();
  cleanup(root);
});

test("a document deleted between the traversal and the node lookup still has its node", () => {
  const { edges, nodes } = walkLinks(reader, { path: "me/identity.md", depth: 1, direction: "outgoing" }, () => {
    // Another connection, like a `brain index` in another process, drops a
    // target the traversal has already reported as resolved.
    writer.run("DELETE FROM documents WHERE path = 'context/current-focus.md'");
    expect(writer.prepare("SELECT COUNT(*) AS n FROM documents WHERE path = 'context/current-focus.md'").get()).toEqual({ n: 0 });
  });
  expect(edges).toContainEqual({ source: "me/identity.md", target: "context/current-focus.md", resolved: true });
  expect(nodes.map((n) => n.path)).toEqual(["context/current-focus.md", "me/basics/short-bio.md", "me/identity.md"]);
});
