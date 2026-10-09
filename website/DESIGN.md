---
name: brain-kit public website
description: The Brain UI identity applied to a public website for a second brain you own.
colors:
  dark: "#0c1417"
  paper: "#f3f0e4"
  amber: "#eca634"
  amber-hover: "#f9bd55"
  teal: "#5bb5a2"
  ink-dark: "#f8f5ee"
  ink-paper: "#12181b"
  muted-dark: "#bec5ca"
  muted-paper: "#4e565d"
  action-ink: "#11191c"
  selected-ink: "#10181b"
  passage-ink: "#0d1417"
  passage-muted: "#525957"
  stage-paper: "#ece7dc"
  phone-shell: "#181c1e"
  phone-border: "#90999b"
typography:
  display:
    fontFamily: "'DM Serif Text', Georgia, serif"
    fontSize: "78px"
    fontWeight: 400
    lineHeight: 0.99
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "'DM Serif Text', Georgia, serif"
    fontSize: "64px"
    fontWeight: 400
    lineHeight: 1.03
    letterSpacing: "-0.03em"
  desktop-headline:
    fontFamily: "'DM Serif Text', Georgia, serif"
    fontSize: "59px"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  brand:
    fontFamily: "'DM Serif Text', Georgia, serif"
    fontSize: "29px"
    fontWeight: 400
    lineHeight: 1
  lead:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: "27px"
    lineHeight: 1.45
  body:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  action:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.6
  label:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: "13px"
    lineHeight: 1.6
  mono:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "16px"
    lineHeight: 1.8
rounded:
  inline-code: "4px"
  control: "12px"
  desktop-stage: "18px"
  capture-stage: "28px"
  scenario: "24px"
  phone-shell: "35px"
spacing:
  compact: "8px"
  control: "12px"
  text: "20px"
  gutter: "24px"
  section-gap: "30px"
  header-nav: "36px"
  middle-gutter: "40px"
  mobile-section: "64px"
  wide-column: "90px"
  wide-section: "108px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.action-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "12px 26px"
  button-primary-hover:
    backgroundColor: "{colors.amber-hover}"
  text-link:
    size: "18px"
  scenario:
    rounded: "{rounded.scenario}"
    padding: "8px 15px"
  scenario-selected:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.selected-ink}"
    rounded: "{rounded.scenario}"
    padding: "8px 22px"
  theme-toggle:
    rounded: "{rounded.control}"
    width: "44px"
    height: "44px"
  docs-nav-current:
    backgroundColor: "color-mix(in srgb, {colors.amber} 10%, transparent)"
    textColor: "inherit"
    rounded: "{rounded.control}"
    padding: "10px 14px 10px 26px"
  phone-stage:
    backgroundColor: "{colors.phone-shell}"
    rounded: "{rounded.phone-shell}"
    width: "261px"
    screenAspectRatio: "390 / 844"
  desktop-stage:
    backgroundColor: "{colors.phone-shell}"
    rounded: "{rounded.desktop-stage}"
  capture-stage:
    backgroundColor: "{colors.phone-shell}"
    rounded: "{rounded.capture-stage}"
    width: "390px"
    screenAspectRatio: "390 / 660"
---

# Design System: brain-kit public website

## Overview

**Creative North Star: "A second brain that goes with you"**

The website applies the established Brain UI identity: expressive serif
headings, clear sans-serif reading, dark and paper fields, amber actions and
teal focus. Spacious editorial surfaces give dense, actual application views
room to be understood. The product keeps its own typography, navigation and
controls inside the demonstration stages.

This document governs the website's visual application of that identity.
Published UI package tokens remain authoritative for the embedded product.
Homepage composition and visitor journey belong in the
[surface contract](.impeccable/surfaces/src-pages-index-astro.md), while product
claims and fictional-data constraints belong in [PRODUCT.md](PRODUCT.md).
The values above record the implemented styles; they do not introduce a new
package token API or a uniform spacing scale.

**Key Characteristics:**

- Serif headlines with generous surrounding space.
- Dark and paper surfaces sharing amber actions and teal focus.
- Actual product components presented in clearly labelled stages.
- Readable document flow across desktop and phone widths.
- Restrained shadows, drawn SVG controls and short, optional motion.

Extraction uses the website styles (`:root`,
`website/src/styles/site.css:1-3`) and the finished
[desktop](.impeccable/review/desktop.png) and
[mobile](.impeccable/review/mobile.png) captures.

