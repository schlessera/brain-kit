/** Real worker witness, separate from capture latency samples. */
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveNativeBrainManager } from "../../packages/ui-sdk/src/server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { hostOutputStagingLimits } from "../../packages/ui-sdk/src/server/worker-state-limits.js";
import { launchAgentWorker, prepareWorkerSandbox } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import { createTurnJournal } from "../../packages/ui-server/src/brain/turn-journal.js";
import { createTurnScope } from "../../packages/ui-server/src/brain/turn-scope.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { resolveGovernancePolicy } from "../../packages/common/src/governance-policy.js";

test("independent kernel witness separates suspension from durable observation", async () => {
  expect(process.env.BRAIN_JOURNAL_PROFILE_OWNED).toBe("1752");
  const brain = "/brain-fixture/brain", root = "/proof/suspension"; mkdirSync(root, { mode: 0o700 });
  rmSync(join(brain, "notes"), { recursive: true, force: true }); mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  const cmd = (args: string[]) => { const r = Bun.spawnSync(args); expect(r.exitCode).toBe(0); return r.stdout.toString(); };
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(cmd(["btrfs", "subvolume", "show", brain]))![1]!.replaceAll("-", "");
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(cmd(["btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]))![1]!;
  const socketPath = "/native-runtime/suspension1752.sock", staging = hostOutputStagingLimits({});
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath,
    appUid: 0, appGid: 0, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes, capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const journal = createTurnJournal(db, { brainPath: brain, dbPath, objectsRoot: join(root, "objects"), nativeManager: createNativeBrainManagerClient({ socketPath }) });
  const scope = createTurnScope(db, { brainPath: brain, journal, connected: () => true, changed: () => {} });
  const policy = resolveGovernancePolicy({ schema_version: 1, scope: { max_files_changed: 20 } });
  let worker: ReturnType<typeof launchAgentWorker> | undefined, monitor: ReturnType<typeof Bun.spawn> | undefined;
  const samplesPath = join(root, "kernel-samples.jsonl");
  const samples = () => { try { return readFileSync(samplesPath, "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line) as {at:number;count:number;states:string[]}); } catch { return []; } };
  const wait = async (condition: () => boolean) => { const deadline = Date.now() + 60000; while (!condition()) { if (Date.now() > deadline) throw Error("SUSPENSION_WITNESS_DEADLINE"); await Bun.sleep(20); } };
  try {
    await journal.begin("voyage", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
    scope.begin("voyage", { sessionId: "ithaca", principalId: "athena", origin: "interactive", profile: "governed", policy, source: "policy", hardTimeoutMs: 3600000, current: () => true, stop: () => {} });
    worker = launchAgentWorker({ brainPath: brain, sandbox: prepareWorkerSandbox(brain, { profile: "governed", areas: [] }),
      command: ["/bin/sh", "-c", 'i=0; while [ "$i" -lt 50 ]; do i=$((i+1)); printf "Odysseus Ithaca 2026-07-12 %s" "$i" > .brain/scratch/voyage-$i; sleep 0.05; done; while :; do sleep 1; done'], env: { PATH: "/usr/bin:/bin" } });
    worker.stdout.resume(); worker.stderr.resume(); worker.stdin.end(); scope.workerStarted("voyage", worker);
    const witness = `const fs=require("node:fs");function states(pid){let out=[];try{for(const s of fs.readFileSync("/proc/"+pid+"/task/"+pid+"/children","utf8").trim().split(/\\s+/).filter(Boolean)){const p=Number(s),t=fs.readFileSync("/proc/"+p+"/status","utf8"),n=/^Name:\\s+(.+)$/m.exec(t)?.[1],v=/^State:\\s+(\\S)/m.exec(t)?.[1];if((n==="sh"||n==="sleep")&&v!=="Z")out.push(v);out.push(...states(p));}}catch{}return out;}setInterval(()=>{fs.appendFileSync(process.argv[2],JSON.stringify({at:Date.now(),count:fs.readdirSync(process.argv[3]).length,states:states(Number(process.argv[1]))})+"\\n");},20);`;
    monitor = Bun.spawn([process.execPath, "--no-env-file", "-e", witness, String(worker.pid), samplesPath, join(brain, ".brain/scratch")], { stdout: "ignore", stderr: "pipe" });
    await wait(() => samples().some(s => s.count >= 20));
    await wait(() => samples().some(s => s.states.length > 0 && s.states.every(v => v === "T" || v === "t")));
    const frozen = samples().find(s => s.states.length > 0 && s.states.every(v => v === "T" || v === "t"))!;
    await wait(() => Boolean(journal.summary("voyage").scope?.receipts.length));
    const retainedAt = Date.now(), receipt = journal.summary("voyage").scope!.receipts.at(-1)!;
    const crossing = samples().find(s => s.count >= 20)!;
    expect(frozen.at).toBeLessThanOrEqual(retainedAt); expect(receipt.frozen).toBe(true);
    expect(receipt.dimension).toBe("files_changed"); expect(readdirSync(join(brain, ".brain/scratch")).length).toBe(50);
    writeFileSync("/proof/suspension.json", JSON.stringify({ crossingAt: crossing.at, frozenAt: frozen.at, retainedAt, suspensionAfterCrossingMs: frozen.at-crossing.at, retentionAfterSuspensionMs: retainedAt-frozen.at, receipt, sampleIntervalMs: 20, kernelWitness: true }, null, 2));
    worker.kill("SIGKILL"); await worker.exited; await journal.finish("voyage"); scope.finish("voyage");
  } finally { monitor?.kill(); if (monitor) await monitor.exited; worker?.kill("SIGKILL"); if (worker) await worker.exited; scope.close(); await journal.close(); db.close(); await service.close(); }
}, 120000);
