/** The native stage's checkpoint is owned until publication and deletion complete. */
import { prepareNativeWorkerOutput, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
export async function prepareMaintenanceOutput(brain: string, options: { startupView: WorkerStartupView; signal?: AbortSignal; areas?: readonly string[] }) {
  const prepared = await prepareNativeWorkerOutput(brain, options);
  return { ...prepared, output: { ...prepared.output, target: "/tmp/brain-maintenance-output" } };
}
