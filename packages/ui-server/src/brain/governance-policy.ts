/** Process-local last-valid policy. Every admission reads data anew; no repository code runs. */
import { checkGovernancePolicy, resolveGovernancePolicy, type EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";

export interface TurnGovernancePolicy {
  readonly hash: string | null;
  readonly source: "policy" | "default" | "last_valid";
  readonly policy: EffectiveGovernancePolicy;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Freeze nested values so neither later loads nor consumers can change a running turn's policy. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createGovernancePolicyReader(brainPath: string) {
  let lastValid: { policy: EffectiveGovernancePolicy; hash: string } | undefined;
  return { load(): TurnGovernancePolicy {
    const checked = checkGovernancePolicy(brainPath);
    if (checked.status === "valid") {
      lastValid = { policy: freeze(checked.effective), hash: checked.content_hash! };
      return freeze({ ...lastValid, source: "policy" as const, errors: [], warnings: [...checked.warnings] });
    }
    if (checked.status === "missing") {
      // Removing the optional file is an outside-turn edit selecting defaults;
      // an invalid edit retains the last valid file, not an inferred new policy.
      return freeze({ policy: resolveGovernancePolicy({ schema_version: 1 }), hash: null, source: "default" as const, errors: [], warnings: [] });
    }
    return freeze({ policy: lastValid?.policy ?? resolveGovernancePolicy({ schema_version: 1 }),
      hash: lastValid?.hash ?? null, source: lastValid ? "last_valid" as const : "default" as const, errors: [...checked.errors], warnings: [] });
  } };
}
