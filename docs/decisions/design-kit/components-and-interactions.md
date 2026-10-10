# Design kit — components and interactions

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-15--the-design-drop-gained-interaction-states-light-theme-and-desktop"></a>

## 2026-09-15 — the design drop gained interaction states, light theme and desktop

The Claude Design project was updated mid-build. Three of the deferrals we made
because the design lacked something are now obsolete, because it has it.

**New files**: `kit/Brain Kit Light.dc.html`, `kit/Brain Kit Desktop.dc.html`,
`kit/SideRail.dc.html`, `kit/CommandPalette.dc.html`, `kit/browser-window.jsx`.
**Component count 56 → 58.** The kit README gained three sections: "Interaction
states & accessibility", "Light theme", "Desktop".

Diffed v1 against v2: of the twelve primitives, exactly three changed —
`Button`, `Toggle`, `Icon`. The other nine are byte-identical. The remaining 44
components have not been re-fetched yet; the README's claim that "every
interactive component ships hover, pressed, focus and disabled" means the
interactive ones among them have almost certainly changed too, and waves 2-4
must re-fetch before porting rather than trusting the copies on disk.

<a id="d20--supersedes-d17-port-the-interaction-states-do-not-defer-them"></a>

### D20 — supersedes D17: port the interaction states, do not defer them

D17 deferred focus and hover because the design had none and I did not want them
invented. That reason is gone. The design now specifies all four states with
exact values, a role-and-keys table for nine component groups, and five
non-negotiable rules. Porting without them would mean deliberately discarding
part of the source.

The specification, verbatim enough to implement against:
- **Hover**: surface one step up (`#1a1d22`), border to `#3a3e47` on controls.
  The tone never changes — "a control that looks like something else on hover
  has lied about what it does".
- **Pressed**: `translateY(1px)` + `brightness(.94)`. No colour change, no ripple.
- **Focus**: 2px `#e8e4df` outline, offset **+2 on controls / −2 on full-width
  rows** so nothing clips it. Ink, not amber or teal, because focus says *where
  you are*, not what a thing means. `:focus-visible`, not `:focus`.
- **Disabled**: `opacity .45` + `pointer-events:none` + `aria-disabled`, plus a
  mono line saying *why*.
- **Interactive treatment appears only when a handler is passed** — a row with
  no `onClick` is not focusable and gets no hover, so a static list never
  pretends to be clickable. This is an API contract, not styling.

Mechanism: per-tone values travel as `--hv-bg` / `--hv-bd` / `--hv-fg` custom
properties set in `renderVals()`, because in DC a bound `{{ hole }}` compiles to
an empty rule. That constraint is DC's, not React's, **but keep the mechanism** —
it is exactly what makes the light theme possible: hover values become tokens
like everything else.

The five rules that are not negotiable: never colour alone (a monochrome
screenshot must still parse); a control that writes exposes its effect chip as
part of its accessible name ("Approve this edit, enqueue"); `aria-live="polite"`
on StreamingAnswer's phase line and InlineToast; `prefers-reduced-motion` drops
`breathe` to a static dot; and hit targets are not visual size.

**The hit-target rule has teeth.** 44px minimum on touch, but a 44px *target* is
not a 44px *box* — small visuals stay small and extend their target past the
paint. The constraint: expansion per side must be ≤ half the distance to the
nearest interactive neighbour, so a row of expanded targets needs `gap` ≥ 2× the
inset. The README records what happens otherwise: a neighbour's invisible
pseudo-element sits on top of your visual and steals the click, and
`FeedbackRow` briefly recorded thumbs-down for a thumbs-up. **Verify with
`elementFromPoint` at each target's edges, not its centre.**

Still deferred to the a11y wave: components that do not yet ship states, axe
verification, and flipping `parameters.a11y.test` from `'todo'` to `'error'`.

<a id="d21--revives-d9-the-two-theme-test-matrix-is-real-again"></a>

### D21 — revives D9: the two-theme test matrix is real again

A full light theme now exists with a published token contract, so
`initialGlobals: { theme }` across two Vitest projects is back on. The important
part is that **a light theme is not the dark theme inverted** — every dark
accent was chosen to glow against `#0c0e12` and collapses on paper (amber is
2.2:1 against white, gold 1.8:1). The rule is *hue carries the meaning,
lightness carries the contrast*.

**Accents carry two values in light mode**, where dark needed one: a darkened
**ink** for text, icons and borders, and the original **fill** for solid
surfaces that take near-black text. Fill-as-text is illegible; ink-as-fill turns
the primary button to mud. Small marks need a third step — at 6-8px a darkened
accent reads black, so status dots use a mid value. Tints use the *fill* hue at
8-14%, never the ink hue, which reads as dirt. Alpha ink stays banned in both
themes, and the focus ring is ink in both.

Implementation is exactly what we already instructed: each component's tone map
is the only place a colour literal appears, and that is the seam. Route through
custom properties on a `[data-theme]` root. Default to `prefers-color-scheme`,
keep an explicit three-way toggle (system / paper / dark).

<a id="d22--amends-d16-desktop-comes-into-the-kit"></a>

### D22 — amends D16: desktop comes into the kit

D16 kept desktop chrome in `ui-react` because the design was mobile-only. The
design now has two full desktop layouts and two new components, so `SideRail`
and `CommandPalette` join the kit and the breakpoint ladder is specified:

| Breakpoint | Nav | Layout |
|---|---|---|
| ≤ 479 phone | TabBar, 5 slots | one pane, pushes |
| 480-899 tablet | SideRail collapsed (60px) | list + detail |
| 900-1279 laptop | SideRail expanded (208px) | list + detail |
| ≥ 1280 desktop | SideRail + ⌘K palette | rail + list + detail + evidence |

Same component files as mobile; only frame and density change. Body 13.5 → 13px
(meta stays 9-12px mono); serif titles step 17 → 19 → 21 per pane width; answer
prose caps at **720px measure** however wide the window; StatTiles 3-up at 720px
and 4-up past 1100px; ComparisonTable may take a fourth column past 1100px,
never at 390px. Desktop may reveal *secondary* actions on row hover — never
state, provenance or effect chips, because those are what the row means. Focus
order is rail → list → detail → composer, and a resolved decision moves focus to
the next list item, never to the top of the document.

What never scales: one primary action per pane, one ambient animation, two
background colours, and the effect chip on anything that writes.

Mobile-first still holds as the authoring order, and `PhoneFrame` stays a
Storybook decorator — `browser-window.jsx` presumably becomes its desktop
counterpart.

