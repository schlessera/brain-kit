# @schlessera/brain-render-template

The shared document shell brain-kit wraps around content before it is rendered
to PNG or PDF. Markdown in, a single self-contained HTML document out — inline
CSS, system fonts, no external requests.

It is deliberately tiny and pure: `marked` and a stylesheet, no browser, no
filesystem, no network. The rendering itself lives in
[`@schlessera/brain-render-puppeteer`](../ui-render-puppeteer).

Two callers share it, which is the point — a page shared from the app and a PDF
produced on the command line are byte-identical for identical input:

- `@schlessera/brain-ui-server` → `POST /api/render`
- `@schlessera/brain` → `brain render`

## Usage

```ts
import { buildHtmlDocument } from "@schlessera/brain-render-template";

const html = buildHtmlDocument({
  content: "# Trip plan\n\nDay one: arrive.",
  contentType: "markdown",
  title: "Trip plan",
});
```

| Option | Default | Meaning |
|---|---|---|
| `content` | — | Markdown source or a fragment of HTML |
| `contentType` | — | `"markdown"` parses; `"html"` passes through |
| `title` | `"Shared from Brain"` | `<title>`, escaped |
| `allowHosts` | `[]` | Image hosts the renderer will resolve |

## Remote images

The renderer denies the page network access, so a remote `<img>` would render as
a broken-image box. Those are replaced with a visible placeholder instead:

```html
<span class="remote-image">[Matterhorn at dawn — not embedded]</span>
```

`data:` URIs are always left alone. To let specific hosts through, pass
`allowHosts` **and** give the renderer the same list — this option only stops
the placeholdering; it does not grant the page any access on its own.

## Print behaviour

The stylesheet includes a `@media print` block that keeps tables, blockquotes,
code blocks and diagrams from splitting across pages, and keeps headings with
the content that follows them.
