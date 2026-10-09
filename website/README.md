# Public website

The selected homepage uses the actual public AppShell, ChatPage and Actions
components with a closed, fictional transport. Scenario navigation belongs to
the website. All responses, approvals and run timings are staged; the demo
uses no model, microphone, upload service or live brain. Free text has a small
local set of prepared responses. The application styles stay isolated in
iframes so its phone and desktop layouts behave at their own viewport sizes.

The demo adapts the public Odyssey presentation fixtures into a linked file
hierarchy, with typed Markdown frontmatter, people, voyage records, decisions
and the closed crew ledger. Frontmatter starts collapsed. Explore opens the
real file viewer; Sessions offers additional staged conversations. Keyword
search and the graph operate on these same fictional records.

Sharing uses the product's actual menus and share helpers. PNG and PDF targets
are prepared with the production renderer and committed under
`public/assets/shares/`. Markdown, text, rich text, diagram SVG and optimized
images use the product's browser implementation. Desktop browsers download
files; capable browsers can use their native share sheet. Exact content keys
prevent an unrelated artifact from being substituted for a response.

The demo-scoped worker serves original image/PDF bytes at the product's API
URLs. Sandboxed HTML navigation uses a separate static fixture route because
its opaque origin cannot use the worker. Neither holds user data or an offline
cache. Files and exports require no running backend on GitHub Pages.

Every device screen keeps its own aspect ratio and measures its actual width
to fit the application. The desktop preview retains a 1100×760 viewport.
Expanding a device animates the same mounted iframe over a dimmed page; closing
restores its place, focus and app state. Phone previews use native widths on
small screens, where the expansion control is unnecessary.

Astro generates static HTML under `website/dist/`, including seven deliberately
selected canonical documentation sources. `publication.mjs` controls their
stable routes. The Markdown remains in `docs/`; selected links are rewritten
for the site, and other valid repository links point to the built source SHA.
An unmapped image, missing file or fragment fails the build rather than
silently linking somewhere else. No analytics or newsletter form is included.

## Build and preview

From the repository root, with Bun 1.4.2:

```sh
bun install --frozen-lockfile
npm ci --prefix website --no-audit --no-fund
bun run website:check
bun run website:preview
```

The build uses the locked Node 22.23.3 executable in `website/node_modules/`.
It builds the public packages before compiling the real UI demo. Framework
dependencies belong to this private build project, outside the published
workspaces. Fonts are self-hosted, checked against the existing capture font
lock, and accompanied by their license notices.

UI source improvements are incorporated on rebuild. Changes to fictional data
or API behavior still need corresponding demo updates. Relevant UI, contract,
renderer, font or fixture changes invalidate the prepared export recipe. To
refresh it locally, with Chrome installed:

```sh
bun run website:shares
bun run website:check
```

Review and commit the regenerated assets with the change. Regular builds verify
recipe freshness, artifact signatures, hashes and content-to-artifact mappings;
ordinary local builds do not silently regenerate PDFs. The automated
publication workflow explicitly regenerates them before its browser checks.

The preview serves the build at `http://127.0.0.1:46401/brain-kit/`. `PORT` can
override the port. It stays running until stopped. Browser verification uses
installed Playwright and Chrome (`CHROME_PATH` may select another Chromium
executable); it checks interactions, both themes, 320–1440px layouts and no
external demo requests. Review captures are in `.impeccable/review/`.
Browser proof also exercises real file downloads and previews, frontmatter and
wiki-link navigation, frame geometry and persistent device expansion. The
native OS share sheet itself requires a supported device; browser fallback
downloads are covered by the automated proof.

Also exercise a root deployment:

```sh
SITE_BASE=/ bun run website:check
bun run website:check
```

`build-manifest.json` records the source SHA, dirty-tree boundary, runtime,
dependency locks, recipe fingerprints and every emitted file hash. A dirty
local preview is useful for review but cannot pass the publishing guard.

## Automatic GitHub Pages updates

`.github/workflows/publish-pages.yml` runs on relevant pushes to `main`: website
sources/configuration/assets, canonical docs and READMEs, dependency locks,
build tooling and font inputs. It also runs once for a stable canonical
`@schlessera/brain@X.Y.Z` release tag, rather than once per package tag.
Published GitHub Releases also trigger it.
A scheduled check every 15 minutes reconciles missed bulk tag pushes (GitHub
omits tag events for pushes of more than three tags). It skips dependency
installation, building and deployment when the released product commit/version
match.
Scheduled jobs may be delayed by GitHub; manual dispatch can rebuild immediately.
Package verification CI uses its own GitHub Actions workflows; this GitHub workflow owns website publication.

Main updates and release updates combine the current main website/docs with
**the latest stable tagged product tree and its frozen dependency lock** in an
isolated workspace. The local preview still builds the workspace UI for
development. They confirm the six consumed
packages are published on npm at the tag's exact version. The runtime uses that
tag's source, including its production renderer; it never falls back to newer
main UI code. Both website and product commits, tag/version, npm integrity
receipts, recipe fingerprints and asset hashes are recorded in the public
build manifest and export provenance. This is a tagged-source rebuild, not a
measurement of installed npm tarballs.

Every publishing run regenerates the demo bundle, product CSS, all PNG/PDF
share exports and four fallback screenshots from the selected product UI. It then typechecks integration and runs real Chromium smoke checks of
all four embedded views, plus end-to-end ranking/submission, scenario switching,
allow/deny, dictation/edit/send, file navigation/frontmatter, wiki links,
PNG/PDF/HTML/Mermaid previews and actual downloads. Responsive checks cover
320–1440px, both themes, precise device sizing, and animated expansion preserving
app state. The browser blocks external requests. These checks prove staged
frontend functionality; they do not test a live agent or hosted PWA backend.

The upload/deploy chain runs only after these checks and source/artifact identity
verification succeed. Source inputs must remain unchanged; only generated build
outputs may differ. A broken component/API/export fails the run and leaves the
published site in place. The workflow retains screenshots, a Playwright trace,
failure details and provenance for 14 days. Inspect those and update the demo
adapter if product contracts changed; the workflow does not automatically edit
or invent application logic. Re-run after a fix or registry availability delay.

Select **GitHub Actions** as the repository's Pages source before the first
publication. The separate deploy job uses the `github-pages` environment and
receives `pages: write` and `id-token: write`; build jobs have read access.
If the environment restricts deployment refs, allow main and canonical release
tags so direct release events can deploy. These repository settings have not
been changed by the local implementation.

For a rebuild, dispatch **Update and publish website** from main. Leave inputs
empty to rebuild main against the latest stable release, or choose a full previous main `source_sha` and optional
stable `brain_kit_tag` to rebuild/roll back a known combination through the same
checks. A release tag must be an ancestor of the selected website commit.
The Actions summary records the verified website/product commits and manifest
SHA-256. Release reconciliation continues targeting the latest stable tag after
a manual rollback. After deployment, verify the reported URL and a nested docs link.

Workflow permissions and artifact handling follow the
[GitHub Pages custom workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