> **2026-10-06 — Amended by [D52](sessions-and-drafts.md#2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943).**
> At ≥ 1280, Chat's list pane is the Sessions pane, with `New conversation`
> as its one primary action and Working above its date groups. Below 1280, a
> row between the transcript and the composer carries working sessions in its
> left half and pending follow-ups in its right half (right half only at
> ≥ 1280). It is a sibling, not an overlay, at most 94px tall and 44px while
> composing, and nothing in it animates. The ladder, the hover rule, one
> primary action per pane and the one ambient animation still bind.

<a id="also-noted"></a>

### Also noted
- `Composer` is a display component in the design — a styled span, not a live
  input. The README says to wire it to a real `<textarea>` with `:focus-visible`
  when implementing. That is net-new work, not a port.
- Desktop covers Chat and Actions only; Files, Activity and Settings at desktop
  width are unbuilt, so those screens have no desktop design yet.
- The light theme is specified and proven but **not yet wired into the
  components** — their tone maps still hold dark literals. The README calls
  routing them through `[data-theme]` custom properties "the implementation
  step", which is precisely what we instructed wave 1 to do.

<a id="2026-09-15--d24-is-superseded-buttondisabled-is-complete"></a>

## 2026-09-15 — D24 is superseded: `Button.disabled` is complete

D24 said `disabled` was ported but incomplete, and required the plan to record
the semantics as outstanding. **That was correct when written and is now wrong.**
Porting the interaction states in the same round brought the other half with it:
`aria-disabled`, `tabIndex={-1}` and the `role` the attribute needs in order to
qualify anything. Verified in the source — `aria-disabled` renders gated on
`interactive && disabled`, and the `Disabled` story asserts it.

Leaving the D24 note in place would have sent wave 1b hunting for work that is
finished. **Wave 1b's list is the nine components that have no states at all** —
a different list. The nuance worth keeping: `aria-disabled` appears only when a
handler was passed, because without one there is no `role="button"` for it to
qualify, and a bare `aria-disabled` on a `div` means nothing.

The general principle behind D24 still stands and is worth restating, since it
will apply again: **a half-ported feature must be recorded as half-ported**, or
a later wave reads the checklist and skips the missing half.

<a id="2026-09-15--wave-1-closed"></a>

## 2026-09-15 — Wave 1 closed

12 primitives, 115 tokens, `--bk-` prefixed. Verified independently: `tsc`
clean, six lint gates clean, 2753 pass / 24 skip / 0 fail, `storybook build`
green, 85 storybook tests in real Chromium, leakage clean, `check-dist-types`
clean, api-report regenerated.

Decisions made inside the wave that bind later ones:

- **`sc-host`: no wrapper — the component's own root is the flex item.** The DC
  wrapper was a plain block div, so every `flex` / `width:100%` / `boxSizing`
  the design wrote on a component root was inert. Dropping it makes those
  declarations do what their author wrote them to do. Consequence decided once:
  `inline-flex` roots blockify (visually identical; containers use
  `alignItems`), and a component needing host positioning gains a `style` prop
  merged onto its root.
- **`@theme` must be `@theme static`.** Without it, Tailwind v4 prunes every
  design token out of `dist/styles.css` when no source file uses a utility
  class — shipping a palette-less kit to any consumer who does not run Tailwind.
  Found by grepping the built CSS, not by a green build. Asserted by a test.
- **No `var(--token, #fallback)` anywhere** (D23). Verified the failure is
  genuinely loud: with stylesheets disabled, a primary Button goes
  `rgb(224,159,62)` → `rgba(0,0,0,0)`. Nobody ships that by accident.
- **Name a token for what it is, not where it was first used.** Applied to the
  18 hover tokens immediately rather than deferring — 12 turned out to be an
  existing colour under a second name and now say so
  (`--bk-button-hover-bg-ghost: var(--bk-color-raised)`). `--bk-hover-surface`
  was deleted outright as a duplicate of `raised`: **a second name for one
  colour is how two colours start.** The primary button lifts to
  `--bk-color-amber-lift`, *not* to gold — identical value in this palette, but
  "amber one step up" is what the hover means, and a theme that moved gold must
  not drag the primary button's hover behind it.
- **A token that refers to another must name one that exists** — asserted by a
  test, because an undefined reference inside a token renders nothing and the
  element quietly inherits. The three-level chain was confirmed resolving in a
  real browser: `--hv-bg` → `--bk-button-hover-bg-primary` →
  `--bk-color-amber-lift` → `#eab354`.
- **Keyboard activation is part of porting a role.** A `role="button"` that
  cannot be operated from the keyboard is worse than no role.
- **The DC parity harness lives at `packages/ui-kit/tools/dc-parity/`** and is
  runnable. It serves the real `.dc.html` under the real DC runtime and diffs
  computed styles node-by-node against the built Storybook. Later waves use it.

<a id="2026-09-15--the-two-button-overflow-corrected-cause-and-a-wave-5-hazard"></a>

## 2026-09-15 — the two-button overflow: corrected cause, and a wave-5 hazard

I diagnosed this as `hint-size` masking a latent layout bug. **That was wrong**,
and the real cause is more consequential.

Disproved two ways before the fix was written:

- **In the runtime source.** `hintToMin()` is reached only via
  `r.htmlStreaming ? hintToMin(…) : void 0`, and `htmlStreaming` is `false` in
  the registry's initial record. On a settled render `hint-size` contributes
  nothing — exactly what wave 0 concluded.
- **In the browser.** The DC page's action row was measured: the two
  `div.sc-host` wrappers are **155px and 65px** at `flex: 0 1 auto`. Were
  `hint-size` applied they would carry `min-width: 50%` ≥ 224px. Row
  `scrollWidth` 448 in `clientWidth` 448 — **the DC runtime does not overflow.**

**The actual cause is the `sc-host` decision.** Under DC the flex items were the
*wrapper divs*, and each Button was a block child inside one, so `width: 100%`
resolved against a shrink-to-fit box and came out content-sized. Wave 1 dropped
the wrapper deliberately, and recorded that those declarations "become live,
doing exactly what their author wrote them to do". Here what the author wrote
overflows — **because the author never saw those declarations take effect.**

Wave 1 verified the no-wrapper decision in a flex **column**. Nobody checked a
flex **row**, and a row is where it bites.

<a id="the-real-lesson--a-wave-5-hazard-not-a-button-bug"></a>

### The real lesson — a wave 5 hazard, not a Button bug

**`width: 100%` on a component root is now load-bearing, and nearly every block
component in the kit declares it**: `Surface`, `Placeholder`, `DiffBlock`,
`Receipt`, `DataTable`, `BarList`, `TraceSteps`, `ChoiceOption`, `ListRow`,
`QueueItemRow`, `SearchResultCard`, `ActionCard`, `AskUserCard`, `ApprovalCard`,
`NotificationCard`. **Put any two of them side by side in a flex row and this
recurs.** Wave 5 assembles screens; that is precisely where two components land
in one row. Check it there deliberately rather than discovering it visually.

Deleting `hint-size` remains correct. It was simply never the explanation.

<a id="the-fix"></a>

### The fix

`Button` gained an optional `style` prop merged last onto its root — wave 1's own
seam, which also avoided `theme.css` while wave 3 was editing it.
`ApprovalCard`'s two buttons take `{ flex: "1 1 0", width: "auto" }`;
`ActionCard`'s `WithButtons` uses `block={false}`, the content-sized shape
`AskUserCard` already demonstrates.

<a id="open-design-question--the-even-split-diverges-from-dc-on-purpose"></a>

### Open design question — the even split diverges from DC on purpose

DC actually draws ApprovalCard's buttons **content-sized at 155/65**;
`block={false}` would have been byte-identical parity. The 50/50 split is a
deliberate divergence, kept because the content-sized result is an accident of
the wrapper rather than anyone's decision, and the `hint-size="50%"` annotation
is the only *stated* intent. It shows in parity as one property on two nodes.

Note the ambiguity honestly: in the DC **editor** the designer saw 50/50
(hints apply while streaming); in the settled **catalog** they would have seen
155/65. So both readings have evidence. This is exactly the kind of question the
Storybook exists to settle — flagged for the maintainer rather than silently
resolved.

<a id="the-test"></a>

### The test

`overflowing()` in `stories/_stage.tsx` compares `scrollWidth` to `clientWidth`
*and* names which element escaped. Proven failing first:

```
content is 686px wide inside a 360px box
<div>Skip it overflows the right edge by 326px
<span>Skip it overflows the right edge by 178px
```

This is the general form, not the instance — it will catch the wave-5 hazard
above wherever a story exercises it.

<a id="2026-09-15--wave-3-closed-46-components"></a>

## 2026-09-15 — Wave 3 closed; 46 components

Verified independently: `tsc` clean, six lint gates clean, leakage clean, 2920
pass / 0 fail, brand sweep across `src/ stories/ fixtures/ tests/` empty,
`mapview-projection` 14 pass.

<a id="the-designs-hit-target-numbers-are-wrong--measured"></a>

### The design's hit-target numbers are wrong — measured

`inset` on an absolutely positioned pseudo-element resolves against the **padding
box**, so a 1px border eats 1px of reach per side. `FeedbackRow`'s thumb is
**46×42**, not the 48×44 its own source comment claims; `InlineToast`'s undo is
**43.65px** tall, not 44. **Both fall under the design's own 44px floor.**
Wave 1's `Toggle` is correct only because its track has no border.

Deliberately reported rather than silently fixed: `inset: -10px` would need
`gap ≥ 20`, and the design's gap is 18 — so "fixing" it reintroduces the click
theft the gap rule exists to prevent. The stories assert the *real* measured
numbers, and `NarrowGapStealsTheClick` reproduces the theft at `gap: 10` on
demand. **This needs the designer, not a patch.**

<a id="mapview-is-numerically-verified"></a>

### MapView is numerically verified

13 tests including the property that separates Mercator from equirectangular
(vertical stretch = 1/cos φ), pin pixels for Scylla/Charybdis, and the scale
bar's 59px converted back through metres-per-degree. **Two hand-computed
constants were wrong and the component was right** — which is the outcome that
makes the exercise worth doing. DC parity identical on every probed property
including every `top`/`left`.

<a id="d26--brand-replacement-stays-scoped-to-actual-contamination"></a>

### D26 — brand replacement stays scoped to actual contamination

A twelfth contaminated fallback was found that wave 2 missed: `TraceSteps` named
the same plausible real person. An earlier pass replaced **all twenty** default
fallbacks with Odyssey content; nine were reverted.

**Decision: keep that revert.** Replace a runtime fallback only where it carries
a real brand or person. The untouched fallbacks stay parity-comparable against
the DC source, and parity is a verification asset we have repeatedly cashed in —
it caught the `sc-host` row hazard and confirmed MapView's projection. Divergence
has a cost and should be paid only where a rule requires it.

**Sharpened by D29 (wave 4), which is where the operative test is stated:** the
question is not "is this in-world?" but "would shipping this string name
something REAL?", and the line is drawn by audience — stories and fixtures are
the demo world and are Odyssey without exception, while a runtime fallback is a
developer-facing default and a parity anchor.

<a id="a-real-design-gap-surfaced-by-narrowing-types"></a>

### A real design gap, surfaced by narrowing types

Six tone unions were narrowed, which let 13 fixture shapes re-point at `../src`
and turned `fixtures/types.ts`'s stated guarantee into a compile error. It
immediately caught something a human review would not: **`ContactCard` cannot
express severity in a fact** — its table is the entity palette, with no red or
gold — so "last spoke: 20 years ago" had to settle for amber. Worth fixing in
the design rather than working around.

<a id="two-harness-findings-worth-keeping"></a>

### Two harness findings worth keeping

- An auto margin cannot be compared without width-matching the containers (cost
  a phantom 920px diff).
- `MapView`'s scale bar is a second instance of wave 1's `Chip variant="count"`
  box-sizing exception — so that is a pattern, not a one-off.
- A grep for `::before` in built CSS reports MISSING because the minifier
  collapses it to `:before`. Check both forms.

<a id="2026-09-15--d27-disclosure-becomes-optionally-controlled-maintainer"></a>

## 2026-09-15 — D27: `Disclosure` becomes optionally controlled (maintainer)

**A deliberate divergence from the DC source, and the only one in wave 3.** The
design's component is uncontrolled after first interaction and the port
reproduced that exactly. It now supports a controlled mode as well. Recorded
here because a later reader comparing the React component against the `.dc.html`
will see an extra prop and be tempted to "restore parity" by deleting it; the
component's own doc comment points back at this entry for the same reason.

<a id="why-the-designs-behaviour-is-not-enough"></a>

### Why the design's behaviour is not enough

Two cases in this app are simply unreachable without it, and neither is
hypothetical:

- **A server-driven expand.** A transcript that re-renders because the agent
  said "expand the trace" cannot expand it. The value is in the parent and the
  component refuses to look at it after the first click.
- **An accordion.** A parent rendering several disclosures — the Run-detail
  screen does — cannot collapse the others when one opens, because each holds
  its own state and no parent can reach in.

Both are the same defect seen from two sides: the value lives in the component
and the reason to change it lives outside.

<a id="the-shape-which-is-what-keeps-this-safe"></a>

### The shape, which is what keeps this safe

Three modes, and the middle one is the design's, untouched:

| Props passed | Mode | Behaviour |
|---|---|---|
| neither | uncontrolled | starts closed, toggles itself |
| `open` | **seeded** | **the design's exactly** — seeds once, then ignored |
| `open` + `onOpenChange` | controlled | the parent owns the value |

**The presence of BOTH props is what hands over control**, not `open` alone.
That is the whole reason the divergence is cheap: every existing call site
passes only `open`, so every existing call site is bit-for-bit unaffected, and
`OpenPropIsSeedOnly` still asserts the old behaviour rather than being rewritten
to match the new one. Had `open` alone flipped the component to controlled, this
would have been a breaking change to a component the design already shipped.

`onOpenChange` fires on every toggle in all three modes, so a parent can observe
without taking ownership.

<a id="verification"></a>

### Verification

Four stories, one per mode plus the accordion. `Controlled` asserts the case
that is invisible when you get this wrong: a parent that IGNORES the callback
gets a disclosure that does not open, proving no second source of truth is
quietly holding state alongside the parent's. `Accordion` asserts that opening
one of three collapses the other two, which is the case the change exists for.

<a id="the-general-rule"></a>

### The general rule

A port may diverge from the design where the design's behaviour makes a real
requirement unreachable — but the divergence must be ADDITIVE and gated on a
prop the design never had, so the design's own behaviour remains the default and
stays asserted. Anything that changes what an existing call site does is a
different kind of decision and needs the design to move first.

<a id="2026-09-15--wave-4-closed-59-components"></a>

## 2026-09-15 — Wave 4 closed; 59 components

Verified independently: `tsc` clean, six lint gates clean, leakage clean, 2961
pass / 24 skip / 0 fail, 486 storybook tests in real Chromium, brand sweep
empty, `agentorbit-placement` 8 pass, eight DC parity comparisons.

Thirteen components: the four agent views, six pieces of chrome, `ScreenBody`,
and D22's two desktop components. `PhoneFrame` shipped as story furniture, not
as a component (D16), so the kit exports 59 and the tarball contains no frame.

<a id="d27--the-negative-margin-hit-target-is-exact-the-pseudo-element-one-is-not"></a>

### D27 — the negative-margin hit target is exact; the pseudo-element one is not

Wave 3 found `inset: -9px` on a bordered element short by 1px per side, because
`inset` resolves against the containing block's PADDING box. The brief asked
whether the padding/negative-margin method carries the same error. **It does
not**, and the reason is structural rather than incidental: padding is not
measured against anything, it IS the box, so the expansion is exact whether or
not the element has a border.

The neighbour constraint still applies, and for `TabBar` it now has a measured
number. With `justify-content: space-around` the clear gap between two slots is
the bar's free space over the slot count, so for the five default slots it
reaches the required 28px at a bar width of **276px** — measured, not derived:
275px touches at -0.02px, 276px separates at +0.19px. **A five-slot tab bar below
276px steals its own clicks.** Comfortably under any phone the design targets,
but it moves with the slot count and the label lengths, and the floor is now
recorded in the component, in the README and in a story that reproduces the theft
at 240px.

**One deliberate departure from D20's gating rule.** `TabBar`'s padding is
ungated, unlike wave 1's `.bk-switch::before` and wave 3's `.bk-thumb::before`,
because it is ALSO the badge's containing block — `right: 0` resolves against the
padding box, so gating it would move the badge out of the corner the moment an
item lost its handler. Geometry that two things depend on is not gated on one of
them. The cost is that a static item in a mixed bar still carries an expanded box.

<a id="d28--stagewidth-is-a-cap-not-a-width"></a>

### D28 — `stageWidth` is a cap, not a width

`#storybook-root` shrink-wraps under the preview's `layout: "centered"`, and the
stage is `width: 100%; max-width: <stageWidth>`. A component that does not force
a width therefore renders at its CONTENT width and the cap never binds — measured
at 212.23px for `LaneChart` in a 244.23px root, against the 360 its parameter
names.

**Were the earlier assertions wrong, then? No, and the reason is specific rather
than reassuring.** Waves 1-3's layout assertions go through `overflowing()`,
which compares `scrollWidth` to `clientWidth` and then each child's edges to its
parent's. Every one of those is RELATIVE — it asks whether content fits its own
box, whatever that box turned out to be — so a narrower box cannot corrupt it.
It can only make the test easier or harder to pass, never wrong. The assertions
that D28 would have invalidated are ones about an ABSOLUTE pixel number, and
waves 1-3 made none; wave 4 is the first to need any, which is why it is the
wave that found this.

The corollary is the rule: **any story that measures geometry must state its own
width in a wrapper**, which `TabBar`'s now do. At content width `TabBar`'s five
slots touch and their padding boxes overlap by 28px, which would have made every
number in `HitTargetIsExact` meaningless while still passing.

<a id="composer-is-net-new-work-and-it-is-finished"></a>

### `Composer` is net-new work, and it is finished

The design's own known-gaps list asks for the real input, so this is not a port
and should never be read as one. ⏎ sends, ⇧⏎ inserts a newline, the ring moved to
the field via `.bk-field:has(:focus-visible)`, and with no `onChange` the field
is genuinely `readOnly` rather than a div wearing `role="textbox"`. Height
follows a controlled value's newline count, capped at five rows, which keeps the
component a pure function of its props at the cost of not growing on soft wrap.

The parity harness cannot compare it on anything. That is the correct outcome for
a component that deliberately renders a different element.

<a id="screenbody-is-the-one-addition-and-it-earns-its-place"></a>

### `ScreenBody` is the one addition, and it earns its place

`flex: 1; min-height: 0; overflow` is retyped by hand on every assembled screen
in the catalog. A flex item without `min-height: 0` is floored at its content
height, so the body grows instead of scrolling and the tab bar walks off the
bottom of the phone — a failure that reads as "the list is too long" rather than
as a missing declaration. Nine screens, nine chances to get it wrong.

<a id="agentruncard-takes-agent-not-name"></a>

### `AgentRunCard` takes `agent`, not `name`

The source's `data-props` declares `name` while its own `renderVals()` reads
`p.agent`. The half that renders wins, and the design's own prose agrees
("FileRow uses `label`, AgentRunCard uses `agent`"). `name` was only ever reserved
because `<dc-import name="…">` owns that attribute — a DC constraint React does
not have. The wave-0 inconsistency is closed.

<a id="d29--sharpens-d26-demo-world-versus-developer-facing-default-maintainer"></a>

### D29 — sharpens D26: demo world versus developer-facing default (maintainer)

Wave 4 replaced four fallbacks and then reverted one, and the ruling that came
back is worth more than the string. **D26 said "replace only actual
contamination"; D29 says what actual means**, and draws the line by AUDIENCE
rather than by coherence:

- **Stories and fixtures are the demo world.** They appear in screenshots,
  website copy and demo videos, so they must be Odyssey, coherent, and free of
  real brands and real people. No exceptions.
- **Runtime fallbacks are developer-facing defaults and parity anchors.** They
  are visible only to a consumer who renders a component with no props. They
  stay verbatim *unless they carry a real brand or a real person*, because
  divergence costs us the ability to parity-compare — and that has repeatedly
  paid, including twice in wave 4.

**So the test is not "is this in-world?" but "would shipping this string name
something REAL?"** A real airline does. A real city in a task description does
not.

Applied: `GraphView`, `CommandPalette` and `MessageBubble` replaced (a real
airline, a plausible real person, a real city used as a project). `AgentRunCard`
restored to the source's "Compare the three Lisbon venues against last year's
notes", which makes it consistent with the nine wave-3 fallbacks that mention a
Lisbon workshop and buys back its default parity — 9 nodes each against the DC
page, the only difference being the `margin: auto` container-width class.

This also retires the standing question wave 3 left open ("should D19 extend to
fallbacks?"). It should not, and now there is a rule rather than a case list.

<a id="the-third-interaction-class-is-one-declaration"></a>

### The third interaction class is one declaration

`.bk-row-fg`, an additive modifier adding `color: var(--hv-fg)` on hover — the
exact sibling of wave 2's `.bk-row-border`. `TabBar` takes it alone (a tab bar has
no row to shade), `SideRail` takes it with `.bk-row`'s background. Both are
`.bk-row` rather than `.bk-control` on the design's own discriminator: their
focus ring is at -2, drawn inside, because a nav item sits against a container
edge.

`.bk-row:hover`'s background gained a `, transparent` fallback so that a
component setting only `--hv-fg` does not get its background reset to initial by
a declaration invalid at computed-value time. Changes nothing for the fourteen
components that set `--hv-bg`.

<a id="lanechart-is-where-tokenisation-broke-the-source"></a>

### `LaneChart` is where tokenisation broke the source

It derives two fills by concatenating a hex alpha suffix onto the lane's own
colour (`c + '80'`, `c + '8c'`). `var(--bk-teal-ink)80` is not a colour, so the
two derived values became two real seven-tone ramps at 0.5 and 0.55.

A consequence worth keeping: the hatch is keyed off the legend's glyph STRING, so
`fixtures/runs.ts` spelling `glyph: "hatched"` would have drawn the solid swatch
— a legend saying "running" beside a chart saying "stopped". Exported as
`HATCH_GLYPH`, ported as found, asserted in a story.

<a id="the-preflight-box-sizing-exception-is-a-pattern-not-a-series-of-one-offs"></a>

### The preflight box-sizing exception is a pattern, not a series of one-offs

Fourth and fifth instances: `TabBar`'s badge (a fixed 15px box with 3px padding,
6px narrower under border-box, showing up as a 6px `left` because it is
positioned by `right: 0`) and `PhoneFrame`'s bezel, where border-box was eating
9px of the device's own screen and a "390x844" mock was really 372x826. The frame
sets `content-box` explicitly, because a bezel is outside the screen.

