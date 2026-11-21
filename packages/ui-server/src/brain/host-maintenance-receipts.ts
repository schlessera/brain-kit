/** Host maintenance can finish before the backend creates its root span. */
import type { AwaitableActivityStore } from "../activity/store.js";
import type { StartupReleaseResult } from "./native-startup-releases.js";
import type { IndexUpdateReceipt } from "./index-update-receipt.js";

export async function recordMaintenanceReceipt(store: AwaitableActivityStore, turnId: string, eventType: "index_update" | "startup_checkpoint_release", result: IndexUpdateReceipt | StartupReleaseResult): Promise<void> {
  const at = "at" in result ? result.at : Date.now();
  const identity = "generation" in result ? result.generation : `${result.checkpointId}:${result.attempt}`;
  const spanId = `${turnId}:${eventType}:${identity}`;
  await store.startSpan({ spanId, parentSpanId: `${turnId}:turn`, runId: turnId, name: eventType === "index_update" ? "Index update" : "Startup checkpoint release", kind: "tool", origin: "session", attrs: { hostMaintenanceReceipt: true }, startedAt: at - result.durationMs });
  const recorded = await store.appendEvent(spanId, eventType, result, at);
  if (recorded === null) throw new Error("Maintenance receipt span was not recorded");
  await store.endSpan(spanId, { endedAt: at, outcome: ["complete", "released"].includes(result.outcome) ? "success" : result.outcome === "cancelled" ? "cancelled" : "error" });
}
export function startupReleaseFailure(result: StartupReleaseResult) {
  return { kind: "checkpoint_release_retry", scope: "startup_checkpoint", ...result, at: result.at, errorClass: result.errorClass ?? "UnknownError", retrying: true };
}
