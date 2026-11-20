/** Native receipts for #4300/#4301; invoked after hosted turns, before shutdown. */
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../../packages/ui-sdk/src/server/worker-startup-view.js";
import { moduleLockHash, moduleStorePath, publishModuleGeneration } from "../../packages/ui-sdk/src/server/module-store.js";
import { prepareWorkerSandbox, workerCommand } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import { createOperationalStateProof } from "../../packages/ui-server/src/brain/operational-state.js";
export async function proveStateModuleBoundaries(brain: string, socketPath: string, dbPath: string, artifact: string): Promise<void> {
  const privateState = join(dirname(dbPath), "state-boundary-probe");
  fs.mkdirSync(privateState); const secret = join(privateState, "state"); fs.writeFileSync(secret, "Odysseus private state");
  const crossLink = (source: string, name: string) => {
    let code: string | undefined;
    try { fs.linkSync(source, join(brain, name)); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code, "CROSS_BOUNDARY_LINK_FAILS_EXDEV").toBe("EXDEV");
  };
  const proof = createOperationalStateProof(), layout = { brainPath: brain, privateStatePaths: [{ setting: "native proof", path: privateState }] };
  expect(proof(layout)).toBeUndefined();
  const reads = spyOn(fs, "readdirSync"); let stateReads: number;
  const began = performance.now();
  try { expect(proof(layout)).toBeUndefined(); stateReads = reads.mock.calls.length; expect(stateReads, "NATIVE_STATE_PROOF_NO_DIRECTORY_READS").toBe(0); }
  finally { reads.mockRestore(); }
  const stateProofMs = performance.now() - began;
  crossLink(secret, "state-alias");
  const generation = randomUUID(), root = join(moduleStorePath(brain), generation), modules = join(root, "node_modules");
  fs.mkdirSync(join(modules, "odysseus"), { recursive: true });
  fs.writeFileSync(join(modules, "odysseus/package.json"), '{"name":"odysseus","main":"index.js"}');
  fs.writeFileSync(join(modules, "odysseus/index.js"), 'module.exports = "Ithaca";');
  publishModuleGeneration(brain, { generation, lockHash: moduleLockHash(Buffer.from("Odysseus")), trigger: "native boundary proof", installedAt: "2026-07-12T00:00:00Z" });
  crossLink(join(modules, "odysseus/index.js"), "module-alias");
  const manager = createNativeBrainManagerClient({ socketPath });
  const view = await prepareNativeWorkerStartupView(brain, manager);
  try {
    const original = fs.readdirSync;
    const reads = spyOn(fs, "readdirSync"); let moduleReads = 0;
    reads.mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      const path = String(args[0]);
      let real = path; try { real = fs.realpathSync(path); } catch { /* Original read reports errors. */ }
      if (real.startsWith(join(brain, "node_modules"))) moduleReads++;
      return Reflect.apply(original, fs, args);
    }) as typeof fs.readdirSync);
    let sandbox: ReturnType<typeof prepareWorkerSandbox>;
    try { sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], maskPaths: [moduleStorePath(brain), dirname(dbPath)], maintenance: { startupView: view } }); }
    finally { reads.mockRestore(); }
    expect(sandbox.profile).toBe("governed"); expect(moduleReads, "NATIVE_MODULE_ADMISSION_NO_DIRECTORY_READS").toBe(0);
    const program = 'const fs=require("node:fs"); if(require("odysseus")!=="Ithaca")process.exit(41); try{fs.appendFileSync("node_modules/odysseus/index.js","attack");process.exit(42)}catch(e){if(e.code!=="EROFS")throw e} console.log("MODULE_RESOLVED_READ_ONLY");';
    const argv = workerCommand({ brainPath: brain, sandbox, command: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: {} });
    const worker = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
    expect(exit, stderr).toBe(0); expect(stdout).toContain("MODULE_RESOLVED_READ_ONLY");
    fs.writeFileSync(artifact, JSON.stringify({ stateDirectoryReads: stateReads!, stateProofMs, moduleDirectoryReads: moduleReads, stateHardlink: "EXDEV", moduleHardlink: "EXDEV", packageResolution: "Ithaca", moduleWrite: "EROFS" }));
  } finally { await view.cleanup(); }
}