<a id="browser-windowjsx-was-not-ported"></a>

### `browser-window.jsx` was not ported

It is Claude Design's own starter scaffold — Chrome's chrome in Chrome's greys,
marked "raw elements/hex/px by design" — rather than Brain Kit design. Nothing in
wave 4 or wave 5 needs a browser mock: `SideRail`'s two-pane stories present a
desktop layout honestly, without pretending to be a browser.

<a id="2026-09-15--d30-data-props-defaults-are-editor-seeds-not-component-defaults"></a>

## 2026-09-15 — D30: `data-props` defaults are editor seeds, not component defaults

All 58 sources swept. **254 props carry a non-empty `data-props` default; 12
diverge** between DC's propless render and ours. The rest are identical
(reachable `??`/`||` fallbacks, booleans read as `!== false`, or equality checks
where the default *is* the un-passed branch), or already covered by wave 1's
"genuinely optional props stay bare".

**Decision: keep the port as it is. Do not resolve `data-props` defaults into
React defaults.**

The deciding argument is what those twelve defaults actually *are*. Nine of them
are booleans and enums whose default makes the component render its **emphasised**
state: `ChoiceOption.selected`, `ListRow.selected`, `FileRow.active`,
`StatusDot.pulse`, `ActionCard.footPulse`, `Callout.italic`,
`ScreenHeader.metaTone='teal'`, `ActionCard.rightMetaTone='red'`,
`TrendChart.deltaTone='red'`.

