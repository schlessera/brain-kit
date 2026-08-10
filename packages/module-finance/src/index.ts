/**
 * @schlessera/brain-module-finance public API.
 *
 * The AR engine (loading, computation, formatting, sync/check) plus the module
 * config schema. The module manifest is the package's `./module` entry.
 */

export {
  loadLedgers,
  computeClient,
  buildPortfolio,
  syncFiles,
  checkSync,
  money,
  renderReport,
} from "./finance.js";

export type {
  FinanceOptions,
  Allocation,
  Payment,
  Invoice,
  ClientLedger,
  InvoiceStatus,
  ComputedInvoice,
  AgingBuckets,
  ClientReport,
  Portfolio,
  SyncResult,
} from "./finance.js";

export { configSchema } from "./module.js";
export type { FinanceConfig } from "./module.js";
