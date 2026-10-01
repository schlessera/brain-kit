/**
 * The internal dependency-edge table — the machine-readable statement of
 * which package may depend on which, and how.
 *
 * Two consumers: tests/dependency-edges.test.ts asserts the manifests match
 * it, and tests/release-manifest.test.ts asserts the build/publish package
 * orderings are topologically consistent with it. It lives in its own module
 * (not exported from a .test.ts file) so importing it never re-registers
 * another file's tests.
 *
 * Widening it is a deliberate decision with a review trail, not a
 * fix-the-test reflex — see the failure messages in dependency-edges.test.ts.
 */

export interface Edges {
  /** Internal packages this one may list in `dependencies` (hard, always installed). */
  dependencies: string[];
  /** Internal packages this one may list only as OPTIONAL `peerDependencies`. */
  optionalPeers: string[];
}

// Keyed by npm name; values are the edges the architecture allows.
export const ALLOWED_EDGES: Record<string, Edges> = {
  // core owns the render template (the CLI's `brain render` uses it); the
  // Puppeteer renderer is heavyweight and optional, so it may never be hard.
  "@schlessera/brain": {
    dependencies: ["@schlessera/brain-render-template"],
    optionalPeers: ["@schlessera/brain-render-puppeteer"],
  },
  // Content modules extend core; concrete web imports also share scrape below.
  "@schlessera/brain-module-finance": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  "@schlessera/brain-module-images": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  // jobs fetches public boards through the polite scraping base.
  // `puppeteer-core` stays optional underneath it.
  "@schlessera/brain-module-jobs": {
    dependencies: ["@schlessera/brain", "@schlessera/brain-scrape"],
    optionalPeers: [],
  },
  "@schlessera/brain-module-speaking": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  // Approved route imports (#524/#568) fetch public geometry. Share the
  // existing robots/pacing/redirect client instead of a second scrape stack;
  // this concrete CLI job does not need the optional browser driver.
  "@schlessera/brain-module-travel": {
    dependencies: ["@schlessera/brain", "@schlessera/brain-scrape", "@schlessera/brain-geo"], optionalPeers: [],
  },
  // #525 ownership B: geo is a concrete independent library; consumers depend one way.
  "@schlessera/brain-geo": { dependencies: [], optionalPeers: [] },
  // The template remains a dependency-free internal leaf.
  "@schlessera/brain-render-template": { dependencies: [], optionalPeers: [] },
  // #558 Option B: the concrete export policy belongs to the shared template;
  // Chrome also verifies its destination text in the final media/layout.
  "@schlessera/brain-render-puppeteer": { dependencies: ["@schlessera/brain-render-template"], optionalPeers: [] },
  // The SDK's `show_block` handler rejects a link block whose address the
  // kit's link policy refuses, and it calls the kit's own `classifyLink` to do
  // it, so the handler and the card that draws the link can never disagree
  // (maintainer ruling on schlessera/brain-kit#43, D48). The edge reaches only
  // `@schlessera/brain-ui-kit/links`, which is pure and imports no React.
  "@schlessera/brain-ui-sdk": { dependencies: ["@schlessera/brain-ui-kit"], optionalPeers: [] },
  // The scraping base is infrastructure, not a content domain: it knows
  // nothing about documents, taxonomy or the index, so it must NEVER depend on
  // core. An edge here would mean scraping logic had started reasoning about
  // what it was scraping, which is the consuming module's job.
  "@schlessera/brain-scrape": { dependencies: [], optionalPeers: [] },
  // Agent backends implement the SDK seam; pi additionally embeds core.
  "@schlessera/brain-backend-claude": {
    dependencies: ["@schlessera/brain-ui-sdk"],
    optionalPeers: [],
  },
  "@schlessera/brain-backend-pi": {
    dependencies: ["@schlessera/brain", "@schlessera/brain-ui-sdk"],
    optionalPeers: [],
  },
  // #558 Option B shares the existing pure classifier through template/links,
  // with the old kit import re-exported. This leaf has no React, state or I/O;
  // the template never depends back on the kit (D46/D49).
  "@schlessera/brain-ui-kit": { dependencies: ["@schlessera/brain-render-template"], optionalPeers: [] },
  // ui-react renders the design kit's components (step 2, S5 onward): a hard
  // dependency, because the app's screens are assembled from them and its
  // stylesheet imports the kit's tokens. The kit never depends back.
  "@schlessera/brain-ui-react": {
    dependencies: ["@schlessera/brain-ui-kit", "@schlessera/brain-ui-sdk"],
    optionalPeers: [],
  },
  // ui-server drives whichever backend the deployment picks, so BOTH backends
  // are optional peers — a hard dependency on either would ship that agent SDK
  // to every install regardless of AGENT_BACKEND. The consumer (a deployment)
  // declares the backend it actually deploys.
  "@schlessera/brain-ui-server": {
    dependencies: ["@schlessera/brain-render-template", "@schlessera/brain-ui-sdk"],
    optionalPeers: ["@schlessera/brain-backend-claude", "@schlessera/brain-backend-pi"],
  },
};
