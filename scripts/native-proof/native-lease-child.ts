/** Actual native owner crash/recovery fixture; all roots come from the Unix broker. */
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [source, mode, directory, brainPath, socketPath, fsid, brainUuid] = process.argv.slice(2);
const { createNativeBrainManagerClient } = await import(join(source!, "packages/ui-sdk/src/server/native-brain-manager-client.ts"));
const { createNativeBrainLeaseManager } = await import(join(source!, "packages/ui-server/src/brain/native-brain-leases.ts"));
const { hostOutputStagingLimits } = await import(join(source!, "packages/ui-sdk/src/server/worker-state-limits.ts"));
const owner = await createNativeBrainLeaseManager(createNativeBrainManagerClient({ socketPath }), {
  statePath: join(directory!, "leases.sqlite"), brainPath, fsid, brainUuid,
});
if (mode === "acquire") {
  const checkpoint = await owner.client.checkpoint(randomUUID());
  const stage = await owner.client.prepareStage(randomUUID(), checkpoint.id, hostOutputStagingLimits({}).allowanceBytes);
  writeFileSync(join(directory!, "acquired.tmp"), JSON.stringify({ checkpointId: checkpoint.id, stageId: stage.id }));
  renameSync(join(directory!, "acquired.tmp"), join(directory!, "acquired.json"));
  setInterval(() => {}, 60000); // The supervisor kills this real owner before it closes.
} else if (mode === "recover") {
  try { writeFileSync(join(directory!, "recovered.json"), JSON.stringify(await owner.recoverDeadOwners())); }
  finally { await owner.close(); }
} else throw Error("Unknown native lease fixture mode");
