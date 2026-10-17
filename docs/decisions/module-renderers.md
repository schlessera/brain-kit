# Module renderers and the diagrams module

**Maintainer decision, 2026-10-16.** A module may contribute *content
renderers*: code that draws a markdown fence or a file type in the chat, the
file viewer and every export path. The first new consumer is a diagrams
module that adapts the editorial method of the MIT-licensed
[diagram-design](https://github.com/cathrynlavery/diagram-design) agent skill to
the brain-kit design system. The renderer seam and the module ship as one body of
work, with no interim release where the module renders through hand-written
SVG files and `<img>`. The design and its ordering are in
[the plan](../plans/module-renderers.md), and the work in
[its epic](https://github.com/schlessera/brain-kit/issues/2079).

This reverses the sentence "A module supplies data and CLI actions, never React
components" in [docs/modules.md](../modules.md#editable-module-settings) for one
purpose only: content renderers. Module settings still render from the
declaration's schema, and a module still contributes no other UI.

## What was asked, and what was measured first

The request was diagrams in diagram-design's visual style, as SVG with light
and dark modes and a print stylesheet. diagram-design has no renderer. It is
a skill of about 9,500 lines of reference prose under which the model writes
every SVG coordinate by hand. It ships each figure as three separate HTML
files, light, dark and editorial, with hex colours inlined as presentation
attributes. Its print stylesheet only fixes overflow. Its quality rests on six
connector rules and a set of Python checkers of about 6,200 lines: geometry,
contrast, the accessible-SVG contract, and a closed-palette linter. The
snapshot examined is upstream commit `b46c970` (plugin 2.6.107, 2026-10-16).

Measurements, taken against that snapshot in Chrome 140 headless:

- **The palette is closed.** The 134 light examples outside upstream's legacy
  baseline contain 8,591 hex and 5,508 `rgba()` colour uses, and none falls
  outside the style guide's role table. The control run, the 55 dark
  examples checked against the light table, flags 1,085 uses. So the check can
  fail, and colour-to-role assignment is deterministic.
- **Dark is mostly a role swap.** The light examples were role-mapped and
  compared colour-for-colour with their 55 shipped dark siblings, of which 44
  have identical geometry. Of 3,879 colours, 3,073 (79%) match exactly. 407
  (10.5%) differ only in hand-tuned opacity. 399 (10.3%) differ in hue, almost
  all from two roles upstream never names: a white card surface (dark
  `#393e53`, 211 uses) and ink on an accent fill. brain-kit already names
  both: `raised` and `--bk-on-fill`.
- **An `<img>` SVG follows its embedder, not the OS.** In Chrome, an
  `<img>`-embedded SVG with an internal `prefers-color-scheme` block
  rendered light inside a page set to `color-scheme: light` while the OS was
  dark, and dark the other way around.
- **`@media print` never reaches inside an `<img>` SVG.** Printing such a
  page to PDF kept the screen palette, and a dark page printed a dark diagram.
  Switching the host page to `color-scheme: light` for print gave the light
  palette, but never the white print palette. A `<picture>` with
  `<source media="print">` was not swapped at print time.
- **Inline SVG prints white, after one fix.** An inline SVG carrying its own
  print token block printed on white paper with extractable vector text.
  It worked only once the print selectors were at least as specific as the
  theme selectors: a plain `@media print { .dd { … } }` loses to
  `:root[data-theme="dark"] .dd`.
- **WebKit is unreliable for `<img>` SVG theming.**
  [WebKit bug 199134](https://bugs.webkit.org/show_bug.cgi?id=199134), "SVG
  images don't support prefers-color-scheme adjustments when embedded in a
  page", was still NEW on 2026-10-16. A 2026-06 comment there says it was
  partly fixed by two later bugs, with the remainder open as bug 316640. Every
  iOS browser is WebKit, and the PWA runs on phones.
- **Layout libraries.** On the npm registry, `@dagrejs/dagre` is MIT,
  `elkjs` is `EPL-2.0 OR GPL-3.0-or-later` and `libavoid-js` is
  `LGPL-2.1-or-later`.

The measurement scripts were throwaway, and the numbers above are the record.

## Rulings

### 1. A module may contribute content renderers

The contribution names fence languages and file extensions, and points at two
entry points:

- **A client entry** with a React component, built from `@schlessera/brain-ui-kit`
  pieces and public entry points only.
- **A static entry** with a pure function from source and theme to static
  HTML/SVG, used by every export path.

A pack also declares whether its static step needs a browser. Mermaid does,
because it needs a DOM. The diagrams module does not, because it builds a
string. The first-party Mermaid support uses the same seam. Its former markdown,
file-preview and sharing special cases now dispatch through the built-in pack
(`mermaidContentPack`, `packages/ui-react/src/content-renderers/mermaid.tsx:10-22`).
The browser preflight runs each bundled browser-only static entry before
sharing (`export async function preRenderBrowserFences`, `packages/ui-react/src/lib/content-renderer-share.ts:10-39`).

A seam needs a second implementation plausible within a year. This one has
four: Mermaid, diagrams, the geo and travel map views
([#905](https://github.com/schlessera/brain-kit/issues/905)), and the
eval-result charts ([#1609](https://github.com/schlessera/brain-kit/issues/1609)).

The seam is `@experimental` until 1.0, like the
[`ToolRenderer`](../extending/README.md) seam it sits beside.

Rejected:

- **Keep modules data-only and ship diagrams as `.svg` files shown through
  `<img>`.** This was the first proposal. It cannot print white from the
  browser, it cannot theme on WebKit, and it cannot inherit the app's fonts:
  the raw-file CSP is `default-src 'none'` (`img-src 'self' data:`,
  `packages/ui-server/src/routes/files.ts:160`) and an image may not fetch
  fonts. It also leaves the figure an opaque, undiffable file beside markdown
  that is supposed to be the source of truth.
- **Phase the work, files first and renderers later.** Rejected by the
  maintainer: every file-based figure would become a migration debt and a
  second format to keep compatible.
- **A `show_block` kind per figure type.** Every kind costs prompt tokens in
  every turn ([D44](design-kit/tool-loading.md), [D47](design-kit/show-block-schema.md)), and a fence
  needs no schema change.
- **Inline raw agent-authored SVG.** brain-kit has no HTML sanitizer, and
  inline SVG from the model is an injection surface (`<script>`, `on*`
  handlers, `foreignObject`, external `href`). Renderers build elements from
  data. No raw markup from content is ever injected.

### 2. Packs are bundled at build time, never loaded at runtime

The client entries are registered by the build that produces the PWA,
exactly as tool-renderer packs are (`Runtime plugin loading`,
`packages/ui-react/src/components/chat/renderers/index.ts:3`). A renderer runs
in the app's origin with the session's privileges, so it is trusted code, and
content-repo configuration can never introduce one.

Modules are configured at runtime, but packs are bundled at build time. So the
server reports which renderers its configured modules declare, and the client
shows a fence it has no pack for as code with a "renderer not bundled" note,
never as an error. A throwing renderer falls back to the code view for that
block only ([#1376](https://github.com/schlessera/brain-kit/issues/1376) is
the precedent).

Rejected: **dynamic import from a URL the server names.** That turns a
content-repo config change into code execution in every signed-in browser.

### 3. Diagrams are a declarative spec in a fence, and geometry is computed

A diagram is a ```` ```diagram ```` fence holding a versioned YAML spec: type,
nodes, groups, edges, roles and focal marks. For free-layout types it also
holds node positions on a 4px grid, chosen by the model. Axis types (sequence,
swimlane, timeline) derive position from order.

The renderer computes everything diagram-design's six connector rules
constrain:

- orthogonal elbows
- fanned attach points
- label masks and their gap
- parallel offsets
- bridges at crossings
- no transit behind a box

The rules hold by construction, not by a checker run afterwards.

The model still chooses what to draw and roughly where, which is where
upstream's editorial quality comes from. The spec diffs in git, which removes
two weaknesses upstream's own README names: no text to diff in a pull request,
and the same prompt laying out differently twice.

Rejected:

- **Automatic layout of whole diagrams.** It gives up the hand placement that
  makes the style worth adopting. The only permissively licensed candidate,
  dagre, is the engine behind the Mermaid look this work exists to improve on.
  `elkjs` and `libavoid-js` fail the MIT redistribution bar.
- **Hand-written SVG checked after the fact.** That is upstream's model, and
  porting its checkers is most of the cost with none of the guarantee.

### 4. The look is brain-kit's, and diagram-design contributes the method

Diagrams paint only with `--bk-*` tokens:

- `--bk-diagram-*` for grounds, nodes, clusters, lines and text (`--bk-diagram-bg: light-dark`, `packages/ui-kit/src/tokens.css:782-788`)
- the CVD-ordered canvas slots for series
- the accent `ink` / `fill` / `mark` triples, with `--bk-on-fill` for text on fills

They switch with `color-scheme` and `[data-theme]` like the rest of the app
(`[data-theme="dark"] {`, `packages/ui-kit/src/tokens.css:849`). They take
white grounds from the generated print theme (`[data-theme="print"] {`,
`packages/ui-kit/src/tokens.css:870`). The token block a static export embeds
is generated from `tokens.css` and pinned to it by a test. It is never written
by hand.

Where the two systems disagree, brain-kit wins:

- **Fonts:** DM Serif Text, Plus Jakarta Sans and JetBrains Mono. Upstream
  bans JetBrains Mono.
- **Minimum size:** nothing below 9px. Upstream's 7–8px eyebrows and arrow
  labels become the kit's 9.5px uppercase mono label.
- **No alpha ink.** Upstream's opacity ramps become solid `color-mix` steps
  of ink into the ground.
- **Never colour alone:** every hue has a redundant shape or label.
- **Radii:** the kit's chip and inset steps.

Upstream's 4px grid survives as the diagram's internal coordinate system. It
is not UI spacing.

Upstream's method carries over:

- the deletion-first taste rules and the one-or-two focal elements
- the complexity budgets
- the semantic-pattern-then-visual-type selection
- the accessible-figure contract
- the type grammars

The maintainer adopted the [revised eight-node composition, authored 320px
layout and absent-layout fallback](https://github.com/schlessera/brain-kit/blob/ce92ea1d4142481fadf6cef08bfef7eecf02543b/docs/assets/diagrams-2091/README.md)
on [#2091](https://github.com/schlessera/brain-kit/issues/2091#issuecomment-6222708390).
The shared dark cluster border is `#6b6873`; print cluster grounds are white;
focal grounds use the solid named tint. Focal sublabels use diagram-text,
fixing the dark muted pair's 4.16:1 contrast to 9.51:1. Async lines are dotted
`1.5 3.5` with round caps; returns are dashed `6 4`. Named narrow placement
is authored explicitly and preserves semantic nodes, groups and edges.
Absent placement selects a caption/summary and Open diagram control, with
readable dedicated viewing; it never requests automatic reflow or shrinking.

### 5. Every surface prints white

Every surface where a diagram is rendered by the app prints on the white print
theme, whatever the theme on screen:

- the chat and the file viewer render inline, so the browser's own print
  reaches it
- export paths call the static renderer with the print theme

An external viewer such as GitHub or a plain editor sees the fence as code. On
request, the module's CLI writes a flattened light/dark SVG pair for `<picture>`.
That pair is a derived artifact, never the source.

### 6. Every content renderer meets one theme contract

The seam defines three themes, and a pack must implement all three.

| Theme | Used for |
| --- | --- |
| `light` and `dark` | Screen only, following the app's `[data-theme]` |
| `print` | Every artifact made to leave the screen: browser print, share as PNG or PDF, `brain render`, `/api/render` |

The kit already says this of its print theme: "Paper that is printed rather than
looked at: what a shared PNG or PDF is drawn in"
(`Paper that is printed rather than looked at`, `packages/ui-kit/src/tokens.css:863`).
`light` and `dark` reach an export only when a CLI caller asks for them by name.

In the print theme a pack draws:
- on the document's white ground
- with the print token values
- with no washes or translucent fills
- with structure carried by borders and labels, so a grayscale printer loses
  no meaning

Its static output contains no script and no external resource.

A shared conformance suite in the SDK renders every registered pack in all
three themes and asserts these properties, as
[backend conformance](backend-conformance.md) does for agent backends.

Measured reason: the former Mermaid share pipeline used the light ground
`#f8f5ef` against the document shell's `#ffffff` paper. A PDF holding a
Mermaid chart and a diagram would show two different grounds. Mermaid now
uses the kit's generated print values and white paper for exports
(`Every export uses`, `packages/ui-react/src/lib/mermaid-theme.ts:25`).

Rejected:
- **Leave each pack to choose its export palette.** That is exactly how the
  mismatch above happened.
- **Use `light` for exports.** The kit's light ground is a warm off-white
  meant for screens, and its washes do not survive a grayscale printer.

### 7. The adaptation is a pinned fork with a written sync procedure

The module records the upstream commit it last reviewed, and carries
upstream's MIT notice for the portions it adapts. It also ships a procedure, in
the module, for reviewing upstream changes since that commit: new diagram
types, revised rules and budgets, fixed checker cases. Each candidate is
judged against the brain-kit skin before anything is adopted. Upstream's
example HTML is never vendored: examples are re-authored in the Odysseus world
([the corpus decision](example-corpus.md)).

### 8. Upstream attribution lives in the module's licence

**Maintainer ruling, 2026-10-16, on [#2109](https://github.com/schlessera/brain-kit/issues/2109).**

Upstream's MIT licence requires its copyright notice, which names a person,
in every copy of a substantial portion. The tree forbids real names. The
module therefore carries the notice in
`packages/module-diagrams/LICENSE`, under a "Portions adapted from
diagram-design" section after brain-kit's own MIT text. This adds nothing to the
leakage gate: it already skips files named `LICENSE`
(`const EXCLUDED_FILES`, `scripts/check-leakage.ts:53`), and every package's
`LICENSE` already holds a real copyright line.

Links to a public open-source project may contain its owner's handle,
including in docs, issues and the module's `upstream.json`. Such a link is how
the work is attributed and how the sync procedure finds upstream. It is not
personal data about anyone in the maintainer's life.

AGENTS.md states both exceptions beside the hard rule, so that an agent
neither strips a required notice, which would breach the licence, nor widens
the gate.

Rejected:
- **A separate `NOTICE` or `THIRD_PARTY_LICENSES.md` file.** It would need a new
  file exemption in the gate for no gain over the licence file.
- **No notice, by authoring every rule and grammar independently.** That is
  hard to defend for grammars that track upstream's structure closely, and it
  would lose the "adapted under MIT" provenance the sync procedure relies on.

## Consequences

- The module manifest gains a `renderers` key, and the integration contract
  gains the fence spec and the module's `--json` shapes. Each lands with a
  `CONTRACT:` commit.
- The fence spec lives in users' content repositories indefinitely. Its
  `schema_version` only grows additively without a maintainer ruling.
- Mermaid stops being a special case, and its export path becomes the generic
  one.