## Colors

Warm paper and amber balance a cool dark ground; teal provides the shared
focus treatment. The frontmatter records exact colors, including the small
ink differences already present between website surfaces. The sidecar's
eight-step tonal ramps are generated inspection aids, not additional colors
used by the website.

### Primary

- **Amber** (`amber`): primary actions, selected scenarios, the current docs
  destination and selection highlighting. `amber-hover` brightens primary
  actions on hover.
- **Action Ink** (`action-ink`): text on amber buttons and the paper capture
  passage. `selected-ink` is the existing selected-navigation ink.

### Secondary

- **Teal** (`teal`): the website's visible keyboard-focus outline; product
  intelligence accents stay governed by the product's own styles.

### Neutral

- **Dark** (`dark`) and **Paper** (`paper`): the two website grounds. The paper
  desktop and capture passages keep their paper treatment in both site themes.
- **Dark Ink** (`ink-dark`) and **Paper Ink** (`ink-paper`): theme-dependent
  foregrounds. `passage-ink` supplies the desktop paper passage's ink.
- **Dark Muted** (`muted-dark`) and **Paper Muted** (`muted-paper`): secondary
  copy, dividers and hints in their respective themes. `passage-muted` labels
  capture constraints on the fixed paper passage.
- **Stage Paper** (`stage-paper`): the background beneath paper product stages.
- **Phone Shell** (`phone-shell`) and **Phone Border** (`phone-border`): exterior
  device framing, separate from the actual application surface.

**The Surface Ownership Rule.** Website theme colors govern the surrounding
page. Embedded product surfaces retain their native themes and tokens.

The initial opening pairs a paper decision screen with a dark plan screen.
The website theme toggle subsequently sends the selected theme to the loaded
product frames; it does not recolor their interiors with website CSS.

## Handbook reading experience

The handbook is a short, authored learning path rather than an engineering
catalog. Its four sections move from first principles and setup to everyday
use, optional configuration and integration work. Technical references remain
visibly marked links to GitHub. Each chapter ends with understated, ruled
previous/next links before the source actions. Keep paragraphs short and
introduce a capability's purpose before its flags or settings.

## Typography

**Display Font:** DM Serif Text, with Georgia and serif fallbacks.
**Body Font:** Plus Jakarta Sans, with a sans-serif fallback.
**Code Font:** JetBrains Mono, with a monospace fallback.

The high-contrast serif supplies personality through heading scale and
line breaks. Sans-serif text supplies instructions and readable explanations.
Monospace identifies actual Markdown and technical examples. Fonts are served
locally rather than requested from a font service.

### Hierarchy

- **Display:** the large opening heading uses the `display` role. Its
  responsive sizes are documented below; preserve the two-line intent when
  space allows.
- **Headline:** major section headings use `headline`; the first paper
  passage uses `desktop-headline`.
- **Body and lead:** ordinary reading uses `body`. Opening copy uses `lead`;
  later section leads are (23px, 1.5 line height) with a (42ch) maximum width.
  Longer supporting paragraphs cap at (65ch).
- **Actions and labels:** primary controls use `action`; demo disclosures use
  `label`. Labels remain sentence case. Footer links and feature limits use
  (14px), while the opening PWA qualification uses (12px).
- **Code:** the file example uses `mono`; documentation code uses (14px, 1.7
  line height). Code wraps deliberately instead of widening the page.
- **Documentation:** page titles use (54px), section headings (33px, 1.2 line
  height), and third-level headings (22px). Reading width caps at (75ch).

Type sources: (`.hero-copy h1`, `website/src/styles/site.css:5-5`),
(`.answer-passage h2`, `website/src/styles/site.css:16-17`) and
(`.docs-layout`, `website/src/styles/docs.css:1-33`).

## Layout

Wide page content is centred within (1208px). The header is (70px) tall.
Desktop sections use explicit grids rather than a repeated card grid; their
widths follow the content and product stage. Later paired sections use equal
columns, a (90px) gap and (108px) vertical padding. The fixed paper capture
passage pairs flexible copy with a (390px) stage and a (140px) gap. The
frontmatter spacing entries name recurring measured values, not a prescribed
multiple for every margin.

### Responsive behavior

