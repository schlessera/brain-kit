import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { countExecutions } from "./statement-counter";

test("the statement counter counts a cached statement once per execution, and nothing after restore", () => {
  const db = new Database(":memory:");
  try {
    const counter = countExecutions(db);
    db.query("SELECT 1").get();
    db.query("SELECT 1").get();
    db.prepare("SELECT 2").all();
    db.run("SELECT 3");
    expect(counter.count()).toBe(4);
    counter.restore();
    expect(db.query("SELECT 1").get()).toEqual({ "1": 1 });
    db.prepare("SELECT 2").get();
    expect(counter.count()).toBe(4);
  } finally {
    db.close();
  }
});
