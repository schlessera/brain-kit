import { expect, test } from "bun:test";
import { expectRejection } from "./helpers/expect-rejection.js";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import * as probe from "./fixtures/write-worker-probe.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "write-worker-odysseus-")), path = join(root, "ui.db"), db = createUiDb(path), writer = openSqliteWriter(db);
  const log = (table = "odysseus_log") => (db.query(`SELECT label FROM ${table} ORDER BY n`).all() as { label: string }[]).map(row => row.label);
  return { root, path, db, writer, log, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a file database commits on the write worker while the event loop keeps running", async () => {
  const f = fixture();
  try {
    const voyage = f.writer.channel(probe, { table: "odysseus_log" }); await voyage.ready;
    expect(f.writer.offloop, "WRITE_WORKER_OFFLOOP_FOR_FILES").toBe(true);
    let last = performance.now(), worst = 0;
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    try { expect(await voyage.call<number>("slow", "Ithaca", 400)).toBe(1); } finally { clearInterval(timer); }
    // An inline commit holds the loop for the whole 400 ms; the worker's leaves it free.
    expect(worst, "WRITE_WORKER_COMMIT_LEAVES_EVENT_LOOP").toBeLessThan(300);
    expect(f.log()).toEqual(["Ithaca"]);
  } finally { await f.close(); }
});

test("every write-worker commit runs at synchronous=FULL and a lowered commit is refused before it lands", async () => {
  const f = fixture();
  try {
    const voyage = f.writer.channel(probe, { table: "odysseus_log" }); await voyage.ready;
    expect(await voyage.call<number>("level"), "WRITE_WORKER_CONNECTION_FULL").toBe(2);
    await voyage.call("log", "Troy");
    await expectRejection(voyage.call("lowered", "Calypso"), "SQLITE_WRITE_BELOW_FULL", "WRITE_WORKER_REFUSES_TRANSACTION_BELOW_FULL");
    expect(f.log(), "WRITE_WORKER_REFUSED_COMMIT_ROLLED_BACK").toEqual(["Troy"]);
    await expectRejection(voyage.call("loweredAutocommit", "Circe"), "SQLITE_WRITE_BELOW_FULL", "WRITE_WORKER_REPORTS_AUTOCOMMIT_BELOW_FULL");
    expect(await voyage.call<number>("level"), "WRITE_WORKER_RESTORES_FULL").toBe(2);
    await voyage.call("log", "Ithaca");
    expect(f.log().at(-1)).toBe("Ithaca");
  } finally { await f.close(); }
});

test("writes reach the database in submission order across channels, and refusals keep their fields", async () => {
  const f = fixture();
  try {
    const voyage = f.writer.channel(probe, { table: "odysseus_log" }), crew = f.writer.channel(probe, { table: "odysseus_log" });
    // Nothing is awaited: the first call holds the worker while the rest queue.
    const submitted: string[] = [], calls: Promise<unknown>[] = [voyage.call("slow", "Troy", 100)];
    submitted.push("Troy");
    for (let index = 0; index < 60; index++) {
      const label = `${index % 2 ? "crew" : "voyage"}-${index}`;
      submitted.push(label); calls.push((index % 2 ? crew : voyage).call("log", label));
    }
    await Promise.all(calls);
    expect(f.log(), "WRITE_WORKER_SUBMISSION_ORDER").toEqual(submitted);
    const refusal = await expectRejection(voyage.call("refuse", "Penelope waits"), "Penelope waits") as Error & { reason?: string };
    expect(refusal.reason, "WRITE_WORKER_REFUSAL_FIELDS").toBe("odysseus_refused");
  } finally { await f.close(); }
});

test("an app-connection transaction that reads, then writes, waits for its turn instead of failing", async () => {
  const f = fixture();
  try {
    const voyage = f.writer.channel(probe, { table: "odysseus_log" }); await voyage.ready;
    f.db.exec("CREATE TABLE IF NOT EXISTS odysseus_harbour (port TEXT)");
    // The worker commits while the app's transaction sits between its read and its write.
    const commit = voyage.call("slow", "Aeolus", 150);
    await Bun.sleep(20);
    f.db.transaction(() => {
      f.db.query("SELECT count(*) FROM odysseus_log").get();
      Bun.sleepSync(300);
      f.db.query("INSERT INTO odysseus_harbour VALUES ('Ithaca')").run();
    })();
    await commit;
    expect(f.db.query("SELECT port FROM odysseus_harbour").all(), "WRITE_WORKER_APP_TRANSACTION_TAKES_ITS_TURN").toEqual([{ port: "Ithaca" }]);
  } finally { await f.close(); }
});