| Viewport | Implemented behavior |
| --- | --- |
| At least 1400px | Full (1208px) container; opening copy column (621px), (34px) gap and two (261px) phone stages. Opening display is (78px); later headings are (64px). Desktop application retains its (1100:760) aspect ratio. |
| 901–1399px | Content width becomes `calc(100% - 80px)` with (40px) side gutters. Opening columns use (1.1fr / 1fr), and later paired gaps reduce to (50px). Display scales with `clamp(54px, 5.38vw, 78px)`; lead with `clamp(21px, 1.87vw, 27px)`. Later headings use `clamp(45px, 4.4vw, 64px)`. Phone previews and the desktop iframe scale to fit. |
| At most 900px | Sections stack in source order with (24px) gutters. Later sections use (64px) vertical padding; section leads become (20px) and later headings (46px). Opening display uses `clamp(40px, 7.8vw, 68px)`. Primary button text becomes (16px) with (12px 20px) padding. Header keeps Docs, GitHub and the theme control; the two same-page links hide. Docs navigation loses stickiness and collapses into a disclosure above the article. |
| At most 480px | Opening/header gutters become (20px), opening display uses `clamp(37px, 10.5vw, 43px)`, and portrait stages stack. Phone frames fill the available width up to (390px), retain (390:844) proportions and use native unscaled iframe viewports. Expansion controls hide because the product already fills the phone width. |
| At most 360px | GitHub hides from the header. Phone and capture stages reach the viewport edges; all device bezels and proportional screens remain visible. The desktop iframe scales its (1100:760) composition to fit. The product's bottom navigation stays within its own stage. |

At (481–900px), portrait previews remain (290px) wide with scaled product
viewports. The desktop retains its (1100:760) composition at every width.
Expansion holds the original layout with a placeholder and animates the same
mounted device into a fixed overlay over a dimmed, inert page. Closing restores
its position, scroll and focus without resetting the app.

Responsive sources: (`@media(min-width:901px)`,
`website/src/styles/site.css:7-9`), (`@media(max-width:480px)`,
`website/src/styles/site.css:61-61`) and (`@media(max-width:360px)`,
`website/src/styles/site.css:62-62`). Device fitting and expansion are in
[demo-devices.ts](src/scripts/demo-devices.ts).

## Elevation & Depth

Large dark/paper fields establish page hierarchy. Soft offset shadows lift
product stages from those fields; ordinary copy, navigation and the ruled
Markdown example remain flat. Shadows frame the application and do not replace
its own component hierarchy.

### Shadow Vocabulary

- **Phone stage:** `0 16px 36px #0005` beneath the framed portrait preview.
- **Desktop stage:** `0 14px 34px #3630212a` beneath the desktop device bezel.
- **Capture stage:** `0 16px 40px #29211921` beneath dictation review.

The sidecar carries these shadow values, which are outside the frontmatter
schema. Source: (`.device-body`, `website/src/styles/site.css:37-38`) and
(`.capture-stage .device-body`, `website/src/styles/site.css:50-51`).

## Shapes

Soft corners distinguish controls and device stages from the open editorial
page. Primary buttons, the theme control and docs destinations use the
`control` radius; scenario choices use the pill-like `scenario` radius.
Product stages use their dedicated radii from the frontmatter. Device framing
uses a (2px) border and clipped overflow; clipping must retain the product's
usable controls. At the narrowest breakpoint, edge-to-edge stages lose their
exterior device corners.

Inline code has small corners; file examples use horizontal rules rather than
a card enclosure. Footer and closing dividers mix the current ink into the
ground at (15%) and (20%) respectively. These are intentional boundaries,
not a generic border around every section.

## Components

### Buttons and directional links

Primary actions combine amber, dark ink and a drawn arrow. Their minimum
height is (54px); desktop padding is in the frontmatter. Hover uses
`amber-hover` with a (180ms) background transition. Text links retain their
underline, inherit the surface foreground and provide at least (44px) height.
Scenario-jump buttons are underlined, left aligned and turn amber on hover.
Disabled buttons have (0.55) opacity and a default cursor.

Keyboard focus uses a (3px) teal outline with a (5px) offset. The shared SVG
arrow is (22px) square with (1.7px) strokes and rounded caps/joins. Forward
actions use a horizontal arrow; expansion uses the diagonal version. Both are
decorative SVGs with `aria-hidden`, leaving the control text or accessible
name to convey the action. Source: (`const { diagonal`,
`website/src/components/Arrow.astro:2-4`).

### Scenario choices and guidance