Reproducing DC would make a propless `ChoiceOption` render *selected* and a
propless `TrendChart` render *red*. The sharpest case is `TrendChart.deltaTone`:
`'red'` as a React default would make **every un-toned delta read as bad news**.

So the `data-props` defaults are optimised for a catalog preview — "show me what
this looks like" — not for "what should this be when unspecified". A catalog
wants the interesting state; a component library wants the neutral one. They are
different questions and the design only ever answered the first.

Cost of this choice: our Storybook and the DC catalog disagree on propless
renders, and parity comparisons pass explicit props. Waves 3 and 4 already paid
that without difficulty — six of eight wave-4 comparisons needed no props at all.

**This is an existing rule applied consistently, not a new one.** `Meter.variant`
and `StatusDot.pulse` are in the twelve and have the same shape, so wave 1's
ruling already covered them. (`Button.size` is not: its `p.size || 'md'` is
reachable, so the port is right by any reading.)

<a id="the-one-genuine-defect-which-goes-back-to-the-designer"></a>

### The one genuine defect, which goes back to the designer

`AgentRunCard.progress` is the only case where a `??` **exists and is
unreachable**: `Number(p.progress ?? 72)` sits beside
`showProgress: p.progress !== undefined`. Every other divergence is honestly
signalled by having no fallback at all; this one *looks* like a kept fallback
while behaving like the rest. That is a readability trap in the source — dead
code that reads as live — and it is why this whole question looked like a new
policy rather than an old one.

