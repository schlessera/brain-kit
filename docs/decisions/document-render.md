# Rendered documents: one stylesheet, components and kinds

How `brain render` and the UI's `/api/render` turn content into a document
someone would send (#530). The design drop for the issue proposed the
stylesheet, the component classes and the kinds. This record keeps the
rulings a later change could undo without knowing why, the places the build
departs from the drop, and the measurements behind them. Dated 2026-09-28.

## 1. A kind is a recipe, and the class list is the contract

A document is one opener plus blocks under up to three `<body>` switches
(`data-accent`, `doc--editorial`, `doc--compact`). There are no per-kind
stylesheets and no kind classes. A kind (itinerary, brief, report, how-to,
comparison, invoice, invitation, note) exists as data: a name, the opener and
blocks it usually uses, an accent, and a skeleton file that is also its visual
fixture.

The contract is therefore the list of class names
(`export const DOCUMENT_CLASSES`, `packages/render-template/src/components.ts:297-303`).
A test holds it to the stylesheet in both directions and pins it as an explicit
list, so a rename is a reviewed diff rather than a side effect.

Rejected:

- **A stylesheet or template per kind.** Seven places for the same typography
  to drift, and a new kind would mean new CSS.
- **Markup in the skill.** Every use would pay for every kind's HTML in
  tokens, and the markup would drift from the CSS it depends on. The skill
  names the kinds; `brain render --kind <kind> --scaffold` prints the one it
  needs (`function runReference`, `packages/core/src/cli/commands/render.ts:156-187`).
- **`generate-pdf/kinds/<kind>.md` reference files**, the drop's fallback if
  the CLI flag was out of scope. They would be a second copy of each skeleton.

## 2. A complete HTML document is injected into, never nested

`buildHtmlDocument` used to wrap everything in its own `<html><body>`, so a
full document arrived nested and relied on the browser's error recovery.
Content that starts with a doctype or `<html>` now gets the stylesheet as the
first child of its `<head>` (`function injectShell`, `packages/render-template/src/template.ts:106-133`).
Every shell rule is in `@layer brain-document`, `@page` rules and the footer
included, so any unlayered author rule wins whatever its specificity. The drop
kept `@page` outside the layer. Chrome 140 happens to let an author's
`@page { margin: 20mm }` beat the shell's `@page :first` there too (measured:
20.1 mm on page 1), but only the layer makes that the rule rather than an
accident of how Chrome weighs page selectors, and layered `@page` rules and
margin boxes render the same (measured: size, margins and footer all applied).
`<meta name="brain-render" content="bare">` skips the injection.

