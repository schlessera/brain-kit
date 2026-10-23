/** Actual separate-UID refusals, using only disposable native fixture state. */
import { expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareNativeWorkerOutput } from "../src/server/worker-native-output.js";
import { prepareMaintenanceGitInput, prepareMaintenanceWorker, runMaintenanceWorker, type MaintenanceCommand } from "../src/server/maintenance-worker.js";
import { probeWorkerHost } from "../src/server/worker-launcher.js";
const brain = "/brain-fixture/brain";
if (process.getuid?.() !== 21001) throw Error("Disposable native index fixture requires its server UID");
const probe = probeWorkerHost(brain, { profile: "governed", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
if (!probe.ok) throw Error("Actual index refusal identity probe failed");
mkdirSync(`${brain}/.brain-index`, { recursive: true });
const db = new Database(`${brain}/.brain-index/brain.db`); db.run("CREATE TABLE odysseus(value INTEGER)"); db.run("INSERT INTO odysseus VALUES(11)"); db.close();
const original = readFileSync(`${brain}/.brain-index/brain.db`);
const manager = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
for (const kind of ["readonly", "symlink", "hardlink", "fifo", "orphan", "oversized", "super-journal", "copy-enospc"] as const) {
  const previous = process.env.BRAIN_UI_OUTPUT_STAGING_BYTES;
  if (kind === "copy-enospc") {
    writeFileSync(`${brain}/.brain-index/brain.db`, Buffer.alloc(36864));
    process.env.BRAIN_UI_OUTPUT_STAGING_BYTES = "40960";
  }
  const view = await prepareNativeWorkerStartupView(brain, manager);
  let output: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
  try {
    output = await prepareNativeWorkerOutput(brain, { startupView: view });
    const owned = output, base = (): MaintenanceCommand => ({ brainPath: brain, startupView: owned.view,
      output: { ...owned.output, target: "/tmp/brain-maintenance-output" }, credentials: false, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/true"] });
    // An already-cancelled request has not acquired preparation custody.
    const abort = new AbortController(); abort.abort();
    await expect(prepareMaintenanceWorker(base(), abort.signal)).rejects.toThrow();
    if (kind === "copy-enospc") {
      // Existing fixed Git installer consumes two upper pages without touching
      // SQLite. The admitted DB fits its bound, but copy-up exceeds free tmpfs.
      const root = owned.output.source.replace(/\/merged$/, "/git-adapter");
      mkdirSync(root, { mode: 0o700 }); mkdirSync(`${root}/bin`, { mode: 0o700 }); mkdirSync(`${root}/hooks`, { mode: 0o700 });
      writeFileSync(`${root}/config.json`, "{}", { mode: 0o600 }); writeFileSync(`${root}/empty-config`, "", { mode: 0o600 });
      writeFileSync(`${root}/bin/git`, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await prepareMaintenanceGitInput({ ...base(), git: { source: root, target: "/tmp/brain-maintenance-git",
        entry: Bun.resolveSync("../src/server/maintenance-git-entry", import.meta.dir), binary: "/usr/bin/git" } });
    } else {
      const mutation = await runMaintenanceWorker({ ...base(), command: ["/usr/bin/python3", "-I", "-S", "-c", String.raw`
import os,sys
r=os.environ["BRAIN_ROOT"]; p=r+"/.brain-index/brain.db"; k=sys.argv[1]
if k=="readonly":os.chmod(p,0o400)
if k=="symlink":os.symlink("../brain.config.ts",p+"-wal")
if k=="hardlink":os.link(p,p+"-wal")
if k=="fifo":os.mkfifo(p+"-wal")
if k=="orphan":os.unlink(p);open(p+"-wal","wb").write(b"Odysseus orphan")
if k=="oversized":
 with open(p+"-wal","wb") as f:f.truncate(256*1024*1024+1)
if k=="super-journal":open(p+"-journal","wb").write(bytes(56)+(56).to_bytes(4,"big")+bytes(4)+bytes.fromhex("d9d505f920a163d7"))
`, kind], timeoutMs: 5000 });
      expect(mutation.exitCode, `ACTUAL_INDEX_REFUSAL_INPUT_${kind}`).toBe(0);
    }
    const sentinel = ".brain-index-unexecuted";
    let refusal: unknown;
    try { await runMaintenanceWorker({ ...base(), command: ["/bin/sh", "-c", `printf forbidden > "$BRAIN_ROOT/${sentinel}"`] }); }
    catch (error) { refusal = error; }
    expect(refusal, `ACTUAL_INDEX_PREPARATION_REFUSED_${kind}`).toBeDefined();
    if (kind === "copy-enospc") expect(String(refusal), "ACTUAL_INDEX_COPY_FAILED_ENOSPC").toContain("ENOSPC");
    await expect(runMaintenanceWorker(base()), `ACTUAL_INDEX_POISONED_RETRY_${kind}`).rejects.toThrow("discard");
    await expect(owned.publish(), `ACTUAL_INDEX_POISONED_PUBLICATION_${kind}`).rejects.toThrow("discard");
    const stageId = owned.output.storage.mount.split("/").at(-1)!;
    expect(await manager.statStage(stageId, sentinel, probe.workerUid!), `ACTUAL_INDEX_PAYLOAD_NOT_RUN_${kind}`).toBeNull();
    console.log(JSON.stringify({ actualIndexPreparationRefusal: kind, payloadNotRun: true, retryRefused: true, publicationRefused: true }));
  } finally {
    try { await output?.cleanup(); } finally { await view.cleanup(); }
    if (previous === undefined) delete process.env.BRAIN_UI_OUTPUT_STAGING_BYTES; else process.env.BRAIN_UI_OUTPUT_STAGING_BYTES = previous;
    rmSync(`${brain}/.brain-index/brain.db`, { force: true }); writeFileSync(`${brain}/.brain-index/brain.db`, original);
  }
}
for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${brain}/.brain-index/brain.db${suffix}`, { force: true });
