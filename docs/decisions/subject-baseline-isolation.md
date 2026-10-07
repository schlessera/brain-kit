# Subject baselines use a separate browser

2026-10-03, measured for [#879](https://github.com/schlessera/brain-kit/issues/879).

The incumbent composed-story baseline file has its own Vitest browser project.
Another file's failure screenshot must not choose the platform font fallback
used by these comparisons. This is the same process boundary already used for
module Settings; it changes neither product styles nor reference images.

## What distinguished the runs

The source was main `1d1fcc72a7e06352e8b5ee020b3910864babc5db`, with frozen
Vitest/browser-playwright 4.1.11 and Playwright 1.63.0. Every workspace was built.
The pinned `mcr.microsoft.com/playwright:v1.63.0-noble` image had ID
`sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`.
Docker used network denial, host IPC, user 1000:1000 and `HOME=/tmp`; the
checksum-verified font cache was mounted read-only. Its lock hash was
`3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad`.

The #853 draft's sequential-file wrapper control, retaining all five original
projects, reproduced **722 pass / 42 fail** in the first shard: forty incumbent
subject pixel mismatches plus the two independent #867 picker failures.
The fresh direct full control passed the subjects because they ran before
track intake. Neither a focused subject pass nor the earlier dictation/ranking
controls exercised the preceding failing picker file.

A bounded two-file control forced track intake before subjects. All forty pixel
mismatches recurred. Print figures differed by **5536 pixels, ratio 0.03**.
Putting subjects first passed all 54 subject tests. Both arms retained the
source, image, reporter, environment and sequential-file setting.

Synchronous browser observations collected computed styles, stylesheet rules,
FontFaceSet entries and readiness immediately before the original assertion.
Node-side Playwright observers collected CSS responses and CDP
`CSS.getPlatformFontsForNode` results concurrently, without a test-side await,
font load or extra screenshot. A later observer retained the buffers from the
existing locator screenshot calls. All temporary instrumentation was restored.

| Measurement at print figures | Shared browser after picker failure | Isolated subject browser |
| --- | --- | --- |
| Computed mono family | `"JetBrains Mono", ui-monospace, monospace` | identical |
| Computed weight for advice text | 400 | 400 |
| Actual advice-text face | Liberation Mono, `LiberationMono`, 14 glyphs | WenQuanYi Zen Hei Mono, `WenQuanYiZenHeiMono`, 14 glyphs |
| Actual bold sans face | Liberation Sans, `LiberationSans-Bold`, 17 glyphs | identical |
| Custom platform face | false | false |
| FontFaceSet status / entries | loaded / empty | identical |
| Kit stylesheet / declared font faces | 67915 characters / none | identical |
| CSS module response | 200, 70529 bytes | identical |
| Font requests / request failures | none / none | identical |
| Iframe / parent scale | 414 × 896 / 0.8035714285714286 | identical |

The nonempty CSS response SHA-256 was
`b34705efed2eadfc08cd4ffa171af95a3004bbfd832c2940fa43caaeaf13fcc0` in both arms.
An empty FontFaceSet here records the absence of custom faces; the CDP glyph
counts independently establish which installed faces painted the text.

The print-figures reference SHA-256 is
`db466286675a7bb6fc2e36fc999855bde7a4908eecca769f87dbd930cc8811c2`.
The restored shared-project mutation's matcher-written actual PNG SHA-256 was
`95e95c33f9eb7b8a0e7b3bde43185a8c79af7c672fe7f80432a9f398f013673d`;
its two original screenshot buffers both hashed to
`c92da9b607b099e3e349c961961134681de23eadabe9decf54598c96fe3fbd4f`.
The restored isolated-project capture hashed to
`dba27dfeec20dd57241e906cae1f6e023809ee99be3c6f4fb5b6f337dc4ca66b`
and passed the original pixel comparison. PNG byte hashes distinguish capture
artifacts; a passing pixel assertion does not require identical PNG encoding.

## The failure screenshot is the trigger

Removing only consumer CSS did **not** prevent the mismatch. Importing the
picker fixture without executing its two picker tests passed. Successively
bounded controls for viewport restoration, Composer rendering, typing, canvas
creation and file selection all passed the later print assertion when they
stopped before the independent failing `expect(uploaded).toBeDefined()`.

Replacing that flow with a deliberately failing assertion immediately after
viewport restoration still changed the used mono face to Liberation Mono and
reproduced the same 5536-pixel mismatch. A diagnostic arm with
`browser.screenshotFailures: false` retained both deliberate failures but kept
WenQuanYi Zen Hei Mono and passed print figures. The installed Vitest runner's
`onTaskFinished` takes a screenshot after an ordinary failed test; its browser
provider takes that capture through a body locator. This separates the measured
trigger from consumer CSS, product typography and pointer state. The underlying
Chromium font-cache mechanism was not established by these measurements.

## Why a project boundary

The subject file is excluded from the shared visual project and included exactly
once in `subjects`, with its existing `formViewport` command
(`name: "subjects"`, `packages/ui-kit/vitest.config.ts:169-177`). All 54 tests run,
including the form comparisons that need that command. The provider owns a
separate browser for each project. Default wrapper selection includes this
project; the `visual` and `visual:update` package scripts select both projects
so moving the file cannot silently drop its comparisons.

Changing product fonts or refreshing baselines would conceal the state
dependency. Disabling failure screenshots would remove useful diagnostics.
Sorting subjects first depends on every preceding file and cache order. The
separate browser preserves diagnostics and protects every subject from the
measured preceding-file state, rather than special-casing the upload fixture.
Existing local FontFace fixtures and the consumer-style fixtures were audited;
they remain outside this subject project's browser. The subject file's own
local FontFace checks delete their faces in `finally` and remain unchanged.

The runtime mutation moved the subject file back into the shared visual
project: the original print assertion failed on **5536 differing pixels** after
the two known picker assertions. Restoring the project boundary passed all 54
subject tests while retaining both picker failures. This is behavioral evidence
from actual Chromium, rather than a predicate over the config object.

The complete sequential-file matrix retained all **1844 tests / 173 files**:
**1834 pass / 10 fail**, with only #867's two picker assertions and #878's eight
fine-pointer assertions failing. Those failures have separate owners. The
#853 scheduling control and its complete-matrix requirement remain separate;
this rendering measurement does not establish a cause or resolution of #559's
stable-screenshot timeout. Shard receipts and current-head CI belong in the
issue and PR, not in this decision record.
