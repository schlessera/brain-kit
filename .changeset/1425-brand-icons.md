---
"@schlessera/brain-ui-kit": minor
---

Ship a favicon and install-icon set for hosts. `@schlessera/brain-ui-kit/brand/` now also carries `favicon.ico` (16, 32 and 48px), an opaque 180px `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, a maskable `icon-maskable-512.png` and a 1200x630 `social-card.png`, all rendered from the logo's master SVGs. The `@schlessera/brain-ui-kit/brand` entry lists them in `BRAND_RASTERS` and exports what a host declares: `WEB_APP_MANIFEST_ICONS` for a web app manifest's `icons`, `WEB_APP_COLORS` for its `theme_color` and `background_color`, and `HTML_ICON_LINKS` for the page head.
