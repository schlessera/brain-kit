/**
 * The markup layer's bounds (#3975), shared by the browser editor, the upload
 * route and the server's application so that no hop is narrower than the cap
 * it advertises.
 *
 * The values are the `brain image --markup` CLI's own (`MARKUP_LIMITS` in the
 * images module, #3785): a layer of at most 52,428,800 bytes (50 MiB, which
 * the CLI calls "50 MB") over a first reference of at most 16,777,216 pixels.
 */
export const BRAIN_MARKUP_MAX_BYTES = 50 * 1024 * 1024;
export const BRAIN_MARKUP_MAX_PIXELS = 16_777_216;
/**
 * The largest source image the markup application reads to bind its hash and
 * displayed size. Generous for a 16.7 MP photo in any of the accepted formats;
 * a separate bound from the 8 MiB mask application's, which it never shares.
 */
export const BRAIN_MARKUP_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
/** Where every layer is written; no caller chooses another destination. */
export const BRAIN_MARKUP_DIR = ".brain/scratch/markup";
/** Bounds on the drawing summary the browser sends with the layer. */
export const BRAIN_MARKUP_MAX_NOTES = 200;
export const BRAIN_MARKUP_NOTE_MAX_CHARS = 80;
/** The tool's refusal when the user closes the editor without sending. */
export const BRAIN_MARKUP_CLOSED = "The user closed the markup editor";
