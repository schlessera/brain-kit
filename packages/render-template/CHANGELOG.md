# @schlessera/brain-render-template

## 0.38.0

### Minor Changes

- 1c30db2: Rendered documents get a designed default style and a component system (#530). Every `brain render` and shared PDF now uses a new stylesheet: system sans display type, an accent bar over each `h2`, hairline tables, and a full-bleed A4 page whose footer shows the title and page numbers from page 2. Designed documents are composed from `doc-*` component classes (hero, letterhead, callout, card, badge, buttons, columns, timeline, steps, checklist, stats, bars, compare, line items and more) under per-document switches (`data-accent`, `doc--editorial`, `doc--compact`), never from hand-written CSS.

  `@schlessera/brain-render-template` exports the component list and snippets (`DOCUMENT_CLASSES`, `DOCUMENT_BLOCKS`), `lintDocument`, and eight document kinds with a skeleton each under `@schlessera/brain-render-template/kinds`. A complete HTML document is no longer nested inside the shell: the stylesheet is injected into its `<head>` under the author's own rules, and `<meta name="brain-render" content="bare">` opts out. The package now depends on `parse5`, which reads documents and fragments the way the browser does. `@schlessera/brain-render-puppeteer` takes page size and margins from the document's `@page` rule. Pointing `PUPPETEER_EXECUTABLE_PATH` at `chrome-headless-shell` renders in about half the time of full Chrome.

  `brain render` adds `--kind list`, `--kind <kind> --scaffold`, `--blocks [name…]` and `--no-running-title`, and its JSON envelope adds `pages` and `warnings`. The `generate-pdf` skill is rewritten around picking a kind, scaffolding, filling and rendering until there are no warnings; `plan-travel` renders its day plans as the `itinerary` kind.

## 0.37.0

## 0.36.0

## 0.35.0

## 0.34.1

## 0.34.0

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.1

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

### Patch Changes

- a714ee1: Per-package `test` scripts now pass `--timeout 30000`, so `bun run test` inside a package no longer flakes on bun's 5s default when suites spawn the CLI.
- ef519d1: Harden the publish surface: what a consumer installs now matches what the
  declarations, bundler and runtime actually reach for.

  - `@schlessera/brain-backend-pi` declares `@earendil-works/pi-agent-core`
    (exact-pinned, like its sibling pi pins) instead of borrowing it from
    hoisting — its public `history.d.ts` types reference the package, so a
    strict installer (pnpm, npm with isolated modes) could not typecheck it.
  - `@schlessera/brain-ui-react` sets `sideEffects` to `["**/*.css"]` — the
    blanket `false` licensed bundlers to tree-shake a direct
    `import "@schlessera/brain-ui-react/styles.css"` away entirely.
  - `./theme.css` now resolves from `dist/` (copied verbatim at build) like
    `./styles.css` already did, so both stylesheets survive a dist-only tarball
    and the export map is uniform. The import specifier is unchanged.
  - `@schlessera/brain-module-finance`, `-images` and `-speaking` declare the
    same optional `@types/bun` peer that `-jobs` already carried: their module
    declaration graphs reach `bun:sqlite` types through `@schlessera/brain`.
  - Every package exports `"./package.json"` — tooling like Vite, Tailwind and
    Jest stats it, and the export map previously made that unreachable.
  - `engines.bun` is aligned with reality: bun-runtime packages require
    `>=1.3.5` (the CVE-2026-24910 floor `brain doctor` warns below), and
    packages that import cleanly under plain Node carry no bun engines field.
    Scrape keeps its (bumped) engines despite importing node-clean: its proxy
    fetch path shells out through `Bun.spawn`, so the runtime constraint is
    real even though the import is not.
  - Backend loading in `@schlessera/brain-ui-server` uses `await import()`
    instead of CJS `require()`, and only "the backend package itself is not
    installed" maps to the install-hint error. An installed-but-broken backend
    (missing transitive dep, syntax error, `ERR_REQUIRE_ESM`) now surfaces its
    real error instead of a misleading "not installed".

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.1

## 0.13.0

## 0.12.1

## 0.12.0

## 0.11.0

## 0.10.0

### Minor Changes

- 50f6ec7: Add `brain render` — documents to PDF, PNG, or standalone HTML from the CLI

  PDF generation existed in brain-kit already, but only over HTTP: the UI posted
  content to `/api/render`, which wrapped it in a document template and drove the
  headless Chrome in `@schlessera/brain-render-puppeteer`. Nothing on the command
  line could reach it, so agents and skills that wanted a shareable file shelled
  out to a browser themselves and re-invented the layout each time.

  - **New package `@schlessera/brain-render-template`** holds the markdown/HTML →
    print-ready document shell (marked plus the stylesheet), extracted from
    ui-server. Both callers now share it, so a page shared from the app and a PDF
    produced on the command line are byte-identical for identical input.
  - **New command `brain render <path|->`** with `--format pdf|png|html`. It
    strips frontmatter, takes the title from it, defaults the output path to the
    input with the format's extension, and refuses to write outside the brain
    root. `--format html` needs no browser at all.
  - **Remote images** stay blocked by default — the rendered page resolves no
    hostname, so a remote `<img>` becomes a visible `[alt — not embedded]`
    placeholder. The new repeatable `--allow-host` opens specific image hosts,
    passing the same allowlist to both the placeholdering and the renderer.
  - **New core skill `generate-pdf`** drives the command. It declares no `requires:`
    beyond `brain` itself.
  - `@schlessera/brain-render-puppeteer` becomes an optional peer of core, resolved
    dynamically like `@google/genai`: a missing renderer produces install
    instructions rather than a module-resolution stack trace.

  Also fixes a latent bug in the image placeholdering that ui-server shipped: the
  `<img>` match used `[^>]*` for attributes, so a `>` inside an earlier quoted
  attribute (`alt="<b>x</b>"`) truncated the match and let the remote image
  through unplaceholdered, to render as a broken-image box.
