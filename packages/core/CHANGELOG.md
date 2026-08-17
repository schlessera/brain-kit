# @schlessera/brain

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
