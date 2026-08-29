# @schlessera/brain

## 0.22.0

### Patch Changes

- @schlessera/brain-render-template@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain-render-template@0.21.0

## 0.20.0

### Patch Changes

- @schlessera/brain-render-template@0.20.0

## 0.19.0

### Patch Changes

- @schlessera/brain-render-template@0.19.0

## 0.18.0

### Patch Changes

- @schlessera/brain-render-template@0.18.0

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
- 6e1fd43: Fix per-connection protocol state never reaching the WS dispatcher (declared
  protocolRev was dropped, so the rev-3 turnId-echo requirement was never
  enforced), extract the tool-view diff engine into `lib/diff.ts`, and clean up
  dead imports/variables surfaced by the new oxlint gate.
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

- Updated dependencies [a714ee1]
- Updated dependencies [ef519d1]
  - @schlessera/brain-render-template@0.17.0

## 0.16.0

### Patch Changes

- @schlessera/brain-render-template@0.16.0

## 0.15.0

### Minor Changes

- 4d3d28a: Restructure the indexer as an explicit pipeline.

  `indexAll` was a single ~990-line function inside a 1,495-line module, with
  its eight phases marked only by comment banners and `quiet` re-checked at 24
  call sites. It is now a pipeline of phases under `lib/indexer/`, each in its
  own module with a stated input and output, composed by a `run.ts` that reads
  top to bottom: scan → parse → persist → vector hygiene → assets → embeddings →
  caches → graph. Shared state travels in one `IndexRun` context that also
  carries `report`/`warn`, so no phase re-derives whether it may log.

  Behaviour is unchanged and the public surface is identical — `indexAll`,
  `getMarkdownFiles`, `getAssetFiles`, `extractWikiLinks`, `resolveWikiLink` and
  `chunkContextKey` all still come from `lib/indexer`. The split did remove one
  piece of dead code (`deletedDocIds`, collected on every run and never read) and
  gained a regression test for a rule the old shape made easy to break: a run
  that refuses to embed because the embedding provider changed must still write
  the asset descriptions it just paid for to the sidecar cache.

- 0af99c4: Export `SCHEMA_VERSION` — the brain.db schema version core writes — from the
  package entry, and make `brain doctor` read it instead of carrying its own copy
  of the number.

  The version used to be spelled out as a bare `8` in four unconnected places
  (core's schema writer, the doctor check, `ui-server`'s two read floors, and the
  integration-contract doc), so bumping it meant four silent edits and any missed
  one failed at runtime rather than at build time. Consumers reading brain.db
  directly can now import the floor they should gate on.

### Patch Changes

- @schlessera/brain-render-template@0.15.0

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

- @schlessera/brain-render-template@0.14.0

## 0.13.1

### Patch Changes

- 01004ef: Read a shared photo's own metadata before filing it

  The `share` skill now checks EXIF on an image before writing the note.

  A shared photo arrives with a name its sending app invented and metadata that is
  actually true. `DateTimeOriginal` is when the photo was TAKEN — a photo shared
  today can be years old, and dating the note "today" quietly makes the brain
  wrong about when something happened. `GPSPosition` is often the single most
  useful fact about a photo of a building, a menu, or a conference badge.

  The skill asks for the place rather than the coordinates, and says outright that
  a private location is a reason to leave it out of the note rather than a detail
  to record precisely. A screenshot carries none of these tags, and that absence
  is itself a signal about what the image is.

  `exiftool` is declared in `compatibility:` and ships in the brain-ui container
  image.

  - @schlessera/brain-render-template@0.13.1

## 0.13.0

### Minor Changes

- 2be49b8: Add the `share` skill

  Fourth phase of the Android share target: the behavior that turns a staged
  share into brain content now ships as a skill rather than living in the prompt
  the UI sends. That means how a share gets filed is editable in a content repo,
  versioned with the taxonomy, without a package release.

  It reads `meta.json`, branches on what actually arrived (a link is fetched
  because a shared title is usually the site name; an image is already attached to
  the turn; a PDF or text file is read from its staged path), looks for an existing
  home before creating a near-duplicate, moves worth-keeping binaries into the
  assets tree under a name a human would recognize, captures with `brain add`, and
  clears the staging directory even when nothing was filed.

  It carries a prompt-injection guard, and needs one more than any other skill
  here: the payload can be pushed at the app by any website, so the skill states
  that shared content is material to file and that instructions inside it are part
  of the content rather than part of the task.

  Deciding a share is not worth filing is an explicit, legitimate outcome — the
  alternative is a brain that accumulates every meme anyone ever shared at it.

