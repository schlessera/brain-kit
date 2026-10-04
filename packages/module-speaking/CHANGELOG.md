# @schlessera/brain-module-speaking

## 0.40.0

### Minor Changes

- c8e81ad: Add module dormancy, context estimates and source-preserving CLI toggles with explicit instruction ownership and legacy migration checks.
- 502d6d9: Add standalone travel with canonical journey, day-trip and place formats and a lossless configuration migration.

  Pre-1.0 break: speaking stops contributing travel taxonomy and plan-travel. Install and enable the matching travel module, migrate travelParty with `brain travel migrate`, then restart and sync skills; existing document paths, types and links are preserved.

### Patch Changes

- Updated dependencies [b1b83cd]
- Updated dependencies [e977423]
- Updated dependencies [113fa0a]
- Updated dependencies [6b311b2]
- Updated dependencies [fe5c751]
- Updated dependencies [eac3e7a]
- Updated dependencies [5df68f6]
- Updated dependencies [c926d42]
- Updated dependencies [f19da8b]
- Updated dependencies [22ed27c]
- Updated dependencies [9c830e4]
- Updated dependencies [36ad7da]
- Updated dependencies [523ffa8]
- Updated dependencies [c8e81ad]
- Updated dependencies [a39b7bc]
- Updated dependencies [4503591]
- Updated dependencies [fb992c8]
- Updated dependencies [2898ef1]
- Updated dependencies [619ee2b]
- Updated dependencies [2480efe]
- Updated dependencies [a4cc575]
- Updated dependencies [d981938]
- Updated dependencies [ac34a83]
- Updated dependencies [56a9005]
- Updated dependencies [67c7403]
- Updated dependencies [878e6cf]
- Updated dependencies [a5e1ecf]
- Updated dependencies [e977423]
- Updated dependencies [502d6d9]
- Updated dependencies [fa6a62c]
- Updated dependencies [17146c4]
  - @schlessera/brain@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies [0c19962]
- Updated dependencies [ba23fcc]
  - @schlessera/brain@0.39.0

## 0.38.0

### Patch Changes

- 7668c7c: The `codex` skill emitter now gives Codex the brain's agent contract, and stops writing files Codex never read. `brain skills sync` with `skills: { emitters: ["codex"] }` copies the body of the installed `CONTRACT.md` into `AGENTS.md` between `<!-- brain-kit:contract:start -->` and `<!-- brain-kit:contract:end -->`, and it no longer writes `.codex/prompts/`. Codex already finds skills in `.agents/skills/`. The first sync after upgrading deletes the `.codex/prompts/<name>.md` files the old "Skills index" block proves it generated, then swaps that block for the contract block in place and removes `.codex/` if it is left empty. A prompt it cannot prove it wrote stays, with a warning. If a prompt or directory cannot be inspected, deleted or removed, the index block stays so the next sync retries. With a missing, repeated or misordered marker, `AGENTS.md` is left untouched and the sync warns. With the emitter on, `/brain-init` writes `CLAUDE.md` as `@AGENTS.md` plus your overlay, so the contract loads only once.

  Manual-only skills are now manual-only for Codex too. The shipped `sync` and `new-submission` skills carry `agents/openai.yaml` with `policy.allow_implicit_invocation: false`, and `brain skills lint` warns when a skill's `disable-model-invocation` and that policy disagree. `runSkillEmitterContract` takes `readsCanonicalHome: true` for an emitter whose agent reads `.agents/skills/` itself. A `SkillEmitter` may now return an optional `warnings` list, and `brain skills sync` reports each entry prefixed with the emitter's agent.

