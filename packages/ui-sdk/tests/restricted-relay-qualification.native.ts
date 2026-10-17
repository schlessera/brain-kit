/** Consumer-level controls in the existing disposable second-UID/Btrfs fixture. */
import { expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView, retainWorkerStartupView, type WorkerStartupView } from "../src/server/worker-startup-view.js";
import { launchAgentWorker, workerCommand, type LaunchedWorker } from "../src/server/worker-launcher.js";

if (process.getuid?.() !== 21001 || process.env.BRAIN_UI_WORKER_IDENTITY_HELPER !== "/usr/local/bin/identity-helper") {
  throw Error("RESTRICTED_RELAY_REQUIRES_DISPOSABLE_IDENTITY_FIXTURE");
}
const helper = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
const root = mkdtempSync("/identity-fixture/odysseus-restricted-relay-");
const brain = "/brain-fixture/brain";
let cases = 0;
let view: WorkerStartupView | undefined;
async function refuse(directory: string, name: string) {
  let worker: LaunchedWorker | undefined;
  try {
    expect(() => {
      worker = launchAgentWorker({ brainPath: brain, startupView: retainWorkerStartupView(view!), restricted: { readPaths: [], inferenceDir: directory }, command: ["/bin/true"], env: {} });
    }, `RESTRICTED_RELAY_${name}_REFUSED_BEFORE_PAYLOAD`).toThrow("the inference relay requires its private directory and server-owned socket");
    expect(worker, `RESTRICTED_RELAY_${name}_DID_NOT_LAUNCH`).toBeUndefined();
    console.log(JSON.stringify({ restrictedRelayRefusal: name, result: "pass" })); cases++;
  } finally {
    if (worker) {
      worker.stdout.resume(); worker.stderr.resume(); worker.stdin.end();
      worker.kill("SIGKILL"); await worker.exited;
      worker.state?.close(); worker.turnTemp?.close();
    }
  }
}
try {
  view = await prepareNativeWorkerStartupView(brain, createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" }));
  for (const separate of [true, false]) {
    if (separate) process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper;
    else delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    const directory = join(root, separate ? "helper" : "private"); mkdirSync(directory);
    const directoryMode = separate ? 0o750 : 0o700, socketMode = separate ? 0o660 : 0o600;
    chmodSync(directory, directoryMode);
    const socket = join(directory, "relay.sock");
    const relay = Bun.serve({ unix: socket, fetch: () => new Response("ithaca") }); chmodSync(socket, socketMode);
    try {
      for (const path of [directory, socket]) {
        expect(lstatSync(path).uid, "RESTRICTED_RELAY_SERVER_OWNER").toBe(21001);
        expect(lstatSync(path).gid, "RESTRICTED_RELAY_SHARED_PRIMARY_GROUP").toBe(21001);
      }
      // The actual separate-UID HTTP exchange and isolation controls ran in probeWorkerHost above.
      expect(workerCommand({ brainPath: brain, restricted: { readPaths: [], inferenceDir: directory }, command: ["/bin/true"], env: {} })).toContain(directory);
      for (const mode of [0o755, 0o770, 0o2750, separate ? 0o700 : 0o750]) {
        chmodSync(directory, mode);
        try { await refuse(directory, `${separate}_DIRECTORY_MODE_${mode.toString(8)}`); }
        finally { chmodSync(directory, directoryMode); }
      }
      for (const mode of [0o666, 0o6660, separate ? 0o600 : 0o660]) {
        chmodSync(socket, mode);
        try { await refuse(directory, `${separate}_SOCKET_MODE_${mode.toString(8)}`); }
        finally { chmodSync(socket, socketMode); }
      }
      const alias = join(root, "alias"); symlinkSync(directory, alias);
      try { await refuse(alias, `${separate}_DIRECTORY_ALIAS`); } finally { unlinkSync(alias); }
      const held = `${socket}.held`; renameSync(socket, held);
      try {
        await refuse(directory, `${separate}_MISSING_SOCKET`);
        writeFileSync(socket, "Odysseus fixture", { mode: socketMode });
        try { await refuse(directory, `${separate}_NON_SOCKET`); } finally { unlinkSync(socket); }
        symlinkSync(held, socket);
        try { await refuse(directory, `${separate}_SOCKET_ALIAS`); } finally { unlinkSync(socket); }
      } finally { renameSync(held, socket); }
      await refuse(join(root, "absent"), `${separate}_MISSING_DIRECTORY`);
    } finally { relay.stop(true); }
  }
  process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper;
  for (const name of ["directory-owner", "directory-group", "socket-owner", "socket-group"]) {
    const directory = `/identity-fixture/restricted-${name}`;
    expect(existsSync(directory), "FOREIGN_RELAY_CONTROL_EXISTS").toBe(true);
    await refuse(directory, name);
  }
  console.log(JSON.stringify({ restrictedRelayQualification: "pass", cases }));
} finally {
  process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper;
  try { await view?.cleanup(); } finally { rmSync(root, { recursive: true, force: true }); }
}