test("app writes, autocommit or not, never land while a worker procedure runs", async () => {
  const f = fixture();
  try {
    const voyage = f.writer.channel(probe, { table: "odysseus_log" }); await voyage.ready;
    const gap = voyage.call<[number, number]>("gap", 300);
    await Bun.sleep(50);
    f.db.query("INSERT INTO odysseus_log (label) VALUES ('Aeolus')").run();
    f.db.transaction(() => f.db.query("INSERT INTO odysseus_log (label) VALUES ('Circe')").run())();
    f.db.run("INSERT INTO odysseus_log (label) VALUES ('Scylla')");
    const [before, after] = await gap;
    expect(after, "WRITE_WORKER_APP_WRITES_WAIT_FOR_THEIR_TURN").toBe(before);
    expect(f.log()).toEqual(["Aeolus", "Circe", "Scylla"]);
  } finally { await f.close(); }
});

test("a read-only app snapshot keeps its deferred mode and never holds the write lock", async () => {
  const f = fixture();
  try {
    const voyage = f.writer.channel(probe, { table: "odysseus_log" }); await voyage.ready;
    const other = new Database(f.path); other.exec("PRAGMA busy_timeout = 0");
    try {
      // Another connection still writes while the app connection reads its snapshot.
      f.db.transaction(() => {
        f.db.query("SELECT count(*) FROM odysseus_log").get();
        other.query("INSERT INTO odysseus_log (label) VALUES ('Penelope')").run();
      })();
      expect(f.log(), "WRITE_WORKER_READ_SNAPSHOT_STAYS_DEFERRED").toEqual(["Penelope"]);
    } finally { other.close(); }
  } finally { await f.close(); }
});

test("an attached database file is owned by the same write connection, at FULL", async () => {
  const root = mkdtempSync(join(tmpdir(), "write-worker-attach-odysseus-")), path = join(root, "ui.db"), journalPath = join(root, "journal.db");
  const db = createUiDb(path);
  db.query("ATTACH DATABASE ? AS journal").run(journalPath); db.exec("PRAGMA journal.journal_mode = WAL");
  const writer = openSqliteWriter(db, { attach: [{ schema: "journal", path: journalPath }] });
  try {
    const voyage = writer.channel(probe, { table: "journal.odysseus_log" }); await voyage.ready;
    expect(await voyage.call<number>("levelOf", "journal"), "WRITE_WORKER_ATTACHED_FULL").toBe(2);
    await voyage.call("log", "Ithaca");
    const separate = new Database(journalPath, { readonly: true });
    try { expect((separate.query("SELECT label FROM odysseus_log").all() as { label: string }[]).map(row => row.label), "WRITE_WORKER_COMMITS_ATTACHED_FILE").toEqual(["Ithaca"]); }
    finally { separate.close(); }
    await expectRejection(voyage.call("loweredIn", "journal", "Calypso"), "SQLITE_WRITE_BELOW_FULL", "WRITE_WORKER_REFUSES_ATTACHED_BELOW_FULL");
    expect(await voyage.call<number>("levelOf", "journal"), "WRITE_WORKER_RESTORES_ATTACHED_FULL").toBe(2);
    expect((db.query("SELECT label FROM journal.odysseus_log").all() as { label: string }[]).map(row => row.label)).toEqual(["Ithaca"]);
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an in-memory database runs the same procedures inline", async () => {
  const db = new Database(":memory:"), writer = openSqliteWriter(db);
  try {
    const voyage = writer.channel(probe, { table: "odysseus_log" }); await voyage.ready;
    expect(writer.offloop).toBe(false);
    await Promise.all([voyage.call("log", "Aeolus"), voyage.call("log", "Scylla")]);
    expect((db.query("SELECT label FROM odysseus_log ORDER BY n").all() as { label: string }[]).map(row => row.label)).toEqual(["Aeolus", "Scylla"]);
  } finally { await writer.close(); db.close(); }
});

test("an idle write worker does not keep its process alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "write-worker-exit-odysseus-"));
  try {
    const script = join(root, "idle.ts");
    writeFileSync(script, `import { createUiDb } from ${JSON.stringify(join(import.meta.dir, "../src/db/client.ts"))};
import { openSqliteWriter } from ${JSON.stringify(join(import.meta.dir, "../src/db/write-worker.ts"))};
import * as probe from ${JSON.stringify(join(import.meta.dir, "fixtures/write-worker-probe.ts"))};
const db = createUiDb(${JSON.stringify(join(root, "ui.db"))}), voyage = openSqliteWriter(db).channel(probe, { table: "odysseus_log" });
await voyage.call("log", "Ithaca"); console.log("committed");\n`);
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => "running")]);
    if (exited === "running") child.kill();
    expect(exited, "WRITE_WORKER_IDLE_DOES_NOT_HOLD_PROCESS").toBe(0);
    expect(await new Response(child.stdout).text()).toBe("committed\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
