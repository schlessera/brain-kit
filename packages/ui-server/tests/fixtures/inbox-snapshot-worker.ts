// Test-only barriers stop real I/O/transactions at crash boundaries. The parent
// confirms readiness, sends SIGKILL and observes SQLite rollback on reopening.
import { spyOn } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { restoreInboxSnapshot, writeInboxSnapshot } from "../../src/inbox/snapshot.js";

const [mode, dbPath, brainRoot, backup, ready, at, publication = "complete"] = process.argv.slice(2);
Date.now = () => Number(at);
function barrier() {
  if (publication !== "complete") {
    // Hold incomplete bytes until the parent actually observes them, so the
    // regression controls do not depend on process scheduling or a delay.
    const token = publication === "empty" ? "" : mode!.slice(0, -1);
    writeFileSync(ready!, token);
    const deadline = performance.now() + 10_000;
    while (true) {
      let observed: string | undefined;
      try { observed = readFileSync(`${ready}.observed`, "utf8"); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (observed === token) break;
      if (performance.now() >= deadline) throw new Error(`Parent did not observe incomplete ${mode} readiness`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  writeFileSync(ready!, mode!);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Crash barrier unexpectedly resumed");
}
if (mode === "export") {
  const rename = fs.rename;
  spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === backup) barrier();
    return rename(from, to);
  });
  const db = new Database(dbPath!, { readonly: true });
  try { await writeInboxSnapshot(db, brainRoot!, backup!); } finally { db.close(); }
} else {
  const link = fs.link;
  spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (mode === "staging" && String(to).endsWith("harbor.png")) barrier();
    await link(from, to);
    if (mode === "restore-image" && String(to) === dbPath) barrier();
  });
  const query = Database.prototype.query;
  spyOn(Database.prototype, "query").mockImplementation(function<R, P extends SQLQueryBindings | SQLQueryBindings[]>(this: Database, sql: string) {
    if (mode === "reconcile" && sql.startsWith("UPDATE inbox_recovery_state SET status = 'ready'")) barrier();
    return (query<R, P>).call(this, sql);
  });
  const close = Database.prototype.close;
  spyOn(Database.prototype, "close").mockImplementation(function(this: Database, ...args: Parameters<Database["close"]>) {
    if (mode === "committed" && this.filename === dbPath) barrier();
    return close.apply(this, args);
  });
  await restoreInboxSnapshot(JSON.parse(readFileSync(backup!, "utf8")), dbPath!, brainRoot!, Number(at));
}
throw new Error("Crash boundary was not reached");
