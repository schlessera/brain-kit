# @schlessera/brain-module-images

## 0.38.0

### Minor Changes

- d350daa: Transient output now has a place inside the brain: the scratch area, `.brain/scratch/`. `brain render --scratch` and `brain image --scratch` write there, under a name unique to each run, and so does `brain render -` without `--out`. The chat UI can open anything written there, it is never committed, indexed or exported, and it is pruned after 7 days or past 1 GB (after each of these writes, by `brain maintain`, hourly by the chat server, and by the new `brain scratch clean|prune`). Nothing writes there until git excludes the directory itself (`brain doctor --fix` adds the line, new brains have it from the template, and outside a git repository the line is required all the same, read by git), nothing is written to or pruned from a `.brain` or `.brain/scratch` that is a symlink, and every write goes to a temporary sibling renamed onto its name, so it never writes through a planted link. That covers every one of brain's own transient writers, wherever it is pointed: `brain render --out`, `brain image --out`, `brain okf export --out`, and a mask requested beside a draft in scratch, which now prunes like the others.

  Behaviour change: `brain render --out`, `brain image --out` and `brain okf export` never write through a symlink any more: a target whose entry is a link is refused, and every write goes to a temporary sibling renamed onto the name. `brain render` and `brain image` no longer accept paths under the system temp directory. A file there could not be opened from the UI. Use `--scratch` instead. `resolveWritable` now returns the path or `null`.

  `brain scratch clean|prune --json` reports `failed: [{ path, reason }]` (additive) for files the OS would not remove, and exits 2 when there are any; `brain maintain` reports its scratch step as failed the same way. A replaced output file keeps its mode. `BrainUiApp.close()` now returns a promise that resolves once the scratch prune pass in flight, if any, has been killed and has exited; await it before tearing down.

### Patch Changes

- 4224247: Source comments, the `BRAIN_UI_CHROME_NO_SANDBOX` description, and the `generate-pdf` and `image-gen` skills no longer describe one particular deployment. They say what a deployment may or may not have instead.
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

