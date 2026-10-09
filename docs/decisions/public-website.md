# Public website: canonical Markdown, static Astro and GitHub Pages

Decision of 2026-10-01 under [#611](https://github.com/schlessera/brain-kit/issues/611)
and the [launch epic](https://github.com/schlessera/brain-kit/issues/608).
The maintainer selected [framework/content option A](https://github.com/schlessera/brain-kit/issues/611#issuecomment-5938291170)
and [publishing option A](https://github.com/schlessera/brain-kit/issues/611#issuecomment-5938985608).
These rulings bind the site implementation. The maintainer’s subsequent
2026-10-09 instruction authorizes automatic website updates on relevant main
pushes and stable brain-kit release tags, superseding the separate per-artifact
publication step below. Account/visibility changes remain separate.

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
`README.md`, reference definitions, query strings and fragments.

The maintainer's 2026-10-09 documentation update selects every Markdown source
reachable from this index and the established published guides, including
linked package references, contributor guides, plans and decision records.
Following a documentation link stays on the site, including directory links
with a README. This is the index's linked reading set, not blanket publication
of every Markdown file in the repository. Preserve the seven established routes
and derive stable routes for the newly selected sources.

Selected targets become base-prefixed site links. Source code, repository
directories without a documentation index, historical revision citations and
other external destinations retain their URLs with a visible external-link
icon and an accessible destination annotation. Explicit source/edit links keep
their GitHub destinations and use the same marking. Filename-only documentation
labels become page headings on the website; canonical Markdown stays unchanged.
Derive grouped sidebar navigation from the docs index's headings and links.
Missing targets fail the build. Preserve
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

The maintainer's 2026-10-09 update selects automatic publication through
GitHub Actions after source changes merge into main and after stable canonical
brain-kit release tags. Package verification CI uses the separate ci.yml and contract.yml workflows. Website source
updates and release updates combine current website/editorial sources with the
latest stable tagged product tree and its dependency lock in an isolated
workspace. Record both commits and the exact released version, and verify npm
publication before calling it a release build. A scheduled check every 15
minutes reconciles bulk tag pushes that GitHub does not emit as tag events,
skipping builds when the deployed product/version already match. Published GitHub
Releases also trigger the update. Local development can preview workspace UI.

Regenerate product components and demo export assets before checking the built
site. Typechecks, static route/fragment/digest checks, real-browser smoke and
end-to-end checks of the embedded apps, responsive/accessibility checks and
source/provenance identity verification must succeed before artifact upload and
deployment. Preserve the working public artifact when any check fails and retain
browser traces/screenshots for diagnosis. Changes to application contracts may
require a reviewed demo adapter update; automation detects this rather than
silently substituting another UI or editing source.

Only the separate deploy job receives `pages: write` and `id-token: write`
through `github-pages`. Serialize publications. A main-only manual dispatch
allows rebuilding an earlier main commit with an optional released product tag
through the same checks. Deployment receipts identify the website source,
product source/version and final manifest hash. No per-build approval digest is
required after this authorization. Repository Pages enablement and anonymous
source access remain launch prerequisites, not actions of the build itself.

The implementation and exact trigger/input coverage are documented in
[website/README.md](../../website/README.md). GitHub's
[custom workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
govern the artifact and deployment jobs.

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
