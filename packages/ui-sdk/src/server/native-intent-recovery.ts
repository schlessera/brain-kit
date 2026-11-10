import { readdirSync } from "node:fs";
import { nativeCheckpointId } from "./native-brain-manager-protocol.js";
import { recordNativeRecoveryFailure } from "./native-recovery-diagnostics.js";

/** Recover independent records; keep unreadable originals as permanent identity fences. */
export function recoverNativeIntents(state: string, diagnostics: string, recover: (id: string) => void): { ids: string[]; quarantined: Set<string> } {
  const ids: string[] = [], quarantined = new Set<string>();
  // A failure to enumerate the store is still store-wide uncertainty.
  for (const name of readdirSync(state).filter(name => name.endsWith(".json"))) {
    const id = name.slice(0, -5);
    try {
      if (!nativeCheckpointId.safeParse(id).success) throw Error("Native state contains an unrecognized identity.");
      recover(id);
    } catch (error) {
      quarantined.add(id);
      recordNativeRecoveryFailure(diagnostics, name, "native-brain-manager.recoverIntent", error);
    }
    // Even a quarantined valid UUID stays in the index. A page containing it
    // refuses explicitly instead of silently presenting an incomplete census.
    if (nativeCheckpointId.safeParse(id).success) ids.push(id);
  }
  return { ids, quarantined };
}
