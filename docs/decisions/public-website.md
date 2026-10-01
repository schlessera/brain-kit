# Public website: canonical Markdown, static Astro and GitHub Pages

Decision of 2026-10-01 under [#611](https://github.com/schlessera/brain-kit/issues/611)
and the [launch epic](https://github.com/schlessera/brain-kit/issues/608).
The maintainer selected [framework/content option A](https://github.com/schlessera/brain-kit/issues/611#issuecomment-5938291170)
and [publishing option A](https://github.com/schlessera/brain-kit/issues/611#issuecomment-5938985608).
These rulings bind the site implementation; they do not authorize publication.

## Why Astro

The site needs a product homepage and justified landing pages alongside the
maintained documentation. Use Astro with static output in `website/`. Keep
`docs/` and package READMEs as the canonical editorial sources. Product copy
belongs in `website/` and links to those guides rather than duplicating their
installation or configuration instructions.

The [investigation](../public-website-investigation.md) compares three concrete
approaches against Markdown reuse, routes, assets, preview, source links,
navigation and maintenance. VitePress 1.6.4 supplies useful docs navigation,
search and edit links, but its docs-first theme and Vue customization are a
less direct fit for the product pages. Eleventy 3.1.6 supplies a small static
template model, but leaves more documentation assembly to this project.
Astro's content collections and explicit routes fit the mixed presentation.
Only Astro was installed and executed; the alternatives were checked against
their primary documentation, not measured builds. This is a fit decision,
not a comparative speed or accessibility claim.

The [bounded local experiment](../../scripts/site-model-spike/README.md) pins
Astro 7.3.5 and `@astrojs/markdown-remark` 7.3.1. It reads seven unmodified
documentation files directly and one Odysseus sample. Cold builds at `/` and
`/brain-kit/` produced eight pages. Real Chrome checks followed nested links
and heading fragments, decoded the sample SVG and verified nonempty Markdown,
source links, GFM, code and a native disclosure. No browser scripts were
needed. This establishes content/link feasibility; final navigation, search,
responsive layout and accessibility still require their own designed-page
verification.

Astro 7's link transform uses `unified()` through the supported
[`markdown.processor`](https://docs.astro.build/en/reference/configuration-reference/#markdownprocessor)
configuration. Reusing the deprecated top-level plugin option would silently
assume an older Markdown pipeline. The project owns the actual link transform,
semantic navigation, keyboard/focus behavior and browser accessibility checks;
framework choice does not satisfy them.

## Stable routes without a second docs tree

Maintain an explicit publication manifest from intentionally selected sources
to stable public routes. For example, `docs/README.md` maps to `/docs/`,
`docs/quickstart.md` to `/docs/quickstart/`, and a selected package README may
map to `/docs/modules/<module>/`. These paths are relative to the configured
base. Source file renames preserve their published routes. Deliberate route
changes require a static redirect page and updated navigation, links and
canonical metadata. Do not publish every repository Markdown file by default.

Derive documentation navigation from the canonical [docs index](../README.md).
Resolve authored links against the original source location, including
`README.md`, reference definitions, query strings and fragments. Selected
targets become base-prefixed site links. Valid unselected repository targets
use public source/tree fallback; missing targets fail the build. Preserve
external URLs and GitHub-compatible heading IDs. Validate fragments, raw HTML
links, encoded paths, route collisions and approved image destinations in the
production build, beyond the experiment's deliberately narrow cases.

Published source links identify the file at the built commit. An edit link may
point to `main`. The experiment uses `main` source links as a feasibility check;
production must bind them to the artifact's source SHA and verify anonymous
readability before launch. Keep documentation images beside their source or
in an approved shared asset location and rewrite/copy them once. Generated
feature assets obey the separate [capture/provenance decision](feature-captures.md),
not the visual regression baseline directory. The
[sole-Odysseus corpus ruling](example-corpus.md) governs all public examples.

## Why repository-controlled GitHub Pages

Use the repository's GitHub Pages project site under `/brain-kit/`. One
repository controls the content, pinned build, review and CI publication.
Cloudflare Pages would add a separate project/account and CI deployment
credential. Deferring the host would leave the publishing handoff unresolved.
The maintainer chose the existing repository-controlled path. No custom
domain or publishing-provider interface is selected.

The project base must survive in page, navigation, stylesheet, image and other
asset URLs. Astro's [base setting](https://docs.astro.build/en/reference/configuration-reference/#base)
does not remove the need to construct authored URLs with that prefix. Verify
both root and project-prefix builds locally and the selected project prefix
in production CI.

Confirm current repository/account
[Pages eligibility](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
and anonymous access to every source/fallback destination before launch.
Public intent is not evidence of the repository's current visibility. The
maintainer controls Pages settings and publication authorization. A framework
or host ruling does not authorize a visibility change, account purchase, DNS
change, Pages enablement or live deployment.

## Build ownership and a reviewable update

`website/` is a private development/build project outside the published Bun
package workspaces, with output in `website/dist/`. Exclude it from npm release
lists and keep site framework dependencies out of brain package runtimes.
Provide one root build/check entry point that contributors and CI both use,
with frozen dependencies and pinned tooling. Page design belongs to #612;
final asset integration and launch checks belong to #615. Visitor policy
remains a separate ruling under #616; this decision approves no collection
form, tracking or hosted brain service.

The update procedure deliberately separates a green build from publication:

1. Edit canonical Markdown or approved site sources/assets in a PR. Build
   locally at both bases and inspect affected pages.
2. CI validates the exact PR source commit: routes, fragments, source mappings,
   asset freshness/provenance, leakage and designed-page browser accessibility
   and responsive checks. Make the built HTML available for local review with
   a manifest containing source SHA, lock hash, runtime/tool versions, base and
   asset/recipe provenance.
3. Merge the reviewed change. Build and validate the exact selected main
   commit and review that artifact's manifest and pages.
4. Obtain separate publication authorization for that commit/artifact. A
   repository-controlled dispatch validates their identity and deploys the
   reviewed static artifact through a separate job. Build jobs need repository
   read access; deployment uses `pages: write`, `id-token: write` and the
   `github-pages` environment, following GitHub's
   [custom workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
   Merging alone does not publish.
5. Verify the reported deployed commit and public homepage, nested deep link,
   image and source link. Record the sanitized receipt on the publishing issue.
   Rollback uses the same validation and separate authorization for a previous
   known-good commit/artifact.

These are production implementation requirements, not a claim that the local
experiment supplies a publishing workflow. A downloaded artifact served
locally is sufficient for review; a public preview service is unnecessary.

## Measurements that constrain the implementation

Removing the document base prefix caused the browser's `Resolved Quickstart`
assertion to fail. Removing only the image prefix failed at the image URL
assertion after document links passed. Both mutations were restored. A warm
collection cache initially masked the image mutation behind an older link
failure; that receipt was discarded and both mutations were repeated from
fresh caches. Clear or correctly invalidate compiled Markdown when the
transform changes. A green assertion is useful only when it observes the
changed output.

A later cold build on Node 24.21.0 failed inside V8 with
`Check failed: LookupIterator::ACCESSOR == it.state()` and exit 132 before page
generation. Node 22.18.0 completed cold root/project builds and real-browser
verification; earlier Node 24 successes and the later crash remain distinct
observations, with no established upstream cause. The spike's transitive
`undici` 8.11.2 declares Node `>=22.19.0`, so those successful Node 22.18 runs
are measured feasibility evidence, not full dependency-engine compatibility.
Production must select, pin and exercise a runtime satisfying the entire
installed dependency graph in CI. The investigation's versions and roughly
one-second local build are dated measurements, not permanent minimums or
product performance promises.