- 1c30db2: Rendered documents get a designed default style and a component system (#530). Every `brain render` and shared PDF now uses a new stylesheet: system sans display type, an accent bar over each `h2`, hairline tables, and a full-bleed A4 page whose footer shows the title and page numbers from page 2. Designed documents are composed from `doc-*` component classes (hero, letterhead, callout, card, badge, buttons, columns, timeline, steps, checklist, stats, bars, compare, line items and more) under per-document switches (`data-accent`, `doc--editorial`, `doc--compact`), never from hand-written CSS.

  `@schlessera/brain-render-template` exports the component list and snippets (`DOCUMENT_CLASSES`, `DOCUMENT_BLOCKS`), `lintDocument`, and eight document kinds with a skeleton each under `@schlessera/brain-render-template/kinds`. A complete HTML document is no longer nested inside the shell: the stylesheet is injected into its `<head>` under the author's own rules, and `<meta name="brain-render" content="bare">` opts out. The package now depends on `parse5`, which reads documents and fragments the way the browser does. `@schlessera/brain-render-puppeteer` takes page size and margins from the document's `@page` rule. Pointing `PUPPETEER_EXECUTABLE_PATH` at `chrome-headless-shell` renders in about half the time of full Chrome.

  `brain render` adds `--kind list`, `--kind <kind> --scaffold`, `--blocks [name…]` and `--no-running-title`, and its JSON envelope adds `pages` and `warnings`. The `generate-pdf` skill is rewritten around picking a kind, scaffolding, filling and rendering until there are no warnings; `plan-travel` renders its day plans as the `itinerary` kind.

- 806d061: Archiving through `brain_update` (MCP and the pi backend) now applies the same relevance rule as `brain archive`: setting `status: "archived"` turns a `primary` or missing relevance into `historical`, and the result's `changes` lists `"relevance"`. The rule reads the effective relevance, so a `primary` passed in the same call is demoted too, and an explicit `secondary` or `historical` (in the document or in the call) stays. Before, a status edit left the document claiming `primary`, and `brain validate` then warned about a state the product had written. The rule is exported from `@schlessera/brain` as `relevanceOnArchive`. The conference-aftermath skill now archives with `brain archive` instead of setting `status: archived` by hand.
- Updated dependencies [1751c05]
- Updated dependencies [ee55f82]
- Updated dependencies [6757475]
- Updated dependencies [e2325b2]
- Updated dependencies [3c2b20e]
- Updated dependencies [3bcb130]
- Updated dependencies [8c6a3f5]
- Updated dependencies [9ce7d84]
- Updated dependencies [61d2869]
- Updated dependencies [93e12bd]
- Updated dependencies [8c97273]
- Updated dependencies [60e9fbd]
- Updated dependencies [bad7650]
- Updated dependencies [0268bf1]
- Updated dependencies [7668c7c]
- Updated dependencies [3c1310c]
- Updated dependencies [a57da97]
- Updated dependencies [25e4911]
- Updated dependencies [00391fd]
- Updated dependencies [c7aed00]
- Updated dependencies [2ed2d21]
- Updated dependencies [a554aa7]
- Updated dependencies [e499c82]
- Updated dependencies [e89de6e]
- Updated dependencies [968d151]
- Updated dependencies [1c30db2]
- Updated dependencies [995ed30]
- Updated dependencies [d176c64]
- Updated dependencies [5bef3b7]
- Updated dependencies [ff9ebc2]
- Updated dependencies [6b30469]
- Updated dependencies [5d9a179]
- Updated dependencies [55fe04c]
- Updated dependencies [a59b3b1]
- Updated dependencies [548561f]
- Updated dependencies [2fac781]
- Updated dependencies [48377ab]
- Updated dependencies [6f9ab3b]
- Updated dependencies [82f6b55]
- Updated dependencies [54b21fe]
- Updated dependencies [5b9daa4]
- Updated dependencies [2d59201]
- Updated dependencies [8e5229a]
- Updated dependencies [dd5e87f]
- Updated dependencies [d1ad02b]
- Updated dependencies [2b02102]
- Updated dependencies [97baef6]
- Updated dependencies [f82fc83]
- Updated dependencies [9c53741]
- Updated dependencies [8e84ba8]
- Updated dependencies [d4b62d3]
- Updated dependencies [acd47da]
- Updated dependencies [faba978]
- Updated dependencies [3b71a3a]
- Updated dependencies [b5bf884]
- Updated dependencies [ff023f6]
- Updated dependencies [18c4495]
- Updated dependencies [d350daa]
- Updated dependencies [e4b5251]
- Updated dependencies [51ad062]
- Updated dependencies [7e5e363]
- Updated dependencies [bc10acc]
- Updated dependencies [2025590]
- Updated dependencies [4224247]
- Updated dependencies [5b8e614]
- Updated dependencies [cc5b868]
- Updated dependencies [cb19184]
- Updated dependencies [48c4000]
- Updated dependencies [7c513fb]
- Updated dependencies [02b3d13]
- Updated dependencies [2cb91e2]
- Updated dependencies [4cdb0c3]
- Updated dependencies [806d061]
- Updated dependencies [532347f]
- Updated dependencies [02b2c85]
- Updated dependencies [803a496]
  - @schlessera/brain@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies [dd8ae8a]
- Updated dependencies [0970d31]
- Updated dependencies [b3529ac]
- Updated dependencies [5f7dbb5]
- Updated dependencies [e802456]
- Updated dependencies [acad158]
- Updated dependencies [ac94af4]
- Updated dependencies [95ef35d]
- Updated dependencies [731282f]
- Updated dependencies [2d553e2]
- Updated dependencies [fb1d784]
- Updated dependencies [4fc7f0b]
- Updated dependencies [4157941]
- Updated dependencies [0d28bae]
- Updated dependencies [f4edb02]
- Updated dependencies [af2affb]
  - @schlessera/brain@0.37.0

## 0.36.0

### Patch Changes

- @schlessera/brain@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [545f2f9]
- Updated dependencies [7a4b5af]
- Updated dependencies [cc48069]
- Updated dependencies [1ddc4bb]
- Updated dependencies [60e05c6]
- Updated dependencies [84b748c]
- Updated dependencies [8adb53d]
  - @schlessera/brain@0.35.0

## 0.34.1

### Patch Changes

- @schlessera/brain@0.34.1

## 0.34.0

### Patch Changes

- @schlessera/brain@0.34.0

## 0.33.1

### Patch Changes

- @schlessera/brain@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [54725c0]
  - @schlessera/brain@0.33.0

## 0.32.0

### Patch Changes

- @schlessera/brain@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain@0.31.0

## 0.30.1

### Patch Changes

- @schlessera/brain@0.30.1

## 0.30.0

### Patch Changes

- @schlessera/brain@0.30.0

## 0.29.0

### Patch Changes

- @schlessera/brain@0.29.0

## 0.28.1

### Patch Changes

- @schlessera/brain@0.28.1

## 0.28.0

### Patch Changes

- Updated dependencies [e381a99]
  - @schlessera/brain@0.28.0

## 0.27.0

### Patch Changes

- @schlessera/brain@0.27.0

## 0.26.0

### Patch Changes

- @schlessera/brain@0.26.0

## 0.25.0

### Patch Changes

- @schlessera/brain@0.25.0

## 0.24.0

### Patch Changes

- @schlessera/brain@0.24.0

## 0.23.0

### Patch Changes

- @schlessera/brain@0.23.0

## 0.22.0

### Patch Changes

- @schlessera/brain@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain@0.21.0

## 0.20.0

### Patch Changes

- @schlessera/brain@0.20.0

## 0.19.0

### Patch Changes

- @schlessera/brain@0.19.0

## 0.18.0

### Patch Changes

- @schlessera/brain@0.18.0

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

- Updated dependencies [210446f]
- Updated dependencies [6e1fd43]
- Updated dependencies [a714ee1]
- Updated dependencies [ef519d1]
  - @schlessera/brain@0.17.0

## 0.16.0

### Patch Changes

- @schlessera/brain@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [4d3d28a]
- Updated dependencies [0af99c4]
  - @schlessera/brain@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [59de559]
  - @schlessera/brain@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [01004ef]
  - @schlessera/brain@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [a4eb4d0]
- Updated dependencies [fc5c897]
- Updated dependencies [2be49b8]
  - @schlessera/brain@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [4281c59]
  - @schlessera/brain@0.12.0

## 0.11.0

### Patch Changes

- @schlessera/brain@0.11.0

## 0.10.0

### Minor Changes

- 683f3e3: Rewrite every skill description as a trigger, not a summary

  A skill's description is the entire triggering mechanism — it is all an agent
  sees when deciding whether the skill is relevant to what the user just asked.
  Most of these descriptions were written as summaries: they led with what the
  skill does and how it works, and appended a short "Use when …" clause at the
  end. Some had no trigger at all.

  All 24 shipped descriptions now lead with the situation that should pull the
  skill in, phrased the way a user would actually put it, with mechanism left to
  the body where it belongs. `content-hygiene`, `sync` and `talk-ideas` gained a
  trigger they never had.

  Three CI gates keep it that way: shipped skills must lint clean (no errors _and_
  no warnings), must describe when to use them, and must stay within the
  specification's 1024-character cap.

### Patch Changes

- Updated dependencies [e6f55e0]
- Updated dependencies [e33db75]
- Updated dependencies [50f6ec7]
- Updated dependencies [683f3e3]
- Updated dependencies [fc79a8f]
  - @schlessera/brain@0.10.0

## 0.9.0

### Patch Changes

- @schlessera/brain@0.9.0

## 0.8.0

### Patch Changes

- @schlessera/brain@0.8.0

## 0.7.2

### Patch Changes

- @schlessera/brain@0.7.2

## 0.7.1

### Patch Changes

- @schlessera/brain@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [89d8a72]
  - @schlessera/brain@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain@0.5.1

## 0.5.0

### Patch Changes

- @schlessera/brain@0.5.0

## 0.4.0

### Patch Changes

- @schlessera/brain@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [9e4668b]
- Updated dependencies [e08752c]
  - @schlessera/brain@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain@0.2.0