### Patch Changes

- a4eb4d0: Spell control and invisible characters as escapes so grep can see the source

  `chunkContextKey` embedded raw NUL bytes as hash field separators, which makes
  grep and ripgrep classify `indexer.ts` as binary — the file silently dropped out
  of every search. `brain-markdown.tsx` had the milder version: its entity
  delimiters were runs of one, two and three literal zero-width spaces, unreadable
  in a diff and destroyable by any editor that trims whitespace.

  Both now use escape sequences. The runtime strings are byte-identical, so
  existing `.context-cache.jsonl` keys still match and no LLM-generated context is
  regenerated.

  `bun run lint` (`scripts/check-invisibles.ts`) refuses raw control and invisible
  characters in tracked files and runs in CI as the invisible-character gate.

- fc5c897: Prune sidecar cache entries nothing can reach any more

  `.asset-cache.jsonl` and `.context-cache.jsonl` are tracked, so a deleted asset
  left its generated description in the repo indefinitely: the caches are keyed by
  content, and deleting a file makes its entry unreachable rather than removing
  it. `saveAssetCache`/`saveContextCache` rebuild from the database and would
  clear it, but they only run on an `--embeddings` pass — deliberately, since they
  exclude placeholder rows and rebuilding on a keyless machine would empty the
  cache for everyone.

  Pruning by reachability is safe where rebuilding is not: it asks only whether a
  key still corresponds to something in the index, which holds regardless of
  whether this machine can generate descriptions. It now runs on every `brain
index`, and writes only when something was actually removed, so a no-op run
  still produces no git diff — the property `content-hygiene` depends on.

  Malformed lines are left alone rather than discarded. Pruning found five stale
  entries in the reference brain on its first run.

  - @schlessera/brain-render-template@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain-render-template@0.12.1

## 0.12.0

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

  - @schlessera/brain-render-template@0.12.0

## 0.11.0

### Patch Changes

- @schlessera/brain-render-template@0.11.0

## 0.10.0

### Minor Changes

