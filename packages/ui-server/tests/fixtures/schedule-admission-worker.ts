/**
 * A second process on the same operational database. `admit` races the
 * admission boundary; the crash modes die by SIGKILL at a chosen point of an
 * attempt, so nothing in this process gets to record what happened.
 */
import { existsSync, writeFileSync } from "node:fs";

import { createUiDb } from "../../src/db/client.js";
import { scheduleRuntime, type Script } from "../helpers/schedule-runtime.js";

const [mode, path, root, clock, ready, gate] = process.argv.slice(2) as [string, string, string, string, string, string];
const db = createUiDb(path);
const die = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("unreachable"); };

const script: Script = async (request) => {
  if (mode === "crash-after-effect") {
    // The backend reported its result; the host dies before recording it.
    request.bridge.emit({ type: "text_delta", text: "Ithaca checked." });
    request.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
    die();
  }
};
const h = scheduleRuntime(db, { root, clock: { now: Number(clock) }, script,
  // Called after the start transaction and before the backend acquires its
  // reservation: dying here leaves a started attempt with no possible effect.
  allowedTools: mode === "crash-after-start" ? die : undefined,
  // The Queue claim (lease and reservation) committed; no attempt has started.
  afterClaim: mode === "crash-after-claim" ? die : undefined });
await h.service.ready;
writeFileSync(ready, "ready");
while (!existsSync(gate)) await Bun.sleep(5);
if (mode === "admit") process.stdout.write(JSON.stringify(await h.admission.admit()));
else await h.runtime.tick();
await h.runtime.close();
db.close();