Rejected: **passing the document through untouched.** Agents would have to
restate all typography in every document, which is the cost #530 set out to
remove. The price of injecting is that an element default the author never set
(an `h2`'s font, say) now comes from the shell; `bare` exists for that.

## 3. The PDF footer is CSS margin boxes, not `displayHeaderFooter`

The drop specified Puppeteer's `displayHeaderFooter` with a footer template.
The build draws the footer with `@page` margin boxes instead
(`export function pageFooter`, `packages/render-template/src/styles.ts:407-420`):
the running title bottom left and "2 / 5" bottom right, on every page but the
first.

- The stylesheet gives the first page a different top margin
  (`@page :first { margin-top: 0 }`) so the opener bleeds to the top edge.
  Puppeteer's footer template is reported to go missing in exactly that case
  (puppeteer#2480).
- A footer template shares no styles or fonts with the page, and its font size
  on Linux is unreliable (puppeteer#7880). Margin boxes use the page's fonts
  and ship with the stylesheet, so a CLI render and a shared PDF get the same
  footer with no renderer option.
- Margin boxes need Chrome 131 or later. They render under Chrome 140 and
  chrome-headless-shell 140, checked by rasterising both PDFs.

The first page carries no footer. A one-page document therefore has none, and
the opener identifies the document on page 1.

## 4. The cover is its own page, 296 mm tall

The drop's cover was `min-height: 279mm` inside the page margins, which leaves
a white 16 mm strip under the accent ground. The build puts the cover on a
named page, `doc-cover`, with no margins and no footer, so it bleeds on all
four sides (`@media print { .doc-hero--cover`, `packages/render-template/src/styles.ts:201`).
Its height is 296 mm rather than 297 mm, because a box exactly one page tall
can round over and push an empty page after it. The invitation skeleton
renders as two pages, cover and programme, under both binaries.

## 5. Headings do not split

`h2` draws its accent bar as a block `::before`. With only
`break-after: avoid`, the first render of the brief skeleton left the bar at
the foot of page 1 and the heading text at the top of page 2. Headings now
also carry `break-inside: avoid`.

## 6. chrome-headless-shell is faster, and opt-in

Measured on WSL2 with the same Chrome version (140), seven cold
launch-render-close cycles each, median:

| Binary | `headless: "shell"` | `headless: true` |
|---|---|---|
| chrome-headless-shell | 152 ms | 143 ms |
| google-chrome | 336 ms | 296 ms |

The binary decides the speed and the flag decides nothing. Both binaries also
start under either flag, so the renderer keeps passing `headless: true`. An
earlier draft chose the flag from the binary's name on the belief that each
binary refused the other's mode; this measurement disproved it and the switch
was removed. A whole `brain render` of the itinerary skeleton took 0.55 s with
full Chrome and 0.46 s with the shell.

The shell is used when `PUPPETEER_EXECUTABLE_PATH` points at it. It is not
searched for among the well-known paths: an earlier draft tried
`/usr/bin/chrome-headless-shell` first, and a broken binary there would have
failed every render while a working Chrome sat further down the list.

Considered and left out: a persistent browser or daemon for the CLI (a one-shot
render is already under half a second), `--single-process` and `--no-zygote`
(crash reports, and the latter needs the sandbox off), and `tagged: false`
(smaller files, but it drops the accessible structure).

## 7. Every render is linted

A misspelt component class renders silently unstyled, which is the failure an
agent composing from classes will hit most. `lintDocument`
(`export function lintDocument`, `packages/render-template/src/lint.ts:51-142`)
checks the built document for unknown classes and accents, a second opener or
one that is not first (a document with none is fine), skeleton placeholder
images, links to `#`, remote images,
scripts and anything that would load from the network. `brain render` prints
the findings and returns them as `warnings`, beside the PDF's page count. The
`generate-pdf` skill treats zero warnings and the expected page count as done,
which replaces looking at a PNG of every render.

Skeleton images carry `data-placeholder`, so a skeleton left half-filled is
reported rather than shipped.

## 8. No CSS that rasterises

Chrome's PDF backend (Skia) rasterises CSS `filter`, `backdrop-filter` and
blurred shadows into bitmaps, which grows the file and turns the text inside
into pixels. Gradients, opacity, clipping and blend modes stay vector. The
stylesheet uses only zero-blur `inset` shadows, gradients and `clip-path`, and
new components should keep to that.

## 9. The skeletons are in the Odyssey fixture world

The drop's fixtures used a third fictional cast. AGENTS.md allows exactly two
fixture personas, so the skeletons were rewritten into the Odysseus world of
`packages/ui-kit/fixtures/`, block for block, with its figures where the world
has them: the estate ledger for the report and the invoice, the crew ledger for
the note, the strait for the comparison.

## 10. The HTML is read by a spec parser

Finding a document's `<head>`, its title and its `bare` switch, replacing its
remote images, and walking its elements for the lint all read the tree
parse5 builds, with scripting off because the renderer runs none, and with
source offsets, so the shell edits the author's bytes rather than
re-serialising them (`export function parseDocument`, `packages/render-template/src/html.ts:32-34`).
The title is the browser's: the first HTML `<title>` in tree order. A leading
byte-order mark is stripped before parsing, as a browser strips it while
decoding, and offsets are shifted back. CSS is scanned for `url()` and
`@import` by a small linear scanner that skips comments and strings.

Rejected: **regexes, and then a hand-written tokenizer.** Three review passes
by another model family measured what each got wrong. The regex draft injected
the stylesheet into a `<head>` written in a comment, let a commented-out `bare`
meta switch the shell off, and was quadratic on unclosed tags (1.7 s for
48 KB; 19.5 s for the test that now builds and lints five 20,000-tag inputs in
milliseconds). The tokenizer that replaced it was linear, but the next pass
still found a dozen inputs it read differently from the HTML spec: `<!-->`,
`<img:foo>`, `<plaintext>`, CDATA and self-closing `<title/>` in SVG, text in
`<head>`, entities in attribute values. Each would have needed another state
of a parser that already exists. parse5 is the WHATWG parser in JavaScript,
linear, with one dependency. It builds and lints a 1 MB document in about
450 ms. Each reviewed case is a test.
