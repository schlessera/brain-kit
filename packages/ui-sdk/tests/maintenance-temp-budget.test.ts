import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reserveMaintenanceTemp, type MaintenanceTempReservation } from "../src/server/maintenance-temp-budget";
import { hostMaintenanceTempLimits } from "../src/server/maintenance-temp-limits";
import { resolveMaintenanceTempLimits } from "../src/server/worker-state-limits";
import { ledgerChildLine } from "./maintenance-temp-ledger-protocol";

const DEFAULT = 268435456;
const CHILD = join(import.meta.dir, "maintenance-temp-ledger-child.ts");
const children: ReturnType<typeof Bun.spawn>[] = [];
const detached: { pid: number; start: string }[] = [];
const reservations: MaintenanceTempReservation[] = [];
const roots: string[] = [];
const start = (pid: number) => {
  try { const raw = readFileSync(`/proc/${pid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]; }
  catch { return undefined; }
};
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; }
  for (const child of detached.splice(0)) if (start(child.pid) === child.start) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
  for (const reservation of reservations.splice(0)) reservation.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function reserve(allowanceBytes = DEFAULT, budgetBytes = DEFAULT) {
  const reservation = reserveMaintenanceTemp({ allowanceBytes, budgetBytes });
  reservations.push(reservation); return reservation;
}
type Receipt = { admitted: boolean; attached?: boolean; error?: string; waiting?: boolean; errorClass?: string; id?: string; directory?: string; pid?: number; worker?: { attached: boolean; pid: number } };
async function spawn(role: string, allowanceBytes = DEFAULT, budgetBytes = DEFAULT, action = "hold", marker?: string) {
  const child = Bun.spawn([process.execPath, CHILD, role, JSON.stringify({ allowanceBytes, budgetBytes }), action, ...(marker ? [marker] : [])], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const receipt = JSON.parse(await ledgerChildLine(child, role)) as Receipt;
  if (receipt.worker?.attached) detached.push({ pid: receipt.worker.pid, start: start(receipt.worker.pid)! });
  return { child, receipt };
}
async function attach(reservation: MaintenanceTempReservation) {
  const child = Bun.spawn([process.execPath, CHILD, "attach", JSON.stringify(reservation)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return { child, receipt: JSON.parse(await ledgerChildLine(child, "attach")) as Receipt };
}
function rows(reservation: MaintenanceTempReservation) {
  const db = new Database(join(reservation.directory, "reservations.db"));
  try { return db.query("SELECT id, bytes, released FROM reservations WHERE id = ?").all(reservation.id); }
  finally { db.close(); }
}
function changeOwner(reservation: MaintenanceTempReservation, changes: Record<string, unknown>) {
  const db = new Database(join(reservation.directory, "reservations.db"));
  try {
    const row = db.query("SELECT owner FROM reservations WHERE id = ?").get(reservation.id) as { owner: string };
    db.query("UPDATE reservations SET owner = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.owner), ...changes }), reservation.id);
  } finally { db.close(); }
}

test("maintenance defaults and positive overrides are independent of agent session concurrency", () => {
  expect(hostMaintenanceTempLimits({ MAX_CONCURRENT_SESSIONS: "99" })).toEqual({ allowanceBytes: DEFAULT, budgetBytes: DEFAULT });
  expect(hostMaintenanceTempLimits({ BRAIN_UI_MAINTENANCE_TEMP_BYTES: "4096", BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES: "8192" })).toEqual({ allowanceBytes: 4096, budgetBytes: 8192 });
  for (const value of [0, -4096, 1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, null]) {
    expect(() => resolveMaintenanceTempLimits({ allowanceBytes: value as number })).toThrow();
    expect(() => resolveMaintenanceTempLimits({ budgetBytes: value as number })).toThrow();
  }
  for (const value of ["-4096", "1e6", "4096.0", "NaN", "8192KiB"]) expect(() => hostMaintenanceTempLimits({ BRAIN_UI_MAINTENANCE_TEMP_BYTES: value })).toThrow("digits only");
  expect(() => reserveMaintenanceTemp({ allowanceBytes: 8192, budgetBytes: 4096 })).toThrow("cover at least one");
});

test("full allowances remain fixed across configuration changes and release is idempotent", () => {
  const first = reserve();
  expect(rows(first)).toMatchObject([{ bytes: DEFAULT, released: 0 }]);
  expect(() => reserveMaintenanceTemp({ allowanceBytes: 4096, budgetBytes: DEFAULT }), "MAINTENANCE_LEDGER_ADMISSION").toThrow("Maintenance temporary storage is busy");
  const second = reserve(DEFAULT, 2 * DEFAULT);
  expect(() => reserveMaintenanceTemp({ allowanceBytes: DEFAULT, budgetBytes: DEFAULT })).toThrow("busy");
  first.release(); first.release();
  expect(rows(first), "MAINTENANCE_LEDGER_RELEASE").toEqual([]);
  expect(() => reserveMaintenanceTemp({ allowanceBytes: DEFAULT, budgetBytes: DEFAULT })).toThrow("busy");
  second.release();
  const next = reserve(); expect(rows(next)).toHaveLength(1);
});

test("a second real process refuses before its post-admission code; a raised budget admits parallel callers", async () => {
  const root = mkdtempSync("/tmp/odysseus-maintenance-ledger-"); roots.push(root);
  const first = await spawn("reserve"); expect(first.receipt.admitted).toBe(true);
  const refused = await spawn("reserve", DEFAULT, DEFAULT, "exit", join(root, "refused"));
  expect(refused.receipt, "MAINTENANCE_CROSS_PROCESS_ADMISSION").toMatchObject({ admitted: false, errorClass: "worker_state_busy" });
  expect(await refused.child.exited).toBe(0);
  expect(existsSync(join(root, "refused")), "REFUSED_MAINTENANCE_RAN_NOTHING").toBe(false);
  const second = await spawn("reserve", DEFAULT, 2 * DEFAULT, "hold", join(root, "admitted"));
  expect(second.receipt.admitted).toBe(true); expect(existsSync(join(root, "admitted"))).toBe(true);
  first.child.stdin!.end(); expect(await first.child.exited).toBe(0);
  second.child.stdin!.end(); expect(await second.child.exited).toBe(0);
  const restored = reserve(); expect(rows(restored)).toHaveLength(1);
});

test("simultaneous admissions from two owned processes atomically admit at most one default allowance", async () => {
  const callers = await Promise.all([spawn("race-reserve"), spawn("race-reserve")]);
  expect(callers.map(caller => caller.receipt.waiting)).toEqual([true, true]);
  await Promise.all(callers.map(async caller => { await caller.child.stdin!.write("go\n"); await caller.child.stdin!.flush(); }));
  const receipts = await Promise.all(callers.map(async caller => JSON.parse(await ledgerChildLine(caller.child, "race reserve")) as Receipt));
  expect(receipts.filter(receipt => receipt.admitted), "SIMULTANEOUS_MAINTENANCE_ADMISSION").toHaveLength(1);
  expect(receipts.filter(receipt => receipt.errorClass === "worker_state_busy")).toHaveLength(1);
  for (const caller of callers) caller.child.stdin!.end();
  expect(await Promise.all(callers.map(caller => caller.child.exited))).toEqual([0, 0]);
});

test("a crashed reservation owner is recovered by the next process before fresh admission", async () => {
  const first = await spawn("reserve", DEFAULT, DEFAULT, "crash");
  expect(first.receipt.admitted).toBe(true); expect(await first.child.exited).toBe(9);
  const next = await spawn("reserve", DEFAULT, DEFAULT, "exit");
  expect(next.receipt, "MAINTENANCE_OWNER_CRASH_RECOVERY").toMatchObject({ admitted: true });
  expect(await next.child.exited).toBe(0);
});

test("parent death preserves an attached live worker, then recovers after that worker exits", async () => {
  const first = await spawn("owner-with-worker");
  expect(first.receipt.worker?.attached).toBe(true);
  first.child.kill("SIGKILL"); await first.child.exited;
  expect(() => reserveMaintenanceTemp({ allowanceBytes: DEFAULT, budgetBytes: DEFAULT }), "LIVE_WORKER_SURVIVES_OWNER_ACCOUNTING").toThrow("busy");
  const worker = detached.at(-1)!;
  process.kill(worker.pid, "SIGKILL");
  for (let i = 0; i < 100; i++) {
    const stat = (() => { try { return readFileSync(`/proc/${worker.pid}/stat`, "utf8"); } catch { return ""; } })();
    if (!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
    await Bun.sleep(10);
  }
  const next = reserve();
  expect(rows(next), "ATTACHED_WORKER_CRASH_RECOVERY").toHaveLength(1);
});

test("PID reuse and an earlier boot are positively stale, while a foreign PID namespace stays unverified", () => {
  for (const changes of [{ start: "0" }, { boot: "odysseus-earlier-boot" }]) {
    const old = reserve(); changeOwner(old, changes);
    const next = reserve(); expect(rows(old), "STALE_MAINTENANCE_IDENTITY_RECOVERED").toEqual([]);
    next.release(); old.release();
  }
  const unknown = reserve(); changeOwner(unknown, { namespace: "pid:[0]" });
  expect(() => reserveMaintenanceTemp({ allowanceBytes: DEFAULT, budgetBytes: DEFAULT }), "UNKNOWN_MAINTENANCE_OWNER_RETAINED").toThrow("busy");
  unknown.release(); expect(rows(unknown)).toEqual([]);
});

test("attachment is single-use and release keeps a live child counted until exit", async () => {
  const pending = reserve();
  const worker = await attach(pending);
  expect(worker.receipt.attached).toBe(true);
  const duplicate = await attach(pending);
  expect(duplicate.receipt).toMatchObject({ attached: false, error: "maintenance admission no longer belongs to a live launcher" });
  expect(await duplicate.child.exited).toBe(0);
  pending.release(); pending.release();
  expect(rows(pending), "RELEASE_PRESERVES_ATTACHED_LIVE_CHILD").toMatchObject([{ bytes: DEFAULT, released: 1 }]);
  expect(() => reserveMaintenanceTemp({ allowanceBytes: DEFAULT, budgetBytes: DEFAULT })).toThrow("busy");
  worker.child.kill("SIGKILL"); await worker.child.exited;
  const next = reserve();
  expect(rows(pending)).toEqual([]); next.release();
  const late = await attach(pending);
  expect(late.receipt.attached, "RELEASED_ADMISSION_CANNOT_START_A_CHILD").toBe(false);
  expect(await late.child.exited).toBe(0);
});


test("shared operational-state identity survives caller recreation, aliases and UI database provisioning without changing access", () => {
  const root=mkdtempSync("/tmp/odysseus-maintenance-state-");roots.push(root);
  const state=join(root,"state");mkdirSync(state);
  const statePath=join(state,"ui.db"); const domain={statePath};
  const before=lstatSync(state); const limits={allowanceBytes:DEFAULT,budgetBytes:DEFAULT};
  const first=reserveMaintenanceTemp(limits,domain);reservations.push(first);
  expect(existsSync(statePath),"admission must not provision the UI database before successful boot").toBe(false);
  writeFileSync(statePath,"existing host operational state",{mode:0o600});
  const fileBefore=lstatSync(statePath);symlinkSync(statePath,join(root,"state-alias"));
  expect(()=>reserveMaintenanceTemp(limits,{statePath:join(root,"state-alias")}),"SHARED_STATE_ALIAS_ADMISSION").toThrow("busy");
  expect(()=>reserveMaintenanceTemp(limits,{statePath}),"RECREATED_SHARED_STATE_ADMISSION").toThrow("busy");
  const parallel=reserveMaintenanceTemp({allowanceBytes:DEFAULT,budgetBytes:2*DEFAULT},{statePath});reservations.push(parallel);
  first.release();first.release();
  expect(()=>reserveMaintenanceTemp(limits,{statePath})).toThrow("busy");
  parallel.release();const restored=reserveMaintenanceTemp(limits,{statePath});reservations.push(restored);restored.release();
  expect(readFileSync(statePath,"utf8")).toBe("existing host operational state");
  const fileAfter=lstatSync(statePath),after=lstatSync(state);
  expect([fileAfter.uid,fileAfter.gid,fileAfter.mode,fileAfter.ino]).toEqual([fileBefore.uid,fileBefore.gid,fileBefore.mode,fileBefore.ino]);
  expect([after.uid,after.gid,after.mode,after.ino]).toEqual([before.uid,before.gid,before.mode,before.ino]);
});


test("a live owner hidden by procfs is held rather than mistaken for a crashed reservation", () => {
  const first=reserve();const read=fs.readFileSync;
  const hidden=spyOn(fs,"readFileSync").mockImplementation(((path: Parameters<typeof read>[0],...args: unknown[])=>{
    if(path===`/proc/${process.pid}/stat`) throw Object.assign(new Error("owned process is hidden"),{code:"ENOENT"});
    return (read as (...args: unknown[])=>unknown)(path,...args);
  }) as typeof read);
  try { expect(()=>reserveMaintenanceTemp({allowanceBytes:DEFAULT,budgetBytes:DEFAULT}),"UNVERIFIED_LIVE_OWNER_RETAINED").toThrow("busy"); }
  finally { hidden.mockRestore(); first.release(); }
});
