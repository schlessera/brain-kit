# @schlessera/brain-render-template

The shared document shell brain-kit wraps around content before it is rendered
to PNG or PDF, the components a designed document is composed from, and the
document kinds that combine them. Markdown or HTML in, a single self-contained
HTML document out: inline CSS, system fonts, no external requests.

The main entry is pure: `marked`, `parse5` and a stylesheet, no browser, no
filesystem, no network. parse5 reads complete documents and HTML fragments the
way Chrome does, so the shell finds the right `<head>`, title and images in
them. The rendering itself lives in
[`@schlessera/brain-render-puppeteer`](../ui-render-puppeteer).

Two callers share it, which is the point. A page shared from the app and a PDF
produced on the command line share the same shell. The app additionally enables
the export link policy; CLI defaults are unchanged:

- `@schlessera/brain-ui-server` → `POST /api/render`
- `@schlessera/brain` → `brain render`

## Usage

```ts
import { buildHtmlDocument, lintDocument } from "@schlessera/brain-render-template";

const html = buildHtmlDocument({
  content: "# Trip plan\n\nDay one: arrive.",
  contentType: "markdown",
  title: "Trip plan",
});
const warnings = lintDocument(html); // [] when nothing will render wrong
```

| Option | Default | Meaning |
|---|---|---|
| `content` | — | Markdown source, a fragment of HTML, or a complete HTML document |
| `contentType` | — | `"markdown"` parses; `"html"` passes through |
| `title` | `"Shared from Brain"` | `<title>`, escaped. A complete document keeps its own |
| `allowHosts` | `[]` | Image hosts the renderer will resolve |
| `linkPolicy` | omitted | `"visible-destinations"` classifies final document links; the app always enables it |
| `runningTitle` | the title | The PDF footer's title from page 2; `false` shows page numbers only. The default title is never shown |

## The document style

A plain markdown note already renders as a finished document: system sans
display type set tight, a short accent bar over each `h2`, hairline tables
with an uppercase header, and a full-bleed A4 page with the title and "2 / 5"
in the footer from page 2. The footer is drawn with CSS margin boxes, so it
appears only in PDF output.

Everything, `@page` rules included, sits in `@layer brain-document`, so any
rule an author writes outside a layer wins over it, whatever its specificity.

## Complete HTML documents

Content that starts with `<!doctype html>` or `<html>` (after a BOM,
whitespace and comments) is not wrapped. The stylesheet is injected as the
first child of its `<head>`, a `<head>` is created if there is none, and its
own `<title>` stands. `<meta name="brain-render" content="bare">` in the head
skips the shell injection; remote images are still placeholdered. It cannot
disable an enabled link policy.

## Components

Every component is a class with a `doc-` prefix. `DOCUMENT_CLASSES` lists all
of them and is the contract the stylesheet is tested against in both
directions. `DOCUMENT_BLOCKS` holds a minimal snippet for each, which
`brain render --blocks` prints.

| Layer | Classes |
|---|---|
| Switches, on `<body>` | `data-accent="amber\|teal\|blue\|purple\|graphite"`, `doc--editorial` (serif display), `doc--compact` |
| Opener, at most one, first | `doc-hero` (`--solid`, `--split`, `--cover`), `doc-letterhead` |
| Blocks | `doc-kv` (`--facts`, `--row`, `--stacked`), `doc-callout` (`--warning`, `--critical`), `doc-summary`, `doc-card` (`--tint`, `--accent`), `doc-badge` (`--accent`, `--ok`, `--warn`, `--bad`), `doc-actions` + `doc-button` (`--accent`, `--quiet`), `doc-cols` (`--wide-start`, `--wide-end`, `--three`), `doc-timeline`, `doc-steps`, `doc-checklist`, `doc-stats`, `doc-bars`, `doc-compare`, `table.doc-lines`, `table.doc-zebra`, `doc-quote`, `doc-fineprint`, `doc-n`, `doc-page-break`, `doc-keep` |

Blocks keep together across pages; long timelines, steps, checklists and tables
split only between items. Columns stack under 600px. Markers are CSS
or ASCII, never a font glyph. The one value an author writes inline is data:
`<li style="--v:.46">` on a bar.

## Document kinds

`@schlessera/brain-render-template/kinds` names eight kinds: itinerary, brief,
report, how-to, comparison, invoice, invitation and note. A kind is a recipe:
one opener, the blocks that usually follow it, and an accent. Each has a
skeleton in `skeletons/`, a complete example that is also its visual fixture,
so a skeleton cannot drift from the CSS it is tested against.
`brain render --kind <kind> --scaffold` prints it.

```ts
import { readSkeleton, resolveKind } from "@schlessera/brain-render-template/kinds";

const html = readSkeleton(resolveKind("recipe")!); // the how-to skeleton
```

This entry reads files, so it is kept apart from the main one, which the
browser bundle imports.

## Checking a document

`lintDocument(html)` reports what the renderer would silently get wrong:
`unknown-class`, `unknown-accent`, `opener-not-first`, `several-openers`,
`placeholder-image` (a skeleton image left in), `remote-image`, `empty-link`,
`script` and `network-resource`. Each warning's message says what to do.

## Remote images

The renderer denies the page network access, so a remote `<img>` would render as
a broken-image box. Those are replaced with a visible placeholder instead:

```html
<span class="remote-image">[Matterhorn at dawn — not embedded]</span>
```

`data:` URIs are always left alone. To let specific hosts through, pass
`allowHosts` **and** give the renderer the same list. This option only stops
the placeholdering; it does not grant the page any access on its own.

## App export links

`linkPolicy: "visible-destinations"` adds the existing validated ASCII host
beside a web link's words, or the validated address for mail. Refused links are
inert and carry a withheld marker. Unavailable relative repo paths remain
readable/inert; same-document fragments stay local. Content-supplied bases never
resolve a destination. The transform also covers raw Markdown HTML, complete
and bare documents, SVG targets and declarative shadow content; embedded
documents become placeholders. It does not fetch targets.

Pass the same `linkPolicy` to `@schlessera/brain-render-puppeteer` when producing
PNG/PDF. It re-applies the structural policy idempotently and checks disclosure
in the final media/layout, repairing clipping/hidden styles and rejecting an
export whose destination still cannot be drawn. A template string alone cannot
prove how arbitrary supplied CSS will paint. Custom app renderers must provide
that final check. The CLI does not opt into this policy by default.

`@schlessera/brain-render-template/links` exports the existing pure classifiers
and their types/constants without Markdown, DOM, React or I/O imports. The
UI-kit's public `./links` entry re-exports the same implementation.
