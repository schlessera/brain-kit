# Native browser tests use the pinned design fonts

2026-10-08, approved for [#1278](https://github.com/schlessera/brain-kit/issues/1278).

Every ui-kit browser project, including consumer layout measurements, loads
DM Serif Text, Plus Jakarta Sans and JetBrains Mono before rendering. The test
setup reuses the checksum-locked preview font inputs and licenses already used
by feature captures. Preparation happens outside the browser; execution only
reads verified cache bytes and embeds them as data URLs. Missing or changed
inputs fail setup instead of selecting a platform font.

Portable stories do not consume Storybook's preview-head.html. Their CSS font
tokens were consistent, but without loaded custom faces the pinned image painted
system fallbacks. RecordingRow's original reference matches the WenQuanYi mono
control; changing only its family to Liberation Mono reproduces the failed
Accepted image exactly. This establishes the rendering difference, without
claiming to have measured the historical CI trigger. Other fixtures registered
Liberation Mono under the JetBrains Mono name, sometimes without cleanup.

The maintainer approved reliable design-font loading followed by migration of
all affected baselines. System-font aliases are removed. Product tokens, font
source, fixture strings, screenshot tolerances and browser image stay unchanged.
The preview source supplies mono weights 400–600; the 700-weight status remains
browser-synthesized from the real face, as in that source.

Font readiness and a declared CSS family do not prove painted font identity.
The runtime guard inspects Chromium's CSS.getPlatformFontsForNode results for
nonempty glyphs, custom-font use and the locked files' internal family and
PostScript names. All three roles and required weights/styles are probed.
RecordingRow also verifies its actual timestamp/status nodes. Registered-font
manifest and stylesheet checks surround every test, catching aliases, duplicate
stylesheets and missing inputs. Native negative controls omit font CSS and
register a loaded local alias; both must fail the painted-face guard even though
a declaration-only fonts.check can pass for the alias.

All affected baselines are generated and compared in the pinned Playwright
image with the same verified cache, themes and pointer/viewport settings.
Changing font metrics can reveal layout or accessibility defects; updating a
baseline does not excuse those assertions. Independent defects retain their
own issues and gates.

The separate provider lifetimes from
[subject isolation](subject-baseline-isolation.md) remain in place. That record
describes the historical fallback experiment; this migration replaces its
fallback and local-alias font inputs without removing process isolation or
failure screenshots. The [visual harness README](../../packages/ui-kit/tests/visual/README.md)
documents preparation and complete-matrix regeneration.