Action: keep the behaviour, delete the dead operand, and comment why, so nobody
later "fixes" the gate to use a fallback that was never reachable. Render parity
is unaffected — it is source text, not output. Add it to
`design-feedback.md` as a source defect.

<a id="2026-09-16--four-decisions-wave-6-made-while-building-the-contract-layer"></a>

## 2026-09-16 — four decisions wave 6 made while building the contract layer

**1. A contract with no payload is a first-class shape, and `query_activity` is
one.** The obvious design gives every tool a payload schema. `query_activity`
must not have one: its result is free text from past runs, wrapped in a
nonce-suffixed delimiter precisely so the model reads it as data rather than as
instructions. A payload schema is an invitation to hand that text to a
component, which is a separate decision with its own threat model. So
`ToolContract` and `ToolComponentContract` are two types, `bind()` accepts only
the second, and the refusal is structural rather than a comment.

**2. Bound renderers register GLOBALLY, and the backend-scoped entry had to
go.** The registry resolves backend-scoped exact names before global ones. The
Claude pack listed `mcp__brain-ui__get_current_location`, so a global
contract-bound renderer for the same tool would never have been reached — it
would have looked like `bind()` was broken. The rule that falls out: a tool that
belongs to the CHAT UI is registered under every spelling of its name and scoped
to no backend, and only a tool that genuinely belongs to one backend is scoped.

**3. The payload convention is now followed, not just declared.** pi's
`request_image_mask` reported a sentence while ask_user and
get_current_location serialised payloads, which is the "convention we are
establishing, not following" the plan flagged. Establishing it meant changing
what the model sees for that tool and moving a characterization fixture that
exists to pin pre-refactor behaviour. That is allowed under D31, and the drift
test now states in words that this one result is expected to move — a
characterization test that is silently re-baselined stops being one.

**4. Idempotence belongs to a registry, never to the module that fills it.**
Both `registerBuiltinRenderers` and `registerAsrClients` guarded themselves with
a module-level `registered` boolean that the matching `reset*` could not clear,
so the first reset anywhere permanently un-registered them. The renderer
registry dedupes by pack identity and the ASR registry is keyed by provider id,
so both latches bought nothing and cost the ability to reset. The general
form: **a latch outside the thing being reset is a bug waiting for a reset to
exist.**

<a id="2026-09-18--d36-single-key-shortcuts-are-focus-scoped-a-resolved-decision-hands-focus-to-the-next-card-or-the-empty-heading"></a>

## 2026-09-18 — D36: single-key shortcuts are focus-scoped; a resolved decision hands focus to the next card or the empty heading

The design's answer to design-feedback §10, verbatim in its README and D3:
`a` / `d` / `s` act only while the ActionCard they belong to holds focus, and
are printed on that card's own buttons; `j` / `k` only inside the focused
list, printed in its footer; anything global takes a modifier (⌘K, ⌘1–⌘5);
Settings carries an off switch for single-key shortcuts (WCAG 2.1.4's third
escape hatch). Focus after a decision goes to the next card, and when the
resolved card was the last, to the `EmptyState` heading, "focusable for
exactly this reason". These are app rules and land with the desktop
migration (S7+); the kit's share is small and done: `EmptyState`'s title is a
`role="heading"` at `tabIndex={-1}` with a `focusTitle` prop, `Home` / `End`
reach the edges of every roving group (`focusEdge`, beside `focusSibling`),
and the printed keys are ordinary label text. The kit does not bind `a`, `d`,
`s`, `j` or `k` itself: which card is "focused" for the purpose of a letter
key is the list's knowledge, not the card's.

