/** Owned process fixture only: exercises ledger admission, no worker or namespace launch. */
import { writeSync, writeFileSync } from "node:fs";
import { attachMaintenanceTemp, reserveMaintenanceTemp, type MaintenanceTempReservation } from "../src/server/maintenance-temp-budget";
import { ledgerLine } from "./maintenance-temp-ledger-protocol";

const [role, raw, action = "hold", marker] = process.argv.slice(2);
const answer = (value: unknown) => writeSync(1, `${JSON.stringify(value)}\n`);
if (role === "attach") {
  try {
    attachMaintenanceTemp(JSON.parse(raw!));
    answer({ attached: true, pid: process.pid });
    // Independent lifetime: an owner crash must not forget this live child.
    setInterval(() => {}, 1000);
  } catch (error) { answer({ attached: false, error: error instanceof Error ? error.message : String(error) }); }
} else {
  if (role === "race-reserve") { answer({ waiting: true, pid: process.pid }); await ledgerLine(Bun.stdin.stream()); }
  let reservation: MaintenanceTempReservation;
  try { reservation = reserveMaintenanceTemp(JSON.parse(raw!)); }
  catch (error) { answer({ admitted: false, errorClass: (error as { errorClass?: string }).errorClass, error: error instanceof Error ? error.message : String(error) }); process.exit(0); }
  if (marker) writeFileSync(marker, "admitted");
  if (role === "owner-with-worker") {
    const worker = Bun.spawn([process.execPath, import.meta.filename, "attach", JSON.stringify(reservation)], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const receipt = JSON.parse(await ledgerLine(worker.stdout));
    answer({ admitted: true, id: reservation.id, directory: reservation.directory, pid: process.pid, worker: receipt });
    await Bun.stdin.text();
    worker.kill("SIGKILL"); await worker.exited;
  } else {
    answer({ admitted: true, id: reservation.id, directory: reservation.directory, pid: process.pid });
    if (action === "crash") process.exit(9);
    if (action === "hold") await Bun.stdin.text();
  }
  reservation.release();
}
