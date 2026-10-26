/**
 * The writer gate's transactions off the event loop (#2850): the write
 * worker imports this module, and the gate (`writer-gate.ts`) submits each
 * transaction to it. Its policy reader lives here, with the transactions
 * that read the policy.
 */
import type { Database } from "bun:sqlite";

import { gateProcedures } from "./writer-gate.js";

export const url = import.meta.url;

export function setup(db: Database, options: { brain: string }) {
  return gateProcedures(db, options.brain);
}
