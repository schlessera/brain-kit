---
name: generate-pdf
description: Use when the user wants something they can send, share, or print — a PDF, an image, or a standalone page — whether that is an existing note rendered as it stands or a designed one-pager assembled for the occasion, such as a day plan, itinerary, briefing, or summary.
---

# Generate PDF

**This skill orchestrates; `brain render` does the rendering.** It wraps content
in the shared document shell and drives a headless browser — do not shell out to
a browser, a PDF tool, or an image library yourself.

## Input

The content to render, and where it should land. Either is enough to start:

- an existing brain document → render it as it stands
- a description of what to assemble → build the document first, then render

## Two modes

**Render a document that already exists.** One command, no authoring:

```sh
brain render notes/quarterly-summary.md
```

Frontmatter is stripped, the title comes from it, and the PDF lands beside the
source. This is the right answer far more often than it looks — reach for the
designed mode only when the content genuinely needs a layout.

**Assemble a designed one-pager.** Write the HTML, then render it:

```sh
brain render travel/wallis-2026/day-plan.html --out travel/wallis-2026/day-plan.pdf
```

Or pipe it without leaving a file behind:

```sh
brain render - --as html --out travel/wallis-2026/day-plan.pdf
```

## Formats

```sh
brain render <path> --format pdf     # default
brain render <path> --format png     # single full-page image
brain render <path> --format html    # no browser needed
```

`--format html` is also the debugging path: it writes exactly the document the
other two rasterize, so layout problems can be inspected as text.

Other flags: `--title`, `--width` (320-4096, default 768), `--out`, `--as`.

## Images

The rendered page resolves **no hostname at all** by default, so a remote
`<img>` becomes a visible `[alt — not embedded]` placeholder rather than a
broken box. Two ways to get real images in:

1. **Allow the host** — repeatable, and the honest default for public sources:
   ```sh
   brain render trip.md --allow-host upload.wikimedia.org
   ```
2. **Inline as a `data:` URI** — always renders, no flag, no network.

**Fetch images at the size you need.** There is no image-processing tool in the
loop, so the bytes you reference are the bytes that land in the file. Every
common source takes a size in the URL:

| Source | Sized URL |
|---|---|
| Wikimedia Commons | `.../thumb/a/ab/File.jpg/400px-File.jpg` |
| Unsplash | `images.unsplash.com/photo-…?w=400&q=55` |
| OpenStreetMap static | `staticmap.openstreetmap.de/staticmap?size=400x300&…` |

Three images is plenty for a one-pager: one hero, one per major section.

## Size

Shareable means downloadable. **Target under 400 KB**; the command prints the
size on every run, so check it and re-render smaller if it is over. Full-size
images are the cause essentially every time.

## Where the file goes

Output must live inside the brain repo — `brain render` refuses paths that
escape it, and a file written outside is invisible to anyone browsing the brain.
Put it next to what it describes (`travel/{trip-slug}/`, the project directory)
or in an exports directory for one-offs.

## Authoring HTML that survives a page break

When assembling a designed document, the shared stylesheet already handles
typography, tables, code, and print breaks. Add only what the layout needs, and
keep it inline — the page cannot fetch a stylesheet or a webfont.

- **System fonts only.** A webfont silently falls back.
- **`break-inside: avoid`** on cards and blocks that must not split.
- **Links stay clickable** in PDF output — style them as buttons where they are
  calls to action.
- **No iframes.** A map embed renders blank; link to the map instead.
- **No JavaScript.** The page runs none, so anything script-generated must be
  inlined already (this is how mermaid diagrams reach the renderer — as SVG).

## Checks before reporting done

- [ ] Size is under 400 KB
- [ ] Every image renders — no `[… — not embedded]` left in the output
- [ ] The file is inside the brain repo, at a path that makes sense
- [ ] Links present and clickable; no iframes
- [ ] Content matches what was asked for

## Requirements

PDF and PNG need `@schlessera/brain-render-puppeteer` and a Chrome binary; the
command says so plainly if either is missing. `--format html` needs neither.
