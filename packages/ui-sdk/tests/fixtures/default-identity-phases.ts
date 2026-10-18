/** Fixed complete default proof inventory; each child retains the original deadline. */
export const DEFAULT_IDENTITY_PHASES = ["controls", "fresh", "warm", "strict"] as const;
export function defaultIdentityPhase(args: readonly string[]): typeof DEFAULT_IDENTITY_PHASES[number] | undefined {
  const supplied = args.filter(arg => arg.startsWith("--default-phase="));
  if (!supplied.length) return undefined;
  const phase = supplied[0]!.slice("--default-phase=".length);
  if (supplied.length !== 1 || args[0] !== "--child" || args.includes("--shared-git")
    || !DEFAULT_IDENTITY_PHASES.includes(phase as typeof DEFAULT_IDENTITY_PHASES[number])) throw Error("Invalid default identity fixture phase");
  return phase as typeof DEFAULT_IDENTITY_PHASES[number];
}
