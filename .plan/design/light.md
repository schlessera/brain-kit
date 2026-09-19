# Brain Kit · light — the paper theme

Source: `kit/Brain Kit Light.dc.html` from the 2026-09-18 design drop (the file
is new in that drop; the earlier drops had no light table anywhere), **revised
the same day** after the port measured the first palette failing on the canvas
(design-feedback §19), and **revised again in the fourth drop** later the same
day (§20: teal, purple and red for stacked tints; every dot stated). Values
below are the current ones; the superseded values are listed at the end. Five
sections, `L1`–`L5`. This digest carries every number the file states, because
the file is the only place they are stated and the kit's light values are
generated from them (`packages/ui-kit/tools/theme/derive-light.ts`).

The file's own framing, verbatim: *"A light theme is not the dark theme
inverted. Every accent in the dark palette was chosen to glow against
`#0c0e12`, and on paper those same values collapse: amber `#e09f3e` is 2.2:1
against white, gold is 1.8:1. Inverting the ramp and keeping the hues would
produce a theme where 'needs your approval' is the least legible thing on the
screen."* The rule that replaces inversion: **hue carries the meaning,
lightness carries the contrast** — same hue families, darkened until they pass.

---

## L1 · Token mapping

One-to-one with the dark palette, "so a theme switch is a value swap and never
a layout change". The README's table now states each ink against the **worst
real ground — a 12–16% accent tint over canvas**; the file's L1 table quotes
the surface ratio. Both columns below.

| Token | Dark | Light | On surface | On worst ground |
|---|---|---|---|---|
| canvas | `#0c0e12` | `#ece7dc` | — | — |
| surface | `#141619` | `#f8f5ef` | — | — |
| raised | `#1a1d22` | `#fffefa` | — | — |
| line (hairline) | `#1f2229` | `#ddd6c7` | — | — |
| edge (border) | `#2a2d35` | `#c8bfac` | — | — |
| ink | `#e8e4df` | `#231f1a` | 15.1:1 | 11.6 |
| ink dim | `#c0bcb5` | `#554f45` | 7.4:1 | 5.8 |
| ink meta (the floor) | `#9a96a1` (was `#8a8691`) | `#5f584c` | 5.3:1 | 5.0 |
| amber · ink | `#e09f3e` | `#7f4c08` | 5.4:1 | 5.1 |
| amber · fill | `#e09f3e` | `#e09f3e` | 7.2:1 (with `on-fill` on it) | — |
| gold · ink | `#eab354` | `#6f540c` | 5.1:1 | 5.1 |
| teal · ink | `#5bb5a2` | `#15594c` | 5.8:1 | 5.45 stacked |
| purple · ink | `#b197d4` | `#5d4489` | 5.6:1 | 5.27 stacked |
| blue · ink | `#67b8e3` | `#1a5c7f` | 5.5:1 | 5.2 |
| red · ink | `#f87171` | `#9c2a24` | 5.4:1 | 4.81 stacked |
| focus ring | `#e8e4df` | `#231f1a` | 15.1:1 | 15.1 |

