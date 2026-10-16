/** Real owned Btrfs manager, separate-UID launch and private journal recovery. */
import { expect } from "bun:test";
import { chmodSync, chownSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { serveNativeBrainManager } from "../../packages/ui-sdk/src/server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../../packages/ui-sdk/src/server/worker-startup-view.js";
import { prepareNativeWorkerOutput } from "../../packages/ui-sdk/src/server/worker-native-output.js";
import { launchAgentWorker, probeWorkerHost } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import { hostOutputStagingLimits } from "../../packages/ui-sdk/src/server/worker-state-limits.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createJournalAccounting } from "../../packages/ui-server/src/brain/journal-accounting.js";
import { createJournalObjects } from "../../packages/ui-server/src/brain/journal-objects.js";
import { createNativeJournalCapture } from "../../packages/ui-server/src/brain/native-journal-capture.js";

const brain = "/brain-fixture/brain", socketPath = "/native-runtime/identity-manager.sock";
const MIB = 1024 ** 2;
function command(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

if (process.argv[2] === "--child") {
  expect(process.getuid?.()).toBe(21001);
  const manager = createNativeBrainManagerClient({ socketPath });
  const view = await prepareNativeWorkerStartupView(brain, manager);
  try {
    expect(probeWorkerHost(brain, { profile: "governed", stateBytes: MIB, turnTempBytes: MIB }),
      "ACTUAL_MANAGED_BRAIN_QUALIFIES_SEPARATE_UID").toMatchObject({ ok: true, identity: "separate_uid", workerUid: 21002 });
    const prepared = await prepareNativeWorkerOutput(brain, { startupView: view, areas: [".brain/scratch"] });
    try {
      expect(prepared.output.storage.identityTicketFd, "ROOT_MANAGER_STAGE_TICKET_ACQUIRED").toBeGreaterThan(2);
      const worker = launchAgentWorker({ brainPath: brain, startupView: prepared.view, preparedOutput: prepared,
        sandbox: { brain, profile: "strict", restricted: false,
          areas: [{ name: "scratch", rel: ".brain/scratch", mount: { writable: true, path: join(brain, ".brain/scratch") } }], scratchAliasesRemoved: [] },
        stateBytes: MIB, turnTempBytes: MIB, env: {},
        command: ["/usr/bin/python3", "-I", "-S", "-c", `import errno,os
try: open(${JSON.stringify(join(brain, "notes/strict-write.md"))},'w').write('unexpected')
except OSError as error:
 if error.errno != errno.EROFS: raise
else: raise RuntimeError('STRICT_REAL_STAGE_MUST_BE_READ_ONLY')
os.mkdir('/tmp/brain-worker-areas/scratch/private',0o700)
open('/tmp/brain-worker-areas/scratch/private/result.md','w').write('Odysseus private stage publication')
os.chmod('/tmp/brain-worker-areas/scratch/private/result.md',0o600)
print('Odysseus strict managed stage')`] });
      worker.stdin.end();
      const output = new Response(Readable.toWeb(worker.stdout as Readable) as unknown as ReadableStream).text();
      const errors = new Response(Readable.toWeb(worker.stderr as Readable) as unknown as ReadableStream).text();
      try { expect(await worker.exited, "REAL_MANAGER_STAGE_LAUNCH_PASSED").toBe(0); }
      finally { worker.state?.close(); worker.turnTemp?.close(); }
      expect(await output).toContain("Odysseus strict managed stage"); expect(await errors).toBe("");
      expect(readFileSync(join(brain, ".brain/scratch/private/result.md"), "utf8"), "WORKER_PRIVATE_STAGE_BYTES_PUBLISHED").toBe("Odysseus private stage publication");
      expect(statSync(join(brain, ".brain/scratch/private")).mode & 0o777).toBe(0o700);
      expect(statSync(join(brain, ".brain/scratch/private/result.md")).mode & 0o777).toBe(0o600);
    } finally { await prepared.cleanup(); }

    const data = "/identity-fixture/native-journal"; mkdirSync(data, { mode: 0o700 });
    const dbPath = join(data, "ui.db"), db = createUiDb(dbPath), ledger = createJournalAccounting(db, dbPath);
    const objectsRoot = join(data, "objects"), objects = createJournalObjects(objectsRoot, ledger);
    const capture = createNativeJournalCapture(manager, (fd, bytes) => objects.putFileAsync(fd, bytes), {}, {
      brainPath: brain,
      async createTemporary(maximum) {
        const reservation = ledger.reserveTemporary(maximum), path = join(objectsRoot, `pending-${reservation.id}`);
        try {
          const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await unlink(path);
          return { file, release: () => reservation.release() };
        } catch (error) { reservation.release(); throw error; }
      },
    });
    try {
      await capture.initialize(); const policy = await capture.policy();
      const worker = launchAgentWorker({ brainPath: brain,
        sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
        stateBytes: MIB, turnTempBytes: MIB, env: {},
        command: ["/usr/bin/python3", "-I", "-S", "-c", `import os
os.mkdir(${JSON.stringify(join(brain, "private"))},0o700)
open(${JSON.stringify(join(brain, "private/result.md"))},'w').write('Odysseus private checkpoint')
os.chmod(${JSON.stringify(join(brain, "private/result.md"))},0o600)
open(${JSON.stringify(join(brain, "unreadable.md"))},'w').write('Circe unreadable')
os.chmod(${JSON.stringify(join(brain, "unreadable.md"))},0)
os.mkdir(${JSON.stringify(join(brain, "opaque"))},0o700)
open(${JSON.stringify(join(brain, "opaque/hidden.md"))},'w').write('Athena hidden inventory')
os.chmod(${JSON.stringify(join(brain, "opaque"))},0)`] });
      worker.stdin.end(); const output = new Response(Readable.toWeb(worker.stdout as Readable) as unknown as ReadableStream).text(), errors = new Response(Readable.toWeb(worker.stderr as Readable) as unknown as ReadableStream).text();
      try { expect(await worker.exited).toBe(0); } finally { worker.state?.close(); worker.turnTemp?.close(); }
      await output; expect(await errors).toBe("");
      expect(() => readFileSync(join(brain, "private/result.md")), "SERVER_CANNOT_READ_PRIVATE_CHECKPOINT_INPUT").toThrow();
      const observation = await capture.observe(new Map([["odysseus", policy]]));
      try {
        const entries = observation.changes.get("odysseus")!;
        console.log(JSON.stringify({ checkpointObservation: { paths: entries.map(entry => ({ path: entry.path, kind: entry.after?.kind, bytes: entry.after?.bytes })), unreadable: observation.unreadable } }));
        const recovered = entries.find(entry => entry.path === "private/result.md")?.after;
        const hash = createHash("sha256").update("Odysseus private checkpoint").digest("hex");
        expect(recovered?.hash, "REAL_PRIVATE_CHECKPOINT_BYTES_RETAINED").toBe(hash);
        expect(objects.read(hash, 100).toString()).toBe("Odysseus private checkpoint");
        const unavailable = entries.find(entry => entry.path === "unreadable.md")?.after;
        expect(unavailable?.bytes).toBe(16); expect(unavailable?.hash).toBeUndefined();
        expect(observation.unreadable.some(entry => entry.path === "unreadable.md"), "UNREADABLE_INPUT_HAS_EXPLICIT_METADATA_ROADBLOCK").toBe(true);
        expect(observation.unreadable.some(entry => entry.path === "opaque" && entry.kind === "directory"), "UNREADABLE_DIRECTORY_IS_INCOMPLETE_NOT_EMPTY").toBe(true);
        expect(entries.some(entry => entry.path === "opaque/hidden.md"), "UNKNOWN_PRIVATE_DESCENDANT_IS_NOT_INVENTED").toBe(false);
        expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='temporary'").get()).toEqual({ n: 0 });
        await observation.commit();
      } catch (error) { await observation.abort(); throw error; }
      const restore = launchAgentWorker({ brainPath: brain,
        sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
        stateBytes: MIB, turnTempBytes: MIB, env: {},
        command: ["/usr/bin/python3", "-I", "-S", "-c", `import os;os.chmod(${JSON.stringify(join(brain, "opaque"))},0o700)`] });
      restore.stdin.end();
      const restoreOutput = new Response(Readable.toWeb(restore.stdout as Readable) as unknown as ReadableStream).text();
      const restoreErrors = new Response(Readable.toWeb(restore.stderr as Readable) as unknown as ReadableStream).text();
      try { expect(await restore.exited).toBe(0); } finally { restore.state?.close(); restore.turnTemp?.close(); }
      await restoreOutput; expect(await restoreErrors).toBe("");
      const retried = await capture.observe(new Map([["odysseus-retry", await capture.policy()]]));
      try {
        const hash = createHash("sha256").update("Athena hidden inventory").digest("hex");
        expect(retried.changes.get("odysseus-retry")!.find(entry => entry.path === "opaque/hidden.md")?.after?.hash,
          "RESTORED_DIRECTORY_RETRIES_PREVIOUSLY_UNKNOWN_INVENTORY").toBe(hash);
        expect(objects.read(hash, 100).toString()).toBe("Athena hidden inventory");
        expect(retried.unreadable.some(entry => entry.path === "opaque" || entry.path.startsWith("opaque/"))).toBe(false);
        await retried.commit();
      } catch (error) { await retried.abort(); throw error; }
    } finally { await capture.close(); objects.close(); db.close(); }
    console.log(JSON.stringify({ nativeIdentityManager: "pass", stage: "root-sealed-ticket", recovery: "private-checkpoint-and-unreadable-metadata" }));
  } finally { await view.cleanup(); }
} else {
  expect(process.getuid?.()).toBe(0);
  mkdirSync(join(brain, "notes")); mkdirSync(join(brain, ".brain/scratch"), { recursive: true, mode: 0o2770 });
  chownSync(join(brain, ".brain"), 21001, 21001); chownSync(join(brain, ".brain/scratch"), 21001, 21001); chmodSync(join(brain, ".brain/scratch"), 0o2770);
  chmodSync(brain, 0o2775); chownSync(brain, 21001, 21001); chownSync(join(brain, "notes"), 21001, 21001);
  writeFileSync(join(brain, "brain.config.ts"), "export default {};\n");
  chownSync(join(brain, "brain.config.ts"), 21001, 21001);
  const show = command(["btrfs", "subvolume", "show", brain]);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show)![1]!.replaceAll("-", "");
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(command(["btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]))![1]!;
  mkdirSync("/native-runtime", { mode: 0o755, recursive: true });
  const staging = hostOutputStagingLimits({});
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath,
    appUid: 21001, appGid: 21001, workerUid: 21002, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * MIB });
  try {
    const child = Bun.spawn(["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--clear-groups", process.execPath,
      "--preload", "/repo/scripts/test-network-child-preload.ts", import.meta.filename, "--child"], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", BRAIN_UI_WORKER_IDENTITY_HELPER: "/usr/local/bin/identity-helper" }, stdout: "pipe", stderr: "pipe" });
    const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
    const code = await child.exited, text = await output, detail = await errors;
    writeFileSync("/proof/native-identity-child.stdout", text); writeFileSync("/proof/native-identity-child.stderr", detail);
    expect(code, detail).toBe(0); expect(text).toContain('"nativeIdentityManager":"pass"');
    console.log(text);
  } finally { await service.close(); }
}