- 210446f: Unify boolean environment parsing across all packages: every boolean variable
  now accepts 1/true/on/yes and 0/false/off/no (case-insensitive, trimmed), and
  an unset, empty, or unrecognised value falls back to the variable's documented
  default instead of being misread. Defaults and directions are unchanged;
  previously `"1"`-only flags (the Chrome sandbox switches, `TRUST_PROXY`,
  `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`,
  `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`) accept the full truthy set, and the disable
  set for `BRAIN_UI_REVERSE_GEOCODE` / `BRAIN_UI_MODEL_DISCOVERY` gains `no`.
  `NO_COLOR` keeps its presence-based contract. Published descriptor types
  (`ENV_VARS` shapes) are unchanged.
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

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
  - Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
    (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
    two differently-configured apps coexist in one process.
  - Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
    `schema_version`; `assertBackendResolvable` refuses to boot when the selected
    agent backend is not installed.
  - Changed: `@schlessera/brain-backend-claude` is an optional peer of
    `ui-server`, not a dependency — a deployment declares the backend it uses.
  - Changed: the module contract carries the config generic through
    `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
    longer casts a value the loader already validated.
  - Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
    around client construction.
  - Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
    `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
    namespace and the `getBackends`/`getBackendsInfo` module functions — their
    replacements live on the app handle.

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

- be0a624: Correct the image-model capability strings so they say what the evidence says.

  `evidence.ts` retracted two vendor-sourced claims and fixed routing accordingly,
  but the user-facing half was left behind: `brain image models` still printed
  "Nano Banana Pro — strongest text rendering, 5-character consistency", and the
  `strongTextRendering` flag still marked every Gemini model true and both OpenAI
  models false. Anyone reading the command output got the retracted version.

  - The `strongTextRendering` flag now carries the measured direction —
    `gpt-image-2` true, every Gemini model false. It fed only `strongestFirst()`,
    which already reached the same order by price within a provider, so no routing
    decision changes.
  - Model summaries state each model's actual role: `gpt-image-2` the default that
    leads the arenas, `gpt-image-1.5` the transparency-only fallback,
    `gemini-3-pro-image` a fallback that scores below Flash at twice the price,
    `gemini-3.1-flash-lite-image` the `--draft` tier.
  - `tests/providers.test.ts` guards both, so a retracted claim cannot re-enter the
    copy while routing stays correct.
  - @schlessera/brain@0.12.1

## 0.12.0

### Minor Changes

- 45e2008: Route on measured evidence instead of vendor documentation, and stop asking

  The router's tie-break was "no vendor publishes a head-to-head, so ask the
  user". That is true of vendors and false of the field: public preference arenas
  carry millions of votes, and checking them overturned two rules this module
  shipped with.

  - **In-image text routed to Gemini. That was backwards.** The rule reasoned
    from documentation — Google documents text rendering as a strength, OpenAI
    documents nothing — but vendor silence is not weakness. arena.ai has a
    dedicated text-rendering board and `gpt-image-2` leads it by ~130 Elo, its
    widest category margin.
  - **Character consistency claimed a Gemini win it cannot support.** No
    independent benchmark for identity preservation exists, and Google's own
    model card scores character editing as a tie inside the error bars. The rule
    now narrows to models that document the capability and lets the default
    decide, rather than asserting a winner.
  - **Ambiguity now resolves.** A request with no capability signal takes the
    highest-ranked available model and says so, instead of stopping to ask.
    `preferredModels` in the module config overrides it.
  - **The Gemini default is Flash, not Pro.** Pro costs twice as much and scores
    below Flash on both arenas. Price was being used as a proxy for quality; it
    is not one.
  - **`--draft` now names its model** rather than searching for the cheapest
    survivor: a quick throwaway illustration is `gemini-3.1-flash-lite-image` at
    about $0.03, because "cheapest thing that happens to fit" and "good quick
    sketch" are not the same question.

  The shipped policy is three named cases — quality to `gpt-image-2`,
  transparency to `gpt-image-1.5`, throwaway work to
  `gemini-3.1-flash-lite-image` — with everything else as fallback only.

  The ordering, its sources, its as-of date, and the claims that did NOT survive
  checking all live in `src/evidence.ts` — including the widely-repeated "Nano
  Banana Pro beats GPT-Image on text rendering", which is Google's own eval
  against GPT-Image **1**, five months before gpt-image-2 existed.

### Patch Changes

- 4281c59: Fix three things a real session on a phone turned up

  - **Images written into the brain did not display in chat.** The markdown
    renderer overrode headings, code and links but not `img`, so
    `![](assets/images/x.png)` resolved against the app origin and 404'd — the
    bytes are served by the files API. Repo-relative sources are now rewritten to
    that endpoint; `data:` URIs and absolute URLs pass through untouched.
  - **Scratch files had nowhere to go.** `brain render` and `brain image` refused
    any path outside the repo, which pushed intermediates — an HTML file that
    exists to be rendered two seconds later — into a knowledge base as git noise.
    Both now also accept paths under the system temp directory, report them
    absolute, and say that a file written there is not viewable in a UI. Anywhere
    else is still refused: this is scratch space, not free rein.
  - **The generate-pdf skill refused documents over 400 KB**, citing a file-viewer
    download limit that does not exist. The real ceiling is the file server's
    (10 MB, both the preview and raw paths); below that, size is a judgement call
    about the reader's connection. The skill no longer refuses to produce a
    document for being over an invented figure.

  Also corrects a comment on `FILE_SIZE_CAP_BYTES` claiming the `?raw=1` path was
  unbounded. It is not — `resolveForRaw` enforces the same cap, which is why
  raising it to 10 MB mattered for images and PDFs in the viewer too.

- Updated dependencies [4281c59]
  - @schlessera/brain@0.12.0

## 0.11.0

### Minor Changes

- bf7aaf7: New module: image generation and editing, routed by capability

  Adds `brain image` and an `image-gen` skill. Two providers over plain `fetch`
  — no vendor SDKs, because the deployment container has bun and nothing else.

  Routing is capability-driven rather than a configured default. A mask, a
  transparent background, PNG output or an exact pixel size can only be served by
  OpenAI; in-image text, character consistency and large reference sets are
  documented Gemini strengths. Where nothing in the request settles it, the
  command stops and asks instead of guessing — no vendor benchmark decides
  general image quality, and guessing spends real money. Quality is the default
  bias; cost is always reported, `--draft` opts into the cheapest fit, and
  `--dry-run` prices a decision without spending.

  `--aspect` and `--resolution` work on every model: Gemini takes its ten fixed
  ratios and resolution buckets directly, while OpenAI, which has no aspect
  parameter, gets the ratio converted to exact pixels on its 16-pixel grid.

  Three things in the capability table came from calling the APIs rather than
  reading their docs, via the opt-in live suite
  (`BRAIN_IMAGES_LIVE=1`, ~$0.35, never in CI):

  - every Gemini image model rejects `image/png` and serves JPEG only
  - Gemini returns image bytes inside `steps[].content[]`, not the `output_image`
    field the Interactions API reference documents
  - `gpt-image-1.5` rejects the custom sizes `gpt-image-2` accepts, taking only
    1024x1024, 1536x1024 and 1024x1536

### Patch Changes

- @schlessera/brain@0.11.0
