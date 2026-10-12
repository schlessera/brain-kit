/**
 * Aggregate admission for Claude worker runtime state (#1625) and turn temp
 * (#1703). The ledger lives in the SDK so both backends admit against the one
 * per process (`packages/ui-sdk/src/server/worker-state-budget.ts`).
 */
export { createStateLedger, processStateLedger, WorkerStateError } from "@schlessera/brain-ui-sdk/internal";
export type { Reservation, StateLedger, WorkerStateErrorClass } from "@schlessera/brain-ui-sdk/internal";
