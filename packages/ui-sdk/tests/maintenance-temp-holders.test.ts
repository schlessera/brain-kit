import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceTempBusyError, reserveMaintenanceTemp, type MaintenanceTempReservation } from "../src/server/maintenance-temp-budget";
import { prepareWorkerSandboxAsync } from "../src/server/worker-launcher";
import { FIRST_PARTY_FAILURE_CLASSES } from "../src/protocol";

// #3461: production limits (one 256 MiB allowance in a 256 MiB budget) on a
// private shared-state domain, so no other test's ledger is involved.
const LIMITS = { allowanceBytes: 268435456, budgetBytes: 268435456 };
let root: string;
let domain: { statePath: string };
const held: MaintenanceTempReservation[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-maintenance-holders-")));
  mkdirSync(join(root, "state"));
  domain = { statePath: join(root, "state", "ui.db") };
});
afterEach(() => {
  for (const reservation of held.splice(0)) reservation.release();
  rmSync(root, { recursive: true, force: true });
});
const hold = (kind: Parameters<typeof reserveMaintenanceTemp>[2]) => {
  const reservation = reserveMaintenanceTemp(LIMITS, domain, kind); held.push(reservation); return reservation;
};
const refusal = (kind: Parameters<typeof reserveMaintenanceTemp>[2] = "index") => {
  try { held.push(reserveMaintenanceTemp(LIMITS, domain, kind)); } catch (error) { return error; }
  throw Error("admission unexpectedly succeeded");
};

test("a busy refusal names its holders by kind, without paths or identities", () => {
  hold("scratch_query");
  const error = refusal() as MaintenanceTempBusyError;
  expect(error, "MAINTENANCE_BUSY_IS_A_TYPED_REFUSAL").toBeInstanceOf(MaintenanceTempBusyError);
  expect(error.errorClass, "MAINTENANCE_BUSY_KEEPS_WORKER_STATE_BUSY").toBe(FIRST_PARTY_FAILURE_CLASSES.worker_state_busy);
  expect(error.name, "MAINTENANCE_BUSY_KEEPS_ITS_SERIALIZED_CLASS_NAME").toBe("WorkerStateError");
  expect(error.holders, "MAINTENANCE_BUSY_NAMES_HOLDER_KIND").toEqual(["scratch query"]);
  expect(error.message, "MAINTENANCE_BUSY_MESSAGE_NAMES_HOLDER_KIND").toBe("Maintenance temporary storage is busy: this command needs 256 MiB, "
    + "1 maintenance reservations hold 256 MiB of the separate 256 MiB budget (held by: scratch query). "
    + "Nothing ran. Retry after a maintenance command finishes; no agent runtime state was lost.");
  expect(error.message, "MAINTENANCE_BUSY_MESSAGE_HAS_NO_PATH").not.toContain(root);
  expect(error.message, "MAINTENANCE_BUSY_MESSAGE_HAS_NO_PROCESS_IDENTITY").not.toContain(String(process.pid));
});

test("several holders are counted per kind", () => {
  const limits = { allowanceBytes: 4096, budgetBytes: 4096 * 3 };
  for (const kind of ["git", "sync", "git"] as const) held.push(reserveMaintenanceTemp(limits, domain, kind));
  let error: MaintenanceTempBusyError | undefined;
  try { held.push(reserveMaintenanceTemp(limits, domain, "index")); } catch (caught) { error = caught as MaintenanceTempBusyError; }
  expect(error?.holders, "MAINTENANCE_BUSY_COUNTS_HOLDERS_PER_KIND").toEqual(["git ×2", "sync"]);
});

test("a ledger an earlier release created gains the kind column and labels its rows unlabelled", () => {
  // The ledger an earlier release creates for this state identity, with one live row of its own.
  const statePath = domain.statePath;
  const file = join(root, "state", `.brain-maintenance-${createHash("sha256").update(statePath).digest("hex").slice(0, 24)}.db`);
  const legacy = new Database(file);
  try {
    legacy.exec("CREATE TABLE reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, owner TEXT NOT NULL, worker TEXT, released INTEGER NOT NULL DEFAULT 0)");
    const stat = readFileSync("/proc/self/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const owner = { pid: process.pid, start: fields[19], boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), namespace: readlinkSync("/proc/self/ns/pid") };
    legacy.query("INSERT INTO reservations (id, bytes, owner) VALUES (?, ?, ?)").run("legacy-row", LIMITS.allowanceBytes, JSON.stringify(owner));
  } finally { legacy.close(); }
  chmodSync(file, 0o600);
  expect((refusal() as MaintenanceTempBusyError).holders, "LEGACY_LEDGER_ROWS_ARE_UNLABELLED").toEqual(["unlabelled"]);
  const db = new Database(file);
  try {
    expect((db.query("PRAGMA table_info(reservations)").all() as { name: string }[]).map(column => column.name), "LEGACY_LEDGER_GAINS_KIND_COLUMN").toContain("kind");
    db.query("DELETE FROM reservations WHERE id = 'legacy-row'").run();
  } finally { db.close(); }
});

test("freed() settles on an in-process release and rejects with its signal's reason", async () => {
  const holder = hold("scratch_query");
  const error = refusal() as MaintenanceTempBusyError;
  let settled = false;
  const freed = error.freed().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled, "MAINTENANCE_FREED_WAITS_WHILE_HELD").toBe(false);
  holder.release();
  await freed;
  expect(settled, "MAINTENANCE_FREED_SETTLES_ON_RELEASE").toBe(true);

  hold("scratch_query");
  const again = refusal() as MaintenanceTempBusyError;
  const ending = new AbortController(), reason = new Error("Server shutting down");
  const waiting = again.freed(ending.signal);
  ending.abort(reason);
  await expect(waiting, "MAINTENANCE_FREED_ENDS_WITH_ITS_SIGNAL").rejects.toBe(reason);
});

test("opposite order: a turn's scratch check refused while an index holds the budget stays read-only and names the index", async () => {
  const brain = join(root, "brain");
  mkdirSync(brain);
  hold("index");
  const sandbox = await prepareWorkerSandboxAsync(brain, { areas: ["scratch"], maintenance: { tempLimits: LIMITS, tempDomain: domain } });
  const scratch = sandbox.areas.find(area => area.name === "scratch");
  expect(scratch?.mount.writable, "TURN_SCRATCH_CHECK_LOSES_TO_HELD_INDEX").toBe(false);
  const reason = scratch?.mount.writable === false ? scratch.mount.reason : "";
  expect(reason, "TURN_SCRATCH_CHECK_KEEPS_ITS_DOCUMENTED_OUTCOME")
    .toStartWith(".brain/scratch/ could not be checked (Maintenance temporary storage is busy: ");
  expect(reason, "TURN_SCRATCH_CHECK_NAMES_THE_INDEX_HOLDER").toContain("(held by: index)");
});
