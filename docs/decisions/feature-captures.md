# Feature capture sources and evidence

Decided under [#613](https://github.com/schlessera/brain-kit/issues/613), within
[#608's approved public-presentation scope](https://github.com/schlessera/brain-kit/issues/608).
The [capture guide](../process/feature-captures.md) and
[editorial data](../process/feature-captures.md#capture-data) carry the concrete recipes.

## Curated sources keep the claim small enough to verify

Use a small set of actual assembled screen exports, with search and command
compositions where those affordances need their own view. D19/D29 in
[the design-kit record](design-kit.md) bind the fictional world; the later
maintainer ruling extends Odysseus to every public example surface. D32 and
D34/D35/D37 preserve actual themes, controls and destinations.

A Storybook screen is evidence of component composition. Its fixture props and
mocked callbacks do not establish retrieval, executor policy, persistence or
scheduled delivery. Separate runtime harness sources establish those claims.
This keeps the caption and consuming page tied to the behavior the source
actually exercises.

The alternative, capture every story, grows an unreviewable asset set and
confuses component variants with visitor journeys. Recreating screens in a
marketing-only renderer creates another implementation that can drift. Capturing
a personal installation conflicts with the public-project boundary. The
catalogue instead names real source exports and source-backed readiness.

## Editorial crops serve a different reader from regression baselines

The existing visual suite awaits real composed stories and compares the painted
body (`async function looksRight(`, `packages/ui-kit/tests/visual/subjects.visual.tsx:160-163`).
That is the D10 regression gate. An editorial still needs a named feature,
consumer, crop and caption, so it has its own output and provenance. Reusing
a baseline as an unnamed marketing image loses that relationship.

The phone furniture (`export function PhoneFrame`, `packages/ui-kit/stories/_phone.tsx:45-64`)
defines a 390 × 844 content box inside a 9-pixel bezel. Browser measurement of
these sources gives a 408 × 862 outer box. Cropping the interior preserves the
selected README dimensions without inventing device markup. Whole-stage
component crops retain their actual geometry. Initial crops exclude lower
content on scrolling screens; that exclusion constrains their alt text.

## Readiness includes the environment that produced the pixels

Use the shared pin (`const IMAGE =`, `scripts/visual.mjs:44-44`)
and its matching installed dependency. D10's measured rendering differences
make a host browser an inadequate replacement for the declared environment.
The paper renderer (`async function looksRightOnPaper(`, `packages/ui-kit/tests/visual/subjects.visual.tsx:173-178`)
passes the theme global and asserts the resulting theme; setting an attribute
before render can be overwritten by the preview decorator.

The preview loads font CSS (`rel="stylesheet"`, `packages/ui-kit/.storybook/preview-head.html:17-19`).
An otherwise pinned browser with an unsuccessful font request can draw a
readable fallback screenshot with different wrapping. Resolve and hash the
actual required font bytes, keep notices, serve them locally and require loaded
faces. Record those bytes beside the browser, build and fixture provenance.
A fixed delay or network-idle signal cannot prove that the intended fonts and
state painted.

The source review used the declared browser image, cached actual preview font
responses and blocked unexpected external requests. Measured crops keep the
chat quotation visible while its map lies below the fold; the file viewer
shows early backlinks while later rows need scrolling. Those observations
define the captions, rather than a list of everything mounted in the DOM.

## Motion explains an input gesture

The ranked-question source (`export const RankUntouched`, `packages/ui-kit/stories/decisions/AskUserRankCard.stories.tsx:34-34`)
uses the real component's local ordering. A captured pointer drag moves Circe's
island from third to first while preserving all five choices and announcing
the result. A short clip shows pickup and the changing drop position; before
and after stills show the result and provide a reduced-motion fallback.
Leaving submission untouched keeps the demonstrated behavior local to this UI
interaction. The other selected sources need stills rather than an invented
model stream or a video-editing system.

The configuration is one marked JSON block inside the Markdown guide, so
captions and alt text retain the epic's Markdown editorial source. A separate
committed JSON copy would create another place to edit them. The generator
validates that block and may copy selected values into artifact provenance.

The catalogue is editorial data used with its generator, with no provider seam
or new supported machine API. It follows the existing corpus and launch
acceptance rules; generation produces artifacts for review.
