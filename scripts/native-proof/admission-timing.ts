import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { lifecycleTimingSample } from "./lifecycle-timing.js";

/** Preserve the integration base's admission/backend samples; closing has a sibling artifact. */
export function admissionTimingSample(record: ActivityTurnLifecycle | undefined, coverage: "native" | "claude_worker_fixture" = "native") {
  return lifecycleTimingSample(record ? { ...record, openSubPhases: record.openSubPhases?.filter(step => step.phase !== "closing") } : undefined, coverage);
}
