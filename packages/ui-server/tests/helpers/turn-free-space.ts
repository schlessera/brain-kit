/** Capacity prerequisite for fixtures whose real turns must stay running (#2394). */
import { statfsSync, type StatsFs } from "node:fs";
import { SCOPE_FREE_BYTES } from "../../src/brain/turn-scope.js";

type Statfs = (path: string) => Pick<StatsFs, "blocks" | "bsize" | "bavail">;

export class TurnFixtureFreeSpaceError extends Error {
  constructor(readonly brainPath: string, readonly availableBytes: number, readonly requiredBytes: number) {
    super(`Turn fixture brain filesystem at ${JSON.stringify(brainPath)} has ${availableBytes} available bytes; `
      + `requires at least ${requiredBytes} bytes (max(5% of total, ${SCOPE_FREE_BYTES} bytes)). `
      + "Point TMPDIR at a sufficiently provisioned filesystem with more free space.");
    this.name = "TurnFixtureFreeSpaceError";
  }
}

/** Check the brain itself; TMPDIR may contain a brain mounted on another filesystem. */
export function requireTurnFreeSpace(brainPath: string, statfs: Statfs = statfsSync): void {
  const fs = statfs(brainPath);
  const available = fs.bavail * fs.bsize;
  const required = Math.max(fs.blocks * fs.bsize * .05, SCOPE_FREE_BYTES);
  if (available < required) throw new TurnFixtureFreeSpaceError(brainPath, available, required);
}
