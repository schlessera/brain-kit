# ContactCard fact columns

**Decided 2026-10-04 by the maintainer on [#599](https://github.com/schlessera/brain-kit/issues/599#issuecomment-5978278042).**
The selected treatment is capped aligned growth. It applies to ContactCard's
facts; the header, avatar, badge, actions, tones and fact content retain their
existing behavior.

A fixed-width key box can keep a 10px box gap while its glyphs draw over the
value. Facts are evidence, so hiding the end behind an ellipsis or tooltip
would lose information. One shared column instead grows toward the widest
intrinsic key and then wraps complete text. All values keep one aligned edge.

`keyWidth` is now a **minimum**, rather than an exact column width. Only finite
positive numbers supply that floor; absent, zero, negative, malformed and
nonfinite values use 84px. The upper bound is `max(92px, minimum)`. Keys that
fit the floor preserve their value edge and single-line row pitch. A key
between the floor and cap grows the column; one beyond the cap wraps after
`_`, `-`, `.` or `/`, with emergency wrapping anywhere for unbroken text.
Inserted break opportunities leave selectable and accessible text unchanged.

The 92px cap follows the existing card's 12px padding and 1px border:
a 288px card has 262px of content, which leaves a 160px value track after the
92px key track and 10px gutter. The existing mono font stays 500 at
10.5px/1.5, with a 5px row gap. Only rows whose content wraps grow. Long
unbroken values wrap within their track; empty values receive no placeholder.
Colors continue through the existing [theme and tone rules](design-kit/tokens-and-styles.md#2026-09-18--d32-the-light-theme-is-light-dark-per-token-switched-by-color-scheme-under-data-theme).

An explicit positive minimum above 92px raises the cap to that minimum.
It is deliberately not clamped or stacked: an oversized caller-supplied floor
can overflow a narrow card and leave no value width. The 160px allocation is
the default 288px case, not a guarantee for arbitrary custom widths. The
actual graph rail supplies 72px; fitting degree/hop facts retain that geometry.

The rejected alternatives were an exact fixed column with wrapping, which
would disregard the adopted growth policy, and a new opt-in mode, which would
leave ordinary callers vulnerable to the collision. Truncation would hide
evidence. A responsive clamp on oversized explicit widths would introduce a
different supplied-width policy without a ruling.

This changes a kit layout property's meaning, with an affected-package minor
changeset. It adds no prop, block variant, SDK schema or machine surface;
the integration contract explicitly excludes kit layout knobs.

The browser proof uses the checksum-verified preview fonts and the pinned
Playwright image, measuring nonempty text Range rectangles rather than
estimating a glyph advance from font size. It covers both themes, phone and
desktop containers, the mounted graph caller, supplied floors, normalization,
empty content and the oversized-width boundary. Six fitting captures originate
from the original component; separate long-key captures review the adopted
wrapping. Mutations independently remove wrapping, finite normalization and
fitting geometry to demonstrate that the corresponding assertions can fail.
