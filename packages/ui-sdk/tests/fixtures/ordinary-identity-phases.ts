import { APPLICATION_QUALIFICATION_PHASES, APPLICATION_SCENARIOS, SCRATCH_MASK_QUALIFICATION_PHASES } from "./application-qualification.js";
import { DEFAULT_IDENTITY_PHASES } from "./default-identity-phases.js";

export const IDENTITY_PHASE_TIMEOUT_MS = 90_000;
export const IDENTITY_CLEANUP_TIMEOUT_MS = 5_000;

/** The parent budget and native launcher use the same existing phase selection. */
export function ordinaryIdentityPhases(options: {
  applicationScenario?: keyof typeof APPLICATION_SCENARIOS;
  applicationQualification?: boolean;
  scratchMask?: boolean;
  probeStatePlacement?: boolean;
  sharedGit?: boolean;
  privateGitInputs?: boolean;
  indexControls?: boolean;
}): readonly (string | undefined)[] {
  if (options.scratchMask) {
    if (!options.applicationQualification || !options.sharedGit || !options.privateGitInputs || options.applicationScenario || options.probeStatePlacement || options.indexControls)
      throw Error("Scratch mask partition requires the complete shared/private application composition");
    return SCRATCH_MASK_QUALIFICATION_PHASES;
  }
  if (options.applicationScenario) return APPLICATION_SCENARIOS[options.applicationScenario];
  if (options.applicationQualification) return APPLICATION_QUALIFICATION_PHASES;
  if (options.probeStatePlacement) return ["probe-state"];
  if (options.sharedGit && !options.indexControls)
    return [...(options.privateGitInputs ? ["private", "fresh-controls", "fresh-app"] : ["fresh"]), "warm", "strict"];
  return options.indexControls ? [undefined] : DEFAULT_IDENTITY_PHASES;
}

/** Partitioning controls never adds time to the existing enclosing composition. */
export function ordinaryIdentityApplicationTimeoutMs(options: Parameters<typeof ordinaryIdentityPhases>[0]): number {
  const phases = ordinaryIdentityPhases(options);
  return (options.scratchMask ? APPLICATION_QUALIFICATION_PHASES.length : phases.length) * IDENTITY_PHASE_TIMEOUT_MS + IDENTITY_CLEANUP_TIMEOUT_MS;
}