The dots (fourth drop; "a 7px mark is not type, so it is judged against the
3:1 non-text bar (WCAG 1.4.11) rather than 4.5 — but it *is* judged"):
amber `#b06d10` 3.4 · gold `#9b7610` 3.4 · teal `#227f6c` 3.9 · purple
`#7a5fb0` 4.2 · blue `#22719b` 4.4 · red `#bd3b33` 4.4 · neutral `#847c6f`
3.3, all against the canvas. The aliases: `skeleton` = line, `on-fill`
`#231f1a`, `well-on-fill` `rgba(255,255,255,.28)`.

The kit measures these in `tests/contrast.test.ts`: every accent ink on every
tint of its own hue over the canvas, and ink-meta over every tint, all clear
4.5 — which is the claim the revision makes, verified rather than trusted.

The new rule the revision adds (§L5, "State the palette against its worst
ground"): *"A light palette stated against `surface` has no headroom anywhere
else, and the failure is systemic rather than local: a port measured 141
stories failing on paper from this single cause. The worst real ground is an
accent tint over canvas … Amber, blue, red and ink-meta all sat at 4.1–4.6
there while passing comfortably on surface, and all four came down a notch.
Audit every ink against the tinted canvas first; surface and fill follow for
free."* And its companion, "Tinted cards may sit on canvas": the alternative —
requiring every tinted card to sit on `surface` — was rejected, because
approval cards appear directly on canvas in Actions, Chat and the digest.

Three side notes the section carries:

- **Elevation still means lighter.** In dark a card is lighter than its canvas;
  in light it is lighter too — toward white, not toward grey. So hover keeps its
  meaning with no special case: one step up, both themes.
- **Tints go up, not down.** Dark tints the accent at 4–10% alpha to lift a
  panel off black. On paper the same alpha vanishes, so light tints at 8–14% of
  the **fill** hue — "the warm one, never the darkened ink, which would read
  as dirt".
- **What does not change.** Every radius, every space step, every type size and
  weight, all component structures, and the one `breathe` animation. "A theme
  is a palette, not a redesign."

## L2 · The two-value accent rule

"The one genuinely new idea in this theme." Each accent carries **two values**
on paper: a darkened **ink** for text, icons and borders, and the original
**fill** for solid surfaces that carry near-black text on top. Dark needed one
value because a glowing accent works as both. "Get this wrong in either
direction and the theme fails: fill-as-text is illegible, ink-as-fill turns the
primary button into mud."

The section renders each accent three ways — ink as text, fill as a surface,
and (struck through) the dark value used as text on paper, with its measured
failure printed: amber 2.1:1, teal 2.3:1, purple 2.3:1, gold 1.7:1, red 2.5:1,
blue 2.0:1.

## L3 · Semantics, proven on paper

The §05 decision surfaces and §09 states rebuilt in light tokens, with the
claim that each "should be readable as the same thing it was in dark … without
reading a word of the copy". The concrete values it draws (these are the
`SPECIFIED` overrides in the generator; everything not here is derived):

**ActionCard kinds.** Approval: `2px solid rgba(127,76,8,.4)` over
`rgba(224,159,62,.12)`, kind label `#7f4c08`, meta `#a52e28`, dot `#c07d12`
breathing. Choose: hairline `#ddd6c7` on surface, label `#1a6b5b`, provenance
chip `rgba(107,79,158,.42)` border over `rgba(177,151,212,.16)`, ink `#6b4f9e`.
Dead letter: hairline, label `#a52e28`. Quarantined: `1px solid
rgba(165,46,40,.5)`. Premise unverified: `1px dashed rgba(111,84,12,.6)` over
`rgba(234,179,84,.12)`, label `#6f540c`, struck title in `#5f584c`.

**Queue states.** claimed: dot `#c07d12`, ink, hairline. blocked: dot `#c07d12`,
state ink `#7f4c08`, border `rgba(127,76,8,.42)`, tint `rgba(224,159,62,.1)`.
ready: dot `#1a6b5b`. failed: dot and state `#a52e28`, border
`rgba(165,46,40,.4)`. superseded: dot `#5f584c`, state `#554f45`, opacity .75.
"The dot is the one place the warm fill hue survives as a small mark — at 7px a
darkened ink dot would read black, so dots use a mid value that holds its hue."

**Provenance banner.** `rgba(107,79,158,.42)` border over `rgba(177,151,212,.14)`,
ink `#6b4f9e`. **Callout (accent).** Rail `#7f4c08`, tint `rgba(224,159,62,.14)`,
italic text `#554f45`. **Receipt.** Border `#c8bfac`, head rule `#ddd6c7`, key
`#5f584c`, value ink `#231f1a` / teal `#1a6b5b`, inset diff well `#ece7dc`.

**Controls.** Primary: fill `#e09f3e`, border `#d08f2e`, ink `#231f1a`, effect
chip ground `rgba(35,31,26,.16)`. Ghost/quiet: border `#c8bfac`, ink `#554f45`,
effect chip border `#c8bfac` ink `#6e6659`. Focus ring `#231f1a` at +2 — "the
rule was never 'light ring', it was 'ring is ink, not meaning'". Affirm: fill
`#5bb5a2`, border `#4aa593`. Danger: border `rgba(165,46,40,.45)`, ink
`#a52e28`. Disabled: opacity .45. FilterRow active: `rgba(127,76,8,.42)` over
`rgba(224,159,62,.16)`, ink `#7f4c08`; inactive `#c8bfac` / `#5f584c`.
ChoiceOption selected: `rgba(26,107,91,.5)` over `rgba(91,181,162,.14)`, mark
**filled with the teal INK `#1a6b5b` and a surface-coloured check `#f8f5ef`**
— not the fill. Toggle: on track `#e09f3e`, off track `#c8bfac`, knob `#f8f5ef`
in both states.

**States.** Skeleton bars `#ddd6c7` breathing. Empty: `1px dashed #c8bfac`,
`#5f584c`. Error: `rgba(165,46,40,.45)` border over `rgba(165,46,40,.07)` (the
one tint that uses the ink hue), retry border `rgba(165,46,40,.5)`.

## L4 · Assembled — light screens

Actions and Chat answer from the dark catalog, "re-grounded. The layouts are
byte-identical in structure — only values changed — which is the practical
claim this theme has to support." Additional values these draw:

- Device: bezel `#d9d2c6`, screen `#ece7dc` (the canvas, not the older
  `PhoneFrame theme="paper"` literal `#f4f0e8`), shadow `rgba(90,78,58,.28)`,
  status-bar glyphs `#6e6659`.
- Tab bar: surface ground, `#c8bfac` top rule, active `#94580a`, rest `#6e6659`.
- Screen header (chat): avatar well surface with `#ddd6c7` edge and `#94580a`
  glyph; connection line `#1a6b5b`; **filament** `#c07d12 → #e09f3e → #c07d12`
  (dot → fill → dot), opacity .8.
- User bubble: `#fffefa` (raised) with `#ddd6c7` border.
- StatTiles values: teal `#1a6b5b`, red `#b8362f`, gold `#795c0d`; labels and
  meta `#6e6659`; tile ground surface with `#ddd6c7` edge.
- QuoteCard: rail `#1a6b5b`, tint `rgba(91,181,162,.14)`, quote ink `#231f1a`.
- StepList: done bubble `#1a6b5b` with `#f8f5ef` check; current
  `rgba(224,159,62,.16)` with `#94580a` ring; todo `#c8bfac` ring; connector
  `rgba(26,107,91,.4)` under done, `#ddd6c7` otherwise.
- FeedbackRow thumbs: `#c8bfac` hairline, up glyph `#1a6b5b`, down `#6e6659`.
- Composer: field surface with `#c8bfac` edge, placeholder `#6e6659`, send disc
  `#e09f3e` with `#231f1a` glyph.
- Teal banner (footer): `rgba(26,107,91,.42)` over `rgba(91,181,162,.12)`.
- (third pass) Suggestion chips: the amber one `rgba(127,76,8,.42)` border
  over `rgba(224,159,62,.14)`, ink `#7f4c08`; untoned ones `#c8bfac` border,
  ink `#554f45`. A "Resolved today" list with teal/meta icons, and a timeline
  whose 7px dots are drawn in the accent INK (`#1a6b5b`, `#7f4c08`, …) — note
  that is the ink, not the dot value the §L5 rule names; the kit's
  `TimelineList` uses `StatusDot`, which takes the dot value, and that stands.
- (third pass) The L1 ratio column is computed at render time against the
  worst ground; the numbers in the table above are the README's, which agree.

## L5 · Implementation contract

"The kit currently hardcodes hex values in each component's tone map (`T`, `C`,
`S`, `K`). Those maps are the seam … Route them through custom properties on a
`[data-theme]` root and every component inherits both themes at once." The
contract, verbatim:

