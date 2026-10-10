/**
 * The brain-kit logo's packaged files, React-free so a build script or a
 * service worker can read them without the component library.
 *
 * Every file named here ships in this package and resolves as
 * `@schlessera/brain-ui-kit/brand/<file>` (`BRAND_ASSET_SPECIFIER`). These are
 * the only copies: a consumer that needs the logo takes it from here and never
 * redraws it (#1422). `tests/brand-assets.test.ts` proves each name is in the
 * packed tarball and resolves through the export.
 */

/** The prefix every brand file resolves under. */
export const BRAND_ASSET_SPECIFIER = "@schlessera/brain-ui-kit/brand/";

/**
 * The accepted master SVGs from #1423, byte for byte. Fill-only, with the
 * wordmark outlined from DM Serif Text 400, so none needs a font at runtime.
 * `-on-dark`/`-on-paper` name the flat ground each file's hex fills are for.
 */
export const BRAND_MASTERS = [
  "mark-on-dark.svg",
  "mark-on-paper.svg",
  "mark-small-on-dark.svg",
  "mark-small-on-paper.svg",
  "mark-mono-dark.svg",
  "mark-mono-paper.svg",
  "mark-reversed.svg",
  "lockup-on-dark.svg",
  "lockup-on-paper.svg",
  "favicon.svg",
  "icon-512.svg",
  "apple-touch-icon.svg",
  "maskable-512.svg",
  "social-card.svg",
] as const;

export type BrandMaster = (typeof BRAND_MASTERS)[number];
