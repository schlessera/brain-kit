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
  // Content modules extend core and nothing else.
  "@schlessera/brain-module-finance": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  "@schlessera/brain-module-images": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  // jobs is the one module that fetches from the web, so it is the one module
  // allowed the scraping base. `puppeteer-core` stays optional underneath it.
  "@schlessera/brain-module-jobs": {
    dependencies: ["@schlessera/brain", "@schlessera/brain-scrape"],
    optionalPeers: [],
  },
  "@schlessera/brain-module-speaking": { dependencies: ["@schlessera/brain"], optionalPeers: [] },
  // Leaves: no internal edges at all.
  "@schlessera/brain-render-template": { dependencies: [], optionalPeers: [] },
  "@schlessera/brain-render-puppeteer": { dependencies: [], optionalPeers: [] },
  "@schlessera/brain-ui-sdk": { dependencies: [], optionalPeers: [] },
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
  // The design kit is presentational and prop-driven (D13): it holds no
  // store, does no I/O and knows nothing about the protocol, so it has no
  // internal edges at all. An edge here would mean the kit had started
  // reaching for state, which is the one thing it exists not to do.
  "@schlessera/brain-ui-kit": { dependencies: [], optionalPeers: [] },
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