```css
[data-theme="light"] {
  --canvas:#ece7dc; --surface:#f8f5ef; --raised:#fffefa;
  --line:#ddd6c7;   --edge:#c8bfac;
  --ink:#231f1a;    --ink-dim:#554f45; --ink-meta:#5f584c;
  /* accents carry TWO values in light */
  --amber:#7f4c08;  --amber-fill:#e09f3e; --amber-dot:#c07d12;
  --gold:#6f540c;   --gold-fill:#eab354;
  --teal:#1a6b5b;   --teal-fill:#5bb5a2;
  --purple:#6b4f9e; --purple-fill:#b197d4;
  --blue:#1a5c7f;   --blue-fill:#67b8e3;
  --red:#a52e28;    --red-fill:#f87171;
  --focus:#231f1a;  --skeleton:#ddd6c7;
  --on-fill:#231f1a; /* text that sits on any *-fill */
}
```

Eight rules, verbatim in spirit (the third and fourth are the revision):

1. **Never derive one theme from the other.** No filters, no `invert()`, no
   programmatic lightening — a computed inversion lands amber at 2.2:1.
2. **Ink and fill are not interchangeable.** Text, icons and borders take ink;
   solid backgrounds take fill and put `--on-fill` on top. A tint uses the fill
   hue at 8–14% alpha, never the ink hue.