Scenario controls are buttons in an explicitly named group, not additional
application navigation. Selection uses amber and `aria-pressed`; Reset is a
separate action. Choices wrap as space narrows. Selected/unselected padding
differs as recorded in the frontmatter, with tighter mobile values. A polite
live region reports the current instruction and staged response status.

Scenario changes use one (220ms) fade/lift moment with
`cubic-bezier(.16, 1, .3, 1)`, beginning at (0.75) opacity, (5px) downward
translation and (1px) blur. The script omits this animation when reduced
motion is requested; website CSS also disables animations, transitions and
smooth scrolling under that preference. Content remains usable without motion.

### Navigation and theme control

The brand uses the display face beside the amber brain mark. Desktop
navigation is simple text with (36px) gaps and (44px) link targets. The theme
control is a borderless square with a drawn sun and a translucent ink hover
surface. Its accessible name states the next theme; the selected website
theme persists when local storage is available.

Docs navigation is a sticky (230px) column on desktop. The current page uses
a subtle (10%) amber tint, inherited readable ink, semibold text and a small
amber/ink position marker; every row keeps (26px) left padding. The selected
page's section opens automatically. Below (900px), a native "Browse
documentation" disclosure starts collapsed so the article remains visible in
the first viewport. Its navigation remains available without JavaScript.
Table rules and callout borders use a (20%) ink mix; callouts remove outer
paragraph margins to keep their padding even. Footer
destinations wrap naturally with (44px) link targets. A keyboard-visible skip
link leads directly to the main content.

### Product stages and isolation

Product stages load actual Brain React composition and styles in separate
iframes. Captions, scenario selection, reset, hints and feature qualifications
stay outside the application. Each frame has a descriptive title, an explicit
`allow-scripts allow-same-origin allow-downloads` sandbox, no microphone/camera/geolocation
permission and no referrer. Parent/frame messages use the same origin; the
parent also verifies that status messages came from one of its known frames.
The sandbox permits same-origin scripts and is not a claim of hostile-code
containment.

The iframe owns its fictional clock, request handler and socket simulation.
Unsupported services return local errors. None of these interactions performs
real agent work or records actual microphone input. Real product captures with
descriptive alternatives remain visible before the React demonstration loads;
the no-script message explains how to try the staged interactions.

Portrait expansion has a (44px) SVG control, an updated accessible name and
an expanded-state attribute after use. Its focus treatment reveals the text
label. The same control changes to Close in the expanded device. Expansion takes (380ms), closing takes (300ms); reduced motion makes both immediate. Escape and the backdrop also close the overlay.
The desktop stage preserves the actual product’s (1100:760) composition at
every width. The portrait stages use native phone layouts on narrow screens.

### Dictation review and inputs

Inputs, answer cards, approvals and dictation controls inside stages belong
to the production UI, not a website form system. The website adds no separate
input styling contract.

At an iframe width of (340px) or less, a demo-scoped rule lets the existing
dictation action row wrap with an (8px) gap. Discard, Edit and Add retain at
least (44px) height; Send keeps its full label, at least (44px) height and an
auto left margin. This presents Send on a second row at (320px) without
changing production package styles or inventing a different workflow.
Source: (`@media(max-width:340px)`,
`website/src/components/DemoFrame.astro:20-24`).

### Code and reading containers

The homepage's file example has open sides, top/bottom rules, (24px) internal
vertical padding and wrapping monospace text. Docs code blocks use a subtle
ink/ground mix with rounded corners and (22px) padding, reducing to (14px)
on mobile. Tables use an intentional horizontal scroll region; long paths
and paragraphs wrap within the reading column.

## Do's and Don'ts

### Do:

- **Do** preserve DM Serif Text, Plus Jakarta Sans and the established dark/paper identity.
- **Do** keep website controls outside the actual application stage.
- **Do** use amber for primary actions and selected navigation, and teal for visible focus.
- **Do** preserve native product layout and readable controls as stages change width.
- **Do** use drawn SVG arrows and accessible names for icon-only controls.
- **Do** retain staged-data disclosures, reduced-motion handling and nearby capability limits.

### Don't:

- **Don't** replace published product tokens with the website's extracted values.
- **Don't** invent application destinations, a central notebook or generic context-file attachment.
- **Don't** present fictional responses or preview captures as evidence of live agent execution.
- **Don't** crop dictation actions or shrink native phone controls to preserve desktop composition.
- **Don't** use Unicode directional glyphs in place of the shared SVG controls.
- **Don't** force every editorial section into a shadowed card or a uniform spacing scale.