<a id="d36-addendum--printed-keys-follow-the-pointer-so-a-keyboard-only-tablet-goes-without-them-maintainer-2026-09-22"></a>

### D36 addendum — printed keys follow the pointer, so a keyboard-only tablet goes without them (maintainer, 2026-09-22)

"Every shortcut is printed where it applies" met a tablet in landscape: past
`laptop:` it read the rail's `⌘1`–`⌘5` and a footer of letters it had no key
to press. #86 and #100 answered that by printing those keys — the rail's
`⌘1`–`⌘5`, the approval cards' `a` / `d`, the search and add panels' hint
lines, and the Actions pane's `j` / `k` / `d` — only while
`(any-pointer: fine)` matches (`useFinePointer()`,
`packages/ui-react/src/hooks/use-fine-pointer.ts:13-15`). The palette's `⌘K`
on the rail was left out of that and still prints everywhere. The
**bindings** do not follow the pointer: every key stays registered in every
state, and the Settings switch still decides whether single letters bind at
all.

That query is a proxy for "a key can be pressed", and one configuration falls
through it: **a tablet with a keyboard but no trackpad** (a keyboard folio
without a trackpad, or any Bluetooth keyboard paired to a touch-only tablet).
It reads coarse, so none of those keys print, while every binding still fires. A
keyboard that carries a trackpad reads fine and is unaffected.

The platform offers nothing better. Media Queries Level 4 defines `pointer`,
`hover`, `any-pointer` and `any-hover`, and says they "only relate to the
characteristics, or the complete absence, of pointing devices, and can not be
used to detect the presence of non-pointing device input mechanisms such as
keyboards". **There is no keyboard-presence media query.**