3. **State the palette against its worst ground.** A tint over the canvas;
   amber, blue, red and ink-meta came down a notch for it (see §L1 above).
4. **Tinted cards may sit on canvas.** Darkening four inks "costs nothing and
   holds everywhere"; a surface wrapper behind every card was rejected.
5. **Every accent carries three values on paper.** Ink for text, fill for
   solid grounds, and a dot for small marks — at 6–8px a darkened ink loses
   its hue and reads black. All seven dots are stated in §L5 (fourth drop).
6. **Alpha ink is still banned** — "and never from `opacity` on the container
   either". `#5f584c` is the paper floor at 5.00:1 on the worst ground,
   matching dark's `#9a96a1` at 4.80:1.
6b. **Test two stacked tints of one hue, not one.** A soft Chip inside a
   same-hue tinted Surface is a real composition; teal, purple and red came
   down to `#15594c` / `#5d4489` / `#9c2a24` for it (fourth drop, §20).
7. **Respect the system, offer the override.** Default to
   `prefers-color-scheme`, keep an explicit three-way toggle (system / paper /
   dark) in Settings. "A second brain gets read at 2am and on a sunlit train."

## What the kit did with it (wave 8, D32)

- The contract's names map onto the kit's existing `--bk-*` roles one-to-one:
  `--amber` → `amber-ink`, `--amber-fill` → `amber-fill`, `--amber-dot` →
  `amber-mark`, `--ink-meta` → `color-ink-mute`, `--skeleton` → `color-line`,
  `--focus` → `focus-ring` (already `var(--bk-color-ink)`), `--on-fill` → a
  new `on-fill` token.
- The switch is `color-scheme` + `light-dark()` per declaration, with
  `[data-theme]` as the public attribute the contract names — see D32 for why.
- The contract names every dot since the fourth drop; the kit's earlier 0.55
  blend is gone and the seven values are `SPECIFIED` overrides.
- The contract has no neutral fill. The kit's solid neutral chip needed one:
  `#a59d8f`, derived, flagged.
- Everything L3/L4 draws is a `SPECIFIED` override in the generator; every
  other alpha token is derived by one rule (tints +0.07 capped at 0.16 in the
  fill hue, borders +0.05 in the ink hue, white veils → ink at the same alpha).
  252 derived values, 67 specified, all listed by `bun
  packages/ui-kit/tools/theme/derive-light.ts`. Three of the specified are the
  toned `Surface` hovers for teal/purple/blue (.17: the design's "+.04 over
  its lighter tints", one step past the rule's cap).

## Superseded: the first palette of 2026-09-18

Kept so the numbers in design-feedback §19 stay readable. Ink meta `#6e6659`,
amber `#94580a`, gold `#795c0d`, blue `#1f6d96`, red `#b8362f` — each stated at
5.1–5.4 against the surface and measured at 4.59–4.72 on the bare canvas, under
4.5 on any tint over it. Teal, purple and every base/fill value were unchanged
by the revision.

## §L6 — the canvas palettes on paper (seventh drop, 2026-09-19)

The one place the kit hands colour to something it does not draw. Every
value at the 3:1 non-text bar against canvas `#ece7dc`, slot order identical
to dark:

| Group | Paper values (ratio vs canvas) |
| --- | --- |
| slots 1–8 | `#a9650e` 3.74 · `#226d95` 4.62 · `#227f6c` 3.94 · `#6b4f9e` 5.26 · `#b23a32` 4.81 · `#8a6a10` 4.10 · `#3f6b2f` 5.08 · `#9c3d72` 5.12 |
| distance ramp | `#17324f` 10.64 · `#174b72` 7.40 · `#1a6282` 5.49 · `#1d788b` 4.15 · `#248d91` 3.21 |
| root · other | `#8f5408` 4.95 · `#6f6a61` 4.36 |
| lenses | orphan `#6f6a61` · unreachable `#5d4489` · broken `#9c2a24` · stale `#8a6a10` |
| diagram surfaces | bg `#f8f5ef` · node fill `#fffefa` · cluster `#ece7dc` · line and node border `#5f584c` 5.70 · cluster border `#847c6f` 3.34 · text `#231f1a` |

Rules: a node is a mark, not text (3:1, but judged — the dark set never was on
paper); labels take `--ink`; the ramp gave up its light end, not its steps;
slot order is frozen; fill is never a bare mark on paper.
