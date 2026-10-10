/** The one binary application: a PNG mask for an existing submitted image. */
export const BRAIN_MASK_MAX_BYTES = 8 * 1024 * 1024;
export interface BrainMaskInput {
  imagePath: string;
  maskPath: string;
  png: Uint8Array;
}
