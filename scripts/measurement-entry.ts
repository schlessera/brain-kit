/** Fixed admission rules for repository measurement commands, never a provider extension. */
export interface MeasurementEntryInput { entry: string; argv: readonly string[]; liveEval?: string }
const protocol587 = new Set(["measure-turn-surface-live.ts", "measure-turn-surface-tokens.ts"]);
const liveFlag = new Set(["measure-show-block.ts", "measure-show-block-server.ts", "measure-real-provider-dispatch.ts", "measure-pi-schema.ts", "measure-sync-judge.ts"]);
export const REAL_MEASUREMENT_WARNING = "REAL-PROVIDER MEASUREMENT: provider access and charges are authorized; this is not offline test proof.";
export function measurementMode(input: MeasurementEntryInput): "live" | "offline" {
  const has = (flag: string) => input.argv.includes(flag);
  const offline = input.entry === "measure-show-block.ts" && has("--suggestions") && has("--schema-cost")
    || input.entry === "measure-show-block-server.ts" && (has("--inspect-suggestions") || has("--report"))
    || input.entry === "measure-real-provider-dispatch.ts" && (input.argv[0] === "--server" ? input.argv[3] === "dry" : has("--dry-run"))
    || input.entry === "measure-turn-surface-live.ts" && (has("--offline") || input.liveEval === "587_OFFLINE");
  // Mode takes precedence over ambient authorization: local work stays guarded.
  if (offline) return "offline";
  if (protocol587.has(input.entry)) {
    if (input.liveEval === "587") return "live";
    if (input.entry === "measure-turn-surface-live.ts" && input.liveEval === "587_OFFLINE") return "offline";
    throw new Error("Measurement refused before runtime import: require documented BRAIN_LIVE_EVAL=587 authorization");
  }
  if (liveFlag.has(input.entry)) {
    if (input.argv.includes("--allow-real-provider")) return "live";
    throw new Error("Measurement refused before runtime import: require documented --allow-real-provider authorization");
  }
  return "offline";
}
export function enterMeasurement(input: MeasurementEntryInput, effects: { installOffline(): void; warn(message: string): void }): "live" | "offline" {
  const mode = measurementMode(input);
  if (mode === "live") effects.warn(REAL_MEASUREMENT_WARNING);
  else effects.installOffline();
  return mode;
}
