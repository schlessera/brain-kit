/** Isolated adapter error injection; actual helper authority is qualified natively. */
import { expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as launcher from "../../src/server/worker-launcher.js";
import * as identity from "../../src/server/worker-identity.js";
import * as views from "../../src/server/worker-startup-view.js";
const root = mkdtempSync("/tmp/odysseus-maintenance-adapter-"), brain = join(root, "brain"), state = join(root, "state");
mkdirSync(brain); mkdirSync(state);
const mode = process.argv[2], implicit = process.argv[3] === "implicit";
let refs = 1, originalReleased = false;
const storage = { root: brain, retain() { refs++; }, release() { refs--; } };
const view = { brain, root: brain, storage, cleanup() { if (!originalReleased) { originalReleased = true; storage.release(); } } };
mock.module("../../src/server/worker-identity.js", () => ({ ...identity, workerIdentityHelper: () => "/fixture-only-helper" }));
mock.module("../../src/server/worker-startup-view.js", () => ({ ...views, createWorkerStartupView: () => view }));
mock.module("../../src/server/worker-launcher.js", () => ({ ...launcher, launchAgentWorker(input: launcher.WorkerLaunch) {
  if (mode === "unconfirmed") throw new identity.WorkerIdentityCleanupError("fixture cleanup unconfirmed");
  if (mode === "ordinary") throw Error("fixture confirmed refusal");
  const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end(); stderr.end();
  return { stdin: new PassThrough(), stdout, stderr, pid: process.pid, kill() {},
    exited: Promise.resolve(input.startupView!.cleanup()).then(() => 0) };
} }));
try {
  const { launchMaintenanceWorker } = await import("../../src/server/maintenance-worker.js");
  let refusal: unknown;
  try {
    const worker = launchMaintenanceWorker({ brainPath: brain, ...(implicit ? {} : { startupView: view }), command: ["/bin/true"],
      env: { PATH: "/usr/bin:/bin" }, credentials: false, tempLimits: { allowanceBytes: 4096, budgetBytes: 4096 },
      tempDomain: { statePath: join(state, "ui.db") } });
    await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
  } catch (error) { refusal = error; }
  await Bun.sleep(0);
  const ledger = readdirSync(state).find(name => name.endsWith(".db"))!;
  const db = new Database(join(state, ledger));
  try {
    const rows = db.query("SELECT released FROM reservations").all();
    if (mode === "unconfirmed") {
      expect(identity.workerCleanupUnconfirmed(refusal), "RECOGNIZED_UNCONFIRMED_MAINTENANCE_CLEANUP").toBe(true);
      expect(rows, "UNCONFIRMED_MAINTENANCE_RETAINS_ADMISSION").toEqual([{ released: 0 }]);
      expect(refs, "UNCONFIRMED_MAINTENANCE_RETAINS_REFERENCES").toBe(2);
    } else {
      expect(rows, "CONFIRMED_MAINTENANCE_RELEASES_ADMISSION").toEqual([]);
      expect(refs, "CONFIRMED_MAINTENANCE_RELEASES_ONLY_OWNED_REFERENCES").toBe(implicit ? 0 : 1);
      if (mode === "success") expect(refusal, "MAINTENANCE_ADAPTER_SUCCESS").toBeUndefined();
      else expect(refusal, "MAINTENANCE_ADAPTER_CONFIRMED_REFUSAL").toBeDefined();
    }
  } finally { db.close(); }
  console.log(JSON.stringify({ mode, implicit, result: "pass" }));
} finally { mock.restore(); rmSync(root, { recursive: true, force: true }); }
