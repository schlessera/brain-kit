/** First-party external compute: the job lifecycle behind `brain compute` and `brain_compute_*`. */
export { createComputeService, computeJobView } from "./service.js";
export type { ComputeService, ComputeHealthReport, ComputeInstanceHealth, ComputeCollection, ComputeReconcileReport } from "./service.js";
export { ComputeStateError, computeBrainKey, resolveComputeStateDir } from "./state-dir.js";
export { COMPUTE_JOB_ID } from "./store.js";
export { isTerminal, COMPUTE_TERMINAL_STATES } from "./types.js";
export type {
  ComputeApproval,
  ComputeBudget,
  ComputeCaller,
  ComputeClock,
  ComputeJobRecord,
  ComputeJobResult,
  ComputeJobState,
  ComputeJobView,
  ComputePlan,
  ComputeRefusal,
  ComputeRunRequest,
  ComputeServiceOptions,
  ComputeTerminalState,
} from "./types.js";
