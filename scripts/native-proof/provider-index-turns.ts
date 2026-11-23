/** Each sequential provider-index proof case owns one complete admission lifetime. */
import { createGovernedTurns } from "../../packages/ui-server/src/brain/governed-turn.js";

export function createProviderIndexTurns(options: Parameters<typeof createGovernedTurns>[0]) {
  // close() drains and closes the release owner cached by manager identity.
  // Proof cases are sequential hosts, so each needs a fresh facade over the
  // same fixed transport, just as a new host creates its own manager client.
  return createGovernedTurns({ ...options, nativeManager: { ...options.nativeManager } });
}