- e6f55e0: Declare skill dependencies in `compatibility:`, and fix a macOS break

  The Agent Skills specification allows exactly six frontmatter keys, and
  claude.ai upload, the Skills API and the reference validator reject a skill
  carrying anything else. Ten shipped skills carried `requires:`, a brain-kit
  invention — so they could not be published through any of those surfaces.

  `compatibility` is the specification's slot for exactly that statement, and it
  reads better: prose an author can act on ("Requires git and an authenticated
  gh") rather than a bare token list. The linter now reads it, matching whole
  words so `github` does not satisfy a `git` dependency and `docker.io` does not
  satisfy `docker`. `requires:` keeps working — it is still honoured for the
  shell-command check — but now warns and names its replacement.

  Two skills still carry `disable-model-invocation:`, which no specification field
  replaces. It stays: dropping it would make `sync` — which pushes to a remote —
  model-invocable again, and that safety property is worth more than validator
  cleanliness.

  Separately, `content-hygiene` no longer depends on GNU coreutils. Its stable
  issue IDs came from `sha1sum`, which macOS does not ship, so the one skill
  designed to run unattended on a schedule failed silently there. The pipeline is
  now `{ sha1sum 2>/dev/null || shasum; }`; both print the digest first, so IDs
  match whichever exists.

- e33db75: Add a `pi` skill emitter

  The extending docs stated that "the pi family needs no emitter — pi and
  OMP-style agents discover `.agents/skills/` natively". That is not what pi does.
  pi 0.80.6 loads skills from `<agentDir>/skills` (user level — `$PI_AGENT_DIR`,
  else `~/.pi/agent`) and from `<cwd>/.pi/skills` (project level); its config
  directory name is `.pi`, and `.agents/skills/` is never consulted. A brain's
  skills were therefore invisible to pi while sitting one directory away.

  The new `pi` emitter symlinks each skill into `.pi/skills/<name>`, structurally
  identical to the `claude` emitter: relative links into the canonical
  `.agents/skills/` home, a Windows junction fallback, stale-link pruning, and
  never clobbering a real file or directory at the target path. Links rather than
  copies, so a skill keeps exactly one source of truth.

  Opt in with `skills: { emitters: ["pi"] }`. The docs are corrected.

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

- fc79a8f: Give the `sync` skill explicit autonomy rules

  A sync is frequently unattended — on a schedule, from a container, or through an
  agent runner with nobody watching. The skill did not say so, and an agent
  applying its default caution would enter a plan-and-approve mode or stop to ask
  a question, which in that setting means the sync simply never happens.

  Adds an "Autonomy — no plans, no approval" section: never plan, never ask, take
  the defined conservative default and report what was decided. It also names the
  leftover repo state a previous interrupted run can leave behind — stale unmerged
  index entries, stale `AUTO_MERGE` refs, autostash entries — as part of the job
  rather than a reason to stop, and limits the allowed leftovers to genuinely
  unresolvable items (malformed stash entries, binary conflicts, files over 100KB).

  The rules hold in an interactive session too: every decision in the skill already
  has a conservative default, so there is nothing worth stopping to ask about. This
  is consistent with the rest of the skill, which warns, flags and reports but
  never asks.

### Patch Changes

- Updated dependencies [50f6ec7]
  - @schlessera/brain-render-template@0.10.0

## 0.9.0

## 0.8.0

## 0.7.2

## 0.7.1

## 0.7.0

### Minor Changes

- b8cbf72: Knowledge-graph view: `brain graph` command and schema-v8 derived tables
  (metrics, communities, root distances, precomputed ForceAtlas2 layout) built
  at index time; `/api/graph/*` REST endpoints served from read-only brain.db
  access; a full-screen GraphPage with Clusters, Discovery, Local, and
  Maintenance modes rendered via a lazy-loaded sigma.js WebGL canvas.

## 0.6.3

## 0.6.2

## 0.6.1

### Patch Changes

- 89d8a72: Fixed: vector search silently degrading to FTS-only on a brain whose stored
  embedding identity predates provider namespacing.

  `index_metadata.embedding_model` is compared against the configured provider's
  id. The schema-v3 migration seeds that key with the bare model name from
  models.ts (`gemini-embedding-2`) — a guess, not a record of what produced the
  vectors — while providers report a namespaced id (`gemini:gemini-embedding-2`).
  The two can never compare equal, so `hybridSearch` skipped vector search on
  every query and reported "stored vectors were produced by ... run 'brain index
  --embeddings' to rebuild them".

  The state was self-locking: `brain index --embeddings` read the same mismatch
  and refused to re-embed without `--force`, and `--force` bills a full paid
  re-embed of the corpus to correct what is only a naming difference.

  `embeddingIdentityMatches()` now backs all three comparison sites (search
  engine, indexer guard, doctor): exact match, or a bare stored value that equals
  the model half of the current id. Two namespaced ids must still match exactly,
  so `openai:some-model` is never mistaken for `gemini:some-model`. The indexer
  rewrites the metadata to the namespaced form on its next run, so an affected
  brain heals itself once — with no re-embedding.

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

### Minor Changes

- 9e4668b: Add deterministic OKF v0.1 bundle export and conformance checking commands.

### Patch Changes

- e08752c: Fix three issues surfaced by migrating a real brain repo onto the published packages.

  - **User `classifierHints` no longer vanish when a module claims the same type.**
    `configuration.md` promises "modules contribute theirs; yours layer on top", but
    the first source to mention a type won outright — so enabling
    `@schlessera/brain-module-speaking` silently discarded a user's own `conference`
    vocabulary. Sources now accumulate per type; rule order still follows first
    appearance, which is what a module's position in `modules` expresses.
  - **`brain doctor` reported "no vectors stored" for healthy indexes.** The embeddings
    check counted rows in `vec_chunks` without loading sqlite-vec into that connection,
    so every query threw and the count read as zero. It now loads the extension at the
    dimension the index was built with, and distinguishes "extension unavailable" from
    "genuinely empty".
  - **Export `rerank` / `getDefaultRerankerMode`.** A retrieval-quality harness can now
    score rerank-on and rerank-off orderings from one candidate list instead of
    re-embedding the query for each variant.

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.

## 0.2.0

### Minor Changes

- rename brainform to brain-kit
