/** A separately named partial composition; original full controls stay selected by default. */
export const APPLICATION_QUALIFICATION_PHASES = ["private-positive", "fresh-git", "fresh-app", "warm", "strict"] as const;
export const APPLICATION_SKIPPED_CONTROLS = ["private-input-adverse-controls", "ordinary-probe-relay-controls", "maintenance-stage-principal-mask-publication-and-adverse-controls"];
export function applicationQualificationSelected(options: readonly string[]): boolean {
  const selected = options.includes("--application-qualification");
  if (selected && (!["--shared-git", "--private-git-inputs", "--native-phase-only"].every(flag => options.includes(flag))
    || options.some(flag => flag === "--collector-inventory" || flag === "--probe-state-placement" || flag === "--omit-probe-state-placement" || flag.startsWith("--mutation="))))
    throw Error("Application qualification requires its separate shared/private native composition");
  return selected;
}
