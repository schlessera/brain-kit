import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as workerSdk from "@schlessera/brain-ui-sdk/internal";
import { hostExecution } from "../../src/brain/host-boundary.js";
import { createFixtureWorkerStartupView, prepareFixtureNativeWorkerOutput } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
/** Explicit byte-copy fixture manager, never a product fallback or native filesystem proof. */
export function createNativeHostInputFixture() {
  const store = fs.mkdtempSync("/tmp/odysseus-native-host-"), brain = join(store, "brain");
  fs.mkdirSync(brain); fs.writeFileSync(join(brain, "helper.txt"), "Odysseus initial input");
  const actualStat = fs.statfsSync;
  const stat = spyOn(fs, "statfsSync").mockImplementation(((path: any, options: any) => {
    const value = actualStat(path, options);
    return String(path).startsWith(store) ? { ...value, type: typeof value.type === "bigint" ? 0x9123683en : 0x9123683e } : value;
  }) as typeof fs.statfsSync);
  const output = spyOn(workerSdk,"prepareNativeWorkerOutput").mockImplementation(prepareFixtureNativeWorkerOutput);
  const probe = spyOn(hostExecution,"maintenanceProbe").mockImplementation(async (brain,limits,domain,view,signal) => {
    const prepared = await prepareFixtureNativeWorkerOutput(brain,{startupView:view,signal});
    try { const result = await workerSdk.runMaintenanceWorker({brainPath:brain,startupView:prepared.view,output:{...prepared.output,target:"/tmp/brain-maintenance-output"},command:["/bin/sh","-c",'printf "qualified" > "$BRAIN_ROOT/.brain-maintenance-probe"'],env:{PATH:"/usr/bin:/bin"},credentials:false,tempLimits:limits,tempDomain:domain,timeoutMs:5000,signal});
      return result.exitCode===0 ? {ok:true as const} : {ok:false as const,requirement:result.stderr};
    } finally {await prepared.cleanup();}
  });
  const checkpoints: string[] = [], released: string[] = [];
  const manager = {
    async checkpoint(id: string) {
      const copied = createFixtureWorkerStartupView(brain), path = join(store, ".brain-native/checkpoints", id);
      fs.mkdirSync(join(store, ".brain-native/checkpoints"), { recursive: true });
      try { fs.renameSync(copied.root, path); } finally { copied.cleanup(); }
      checkpoints.push(id);
      return { id, path, readOnly: true as const, sourceUuid: "0123456789abcdef0123456789abcdef", fsid: "00000000-0000-0000-0000-000000000001",
        uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" };
    },
    async release(id: string) {
      released.push(id); fs.rmSync(join(store, ".brain-native/checkpoints", id), { recursive: true, force: true });
      return { id, state: "deleted" as const };
    },
  };
  const execution = { argv: [process.execPath, "--no-env-file", "-e", 'console.log(require("node:fs").readFileSync("helper.txt","utf8"))'],
    env: {}, credentials: false, gate: "none" as const, purpose: "Odysseus input reader" };
  return { brain, checkpoints, released, manager, execution,
    cleanup() { output.mockRestore(); probe.mockRestore(); stat.mockRestore(); fs.rmSync(store, { recursive: true, force: true }); } };
}

