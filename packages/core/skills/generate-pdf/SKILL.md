---
name: generate-pdf
description: Use when the user wants something they can send, share, or print — a PDF, an image, or a standalone page — whether that is an existing note rendered as it stands or a designed document assembled for the occasion, such as a day plan, itinerary, briefing, memo, report, how-to, comparison, invoice, or invitation.
compatibility: PDF and PNG need the optional @schlessera/brain-render-puppeteer package and Chrome or chrome-headless-shell; --format html needs neither. On Linux, install fonts-noto-core and fonts-dejavu-core, and fonts-noto-color-emoji for emoji.
---

# Generate PDF

**This skill orchestrates; `brain render` does the rendering.** It wraps content
in the shared document shell, checks it, and drives a headless browser. Do not
shell out to a browser, a PDF tool or an image library, and do not write CSS:
the shell's stylesheet and components cover every document below.

## Existing document: one command

```sh
brain render notes/quarterly-summary.md
```

Frontmatter is stripped, the title comes from it, and the PDF lands beside the
source. This is the right answer far more often than it looks. A plain note
already renders as a finished document: set type, calm headings, hairline
tables, page numbers.

## Designed document: pick, scaffold, fill, render

### 1. Pick a kind

| Kind | For | Also called |
|---|---|---|
| `itinerary` | A day or a trip: where to be when, what to bring | day-plan, trip |
| `brief` | A recommendation or message someone must act on | memo, letter, proposal |
| `report` | Figures over a period, and what they mean | digest, review |
| `how-to` | Something to make or do, in order | recipe, guide |
| `comparison` | Options side by side, and the one to pick | decision, options |
| `invoice` | Money owed or paid: line items and a total | quote, receipt |
| `invitation` | An event: a cover page, then the programme | event, programme |
| `note` | Anything else, as plain markdown | plain |

When none fits, use `note`. `brain render --kind list` prints this table with
the opener and blocks of each.

### 2. Scaffold

```sh
brain render --kind itinerary --scaffold
```

It prints the kind's skeleton: a complete, filled-in example document. It is
the markup to copy, so read it once and write from it. The example content is a
fictional world, so none of its words belong in the output.

### 3. Fill it in, in one pass

Write the whole file at once, next to what it describes
(`travel/{trip-slug}/day-plan.html`), not as a string of small edits.

- **Keep the opener first** (`doc-hero…` or `doc-letterhead`). It is what
  makes page 1 bleed to the edge. One opener per document.
- **Delete the blocks you do not need, repeat and reorder the rest.** For a
  block the skeleton lacks, print its snippet:
  `brain render --blocks stats bars` (`--blocks` alone lists all of them).
- **Pick the accent from the content**, on `<body data-accent="…">`: amber
  (warm, food, events), teal (travel, money, health), blue (data, reports),
  purple (decisions, ideas), graphite (formal, letters).
- **No `<style>` and no CSS.** The one inline style is the data on a bar,
  `style="--v:.46"`. Anything else inline is a one-off that no class covers.
- **Put meaning in words:** a badge's text, a callout's title. Never let an
  emoji or a dingbat carry it alone, since the render machine may lack the font.
- **Images:** replace each `data-placeholder` image's `src` and remove the
  attribute, or delete the image. A hero without an image is fine.
- **Links:** real URLs, or plain text.

### 4. Render once, then read the envelope

```sh
brain render travel/wallis-2026/day-plan.html --out travel/wallis-2026/day-plan.pdf
```

The JSON has `pages` and `warnings`. Every warning names the problem and the
fix: an unknown component class, an opener that is not first, a placeholder
image, an image or stylesheet that cannot load, a link to `#`. **Fix every
warning and render again. Zero warnings is the bar.**

Check `pages` against what was asked. A one-pager that came out as two gets
shorter content, `class="doc--compact"` on `<body>`, or loses its hero image.
Do not shrink the type with CSS.

### 5. Look only when the layout is in doubt

