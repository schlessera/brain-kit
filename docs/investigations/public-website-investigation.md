# Public website content model

Investigation for [#611](https://github.com/schlessera/brain-kit/issues/611),
under the [launch epic](https://github.com/schlessera/brain-kit/issues/608).
The maintainer selected Astro static output and repository-controlled GitHub
Pages on 2026-10-01. The binding [decision record](../decisions/public-website.md)
captures both rulings, alternatives and implementation requirements. This
report preserves the comparison and dated measurements; it does not authorize
publication. The repeatable [local experiment](../../scripts/site-model-spike/README.md)
provides the evidence.

## Recommendation and alternatives

Use **Astro with static output**, with website code in `website/`, while
`docs/` remains the documentation's editorial source. Prefer the project's
GitHub Pages site under `/brain-kit/`, owned through this repository, with
publication explicitly authorized for a reviewed commit. Keep the default
project URL initially; selecting a custom domain is a separate ownership
choice. This recommendation combines bespoke product pages and existing
reference Markdown without introducing a server or a second component runtime
in the browser.

Registry metadata checked on 2026-10-01 identifies Astro **7.3.5**, VitePress
**1.6.4** and Eleventy **3.1.6** as their respective `latest` releases. Only
Astro was installed and executed in this investigation. Do not treat the other
two as measured builds, or the VitePress 2 prerelease documentation as evidence
for VitePress 1.

| Approach | Markdown, links and assets | Preview and maintenance | Fit for this launch |
| --- | --- | --- | --- |
| Astro 7.3.5, static output | A content collection loads existing Markdown from a selected source directory. An explicit source-to-route map and Markdown transform retain repository-relative authoring links while giving pages stable site URLs. Assets and links need the configured base prefix. | The installed CLI builds static HTML and previews it locally. Layouts, navigation and link validation are owned here; a framework upgrade needs the small proof rerun. | Recommended: the epic needs a product homepage and justified landing pages alongside the docs. Static Astro components provide that composition without hydrating a client framework. |
| VitePress 1.6.4 | Built-in Markdown tables, heading anchors and internal routing; relative image imports are handled by Vite. `index.md` has special routing, while this repo uses `README.md` indexes. Repository code/package links still need a mapping or source fallback. | Its default theme supplies navigation, sidebar, source edit links and local search. Custom marketing layouts use its Vue theme/component system. | Strongest low-effort docs-first alternative. Less suitable when the product landing pages need their own layout and the existing React kit may later supply an isolated demo. |
| Eleventy 3.1.6 | Markdown templates, layouts, permalinks and passthrough assets; the HTML Base plugin handles a deployment prefix. Repository `.md` to site route conversion remains project logic. | Small static template model and local serving, but the project must assemble documentation navigation, heading conventions and source links. | Credible lightweight alternative. Astro's content/routing model and optional framework integration are a closer fit to mixed product and docs pages. |

These capabilities are documented in Astro's
[content collections](https://docs.astro.build/en/guides/content-collections/)
and [base configuration](https://docs.astro.build/en/reference/configuration-reference/#base),
the stable VitePress 1
[Markdown](https://vuejs.github.io/vitepress/v1/guide/markdown),
[asset](https://vuejs.github.io/vitepress/v1/guide/asset-handling) and
[theme](https://vuejs.github.io/vitepress/v1/reference/default-theme-config) guides,
and Eleventy's [Markdown](https://www.11ty.dev/docs/languages/markdown/),
[configuration](https://www.11ty.dev/docs/config/) and
[HTML Base plugin](https://www.11ty.dev/docs/plugins/html-base/) guides.
The fit judgments in the last column are this investigation's recommendation.

For accessible navigation, Astro and Eleventy require this project to own the
semantic navigation, skip link, reading order, current-page indication and
keyboard/mobile behavior. VitePress supplies a default docs navigation layout,
but its presence is not an accessibility measurement. In each approach,
#612/#615 must exercise the actual designed pages in a browser; framework
choice alone cannot establish that acceptance. The experiment proves ordinary
named links and a working disclosure, not the final navigation design.

Astro 7 changed its default Markdown pipeline. The experiment explicitly
installs `@astrojs/markdown-remark` **7.3.1** and selects `unified()` through
`markdown.processor` to run the link transform. This uses the current
[supported processor configuration](https://docs.astro.build/en/reference/configuration-reference/#markdownprocessor),
not the deprecated top-level `markdown.remarkPlugins` option. Astro's installed
manifest requires Node **22.12 or newer**; the proof used Node 24.21.0 and Bun
1.3.14 for the existing repository dependencies. Pin the chosen tool and lock
its dependencies in implementation rather than copying a remembered version.

## One editorial source and stable routes

`docs/README.md` remains the documentation navigation source: Get started,
Guides, Reference and Working on brain-kit. Derive documentation navigation
from its links; do not maintain a competing hand-written sidebar. Marketing
copy belongs to `website/` and links into these guides instead of copying their
installation/configuration instructions. Package references retain their
package README as source. No website copy should imply the hosting template is
published or that pre-1.0 interfaces are stable.

Use an explicit publication manifest mapping selected source files to routes.
For example, `docs/README.md` maps to `/docs/`, `docs/quickstart.md` to
`/docs/quickstart/`, and `docs/hosting/README.md` to `/docs/hosting/`.
Package README pages can use `/docs/modules/<module>/`. Site `/` and any
approved landing paths come from #612's page design. Paths in this document
are relative to the configured base; under the recommended project prefix,
quickstart becomes `/brain-kit/docs/quickstart/`.

Do not publish every Markdown file merely because it exists. Keep process,
design plans, decision records and source files on GitHub unless intentionally
selected. Source links on published pages identify the source file at the
built commit; an edit link may target `main`. A file rename preserves its
published route through the manifest. A deliberate route change provides a
static redirect page and updates navigation, links and canonical metadata;
GitHub Pages cannot supply arbitrary server redirect rules.

Resolve Markdown links relative to the **source file**, including `README.md`,
reference definitions, query strings and heading fragments. Mapped documents
become base-prefixed site links; valid unselected repository files/directories
become GitHub source/tree links. Missing targets fail the build. Preserve
external URLs. Production validation also covers raw HTML links, published
fragment targets, encoded paths, collisions and approved assets; the narrow
experiment is not a complete link checker. Use GitHub-compatible heading IDs
so existing Markdown fragments keep their meaning.

Images referenced by docs remain beside their editorial source or in an
approved shared asset directory. The build imports/copies them once and
rewrites their URLs. Curated generated feature captures remain distinct from
visual-regression baselines, with the recipe and provenance defined by
#613–#615. Keep local fonts and assets bounded and reviewable. This experiment's
small SVG is a link-path fixture, not a screenshot of a shipped feature.

## Local measurements

The pinned experiment loads seven unmodified current docs directly from the
repository and one Odysseus sample with nested links, a relative image, a GFM
table, a code fence and a native HTML disclosure. It does not stage a second
editable docs tree or require adding site frontmatter to the existing docs.

Both `/` and `/brain-kit/` builds generated eight pages. Real Chrome navigation
verified nonempty document content, source links, seven sample link targets,
live heading fragments, a decoded 300px SVG, the populated table, code text and
the working disclosure. Generated pages contain no browser script elements.
These measurements establish content/link feasibility, not final visual design,
accessibility, site search or launch readiness.

Removing the base prefix from document-link rewriting made the real browser
check fail at `Resolved Quickstart`: the observed URL began `/docs/` instead of
`/brain-kit/docs/`. A separate image-prefix mutation reached the image assertion after the link
checks passed: `/assets/experiment-route.svg` lacked `/brain-kit/`. Both
mutations were restored and the final browser check passed. A warm collection
cache initially retained output from the preceding transform: that image
receipt was discarded because it failed at the earlier link assertion. The
experiment clears its own collection cache before every build, and the two
mutations were repeated successfully from fresh caches. Production builds
must similarly avoid retaining compiled Markdown across transform changes.
The measured subpath build completed in about one second on the local machine;
that is a spike observation, not a product performance claim.

One later cold root build on Node 24.21.0 terminated inside V8 with
`Check failed: LookupIterator::ACCESSOR == it.state()` and exit 132, before
page generation. This was not an assertion about the website. Node 22.18.0,
which satisfies the installed Astro engine requirement, completed the cold
root build and browser verification. The earlier successful Node 24 runs and
this crash are retained as separate evidence; no upstream cause is established.
The reproduction instructions identify the measured Node 22 runtime. The
production implementation must pin and verify its own build runtime in CI.

A fresh install during the decision handoff also reported that transitive
`undici` 8.11.2 requires Node `>=22.19.0`. Its installed manifest confirms that
requirement. The successful Node 22.18.0 runs establish the measured sample's
behavior, not compatibility with every dependency's declared engine. Select a
production runtime against the entire pinned dependency graph, not only
Astro's minimum.

## Implementation and publishing boundary

#612 implements the selected static site and its page design after the ruling.
The website is a private development/build project outside the published
package workspaces, produces `website/dist/`, and is omitted from npm release
lists. No brain package gains a runtime dependency on the site framework.
Use one root build/check entry point so contributors and CI run the same
frozen dependency install, content/asset integration and static build. #615
owns the final launch checks; #625 precedes accepted final CLI example output
and feature captures. #616 still decides visitor feedback/data collection.
This recommendation adds no tracking, contact form or hosted brain service.

GitHub documents [Pages eligibility](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
for public repositories on Free, and private repositories on eligible paid
plans. Check the repository visibility and owner's eligibility before enabling
Pages; intended open-source status is not proof of current eligibility. The
maintainer controls repository Pages settings, the canonical project URL and
publication authorization. Source links must be publicly readable at launch.
No visibility change, account purchase, DNS change or Pages setup is performed
by this investigation.

The proposed update procedure is:

1. Edit canonical Markdown or approved website source/assets in a PR. Build
   locally and review the affected pages at both root and project-prefix bases.
2. CI builds an artifact for the exact PR commit and checks links, fragments,
   source mappings, approved capture freshness, leakage and the required browser
   accessibility/responsive behavior. Supply the built HTML and an artifact
   manifest with source SHA, lock hash, tool versions, base and asset/recipe
   provenance. Review that artifact; a green build alone is not launch review.
3. Merge the reviewed change. Build and validate the exact selected commit on
   main, and review the artifact's manifest and pages before publication.
4. After separate authorization for that commit, dispatch publication of that
   validated artifact. The workflow validates the commit/artifact identity,
   uploads the static Pages artifact and deploys it in a separate job using
   the `github-pages` environment. Build jobs need repository read access;
   deployment needs `pages: write` and `id-token: write`, as described in
   GitHub's [custom workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
   Merging a PR does not automatically publish.
5. Verify the reported deployment's commit and public page, nested deep link,
   image and source link. Keep that receipt on the publishing issue. To roll
   back, validate and explicitly authorize the previous known-good commit's
   artifact through the same procedure.

A PR artifact can be downloaded and served locally for review; a public preview
service is unnecessary. The experiment's commands are demonstrably executable;
these production build, CI and publication commands are implementation
requirements for #612/#615, not a claim that a publishing workflow exists now.
The maintainer selected this repository-controlled publishing path. Changing
that choice requires a new concrete ownership ruling; do not create a
publishing-provider interface for this single project site.
