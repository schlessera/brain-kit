import { markupBytesLabel } from "@schlessera/brain-ui-kit";

/**
 * Every displayed size follows the kit's one rule (#4735): bytes below 1,024
 * as `B`, rounded KB, MB with one decimal and none when whole. Labels that
 * state a limit set in decimal megabytes, and the storage and stats scales,
 * are deliberate exceptions and say so where they are built.
 */
export { markupBytesLabel as formatBytes };

/** True when `after` is larger and its displayed label differs from `before`'s. */
export function bytesLabelGrew(before: number, after: number): boolean {
  return after > before && markupBytesLabel(after) !== markupBytesLabel(before);
}
