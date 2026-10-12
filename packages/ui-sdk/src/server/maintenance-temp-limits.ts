import { maintenanceTempEnvironment } from "../config/env.js";
import { DEFAULT_MAINTENANCE_TEMP_BYTES, DEFAULT_MAINTENANCE_TEMP_BUDGET_BYTES, MAINTENANCE_TEMP_BUDGET_ENV, MAINTENANCE_TEMP_BYTES_ENV,
  parseWorkerStateBytes, resolveMaintenanceTempLimits, type WorkerStateLimits } from "./worker-state-limits.js";

/** Resolved once at each direct SDK caller's host edge, not from worker input. */
export function hostMaintenanceTempLimits(env: Record<string, string | undefined> = maintenanceTempEnvironment()): WorkerStateLimits {
  return resolveMaintenanceTempLimits({
    allowanceBytes: parseWorkerStateBytes(env[MAINTENANCE_TEMP_BYTES_ENV], MAINTENANCE_TEMP_BYTES_ENV, DEFAULT_MAINTENANCE_TEMP_BYTES),
    budgetBytes: parseWorkerStateBytes(env[MAINTENANCE_TEMP_BUDGET_ENV], MAINTENANCE_TEMP_BUDGET_ENV, DEFAULT_MAINTENANCE_TEMP_BUDGET_BYTES),
  });
}
