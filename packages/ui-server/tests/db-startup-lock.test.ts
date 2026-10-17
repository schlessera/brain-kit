import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { ledgerChildLine } from "../../ui-sdk/tests/maintenance-temp-ledger-protocol";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("UI database startup waits for a real WAL lock before configuring journal mode", async () => {
  const root = mkdtempSync("/tmp/odysseus-ui-startup-lock-"); roots.push(root);
  const path = join(root, "ui.db");
  // Seed in a separate process so no parent SQLite handles can own the lock.
  const seed = Bun.spawnSync([process.execPath, "-e", `import {createUiDb} from ${JSON.stringify(new URL("../src/db/client.ts", import.meta.url).href)}; createUiDb(process.argv[1]).close();`, path], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  expect(seed.exitCode, seed.stderr.toString()).toBe(0);
  const locker = Bun.spawn([process.execPath, "-e", `
    import {Database} from "bun:sqlite";
    import {writeSync} from "node:fs";
    const db=new Database(process.argv[1]);
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO settings(key,value,updated_at) VALUES('odysseus-lock-release','released',1)");
    writeSync(1,"locked\\n");
    // A real independent lock hold: the parent's synchronous SQLite call must wait.
    await Bun.sleep(300);
    db.exec("COMMIT"); db.close();
  `, path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.push(locker);
  expect(await ledgerChildLine(locker, "WAL lock held")).toBe("locked");
  let db: Database | undefined, failure: unknown;
  try { db = createUiDb(path); } catch (error) { failure = error; }
  try {
    expect(await locker.exited).toBe(0);
    expect(failure, "startup must use its existing busy timeout before journal_mode, rather than throw SQLITE_BUSY").toBeUndefined();
    expect(db!.query("SELECT value FROM settings WHERE key='odysseus-lock-release'").get()).toEqual({ value: "released" });
    expect(db!.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db!.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db!.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  } finally { db?.close(); }
});
