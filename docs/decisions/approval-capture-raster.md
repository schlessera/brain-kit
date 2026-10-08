# Approval capture raster evidence

Measured on 2026-10-08 for [#1263](https://github.com/schlessera/brain-kit/issues/1263).
This investigation preserves a real native mismatch and a bounded
non-reproduction result. That investigation established no rendering cause or source repair.
The later #1284 capture preparation is recorded separately below.

## The original images differ

The failing #1000 combined checkout was
`848df6cd7fb0e2da7ab9eb507ea29bb55ff5c1d9`, with main parent
`8d966cf0ecb9bc23da4150f56769d4fb84c2c9b8` and head
`40359d4c2f95771985f97cd19a0a213e7a25dd69`. Its paired capture artifact
`01a11b8f-bd96-7cd1-b81e-79e704244c5a` preserves the **original**
`first/approval-allow-before-dark.png` and
`second/approval-allow-before-dark.png`; neither is a diagnostic diff image.
Both PNG hashes agree with their capture manifests.

Decoded RGBA comparison finds exactly 144 differing pixels at x=63..205,
y=251..253, only rows 251 and 253. At each differing pixel, the first image is
`(26, 27, 27, 255)` and the second is `(27, 27, 27, 255)`. The difference is one
red-channel byte; it is not red highlighting. At `(63, 251)`, those same values
are directly observable in the originals.

| Original image | SHA-256 |
| --- | --- |
| First | `2e348d62f55397a29f0d62294b588eef4587143825b65f5f7e87bdb35df1e731` |
| Second | `f2022c98d2848d1be2369ba44d317be704d1a241bf211002a8bea40653e4bad1` |

The changed pixels lie on the dotted text decoration of the actual
`.brain-file-link`, not on the kit's `PathRef` border. The relevant CSS starts
at `.brain-file-link` (`.brain-file-link`, `packages/ui-react/src/theme.css:469-481`).
This locates the visible difference; it does not identify the native paint
mechanism that produced it.

## Bounded controls

Every native control uses Bun 1.4.2, Playwright 1.63.0 and Chromium
153.0.8010.12 in `mcr.microsoft.com/playwright:v1.63.0-noble`, image/digest
`sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`.
The checksum-verified font lock is
`3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad`.
Locale, timezone, example clock, reduced motion and scale retain the catalogue
values. Browser arguments retain `--disable-partial-raster`. Containers deny
network egress and mount the source and font cache read-only. Native approval,
file effects, persisted history and required visible text remain checked.

| Control | Allow-before images | Result |
| --- | --- | --- |
| Local approval-only sequence, shared and fresh browsers | 5 | One original hash throughout. |
| Local full CI recipe prelude, two batches, shared and fresh browsers | 10 | Same hash throughout. |
| Local bounded concurrency, three groups of four independent browsers | 12 | Same hash throughout; no child failures. |
| Depot full sequence with shared/fresh browser observations | 10 | Same hash throughout; five recipes and 13 files match across the two original runs. |
| Original main tree, uninstrumented `capture:verify` | 2 | Same hash; five recipes and all 13 exact files match. |
| Exact failing combined checkout, original uninstrumented `capture:verify` | 2 | Same hash; five recipes and all 13 exact files match. |

All 41 observed allow-before images hash to
`f2022c98d2848d1be2369ba44d317be704d1a241bf211002a8bea40653e4bad1`.
The controls are different bounded conditions, not a recurrence-rate sample
or proof that a failure is impossible. Local observed product source is main
`0e4290f5d0023ab912cb69f499118e82a39d739a`; the exact failing checkout control
is a clean detached tree at the original merge commit above. The uninstrumented
main control is a clean detached tree at `0e4290f5` with the same original
capture code.

The temporary observer reads DOM/style state and native CDP font identity
**after** the accepted image, with no extra read or screenshot before that
image. This limits interference with the first image but does not prove that
later observations leave browser caches or timings untouched. Shared-browser
and fresh-browser cases are both retained. The observer is not shipped as a
new capture behavior.

| Target measurement after the image | Observed value |
| --- | --- |
| Link rectangle | x=61, y=238.234375, width=148, height=14 |
| Computed font | 10.45px / 15.675px JetBrains Mono |
| Native face | Custom JetBrainsMono-Regular, 24 glyphs |
| Link and ancestor opacity / transform | 1 / none |
| Decoration | Dotted underline; auto thickness; 3px offset; the same colour throughout |

Target/ancestor geometry, styles and actual font identity match across the
observed local and Depot samples. A separate infinite animation's post-image
clock is 0 or approximately 16.666ms in Depot; that clock variation does not
produce a pixel variation in these controls. Measurements taken after an
image cannot establish the instantaneous native raster state of an earlier
failing image, whose artifact contains no such observation.

## What this establishes

The preserved failure is a decoded pixel difference, not PNG compression or a
misread diagnostic overlay. The measured controls do not reproduce it. They
provide no evidence of a changed font, geometry, product color or ancestor
transform, and select no browser flag, CSS change or rendering fix. The native
raster trigger remains unknown; neither clearing a cache nor changing a
rounding policy is justified by these data.

The exact comparison remains enabled
(`compareCaptures`, `scripts/captures/verify.ts:17-38`). Three identical local
frames remain required (`captureRuntime`, `scripts/captures/runtime.ts:15-120`).
No tolerance, pixel baseline, recipe, output or approval assertion changed.
An unchanged-checkout verification attempt can show that a particular run
passes; it must not be described as repairing this mismatch.

A recurrence needs both original images and hashes, the actual checkout,
image/browser/font identities, and geometry/style/native-font observations
from the failing execution. Then bound one variable at a time while retaining
the original comparison and execution/history assertions. The evidence here
justifies that investigation method, not an inferred common cause with other
browser or font-cache findings.

## 2026-10-08 — Controlled paint-history reproduction and editorial preparation

[#1284](https://github.com/schlessera/brain-kit/issues/1284) reproduced both
original image hashes in the actual mounted approval fixture on source
`af372a97`. After an initial native screenshot, change the path link's display
from inline to inline-block, allow two animation frames, restore its original
style attribute, and allow two more frames. The next screenshot has the other
archived hash. Independent decoding again finds exactly 144 differing pixels
at x=63..205, y=251..253, rows 251 and 253: `(27,27,27)` versus `(26,27,27)`.
This is a controlled reproduction of the original image pair, rather than an
inferred font substitution or a newly synthesized diagnostic image.

Post-image native observations retain the same link rectangle
`[61,238.234375,148,14]`, computed font `10.45px / 15.675px JetBrains Mono`,
colour `rgb(91,181,162)` and dotted decoration
`color(srgb 0.356863 0.709804 0.635294 / 0.4)`. CDP reports the actual custom
JetBrainsMono-Regular face with 24 glyphs. Recorded ancestor geometry, opacity,
transforms and styles also agree. Changing and restoring only display is enough
to retain the alternate raster; toggling decoration or transform afterward does
not restore the initial raster. Thus identical final style, geometry and three
consecutive identical screenshots can still reflect different prior paints.

The controlled native rendering boundary selects an editorial preparation:
materialize an initial surface screenshot, rebuild the link's inline fragment
through the same display cycle, and restore the original style attribute before
checking visibility or accepting screenshots. The helper rejects changed final
text, geometry, font, colour, decoration, display, transform or opacity
(`refreshRuntimeLinkPaint`, `scripts/captures/runtime-paint.ts:4-38`). An initial
headless rAF alone does not reliably materialize the first surface, so the
unaccepted priming screenshot is necessary. No final CSS, browser flag, product
behaviour, tolerance, pixel baseline or comparison assertion changes. This is
capture preparation, not a claimed Chromium engine repair or identification of
the natural trigger in every historical failed CI execution.

The native regression runs the same actual approval fixture with fresh browsers
and two paint histories: ordinary and primed/display-cycled. It retains original
PNGs and post-image style/font observations, runs allow/deny execution and
persisted reload assertions, then uses the original checksum and byte comparator.
Replacing the preparation with a loaded no-op reproduces the original
`approval-allow-before-dark.png differs between unchanged runs` assertion and
image hashes. The restored preparation passes all six PNG comparisons and
correlated principal/effect/history evidence. Viewport resizing and disabling
Skia runtime CPU optimizations did not resolve the controlled mismatch; those
alternatives are not selected.

`capture:verify` retains its original full recipe order and thirteen exact-file
comparison, then requires this additional controlled native regression. The
`paint-history/` directory preserves its screenshots, measurements and receipt
alongside the original two-run artifacts, including on failure. Current-head
and exact-squash main CI are recorded on #1284 and its PR, rather than as a
mutable verification status here. The prior #1263 non-reproduction report and
all original failed attempts remain historical evidence.
