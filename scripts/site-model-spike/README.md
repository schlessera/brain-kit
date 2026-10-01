# Local website content-model experiment

Reproducible evidence for #611. This is a private, standalone development
project outside the published workspaces. It reads existing `docs/` Markdown
in place and emits eight static pages into `dist/site/`. It is not the public
site, a feature demo, a finished design or a deploy command.

The installed/pinned Astro 7.3.5 requires Node >=22.12. The final proof used
Node 22.18.0; select it with your Node version manager for these commands. A
later Node 24.21.0 cold build crashed in V8, after earlier successful runs;
that failure is retained in the investigation rather than counted as a pass.
Install the repository
with Bun to supply its pinned Playwright, then install this experiment from its
separate npm lockfile. A local Chrome is required for browser verification;
`verify.mjs` uses `/usr/bin/google-chrome` on the measured Linux environment.

From the repository root:

```sh
bun install --frozen-lockfile
npm ci --prefix scripts/site-model-spike --ignore-scripts --no-audit --no-fund
npm --prefix scripts/site-model-spike run build
npm --prefix scripts/site-model-spike run preview -- --port 43811
node scripts/site-model-spike/verify.mjs http://127.0.0.1:43811 /brain-kit/
npm --prefix scripts/site-model-spike run preview -- stop

SITE_SPIKE_BASE=/ npm --prefix scripts/site-model-spike run build
SITE_SPIKE_BASE=/ npm --prefix scripts/site-model-spike run preview -- --port 43811
node scripts/site-model-spike/verify.mjs http://127.0.0.1:43811 /
SITE_SPIKE_BASE=/ npm --prefix scripts/site-model-spike run preview -- stop
```

Astro 7's preview starts a background server in this agent environment; stop
it explicitly. A build for a different base needs a fresh preview process.
`SITE_SPIKE_BASE` defaults to `/brain-kit/` and accepts a slash-delimited base
path. It is experiment configuration, not brain package configuration.

`model.mjs` defines the bounded source/route and image mappings. The configured
remark processor resolves links from each original source path, maps selected
Markdown to site routes, preserves query/fragment suffixes, and points valid
unselected files/directories at GitHub. A collection's file IDs retain their
repository paths, including `README.md`. The Markdown itself is not copied or
rewritten. Each build clears its own collection cache: changing an imported
transform does not change the Markdown digest and otherwise retained stale
compiled URLs during this experiment. The one SVG is an explicitly fictional image-path probe.

Browser verification checks populated content and source links on all eight
pages, follows the sample's internal links and real fragments, checks its
external source targets without network requests, decodes the SVG, and
exercises the GFM table, code fence and native disclosure. No browser scripts
are emitted. Breaking the document/image base prefix independently must fail
the named link/image assertion; restore mutations before retaining results.

The experiment deliberately does not implement production navigation, raw-HTML
link rewriting, complete fragment/link validation, search, responsive styling,
accessibility acceptance, capture provenance or publishing. The
[investigation](../../docs/public-website-investigation.md) describes the
recommended implementation boundary and publishing procedure for review.