**Ruling: do nothing (#106).** That tablet keeps working bindings and goes
without the pointer-gated hints. The alternatives were weighed and rejected:

- **Reveal the keys on the first keydown** re-breaks #86: a soft keyboard
  fires `keydown` with real `key` values, so a touch-only tablet typing a
  search query would summon the `⌘1`–`⌘5` row #86 removed.
- **Reveal on a keydown a soft keyboard does not send** (a `meta` / `ctrl` /
  `alt` chord, `Tab`, `Escape`, `F1`–`F12`) asks the reader to press a key
  before learning which keys exist — `⌘1` is one of the things the hint was
  meant to teach — and costs a mid-session reflow plus a module-level flag in
  a single-process test file.
- **A "show keyboard shortcuts: auto / always / never" preference** is a
  settings surface for a rare case, and a second switch beside
  single-key shortcuts that governs something different.

What would reopen this is a signal that says a hardware keyboard is present,
not a better guess from the pointer.


<a id="2026-09-22--the-composer-follows-soft-wrap"></a>

## 2026-09-22 — the composer follows soft wrap

"`Composer` is net-new work, and it is finished" recorded a trade: height from
a controlled value's newline count, capped at five rows, keeping the component
a pure function of its props at the cost of not growing on soft wrap. The cost
landed on the most common input there is — a paragraph typed into a
phone-width field scrolled inside one visible line (#92) — and the trade is
replaced, keeping the half that mattered.

**What replaced it.** `field-sizing: content` on the textarea, applied only when
there is text to follow. The browser's own line layout, which runs on every
keystroke regardless, is the measurement; the component stays a pure function
of its props with no ref, no measuring and no layout effect, so a keystroke is
still one render of the subtree that re-renders on every keystroke by design.
The newline count stays on `rows` as the floor: a browser without
`field-sizing` (it arrived in Chrome 123, Safari 26.2 and Firefox 152) sizes
from `rows` alone and gets exactly the old behaviour. Where `field-sizing`
applies, `rows` bounds nothing, so the cap has to carry `maxRows` itself: it is
`maxRows` whole lines or the design's 96px, whichever is smaller. That is what
the constant `maxHeight: 96` already produced while `rows` did the bounding —
the default still stops at exactly 96px, a smaller `maxRows` gets that many
whole lines rather than a fraction of 96, and a larger one does not raise the
ceiling. Scaling 96px by `maxRows` instead was tried first and rejected: it
spreads the default's deliberate ~4.90-line shortfall to every other row count,
so a three-row field clipped by a pixel that no shipped behaviour had clipped.

**Alternatives refused.** *Measuring `scrollHeight` in a layout effect:* a
forced synchronous layout per keystroke, and either a `setState` that commits
twice per character or a direct style write that makes the height a thing the
render does not know about. *The stacked-grid replica* (a hidden copy of the
value in the same grid cell): works everywhere, but doubles the text in the
DOM, and its correctness rests on two elements' text metrics never diverging.
Both buy back browsers that will have `field-sizing` before either would ship
its next bug.

**An empty field stays one row.** With no text there is nothing to follow, and
a placeholder longer than the field would otherwise take a second row that the
first character typed took away again. The uncontrolled composer is untouched.

<a id="2026-09-24--d46-a-shared-answer-draws-its-blocks-in-a-print-theme-46"></a>

## 2026-09-24 — D46: a shared answer draws its blocks, in a print theme (#46)

**Question.** Sharing an answer as PNG or PDF sent the message's markdown
source to the renderer, so every kit block was missing from the file: a
classified table shared as its raw text, and an explicit `show_block` payload,
which is not in the markdown at all, shared as nothing. What should draw the
shared file?

**Ruling (maintainer, recorded on #46).** Neither the markdown alone, nor a
capture of the live DOM, nor a server that renders React. The browser renders
each block to static HTML with the transcript's own `BlockCard` and embeds it
in the markdown it already sends. `marked` passes raw HTML through, and the
renderer stays scriptless and network-denied. PNG and PDF share that one
document.

- **Order** is `message.parts`: a block sits where the model called
  `show_block`, whenever its payload arrived. Thinking, the tool trace,
  `ask_user` exchanges, and a `show_block` payload that fails the schema are
  left out, as the transcript's answer leaves them out.
- **Print is its own theme**, not the light or the dark one.
  `PRINT_TOKENS` is derived from `LIGHT_TOKENS` by
  `tools/theme/derive-print.ts` under four rules: a white ground, no
  translucent washes, borders that carry the structure (flattened to opaque
  colours a printer keeps), and the light theme's ink. The recommended column
  of a comparison keeps a fill, because it is data. `tests/print-theme.test.ts`
  pins the table, the stylesheet block and each rule.
- **Dependencies run one way**: `ui-kit` → `ui-react` → HTTP → `ui-server` →
  `render-template` → renderer. `ui-kit` owns the palette and `printThemeCss()`.
  `ui-react` composes the document and adds the print `<style>` only when an
  answer has a block. `ui-server` and `render-template` gain nothing and
  know nothing of the kit, which keeps React out of `core`'s `brain render`.
- **A message with no block sends exactly what it sent before**, so the
  common case cannot regress.

**Rejected.** *Capturing the rendered DOM:* the ref covered only the last text
group, the app's Tailwind classes do not exist in the render template, and a
phone-width dark screen is not a page. *Server-side rendering:* it would put
React and the kit into `ui-server`, or into `render-template` and so into
`core`. *Reusing the light theme for print:* its washes and translucent
borders assume a screen, and fade or turn muddy on a grayscale printer.

**One layout change the ruling did not name.** It placed per-format layout in
`render-template`. The PNG width and A4 already live in the renderer, and the
one block-specific rule (`break-inside: avoid` in print) travels in the print
`<style>`. `render-template` is therefore unchanged, and a message without
blocks produces the same document byte for byte.

**Known limits.** The kit's web fonts cannot load in a network-denied
renderer, so shared blocks fall back to the system fonts the rest of the
document uses; embedding the fonts would inline them into every share request.
And several blocks carry a meaning in ink colour alone (a trend delta's good
or bad tone, a table cell's judgment), which a grayscale printer loses: the
tone inks come out as near-equal greys. That is fixed in the components, with
a non-colour cue, not in the palette (#309).

**Proof.** `tests/share-render.test.ts` renders an answer with every block kind
in real Chrome. It asserts that nothing but inline data was requested, that
each block is drawn with a white ground, the print ink, and only print-palette
backgrounds, that the PDF is A4, and that a no-block answer renders to a PNG
byte-identical to the old path. `Blocks/In print` renders every block under
the accessibility gate in both story projects, and four print baselines cover
it in the pinned image.

**App export destinations, 2026-09-30 (#558).** The maintainer selected the
concrete opt-in `linkPolicy: "visible-destinations"` in the shared template.
The app's render route enables it after validating the request and passes the
same option to its renderer for both formats. A bare/full document only opts
out of the shell, never this policy. CLI defaults stay unchanged. The shared
classifier lives in `render-template/links`; the kit re-exports its existing
public imports. Neither the template nor the renderer depends on the kit or
React. The edge table records these two hard leaf dependencies, and existing
build/publish order already puts the template first.

The final HTML is structurally parsed. SVG navigation becomes an inert figure
plus a disclosed ordinary caption link; its drawing is preserved. Declarative
shadow templates are flattened before classification. Embedded documents
(`iframe`, `object`, `embed`) become honest placeholders: Chrome otherwise
includes their independent links in PDF annotations even without JavaScript.
Content-supplied bases, refresh navigation, form targets and SVG href-changing
animations are removed. These rules leave the approved static block vocabulary
and ordinary document styles intact.

Chrome then protects the destination in the final screen/print layout, freezes
motion and checks every destination glyph's geometry and hit-test visibility.
Local clipping/hidden styles are repaired; an obscuring overlay, an unresolved
clipped glyph or a destination beyond the PNG capture cap refuses the export.
Protected declarations follow source shorthand resets. A fresh first layer
prevents source rules from reopening the protection layer, and painted
pseudo-elements participate in hit testing. A document with accepted links
refuses export if its content security policy blocks the protective stylesheet.
The optional renderer lazily loads PDF.js to verify the finished PDF too:
every external annotation must have its own tagged, complete destination on
that physical page at the 9-point floor. Chrome's print scaling and page-size
clipping can differ from live print-media geometry. Author words occupy a
separate paragraph tag; the final monospace code tag owns the disclosure
(older Chrome maps it to `NonStruct`). Body text cannot substitute for it.
The render budget still bounds this work. Scripts remain disabled for this
policy, even if a general-purpose renderer was configured to allow them. The
network and sandbox defaults do not change. Custom app renderer implementations
must honor the option's final-visibility check as well as the HTML transform.

`tests/export-links-runtime.test.ts` inspects real PDF annotations and text,
plus the actual PNG capture's DOM. Its inline image proves the request observer
is wired; no external requests occur. It covers alternate markup, fragments,
mail, long hosts and supplied hiding/clipping CSS at 320/768 pixels. Default
CLI byte preservation and the existing full block print/runtime suites remain
separate checks.

<a id="2026-09-30--d51-recoverable-failures-stay-in-their-turn-and-outward-diagnostics-require-review-576"></a>

## 2026-09-30 — D51: recoverable failures stay in their turn, and outward diagnostics require review (#576)

**Ruling.** The [recovered composition](https://github.com/schlessera/brain-kit/issues/576#issuecomment-5906135339)
and the [maintainer's corrections](https://github.com/schlessera/brain-kit/issues/576#issuecomment-5906946639)
are the design. A red or gold hairline `Surface` follows the partial answer
and tool timeline under the existing turn header. Class-driven copy states
only what the payload establishes. It promises no empty workspace, rollback,
fixed recovery time or absence of prior tool effects. Missing model, runtime
version, time and total call counts are omitted. #631's observed counts are
retries and appear as `retries` in the receipt; they never imply an initial-call
total. The normalized per-turn observations supplied by #630 and #631 survive
replay. D50's error suppression now applies
live and on replay, even when the failed turn had offered valid suggestions.

`TurnErrorCard` composes the kit's `Receipt`, `Disclosure`, inert `DiffBlock`,
`Button` and polite `InlineToast`. The provider message is redacted as best
effort before display, never parsed as markup or allowed to choose actions.
Long messages wrap; the initial preview is capped at forty explicit lines
or 4,000 characters, with a named expansion showing the full text. All
controls have 44px targets. Only live arrival creates an alert; its text is
fixed for the life of the card, and replay creates none. Reduced motion
removes the transcript entrance animation.

Subscription `authAction` remains authoritative: its established instruction
is reproduced verbatim with `for whoever runs this server`. An explicit-key
profile or generic pi auth failure gets neutral credential wording. No
Settings sign-in, new auth workflow or model-switch action is invented. All
model switches wait for #61's linked-session design.

Retry is confined to the latest eligible failure and starts a distinct turn
with the host-retained original request, including image bytes and effective
prompt. The warning says prior actions may run again. An atomic delivery
receipt prevents duplicate starts from a double tap or repeated delivery.
The client stores only correlation ids and checks delivery after reconnect;
unconfirmed delivery is not an invitation to resend. A refusal restores the
action. An unclassified failure gets one manual retry. Server errors offer
Report after a repeated observed failure.

When a reported absolute reset is in the future, the latest eligible action
reads `Retry · in Ns` and is disabled until that timestamp passes. The same
deadline governs live arrival and replay; reopening the transcript never
starts a new delay. Countdown updates do not change the fixed live-failure
announcement. Expiry does not override a pending send or an uncertain delivery:
`Check delivery` remains available to reconcile an acknowledgement, including
while a cooldown is still active. Unknown or expired resets add no wait.

Copy and Report first open an editable, exact outgoing preview in the kit's
`BottomSheet` inside a native modal. Its keyboard focus is trapped and
returned to the opener. The default diagnostic allowlist contains protocol,
known class and observed status, plus product auth instructions when relevant.
Provider text is optional, redacted as best effort and capped visibly at
1,500 characters. The reader can edit every byte. Copy occurs only on the
final Copy action; opening Report transmits the reviewed URL payload to
GitHub before issue submission, which the sheet states explicitly. A long
URL is refused with a copy-and-paste fallback, never silently shortened.
There is no promise that heuristic redaction catches all private content.

**Activity failures (2026-10-05, #598).** The same review serves failed
Activity runs, under the [approved proposal](https://github.com/schlessera/brain-kit/issues/598#issuecomment-5974850029)
and its [corrections](https://github.com/schlessera/brain-kit/issues/598#issuecomment-5981210012).
`DiagnosticReview` moved to `components/report/` and gained an editable title,
explicit inclusions and a URL-length meter; the chat card keeps its copy.
`Send bug report` appears only where `isFailureOutcome` holds: as a 44px
sibling of a history row, reading `Report` below 480px, and under the receipt
in run detail. Its accessible name always names the run, outcome and time.
The default facts are protocol, client release, server release and commit when
`/api/status` was read, origin, outcome, duration, record state, built-in
failed-step tool names and billing. Failure text and job name are explicit,
redacted and capped inclusions. Names, IDs, paths, payloads and traces are never
generated. A pruned, missing or unread record says so in words. Opening the
review from a row reads only that run's record from this server, without
payloads, and changes nothing.

<a id="2026-10-07--sent-tracks-use-attachmentrow-1143"></a>

## 2026-10-07 — Sent tracks use AttachmentRow (#1143)

The [approved attachment composition](https://github.com/schlessera/brain-kit/issues/1143#issuecomment-6030745326)
and [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1143#issuecomment-6030989836)
use `AttachmentRow kind="doc"` for sent validated tracks. Identity and known
metadata come from existing intake/history: incoming name, format, byte count,
`sent`, a differing staged name and a no-line waypoint note. The static row
opens nothing. It has no role, tab stop, duration, waveform, extract or trust
line. Images retain their live zoomable thumbnails and count-only history chip;
the composer's retry/remove chips retain their queue behavior.

`kind` and `label` become required, and prototype attachment facts are removed
from runtime defaults. Metadata accepts several wrapping lines. The accepted
pre-1.0 API break ships in a minor: callers pass identity and optional facts
explicitly. This is an approved exception to D30's parity defaults; examples
remain in stories. No attachment protocol or persistence contract changes.


<a id="2026-10-07--code-fences-compose-codeblock-1142"></a>

## 2026-10-07 — Code fences compose CodeBlock (#1142)

The maintainer approved retaining lazy syntax highlighting for chat code
bodies as an explicit exception to decision-only colour. The host passes
highlighted React children to the pure kit; it owns the clipboard action.
Keywords use purple ink, strings and additions teal, numbers and literals
gold, titles blue, comments muted italic, and deletions red. Other token
classes inherit the ordinary code ink. Every rendered token must meet 4.5:1
against the code surface in dark and paper, measured independently from
computed browser colours. The highlight theme requires the maintainer's
visual sign-off in Storybook before merge.

Copy occupies the head and uses the original React text descendants with
one trailing fence newline removed, including when file linkification
changes the painted text. Mermaid retains its earlier routing. Long lines
wrap without changing copied source. The kit draws no language, sample
command or copy glyph when the corresponding input/action is absent; the
maintainer accepted these pre-1.0 breaking changes in a minor. Other hosts
must pass `lang`, `code` or `children`, and their real `action` explicitly.
No tool schema, protocol or permission semantics change.


<a id="2026-10-07--recorded-subagents-use-state-rings-1145"></a>

## 2026-10-07 — Recorded subagents use state rings (#1145)

The approved AgentOrbit design replaces the prototype progress radius with
three state groups: inner needs you, middle running, outer ended. A pending
approval is evidence only when its tool span descends from that agent in the
recorded run and belongs to its chat. Terminal outcomes win over older
approvals; success is done, failure outcomes are failed, and denied/cancelled
are neutral stopped. No timer, percentage or simulated completion is drawn.

Activity run detail mounts the overview only for at least two recorded child
subagents while Activity is supported and retained. Names are functional types
(or agent when absent), and completed metadata retains outcome and an actual
recorded duration. Pills open the existing chat subagent drill-in; the host
selects the recorded session when present. The complete span list retains
44px named drill-in targets, including on phones and beside the evidence rail.

Below a 480px container width the host requests compact 12px marks; these
are not controls. Labelled circles have fixed state radii and measured,
wrapping pills capped at 160px. Capacity is bounded by circumference and
actual rectangle collisions, including effective targets across rings. A
last-slot +N represents overflow and scrolls/focuses the full span list.
Very tall names that fit no slot are represented by that count rather than
clipped. Frame height can grow to contain targets; the 340px desktop orbit
needs 390px for three rings of 44px targets. No ring spins or transitions;
only running/waiting dots pulse, with the existing static reduced-motion
keyframes. The group names all three counts and creates no live region.

The accepted pre-1.0 break ships in a minor: OrbitAgent requires id/state,
AgentOrbit requires agents, progress orbit/angle are removed, RunState gains
stopped (including AgentRunCard), and core/sample defaults are removed.
This is an approved exception to D30 parity defaults; examples live in
fixtures and stories. Hosts pass compact and real navigation callbacks;
no new wire contract, telemetry or extension seam is introduced.


<a id="2026-10-09--d55-native-icon-and-text-actions-1379"></a>

## 2026-10-09 — D55: native icon and text actions (#1379)

The [design ruling](https://github.com/schlessera/brain-kit/issues/1379#issuecomment-6087751547)
adopts `IconButton` for icon-only controls and `TextButton` for inline text
actions. Both render native `button type="button"`, forward refs for React 18,
and pass `data-*` hooks. `Button` retains its existing API and element;
`DiscButton` remains limited to D52's three transcript discs.

`IconButton` has mute, danger and overlay tones. Its md box is 44px; sm is
28px with a 14px glyph and grows its paint and target to 44px under
`any-pointer: coarse`. Mute hovers to the strong veil and ink; danger stays
red at rest and hover. Overlay uses raised at 80% with ink-dim: ink-mute
fails over arbitrary media, while ink-dim clears 4.5:1 over both white and
black in both themes. Expanded mute triggers stay raised and ink.

`TextButton` formalises the existing ask-list text actions: body link text
uses teal-ink and an underline, mono meta uses ink-mute and lifts to ink-dim
with an underline on hover, and inherit takes its context's font and colour.
Underlines are text-decoration (D34). Standalone targets are at least 44px
tall; inline paint has a 20px minimum box and reaches 12px vertically and 4px
horizontally, requiring 8px between neighbours. The minimum preserves 44px
reach even when inherited text has a shorter line height, without changing
its font. Both primitives retain a 2px focus ring at offset +2,
a pressed translation, and native disabled behaviour at opacity .45.

Composite hit areas remain raw with a closed reason vocabulary:

| Code | Reason |
| --- | --- |
| `row` | Composite full-width list, menu or disclosure content that ListRow cannot draw. |
| `select` | Selection with its own ARIA role or state; no fitting kit segment/tab control. |
| `surface` | A kit card or rendered page is the hit area. |
| `canvas` | Canvas/media tool with that surface's own palette. |
| `kit` | Already uses kit tokens and bk-control, with a reason the component cannot fit. |
| `api` | Requires a native capability absent from the kit control; name that capability. |
| `dev` | Dev-only harness. |

The marker grammar is `raw-button: <code> — <reason>` (a hyphen also separates
code and reason); the reason has at least 12 characters. Put the comment
inside the opening tag, as `//` between attributes or `/* */` on one line.
A marker travels with the element and stays out of the DOM; a file:line
allowlist drifts and a per-file count cannot explain a second button.
Row and select sites use bk-row interaction, preserving selected/rest paint.
The raw-button lint and consumer migrations are separate batches; this
ruling approves only new primitive baselines for the kit batch.