A render with no warnings and the expected page count is done. Render a PNG
and look at it only when a combination of blocks is new to you or the page
count surprised you:

```sh
brain render travel/wallis-2026/day-plan.html --format png --scratch
```

## Formats

`--format pdf` is the default. `--format png` is one full-page image at
`--width` (320-4096, default 768). `--format html` writes exactly the document
the other two rasterize, with no browser, which is the way to inspect a layout
problem as text.

## Page control and the footer

- `class="doc-page-break"` starts a new PDF page. `class="doc-keep"` keeps a
  group on one page. Blocks already keep together; long timelines, steps,
  checklists and tables split only between items.
- From page 2 the footer shows the title and "2 / 5". `--no-running-title`
  keeps only the numbers.
- A complete `<!doctype html>` document is fine. The shell's styles are
  injected under the document's own, and its own rules win.
  `<meta name="brain-render" content="bare">` in its head opts out entirely.
- The page runs no JavaScript and loads nothing from the network: no scripts,
  iframes, webfonts or external stylesheets. Anything script-made must arrive
  as HTML or SVG, which is how mermaid diagrams reach the renderer.

## For domain skills

A skill that produces a document names a kind and its own section order. For
example: "render as `itinerary`; sections: The day, The route, Pack, Food". It
never ships CSS or an HTML shell, so every document a brain produces matches,
and a later theme changes all of them at once.

## Images

The rendered page resolves **no hostname at all** by default, so a remote
`<img>` becomes a visible `[alt — not embedded]` placeholder and a warning. Two
ways to get real images in:

1. **Allow the host.** Repeatable, and the honest default for public sources:
   ```sh
   brain render trip.md --allow-host upload.wikimedia.org
   ```
2. **Inline as a `data:` URI.** It always renders, with no flag and no network.

**Fetch images at the size you need.** There is no image-processing tool in the
loop, so the bytes you reference are the bytes that land in the file. Every
common source takes a size in the URL:

| Source | Sized URL |
|---|---|
| Wikimedia Commons | `.../thumb/a/ab/File.jpg/400px-File.jpg` |
| Unsplash | `images.unsplash.com/photo-…?w=1200&q=60` |
| OpenStreetMap static | `staticmap.openstreetmap.de/staticmap?size=800x600&…` |

A full-width hero wants about 1200px wide, a column image about 600px. Three
images is plenty for a one-pager.

Do not go looking for an image tool. Do not count on `magick`, `convert`, `gm`
or `ffmpeg`, and do not probe for them. Ask for the size up front instead:
`brain image` takes `--resolution` and `--aspect`, and image hosts take a size
in the URL.

## Size

The real ceiling is the file server's, currently 10 MB. A document over that
cannot be previewed or downloaded at all. Below it, size is a judgement about
the reader's connection: a few hundred KB is a comfortable one-pager, and a few
MB is fine for something image-heavy. If a render is large, say so and why (it
is almost always full-size images) and offer smaller ones.

## Where the file goes

Output must live inside the brain repo. `brain render` refuses any path outside
it, and a file written outside is invisible to anyone browsing the brain.

- **To keep:** next to what it describes (`travel/{trip-slug}/`, the project
  directory) or in an exports directory.
- **For now only** (a preview, a file to share and forget): pass `--scratch`.
  It lands in `.brain/scratch/`, hidden from normal file-tree browsing. Give
  the reader a direct chat link to the exact repo-relative output path the
  command prints, including its leading dot, for preview or download. Scratch
  files are never committed and are pruned after 7 days or past 1 GB.

Never write to `/tmp`: the reader cannot open it, and `brain render` refuses it.

## Checks before reporting done

- [ ] `warnings` is empty
- [ ] `pages` is what was asked for
- [ ] Nothing from the skeleton's example content survives
- [ ] The file is inside the brain repo, at a path that makes sense
- [ ] Size is comfortably under the 10 MB server cap
