import { APPLICATION_QUALIFICATION_PHASES, APPLICATION_SCENARIOS } from "./application-qualification.js";
import { DEFAULT_IDENTITY_PHASES } from "./default-identity-phases.js";

export const IDENTITY_PHASE_TIMEOUT_MS = 90_000;
export const IDENTITY_CLEANUP_TIMEOUT_MS = 5_000;

/** The parent budget and native launcher use the same existing phase selection. */
export function ordinaryIdentityPhases(options: {
  applicationScenario?: keyof typeof APPLICATION_SCENARIOS;
  applicationQualification?: boolean;
  probeStatePlacement?: boolean;
  sharedGit?: boolean;
  privateGitInputs?: boolean;
  indexControls?: boolean;
}): readonly (string | undefined)[] {
  if (options.applicationScenario) return APPLICATION_SCENARIOS[options.applicationScenario];
  if (options.applicationQualification) return APPLICATION_QUALIFICATION_PHASES;
  if (options.probeStatePlacement) return ["probe-state"];
  if (options.sharedGit && !options.indexControls)
    return [...(options.privateGitInputs ? ["private", "fresh-controls", "fresh-app"] : ["fresh"]), "warm", "strict"];
  return options.indexControls ? [undefined] : DEFAULT_IDENTITY_PHASES;
}
