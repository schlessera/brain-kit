import type { Database } from "bun:sqlite";
import { createInboxResolverCore } from "./resolver-core.js";
import { inboxResolutionWrites } from "./resolve-writes.js";

export { inboxSnoozeUntil } from "./resolver-core.js";

/** Internal engine wiring must derive a fresh envelope from server authority.
 * Checkpoint facts, stored effects and client data cannot supply that envelope. */
export function createInboxResolver(db: Database, deps: Parameters<typeof createInboxResolverCore>[1]) {
  return createInboxResolverCore(db, deps, timeZone => inboxResolutionWrites(db, timeZone));
}
