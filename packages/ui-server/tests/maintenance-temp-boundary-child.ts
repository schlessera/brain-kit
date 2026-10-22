/** Independent server/cron boundary caller; only ordinary maintenance code runs. */
import { writeSync } from "node:fs";
import { basename } from "node:path";
import { createHostExecution } from "../src/brain/host-execution";
import { createUiDb } from "../src/db/client";
import { ledgerChildLine } from "../../ui-sdk/tests/maintenance-temp-ledger-protocol";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
const [brainPath, marker, role, raw, dbPath, fault] = process.argv.slice(2);
const answer = (value: unknown) => writeSync(1, `${JSON.stringify(value)}\n`);
const phase = (name: string) => writeSync(2, `maintenance-boundary phase=${name}\n`);
phase("native-fixture");
const native = createNativeAppFixture(brainPath!);
phase("host-create");
const host = createHostExecution({ nativeManager: createNativeBrainManagerClient(native.nativeBrain), brainPath: brainPath!, dbPath: dbPath!, maintenanceTemp: JSON.parse(raw!), requireGate: true });
phase("db-open");
const db = createUiDb(dbPath!);
phase("host-attach");
host.attach(db);
const boundary = host.boundary;
const controller = new AbortController();
// Fault injection is test-only and still executes all ordinary worker mask checks.
const heldProgram = fault === "stderr-exit"
  ? 'fs.writeSync(2,"\\u0001".repeat(1024*1024)+"ODYSSEUS_INNER_STDERR_SENTINEL\\n");process.exit(23);'
  : 'console.log(JSON.stringify({held:true}));setInterval(() => {},1000);';
const program = `const fs=require("node:fs"),temp=fs.statfsSync("/tmp"); if(fs.existsSync(${JSON.stringify(dbPath)}) || temp.type!==0x01021994 || temp.blocks*temp.bsize!==${JSON.parse(raw!).allowanceBytes}) throw new Error("maintenance did not run in its admitted filesystem"); fs.writeFileSync(process.env.BRAIN_ROOT+"/"+${JSON.stringify(basename(marker!))}, "${role} ran"); ${role === "server" ? heldProgram : ''}`;
const execution = { argv: [process.execPath, "-e", program], env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared" as const, purpose: `${role} temporary admission`, signal: controller.signal, timeoutMs: 10_000 };
let running: Awaited<ReturnType<typeof boundary.launch>> | undefined;
let exited = false;
try {
  if (role === "server") {
    phase("server-launch");
    running = await boundary.launch(execution);
    void running.exited.then(() => { exited = true; });
    // Reserve room for both streams and worst-case JSON escaping in the outer 8 KiB tail.
    const receipt = JSON.parse(await ledgerChildLine(running, "inner server hold", 512));
    if (receipt.held !== true) throw new Error("owned maintenance command did not start");
    answer({ held: true });
    await Bun.stdin.text(); controller.abort();
    await running.exited;
  } else {
    phase("cron-run");
    try { const result = await boundary.run(execution); answer({ admitted: true, result }); }
    catch (error) { answer({ admitted: false, errorClass: (error as {errorClass?:string}).errorClass, error: String(error) }); }
  }
} catch (error) {
  // Publish the bounded evidence before cleanup can change the worker signal.
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  try {
    if (running) { if (!exited) running.kill("SIGKILL"); await running.exited; }
  } finally {
    phase("close");
    try { host.release(); } finally { try { db.close(); } finally { await native.close(); } }
  }
}
