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

import { BRAND_ICON_GROUND } from "./tokens.js";

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
] as const;

export type BrandMaster = (typeof BRAND_MASTERS)[number];

/**
 * The raster brand files, for clients that need one: a 16/32/48px
 * `favicon.ico`, an opaque 180px `apple-touch-icon.png` and the web app
 * manifest icons, rendered from the masters by `tools/brand/generate.ts`
 * (`bun run brand:generate`), and the 1200x630 `social-card.png` for Open
 * Graph and repository previews, with `social-card@2x.png` (2400x1260) where
 * a high-DPI image suits. Both social cards are reviewed raster masters of
 * their own (#1428), not rendered from an SVG: they hold a product
 * screenshot, so they have no fill-only vector form. A GitHub social preview
 * takes the 1x file; the 2x one is over its 1 MB limit.
 */
export const BRAND_RASTERS = [
  "favicon.ico",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "social-card.png",
  "social-card@2x.png",
] as const;

export type BrandRaster = (typeof BRAND_RASTERS)[number];

/** One entry of a web app manifest's `icons` array. */
export interface WebAppManifestIcon {
  /** A brand file name, relative to wherever the host serves the brand files. */
  src: BrandRaster;
  sizes: string;
  type: "image/png";
  purpose: "any" | "maskable";
}

/**
 * The manifest `icons` for an installed PWA, ready to copy into a web app
 * manifest. `src` is the bare file name: a host that serves the brand files
 * from its root uses it as is, one that serves them under a path prefixes it.
 */
export const WEB_APP_MANIFEST_ICONS: readonly WebAppManifestIcon[] = [
  { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

/** The manifest's `theme_color` and `background_color`, both the icon tile's dark ground (#1423 §6). */
export const WEB_APP_COLORS = { theme_color: BRAND_ICON_GROUND, background_color: BRAND_ICON_GROUND } as const;

/** One `<link>` a host page declares for its tab and home-screen icons. */
export interface HtmlIconLink {
  rel: "icon" | "apple-touch-icon";
  /** A brand file name, resolved the same way as a manifest icon's `src`. */
  href: BrandMaster | BrandRaster;
  type?: string;
  sizes?: string;
}

/**
 * The `<link>` elements for a page's head. The ICO is declared at 32x32 so a
 * browser that takes SVG prefers the scalable favicon over it.
 */
export const HTML_ICON_LINKS: readonly HtmlIconLink[] = [
  { rel: "icon", href: "favicon.ico", sizes: "32x32" },
  { rel: "icon", href: "favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "apple-touch-icon.png" },
];
