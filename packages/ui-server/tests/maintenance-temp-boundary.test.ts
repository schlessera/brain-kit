import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createUiDb } from "../src/db/client";
import { ledgerChildLine } from "../../ui-sdk/tests/maintenance-temp-ledger-protocol";
type Receipt = { held?: boolean; admitted?: boolean; errorClass?: string; result?: { exitCode: number; stderr: string } };
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const databases: Database[] = [];
afterEach(async () => { for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; } for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
test("independent server and cron boundary processes share actual worker admission and recover server death", async () => {
  const parent = resolve(import.meta.dir,"../../../tmp"); mkdirSync(parent,{recursive:true});
  const root = mkdtempSync(join(parent,"maintenance-boundary-")); roots.push(root);
  const brain=join(root,"brain"); const state=join(root,"state"); mkdirSync(brain); mkdirSync(state);
  const dbPath=join(state,"ui.db"); createUiDb(dbPath).close();
  const limits = { allowanceBytes: 268435456, budgetBytes: 268435456 };
  const spawn = (role: string, marker: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir,"maintenance-temp-boundary-child.ts"), brain, marker, role, JSON.stringify(limits), dbPath],{stdin:"pipe",stdout:"pipe",stderr:"pipe"}); children.push(child); return child;
  };
  const held = spawn("server",join(brain,"server-marker"));
  expect(JSON.parse(await ledgerChildLine(held, "server hold"))).toEqual({held:true});
  const ledgerFiles=readdirSync(state).filter(name=>name.startsWith(".brain-maintenance-")&&name.endsWith(".db"));
  expect(ledgerFiles,"ACTUAL_BOUNDARY_SHARED_STATE: admission belongs to configured UI state, not caller uid/temp").toHaveLength(1);
  const ledger=new Database(join(state,ledgerFiles[0]!)); databases.push(ledger);
  const entries=()=>ledger.query("SELECT bytes FROM reservations").all();
  expect(entries()).toEqual([{bytes:268435456}]);
  const refusedPath = join(brain,"refused-cron-marker"); const refused = spawn("cron",refusedPath);
  expect(JSON.parse(await ledgerChildLine(refused, "cron refusal")),"ACTUAL_SERVER_CRON_ADMISSION").toMatchObject({admitted:false,errorClass:"worker_state_busy"});
  expect(await refused.exited).toBe(0); expect(existsSync(refusedPath),"REFUSED_CRON_RAN_NOTHING").toBe(false); expect(entries()).toEqual([{bytes:268435456}]);
  held.kill("SIGKILL"); await held.exited;
  let admitted = false;
  const recoveredPath = join(brain,"recovered-cron-marker");
  for (let i=0;i<50;i++) {
    const next = spawn("cron",recoveredPath); const receipt = JSON.parse(await ledgerChildLine(next, `cron recovery ${i + 1}`)) as Receipt; expect(await next.exited).toBe(0);
    if (receipt.admitted) { expect(receipt.result!.exitCode,receipt.result!.stderr).toBe(0); admitted=true; break; }
    expect(receipt.errorClass).toBe("worker_state_busy"); await Bun.sleep(20);
  }
  expect(admitted,"ACTUAL_SERVER_CRASH_RECOVERY").toBe(true);
  expect(readFileSync(recoveredPath,"utf8")).toBe("cron ran");
  expect(entries(),"SHARED_STATE_EXACT_RELEASE").toEqual([]);
});
