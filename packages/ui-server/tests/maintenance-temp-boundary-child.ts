/** Independent server/cron boundary caller; only ordinary maintenance code runs. */
import { writeSync } from "node:fs";
import { basename } from "node:path";
import { createHostExecution } from "../src/brain/host-execution";
import { createUiDb } from "../src/db/client";
import { ledgerLine } from "../../ui-sdk/tests/maintenance-temp-ledger-protocol";
const [brainPath, marker, role, raw, dbPath] = process.argv.slice(2);
const answer = (value: unknown) => writeSync(1, `${JSON.stringify(value)}\n`);
const host = createHostExecution({ brainPath: brainPath!, dbPath: dbPath!, maintenanceTemp: JSON.parse(raw!), requireGate: true });
const db = createUiDb(dbPath!);
host.attach(db);
const boundary = host.boundary;
const controller = new AbortController();
const program = `const fs=require("node:fs"),temp=fs.statfsSync("/tmp"); if(fs.existsSync(${JSON.stringify(dbPath)}) || temp.type!==0x01021994 || temp.blocks*temp.bsize!==${JSON.parse(raw!).allowanceBytes}) throw new Error("maintenance did not run in its admitted filesystem"); fs.writeFileSync(process.env.BRAIN_ROOT+"/"+${JSON.stringify(basename(marker!))}, "${role} ran"); ${role === "server" ? 'console.log(JSON.stringify({held:true}));setInterval(() => {},1000);' : ''}`;
const execution = { argv: [process.execPath, "-e", program], env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared" as const, purpose: `${role} temporary admission`, signal: controller.signal, timeoutMs: 10_000 };
if (role === "server") {
  const running = await boundary.launch(execution);
  const diagnostic = new Response(running.stderr).text();
  const receipt = JSON.parse(await ledgerLine(running.stdout));
  if (receipt.held !== true) throw new Error("owned maintenance command did not start");
  answer({ held: true });
  await Bun.stdin.text(); controller.abort();
  await running.exited;
  await diagnostic;
} else {
  try { const result = await boundary.run(execution); answer({ admitted: true, result }); }
  catch (error) { answer({ admitted: false, errorClass: (error as {errorClass?:string}).errorClass, error: String(error) }); }
}

host.release(); db.close();
