import type { StateRoomObservation } from "./protocol.js";

/** The approved single warning band; this never changes admission. */
export function stateRoomWarning(observation: StateRoomObservation): boolean {
  return observation.allowanceBytes > 0 && observation.usedBytes / observation.allowanceBytes >= 0.75;
}

/** Agent and UI render the same fact with the same units and rounding. */
export function stateRoomCopy(observation: StateRoomObservation): string {
  const mib = (bytes: number) => (bytes / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const percent = Math.round(observation.usedBytes / observation.allowanceBytes * 100);
  return `This conversation is nearing its saved-state limit: ${mib(observation.usedBytes)} MiB of ${mib(observation.allowanceBytes)} MiB (${percent}%).`;
}
