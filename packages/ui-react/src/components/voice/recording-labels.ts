import type { Recording } from "../../lib/recordings.js";
import { clockTime } from "../../lib/format-time.js";

export function recordingClock(row: Recording): string {
  if (row.createdAt === undefined) return "unknown time";
  return clockTime(row.createdAt);
}
export function recordingDuration(row: Recording): string {
  const seconds = Math.floor(row.durationMs / 1000);
  return `${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds`;
}
