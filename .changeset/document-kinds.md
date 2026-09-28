---
"@schlessera/brain-render-template": minor
"@schlessera/brain-render-puppeteer": minor
"@schlessera/brain": minor
"@schlessera/brain-module-speaking": patch
---

Rendered documents get a designed default style and a component system (#530). Every `brain render` and shared PDF now uses a new stylesheet: system sans display type, an accent bar over each `h2`, hairline tables, and a full-bleed A4 page whose footer shows the title and page numbers from page 2. Designed documents are composed from `doc-*` component classes (hero, letterhead, callout, card, badge, buttons, columns, timeline, steps, checklist, stats, bars, compare, line items and more) under per-document switches (`data-accent`, `doc--editorial`, `doc--compact`), never from hand-written CSS.

`@schlessera/brain-render-template` exports the component list and snippets (`DOCUMENT_CLASSES`, `DOCUMENT_BLOCKS`), `lintDocument`, and eight document kinds with a skeleton each under `@schlessera/brain-render-template/kinds`. A complete HTML document is no longer nested inside the shell: the stylesheet is injected into its `<head>` under the author's own rules, and `<meta name="brain-render" content="bare">` opts out. The package now depends on `parse5`, which reads documents and fragments the way the browser does. `@schlessera/brain-render-puppeteer` takes page size and margins from the document's `@page` rule. Pointing `PUPPETEER_EXECUTABLE_PATH` at `chrome-headless-shell` renders in about half the time of full Chrome.

`brain render` adds `--kind list`, `--kind <kind> --scaffold`, `--blocks [name…]` and `--no-running-title`, and its JSON envelope adds `pages` and `warnings`. The `generate-pdf` skill is rewritten around picking a kind, scaffolding, filling and rendering until there are no warnings; `plan-travel` renders its day plans as the `itinerary` kind.
