# Design kit — loading

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-10-07--d53-loading-is-ghost-text-1116"></a>

## 2026-10-07 — D53: loading is ghost text (#1116)

**Decision.** A loading state is **ghost text**: blurred text set in the same
type role, size and length as the content it stands in for, with the kit
spectrum (amber → purple → blue) sweeping through it left to right. When an
item's data resolves, its ghost cross-fades out under the real text over
600ms. The amber `breathe` skeleton bars are gone from every loading view.
`GhostText` is the only thing that draws a ghost (`ghostString`,
`packages/ui-kit/src/internal/GhostText.tsx:99-116`).

**Why it beat the alternatives.** Grey bars with the amber halo read as a
glowing outline, and they had the shape of no content in particular, so the
layout jumped when the content arrived. The design explored two other answers:
an aurora field behind the card, and "decode" noise that resolves into the
text. The aurora field has no shape at all and says nothing about what is
coming. Decode noise is legible glyph churn: it animates the text itself, reads
as content, and cannot honour reduced motion without becoming a frozen
nonsense string. Ghost text has the replaced content's own shape, so the frame
is final from the first frame and, when the ghost knows what it stands in
for, the handoff moves nothing.

**Length-sized ghosts.** A ghost is as long as what it replaces: the value
this item showed last time on a re-fetch, else a length hint the caller has (a
search snippet's length, a file name from a listing), else the component's
typical length (an ActionCard title 58 characters, a body 44, a queue subject
22, a search path 26 and snippet 120, a file name 14, an answer three lines of
the measure). The glyphs are seeded words of 2–9 characters at roughly English
letter frequency, seeded by the component instance — which React keeps per
item key, not per list position — so they never flicker and re-ranking a row
does not regenerate them. A single-line
slot matches its ready line exactly. A wrapping slot can still break onto one
line more or fewer than the real text, because seeded words do not break
where the real ones do; a sweep of the fixture strings at 110–380px measured
that in about one case in eight. That is the cost of not drawing the stale
value, and it is accepted. So is the cold load: with no history and no hint,
an ActionCard ghosts a typical card — kind, title, body and foot — and a
title-only card loses those two bands when it arrives.

**Paper hues tuned for contrast.** All three hues stay on paper, deepened
along their own hue until each contrasts with the paper ghost base (`#c8bfac`)
as much as its dark pair does with the dark base (`#3a3d46`): amber 4.75,
purple 4.26, blue 4.93. Those are derived values, not drawn ones, and
`tests/ghost-text.test.tsx` holds each pair within 10%.

**Ghost text is a loading state, not ambient motion.** D22's "one ambient
animation" keeps its wording: `breathe` is still the only thing that moves on
its own for as long as a state lasts. A ghost moves only while something is
being waited for and ends when the data does, which is the line between the
two. `ghost` is therefore a second keyframe beside `breathe`, not a second
ambient one. Reduced motion shows the ghost as plain blurred text in the base
colour, with no sweep and no spectrum, makes the handoff instant and lands a
stream's tail at once; print hides it. `tests/visual/ghost-media.visual.tsx`
checks the computed result under the emulated media, so a rule that wins the
cascade back cannot pass it.

**What is never ghosted.** The frame — borders, radii, padding, icons, the
status-dot slot — is final from the first frame. Emphasis that depends on the
data waits for it: an approval's 2px border, a blocked row's amber shell, a
dot's tone. An icon that depends on the data is a 14px outline slot until then.
Slots the caller already passes while loading — an ActionCard's chip,
machine facts, children or foot link, a queue row's note and link — keep their
space: the text ones as ghosts, the rest invisible and inert. A streaming
answer's first chunk fades in over the same 600ms, and it holds
its ghost's height while it streams, so the first token, shorter than the
ghost, moves nothing below it; past that height the answer grows downward.
Nothing is a control while it loads: no role, no tab stop, and a click does
nothing.


<a id="d53-addendum--one-compositor-band-per-frame-1126-2026-10-07"></a>

### D53 addendum — one compositor band per frame (#1126, 2026-10-07)

**Decision.** The maintainer selected V5 after reviewing V1–V4: static base
text, with one moving band for each QueueItemRow, FileRow, SearchResultCard,
ActionCard and Placeholder frame, or StreamingAnswer prose block. This replaces
per-slot sweeps and per-row staggering; each item still hands off when its own
data arrives, over the same 600ms. The retained `index` props no longer set a
sweep delay. Neither the seeded glyphs nor their role/size/blur map changes.

**Why.** V1 moved `background-position` through clipped, blurred text, repainting
and blurring every slot each frame. V3 moved a band per line but multiplied the
compositor work. V5 shares the moving mask across the block. The prototype
measurements on Chromium 153, at 6× CPU throttle, 412×915 and 2.625 DPR, with
20 file rows and 6 action cards, were:

| Variant | Main thread ms/s | Paint ms/s | Raster ms/s | Software compositor ms/s | fps | Frames >33ms |
| --- | --- | --- | --- | --- | --- | --- |
| V1 shipped | 410 | 325 | 300 | 244 | 60 | 0/179 |
| V3 band per line | 171 | 29 | 0 | 4005 | 29 | 37/86 |
| V5 band per block | 15 | 1 | 0 | 1128 | 60 | 0/179 |

These are the profiling session's 3s windows, recorded on #1126. Software
rasterisation makes the compositor numbers relative evidence, not hardware GPU
or Android measurements. No additional measurements are claimed for V2/V4.
The maintainer explicitly chose to ship without a real-device measurement;
there is no Android performance claim and no stepped-animation fallback gate.

**The band.** A track spans the frame plus 0.6em on each side. Its band is
`max(100%, 9em)`, at opacity 0.56, with amber, purple and blue mask windows that
extend 8px above and below the frame and never repeat. The track and band
translate forward, their layout copies counter-translate, all over 2.6s with
`ease-in-out`. The sum keeps glyphs stationary while the band's left edge moves
from `−m − band` to `block + m`. A stationary frame clips the moving layers
at the owning frame’s inline edges, with 8px of vertical blur bleed. Its layout
box never extends sideways, so even a frame at the viewport edge adds no
horizontal scroll width. Slot blur remains unclipped within that frame.
The cycle boundary is colour-free; timing is
tested against this V5 path, not V1's separate per-line paths.

**Broad reflective sweep (maintainer revision).** The maintainer reviewed the
implementation and asked for a band about as wide as the text, with smoother
colour transitions, so the whole text lights up rather than one small focus
area travelling across it. The band therefore spans the full track, with a
9em minimum, instead of the prototype's 40%. At the middle of the cycle it
covers the whole frame. The amber leading ramp reaches opacity .08/.3/.65/1 at
9.23/18.46/29.23/40% of the band; blue mirrors it at
90.77/81.54/70.77/60%. The maintainer specifically requested longer transitions
on both sides; each outer fade therefore spans 40% rather than 26% of the band.
Purple and the inner ends remain percentages. These broad ramps scale with the frame; the earlier
fixed 2.34em edge ruling is superseded by this revision. The maintainer also requested a slight diagonal stagger within each block:
all three masks use a 110° gradient, leaving glyph geometry and the horizontal
motion path unchanged. Visual sign-off at
320px and desktop, in both themes, remains required before merge.

**Copies and media.** The internal band snapshots the committed loading layout
three times, preserving the exact seeded text, font, baseline and wrapping.
Supplied React children are mounted once. Copies are aria-hidden and inert;
controls and resources become empty boxes and only ghost glyphs paint. Custom
elements and customized built-ins also become boxes before cloning, because
inertness does not suppress their constructors; SVG resource tags use the same
guard irrespective of tag-name case. Their
blur is 1.2px greater than the base. Single-line text clips before the blur,
so ellipsis does not cut off blurred ends. Reduced motion hides the entire
band and disables every translation; print hides ghosts and the band. The
existing instant reduced-motion handoff and stream tail rules remain.


<a id="2026-10-07--streaminganswer-is-the-turns-waiting-status-1144"></a>

## 2026-10-07 — StreamingAnswer is the turn's waiting status (#1144)

The [approved waiting composition](https://github.com/schlessera/brain-kit/issues/1144#issuecomment-6030764508)
and [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1144#issuecomment-6031007929)
retain the existing rich thinking/tool/prose renderer and the composer's one
Stop control. Before any group arrives, the waiting row shows `thinking` and
two ghost lines; arrival unmounts it immediately. A pending approval in the
last tool group shows one static `waiting for approval` row under the controls.
Retry shows the existing protocol helper's wording. A restored pending
approval keeps its waiting row until the host closes it, even though replay
has no text stream. Terminal turns draw no waiting row. Status belongs to the message in its root/session/turn.

Elapsed time uses a matching host turn start when supplied; otherwise a turn
started on this page uses its timestamp. A recovered shell without host timing
shows none. Only the phase word is a polite live region, so elapsed ticks and
target changes do not announce. No answer text, cost or progress is passed.

The approved pre-1.0 minor removes the kit's prototype phase, target, elapsed,
answer and cost defaults. Callers supply facts explicitly; `pulse` selects a
working pulse or static decision-wait dot. Existing ghost-band and streamed
text animations retain their implementations. This is an approved exception
to D30's parity defaults, and no stream/cancellation contract changes.


