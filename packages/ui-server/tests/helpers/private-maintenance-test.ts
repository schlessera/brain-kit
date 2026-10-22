/** Re-execute a real test with an owned default maintenance ledger, preserving /tmp and the caller's UID. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { invocationChild } from "../../../../scripts/test-invocation-child.js";
import { reserveMaintenanceTemp } from "../../../ui-sdk/src/server/maintenance-temp-budget.js";
import { ledgerLine } from "../../../ui-sdk/tests/maintenance-temp-ledger-protocol.js";

const ROOT = resolve(import.meta.dir, "../../../..");
const ENV = "BRAIN_TEST_PRIVATE_MAINTENANCE";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LIMITS = { allowanceBytes: 268435456, budgetBytes: 268435456 };
const defaultLedger = () => `/tmp/brain-maintenance-budget-${process.getuid!()}`;
const inode = (path: string) => { const info = statSync(path); return [info.dev, info.ino]; };
const namespace = (ledger: string, ...command: string[]) => ["unshare", "--user", "--map-current-user", "--keep-caps", "--mount", "bash",
  join(ROOT, "scripts/unit-worker-entry.sh"), ledger, ...command];

async function run(command: string[], timeoutMs: number, env = process.env) {
  const child = invocationChild(command, { cwd: ROOT, env });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const deadline = setTimeout(() => { void child.stop("SIGTERM"); }, timeoutMs);
  try {
    await child.ready;
    const [code, out, err] = await Promise.all([child.exited, stdout, stderr]);
    return { code, out, err };
  } finally {
    clearTimeout(deadline);
    await child.stop("SIGTERM"); await child.finish(); await Promise.allSettled([stdout, stderr]);
  }
}

/** Return true in the outer test; false only in its acknowledged private child. */
export async function privateMaintenanceTest(file: string, name: string, timeoutMs = 30_000): Promise<boolean> {
  const selected = process.env[ENV] ? JSON.parse(process.env[ENV]!) as { file: string; name: string; ledger: string } : undefined;
  if (selected?.file === file && selected.name === name) {
    assert.deepEqual(inode(defaultLedger()), inode(selected.ledger), "MAINTENANCE_TEST_USES_ITS_OWN_LEDGER");
    return false;
  }
  const root = mkdtempSync("/var/tmp/odysseus-maintenance-test-");
  const ledger = join(root, "foreign"), privateLedger = join(root, "private");
  for (const path of [ledger, privateLedger]) mkdirSync(path, { mode: 0o700 });
  try {
    const { code, out, err } = await run(namespace(ledger, process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), import.meta.path, "--hold", file, name, privateLedger, String(timeoutMs)), timeoutMs - 500);
    assert.equal(code, 0, `PRIVATE_MAINTENANCE_TEST_COMPLETES: ${name}\n${out}\n${err}`);
    assert.match(err, /\b1 pass\b/, "PRIVATE_MAINTENANCE_CHILD_EXECUTED_THE_NAMED_TEST");
    return true;
  } finally {
    // A failed/aborted child must release its own reservations too. Retain
    // evidence and fail cleanup rather than deleting any unconfirmed state.
    for (const directory of [ledger, privateLedger]) {
      const file = join(directory, "reservations.db");
      if (!existsSync(file)) continue;
      const db = new Database(file, { readonly: true });
      try { assert.deepEqual(db.query("SELECT id FROM reservations").all(), [], `Unreleased owned maintenance state retained at ${root}`); }
      finally { db.close(); }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main && process.argv[2] === "--reserve") {
  const reservation = reserveMaintenanceTemp(LIMITS);
  const input = Bun.stdin.stream().getReader();
  const stop = () => { void input.cancel().catch(() => {}); };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  try {
    console.log(JSON.stringify({ admitted: true, id: reservation.id, pid: process.pid }));
    while (!(await input.read()).done) { /* Parent lifetime pipe; EOF or cancellation releases only this reservation. */ }
  } finally {
    try { await input.cancel(); input.releaseLock(); reservation.release(); }
    finally { for (const signal of signals) process.off(signal, stop); }
  }
}

if (import.meta.main && process.argv[2] === "--hold") {
  const [file, name, ledger, timeout] = process.argv.slice(3) as [string, string, string, string];
  const holder = Bun.spawn([process.execPath, import.meta.path, "--reserve"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(holder.stderr).text();
  let db: Database | undefined;
  try {
    const receipt = JSON.parse(await ledgerLine(holder.stdout)) as { admitted: boolean; id: string; pid: number };
    assert.equal(receipt.admitted, true, "FOREIGN_MAINTENANCE_HOLDER_ACKNOWLEDGED");
    db = new Database(join(defaultLedger(), "reservations.db"));
    const held = () => {
      assert.equal(holder.exitCode, null, "FOREIGN_MAINTENANCE_HOLDER_STILL_LIVE");
      process.kill(receipt.pid, 0);
      assert.deepEqual(db!.query("SELECT bytes,released FROM reservations WHERE id=?").get(receipt.id), { bytes: LIMITS.allowanceBytes, released: 0 }, "FOREIGN_MAINTENANCE_RESERVATION_STILL_HELD");
    };
    held();
    const parent = statSync(defaultLedger());
    console.log("OWNED_MAINTENANCE_HOLDER_ACK", JSON.stringify({ directory: defaultLedger(), uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!(),
      parent: { uid: parent.uid, gid: parent.gid, mode: parent.mode & 0o777 }, row: db.query("SELECT * FROM reservations WHERE id=?").get(receipt.id) }));
    assert.throws(() => reserveMaintenanceTemp(LIMITS), { errorClass: "worker_state_busy" }, "SAME_DOMAIN_MAINTENANCE_STILL_REFUSES");
    assert.notDeepEqual(inode(defaultLedger()), inode(ledger), "FOREIGN_AND_TEST_LEDGERS_ARE_DISTINCT");
    // Invoke the normal test wrapper directly: Bun's run builtin closes the
    // lease FD, and a nested user namespace cannot read its outer owner's FD.
    const result = await run(namespace(ledger, process.execPath, join(ROOT, "scripts/test.ts"), "--timeout", timeout, file, "-t", `${escape(name)}$`), Number(timeout) - 1_000,
      { ...process.env, [ENV]: JSON.stringify({ file, name, ledger }) });
    process.stdout.write(result.out); process.stderr.write(result.err);
    held();
    console.log("OWNED_MAINTENANCE_HOLDER_STILL_RESERVED");
    assert.equal(result.code, 0, "ISOLATED_TEST_PASSES_WHILE_FOREIGN_RESERVATION_IS_LIVE");
  } finally {
    holder.stdin.end();
    const deadline = setTimeout(() => holder.kill("SIGKILL"), 5_000);
    try {
      assert.equal(await holder.exited, 0, `FOREIGN_MAINTENANCE_HOLDER_RELEASED_AND_JOINED: ${await stderr}`);
      if (db) assert.deepEqual(db.query("SELECT id FROM reservations").all(), [], "OWNED_MAINTENANCE_RESERVATIONS_DRAINED");
      console.log("OWNED_MAINTENANCE_HOLDER_RELEASED_AND_JOINED");
    } finally {
      clearTimeout(deadline);
      try { for await (const _chunk of holder.stdout) { /* Drain the receipt stream after its first acknowledged line. */ } await stderr; }
      finally { db?.close(); }
    }
  }
}
