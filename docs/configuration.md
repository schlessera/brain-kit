# Configuration

`brain.config.ts` is the single source of truth for your brain's shape:
its taxonomy, providers, and enabled modules. This page documents every key.

The file default-exports `defineConfig({...})`. `defineConfig` is a typed
identity helper — it gives you autocomplete and type-checking while you edit;
validation happens when the config is loaded, against a zod schema. `brain
validate` runs config validation first and refuses on schema errors.

```ts
import { defineConfig } from "@schlessera/brain";

export default defineConfig({
  profile: { name: "Alex Example", cliTitle: "Alex Example's knowledge base" },
  taxonomy: { /* … */ },
  embeddings: { provider: "gemini" },
  modules: { "@schlessera/brain-module-speaking": {} },
});
```

A brand-new brain works with an almost-empty config: the four core types
(`identity`, `context`, `note`, `index`) are built in, so `defineConfig({})` is
valid. Everything below is optional and additive.

## `profile`

Cosmetic identity for the CLI.

| Key        | Type     | Default | Notes                          |
| ---------- | -------- | ------- | ------------------------------ |
| `name`     | `string` | —       | Your name.                     |
| `cliTitle` | `string` | —       | Shown in `brain --help`.       |

```ts
profile: { name: "Alex Example", cliTitle: "Alex Example's personal knowledge base" }
```

## `taxonomy`

The heart of the config: types, directory anchors, canonical documents, and the
rules that keep the corpus tidy. All keys are optional. See
[concepts.md](concepts.md) for the model.

### `taxonomy.types`

A record mapping a **type name** to its spec. Type names must match
`^[a-z][a-z0-9-]*$` (lowercase, digits, hyphens; starting with a letter).

You can add new types and override core/module types here.

```ts
taxonomy: {
  types: {
    project: {
      dir: "projects/active",     // canonical creation directory
      match: ["projects/"],       // path prefixes counted as this type
      staleDays: 90,
      staleSeverity: "warning",
    },
    expertise: { dir: "expertise" },
    opinion:   { dir: "opinions" },
  },
}
```

Each type spec (`TypeSpec`) accepts:

| Key             | Type                              | Default                     | Meaning                                                                                                    |
| --------------- | --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `dir`           | `string \| null`                  | *(required)*                | Canonical directory new docs of this type are created in. `null` = any directory; directory checks are skipped. |
| `match`         | `string[]`                        | `[dir]`                     | Path prefixes counted as this type. Longest matching prefix wins during path-to-type inference.            |
| `staleDays`     | `number` (positive int)           | —                           | Staleness threshold in days for docs under this type's dir.                                                 |
| `staleSeverity` | `"error" \| "warning" \| "info"`  | `"warning"` when `staleDays` set | Severity of staleness findings.                                                                       |
| `inbox`         | `boolean`                         | `false`                     | This type's dir is the quick-capture inbox (`brain add`'s default target). **Exactly one type must set this.** |
| `orphanExempt`  | `boolean`                         | `false`                     | Exempt from the "no wiki-links point here" orphan audit.                                                    |
| `appendMatch`   | `boolean`                         | `false`                     | `brain add` content titled exactly like an existing doc of this type appends into it instead of creating a new file. |
| `halfLifeDays`  | `number` (positive int)           | `staleDays`, else `365`     | Search recency half-life: a doc of this type loses half its recency boost per `halfLifeDays` since its `updated` date. |
| `mergeStrategy` | `"synthesize" \| "table-union" \| "timeline-append" \| "keep-both" \| "latest-wins-additive" \| "code-merge" \| "cache-union"` | chosen from the file | How `brain sync` merges a document of this type that both sides changed. See [`sync`](#sync). |

Search's heuristic reranker multiplies each result's score by a recency factor
between 0.7 (very old) and 1.0 (updated today), and `halfLifeDays` sets how fast
a type moves between them. A 30-day half-life gives a 30-day-old document 0.85.
Give volatile types a short half-life and durable ones a long one. The core
types ship with their own: `context` 30, `note` 60, `index` 365, `identity`
1095. Overriding a core type keeps its half-life unless you set
`halfLifeDays` again.

Upgrading from 0.37 or earlier: the reranker used to carry a built-in table
of half-lives for type names like `project` (180 days), `travel` (60),
`conference` (90), `career` (180), `infrastructure` (545), `opinion` and
`expertise` (730). That table is gone. A type of yours with one of those names
now decays over its `staleDays`, else 365 days, so set `halfLifeDays` on it to
keep the old ranking.

Three core types set `mergeStrategy`: `identity` is `latest-wins-additive`,
`note` is `keep-both`, and `index` is `table-union`. Overriding a core type
keeps its strategy unless you set `mergeStrategy` again. What each strategy
does, and how a file without one gets its strategy, is under [`sync`](#sync).

### `taxonomy.dirAnchors`

Filenames a directory wiki-link (`[[some/dir/]]`) resolves to, in order. Core
always includes `_index.md`; modules append their own (the speaking module adds
`status.md`, `itinerary.md`, `outline.md`). Yours are added last.

```ts
taxonomy: { dirAnchors: ["overview.md"] }   // tried after _index.md and module anchors
```

Default: `["_index.md"]`.

### `taxonomy.canonical`

Well-known document paths that features look up by name (e.g. briefings and
context assembly read `identity` and `currentFocus`). Features degrade
gracefully — they skip the relevant section — when a canonical path is unset or
the file is missing, which is why fresh templates work.

| Key            | Default                      |
| -------------- | ---------------------------- |
| `identity`     | `me/identity.md`             |
| `currentFocus` | `context/current-focus.md`   |

Set a key to `""` to disable it. You may add your own canonical keys.

```ts
taxonomy: { canonical: { currentFocus: "" } }   // disable the current-focus lookups
```

### `taxonomy.canonicalPolicy`

A size budget and a review cadence per canonical key, which `brain audit`
checks. They matter for the documents every session reads first.

| Field        | Type             | Means                                                                          |
| ------------ | ---------------- | ------------------------------------------------------------------------------ |
| `maxTokens`  | `number \| null` | Estimated tokens (characters ÷ 4) above which the document is a `budget` warning |
| `reviewDays` | `number \| null` | Days (1 to 3650) after `updated` at which the document is a `review-overdue` warning, unless its `next_review` is still ahead |

The only default is `currentFocus: { maxTokens: 1000 }`. Entries merge field
by field over the default, so `{ currentFocus: { reviewDays: 14 } }` keeps
the 1,000-token budget, and `null` unsets a default field:

```ts
taxonomy: { canonicalPolicy: { currentFocus: { maxTokens: null, reviewDays: 14 }, identity: { maxTokens: 1500 } } }
```

A canonical document with a policy entry is also scanned for `past-date`
warnings: a line naming a `YYYY-MM-DD` day before today, outside code blocks
and inline code as a GFM parser reads them.
Any non-archived document whose `next_review` has passed is `review-overdue`,
policy or not.

### `taxonomy.propagation`

Declares that some documents are derived from a canonical source and must not
lag behind it. `brain audit` flags a derivative older than its source.

```ts
taxonomy: {
  propagation: [
    { source: "me/bios/FACTS.md", derivatives: "me/bios/*.md", severity: "warning" },
  ],
}
```

| Key           | Type                             | Meaning                                            |
| ------------- | -------------------------------- | -------------------------------------------------- |
| `source`      | `string`                         | Exact path of the canonical source document.       |
| `derivatives` | `string` (glob)                  | Glob for documents that derive from the source.    |
| `severity`    | `"error" \| "warning" \| "info"` | Optional finding severity.                          |

### `taxonomy.facts`

Declares facts that documents restate, so `brain audit` can catch a copy that
drifted. The value lives in the source document's `facts:` frontmatter map; the
config says where that is and how the fact is phrased elsewhere.

```ts
taxonomy: {
  facts: {
    ranger_since: { source: "me/basics/FACTS.md", patterns: ["ranger at .{0,80}? since (\\d{4})"] },
  },
}
```

```yaml
# me/basics/FACTS.md
facts: { ranger_since: 2019 }
```

| Key        | Type       | Meaning                                                                                  |
| ---------- | ---------- | ---------------------------------------------------------------------------------------- |
| `source`   | `string`   | Exact path of the document whose `facts:` frontmatter holds the canonical value.          |
| `patterns` | `string[]` | Regular expressions, matched case-insensitively, each with exactly one capture group: the value. |

Every non-archived markdown document other than the source is scanned outside
its code. A captured value that differs from the canonical one (compared after
trimming, and as numbers when both are numbers) is a `fact-drift` warning, once
per document per fact. A document that is right to state an old value, such as
a retrospective, lists the key under `facts_ignore: [ranger_since]`. A pattern
that does not compile, or that has other than one capture group, fails config
load with a message naming the fact. Drift is reported, never rewritten.

### `taxonomy.assetTitleRules`

Human titles for binary assets (images, PDFs) based on where they live. Two
shapes; your rules take precedence over module rules.

```ts
taxonomy: {
  assetTitleRules: [
    { prefix: "me/media-kit", label: "Media Kit" },              // dir-prefix rule
    { pattern: "talks/*/slides/**", label: "Slide", slugFrom: 1 }, // dir-glob rule
  ],
}
```

- **Prefix rule** — `{ prefix, label }`: assets whose directory starts with
  `prefix` are titled `"<label>: <filename>"`.
- **Glob rule** — `{ pattern, label, slugFrom? }`: `pattern` is a glob over the
  asset's directory (`*` = one segment, `**` = any depth). `slugFrom` is a path
  segment index appended in parentheses (e.g. the talk slug) → `"Slide: cover (my-talk)"`.

### `taxonomy.classifierHints`

Keyword/phrase lists per type, compiled to word-boundary regexes and used to
guess a type during heuristic capture. Modules contribute theirs; yours layer on
top. Hints for an unknown type are a validation error.

```ts
taxonomy: {
  classifierHints: {
    project: ["sprint", "milestone", "roadmap"],
  },
}
```

### `taxonomy.defaultStaleness`

Staleness applied to documents whose type has no explicit `staleDays`.

```ts
taxonomy: { defaultStaleness: { days: 180, severity: "info" } }
```

Default: `{ days: 180, severity: "info" }`.

### `taxonomy.tags`

The tag vocabulary you mean to use, and how strictly to hold the corpus to it.
[`brain tags`](cli.md#index--quality) reads it to report variants and drift, and
`brain validate` warns against it. Only `brain tags --apply` rewrites a
document's tags: it applies every `aliases` entry and every variant group whose
canonical tag is in `vocabulary`, editing just the tag entries. An alias
always wins over a variant group: an alias target is never renamed by a
group, and an alias chain that loops is reported and left alone. Every key
is optional, and without the block both commands still work: `brain tags`
reports variant groups and redundant tags, and `brain validate` checks only a
tag's format.

```ts
taxonomy: {
  tags: {
    vocabulary: ["astronomy", "hiking", "woodworking"],
    aliases: { "wood-working": "woodworking", scope: "telescope" },
    redundant: "warn",
    inflection: "en",
  },
}
```

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `vocabulary` | `string[]` | none | The tags you mean to use. It makes one of them the proposed canonical tag of a variant group. `brain tags` lists the tags outside it with their use counts, and `brain validate` warns on each one. |
| `aliases` | `Record<string, string>` | none | Old tag → canonical tag. `brain tags` lists the documents that still carry an old tag, and `brain validate` warns with "use `<canonical>`". A tag cannot alias itself. |
| `redundant` | `"warn" \| "off"` | `"warn"` | Report tags equal to the document's `type` or to a directory of its path. They add no information the path does not already carry. |
| `inflection` | `"en" \| "off"` | `"en"` | Group English singular/plural pairs (`trail`/`trails`, `story`/`stories`). Set `"off"` for a vocabulary in another language. |

Every entry is a tag the way `brain validate` wants it: lowercase, no spaces.

Two tags form a **variant group** when they reduce to the same key: lowercase,
`-` and `_` stripped, and (with `inflection: "en"`) a simple English singular
(`-ies` to `-y`, `-es` after `s`/`x`/`z`/`ch`/`sh`, then `-s`, keeping a stem of
at least three letters). Keys also join when they are a small spelling distance
apart: at most one edit for 5-7 characters, at most two for 8 or more, where
swapping two neighbouring letters is one edit. Lengths and edits count
characters, whatever the script. Distance never joins keys containing digits in
any script (`q1-2026`/`q2-2026`). It also never joins a key to one that merely
extends it (`trade`/`trader`), because an ending is inflection's call. Every
member of a group is within reach of every other, so a third tag cannot chain
two that the rules keep apart: `tradre` does not put `trade` and `trader` in one
group.
The proposed canonical tag is a `vocabulary` member when the group has one,
otherwise the most-used tag, then the shorter, then the first alphabetically.

## `exclude`

Paths the indexer ignores. Your entries are **added to** the built-in defaults,
never replace them.

| Key        | Type       | Built-in default                                                                                  |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `dirs`     | `string[]` | `.git`, `node_modules`, `.claude`, `.agents`, `scripts`, `logs`, `tmp`, `workspaces`, `okf-dist`, `.brain/scratch`, `evals` |
| `files`    | `string[]` | `CLAUDE.md`, `README.md`, `AGENTS.md`                                                              |
| `segments` | `string[]` | *(none in core; modules may add — e.g. speaking excludes `alt-decks`, `versions`, `deck`)*        |

- `dirs` — a directory, as a path relative to the brain root, is excluded along
  with everything under it. An entry is matched against each file's relative
  path as a whole leading path: `drafts` excludes `drafts/a.md` and
  `drafts/deep/b.md`, but not `drafts-old/a.md`. A leading `./` and a trailing
  `/` are stripped when the config loads, so `drafts`, `drafts/` and `./drafts`
  all mean the same directory. Before 0.37.0 only the first spelling worked; the
  other two excluded nothing. An entry that is empty once stripped (`./`, `/`) is
  ignored.
- `files` — an exact relative file path. A trailing `/` is rejected during
  configuration loading, with the offending field/value and a suggestion to
  use `dirs`. Change `files: ["drafts/"]` to `dirs: ["drafts"]` if the whole
  directory should be excluded. Exact file rules never prune directories.
- `segments` — any path containing this directory segment at any depth.

```ts
exclude: { dirs: ["drafts"], segments: ["private"] }
```

Separately from `exclude`, the indexer leaves out **images and PDFs that git
ignores** (`.gitignore`, `.git/info/exclude`, your global excludes file), the
same set `git ls-files --others --ignored --exclude-standard` lists, in the brain and in each initialised submodule in it. An ignored
asset exists on one clone only, so it is not described, embedded or searchable
anywhere. One that becomes ignored drops out of the index on the next run.
Ignored **markdown is still indexed**, so gitignored local notes stay
searchable. Outside a git work tree, or without git, nothing is left out this
way. `brain stats` `size.corpus` follows the same rule.

## Providers

Four provider seams, all following the same **dual convention**: a config value
is either a **string** (the name of a built-in, resolved against a static
registry compiled into core) or a **passed-in implementation** (a value you
import and hand over). See [extending/README.md](extending/README.md).

```ts
import { ollamaEmbeddings } from "brain-embeddings-ollama"; // hypothetical 3rd-party pkg

export default defineConfig({
  embeddings: { provider: "gemini" },                          // built-in, by name
  // embeddings: { provider: ollamaEmbeddings({ model: "nomic-embed-text" }) }, // custom, by value
});
```

### `embeddings`

Vector embeddings for semantic/hybrid search. When omitted, the `gemini` built-in
is used but stays dormant until a key is present, so search silently falls back
to full-text.

| Key          | Type                            | Default              | Notes                                           |
| ------------ | ------------------------------- | -------------------- | ----------------------------------------------- |
| `provider`   | `string \| EmbeddingProvider`   | `"gemini"`           | Built-in name or a custom value.                |
| `model`      | `string`                        | `gemini-embedding-2` | Embedding model (built-in providers only).      |
| `apiKeyEnv`  | `string`                        | `GEMINI_API_KEY`     | Env var holding the API key.                    |
| `dimensions` | `number` (positive int)         | `1536`               | Output dimensionality.                          |

Built-in: `gemini`. Changing the provider `id` or `dimensions` forces a vector
rebuild — brain-kit requires an explicit `brain index --embeddings --force` with
a printed cost warning and never silently re-embeds. See
[extending/embeddings.md](extending/embeddings.md).

```ts
embeddings: { provider: "gemini", model: "gemini-embedding-2", apiKeyEnv: "GEMINI_API_KEY" }
```

### `completions`

Plain (non-agentic) LLM completions for enrichment (chunk contexts, asset
descriptions), note processing, and briefings.

| Key        | Type                            | Default          | Notes                                        |
| ---------- | ------------------------------- | ---------------- | -------------------------------------------- |
| `provider` | `string \| CompletionProvider`  | `"gemini-flash"` | Primary provider.                            |
| `fallback` | `string \| CompletionProvider`  | —                | Tried if the primary throws; wraps it.       |
| `apiKeyEnv` | `string`                       | the provider's   | Env var holding the key for a built-in `provider`. |
| `fallbackApiKeyEnv` | `string`               | the provider's   | Env var holding the key for a built-in `fallback`. |

Built-ins: `gemini-flash` (key in `GEMINI_API_KEY`), `anthropic-haiku` (key in
`ANTHROPIC_API_KEY`). A configured `fallback` wraps the primary and advertises
the primary's capabilities, so pair it with a fallback at least as capable. See
[extending/completions.md](extending/completions.md).

```ts
completions: { provider: "gemini-flash", fallback: "anthropic-haiku" }
```

**Name the Anthropic key separately when brain-ui runs Claude.** A Claude chat
turn on a profile without its own credential runs on the subscription, with
`ANTHROPIC_API_KEY` cleared from its environment so the CLI cannot bill it
([decision record](decisions/claude-code-runtime.md)). A `brain` command the
model runs through the Bash tool inherits that environment, so
`anthropic-haiku` would find no key there. Put the key under another name, and
admit that name to the agent's environment with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`:

```ts
completions: { provider: "anthropic-haiku", apiKeyEnv: "BRAIN_ANTHROPIC_COMPLETIONS_KEY" }
```

### `agentRunner`

The coding-agent CLI that skill-invoking flows shell out to.

| Value                       | Default    |
| --------------------------- | ---------- |
| `string \| AgentRunner`     | `"claude"` |

Built-ins: `claude` (the default, supports streaming), `pi`, `codex`, `gemini`.
See [extending/agent-runners.md](extending/agent-runners.md).

```ts
agentRunner: "claude"
```

### `reranker`

How search orders what it retrieves, for `brain search`, `brain context`,
`brain eval`, the MCP tools and the chat backends. When omitted, the `jev`
built-in is used but stays dormant until `TYPESAFE_API_KEY` is present;
without it, search keeps the `heuristic` ordering.

| Key          | Type                   | Default            | Notes |
| ------------ | ---------------------- | ------------------ | ----- |
| `provider`   | `string \| Reranker`   | `"jev"`            | `jev` (relevance judgment), `heuristic` (lifecycle multipliers only), `none`, or a custom value. |
| `model`      | `string`               | `jev-1.13.0`       | Pinned on purpose; `jev-latest` moves and `brain doctor` warns on it. |
| `apiKeyEnv`  | `string`               | `TYPESAFE_API_KEY` | Env var holding the key. |
| `exclude`    | `string[]`             | —                  | Paths never sent to a network reranker: a bare name is a directory or file prefix, anything else a glob. Withheld results keep their retrieval rank. |
| `timeoutMs`  | `number` (positive)    | `3000`             | Deadline for the rerank call; past it, the retrieval order stands. |
| `depth`      | `number` (≥ 2)         | `50`               | How many top candidates are judged; the rest follow in retrieval order. |
| `skipMargin` | `number` (≥ 0)         | —                  | Skip the judgment when the vector lane's top result leads the second by this similarity margin. A cost lever, off by default; derive it with `brain eval`. |

```ts
reranker: { provider: "jev", exclude: ["career", "clients/**/ledger.md"] }
```

`jev` does not apply the `heuristic` lifecycle multipliers on top of its
order. It sends each candidate's `status`, `relevance` and `updated` as
evidence instead: measured, the multipliers after a judgment undid most of its
gain. `supersedes` demotion still applies in every mode.

Per request, `brain search --rerank none|heuristic|jev` overrides the default,
and `--rerank-dry-run` prints the exact outbound request to stderr without
sending it. See [extending/rerankers.md](extending/rerankers.md) for the
interface, the measurements and how to add your own.

## `skills`

Controls which agent formats `brain skills sync` emits skills for. The `claude`
emitter always runs; list additional built-in emitters to also emit for them.

| Key        | Type       | Default | Built-ins available    |
| ---------- | ---------- | ------- | ---------------------- |
| `emitters` | `string[]` | `[]`    | `codex`, `gemini`, `pi` |

```ts
skills: { emitters: ["codex", "pi"] }   // the agent contract in AGENTS.md; .pi/skills symlinks
```

See [extending/skill-emitters.md](extending/skill-emitters.md).

## `search`

How full-text search reads text.

| Key        | Type                    | Default     | Meaning |
| ---------- | ----------------------- | ----------- | ------- |
| `language` | `"english"` \| `"none"` | `"english"` | The full-text tokenizer and the query's stopwords, set together. |

- `english`: the index uses `porter unicode61`, which stems English words, and
  a query drops English stopwords ("the", "was", "also") before its terms are
  ORed. A query made only of stopwords keeps them, so `was` alone still
  searches for "was"; the setting shows in a mixed query such as
  `was telescope`.
- `none`: the index uses `unicode61 remove_diacritics 2`, with no stemming and
  no stopwords. Use it for a brain in another language. The Porter stemmer is
  English-only, stems nothing useful elsewhere, and can conflate unrelated
  words, and an English stopword can be a content word ("was" in German).

```ts
search: { language: "none" }
```

Changing it takes effect on the next `brain index`, which rebuilds the
full-text index and says so. The rebuild commits with the rest of that run's
writes or not at all: a run that fails leaves the old full-text index whole,
and the next run rebuilds it. Nothing is re-embedded. `brain doctor` reports the
configured language and whether the index matches it. Other languages'
stemmers and stopword lists are not built in.

## `stats`

Warn levels for the health figures `brain stats` reports. Both are **ratios in
`0..1`**, not percentages, and each falls back to its default on its own.

| Key                 | Type     | Default | Means                                                            |
| ------------------- | -------- | ------- | ---------------------------------------------------------------- |
| `coverageFloor`     | `number` | `0.9`   | Embedding coverage (vectors / chunks) below this needs attention |
| `brokenLinkCeiling` | `number` | `0.05`  | Broken-link rate (broken / links) above this needs attention     |

```ts
stats: { coverageFloor: 0.75 }   // brokenLinkCeiling stays at 0.05
```

The effective values are echoed back in `brain stats --json` under
`health.thresholds`, so a consumer never has to duplicate the defaults.

This block holds **only** the warn levels. Staleness and orphans are not
configured here: `brain stats` counts exactly what `brain audit` reports, from
the per-type [`staleDays`](#taxonomytypes) / `orphanExempt` and
[`taxonomy.defaultStaleness`](#taxonomydefaultstaleness). There is no second
stale window.

## `instructions`

The warn level for the always-loaded instruction weight that `brain doctor`
reports as its `instructions-weight` check. That weight is what every session
pays for before any work starts:

- `CLAUDE.md`, with its `@` imports resolved one level. An `@` inside a code
  span or fence is not an import. Only files whose real path is inside the
  brain count, so an import through a symlink that leaves the brain is skipped
  with a note, and a file reached under two names counts once.
- `AGENTS.md`.
- The description of every skill a model may invoke on its own, meaning every
  skill without `disable-model-invocation: true`.

Tokens are estimated as characters ÷ 4, the same estimate `brain context` uses.

| Key         | Type     | Default | Means                                          |
| ----------- | -------- | ------- | ---------------------------------------------- |
| `maxTokens` | `number` | `8000`  | Above this estimate, `brain doctor` warns and names the three largest contributors |

The check's detail lists every counted file and skill with its estimate. An
import that cannot be read, or a skill that cannot be discovered, makes the
check warn even under the limit, because the total is then a lower bound.

```ts
instructions: { maxTokens: 6000 }
```

The default leaves the shipped contract (about 900 tokens) and a generous
personal overlay well under the limit.

## `hooks`

What the installed git hooks do beyond their free default.

| Key             | Type      | Default | Meaning                                                                                                   |
| --------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `embedOnCommit` | `boolean` | `false` | The post-commit hook also embeds what the commit changed, when an embedding provider is configured.       |

The post-commit hook always refreshes the keyword index in the background, so an
edit is findable by keyword at once. With `embedOnCommit` on, the same
background run also embeds the chunks the commit changed, so vector and hybrid
search see the edit without waiting for `brain maintain` or `brain sync`. That
is a **paid** call on every commit that changes a chunk. It covers the
embeddings, plus chunk contexts and asset descriptions when completions are
configured. Chunks whose text did not change keep their vectors. The hook never
commits the sidecar cache lines the run adds; `brain sync` does. Without an
embedding provider the option does nothing.

**The first commit after opting in pays for the backlog.** An embeddings run
embeds every chunk that has no vector, not only the ones the commit changed.
On a brain that was indexed without vectors, or that has chunks a failed run
left behind, that is all of them. It also covers chunk contexts, and the
descriptions of any images and PDFs not yet described, when completions are
configured. A run that fails (a rate limit, a quota) leaves those chunks
without vectors, and the next commit tries them again. To pay for the backlog
at a time you choose, run `brain index --embeddings` once before turning the
option on.

If a commit lands while an earlier commit's run is still embedding, its run
still refreshes the keyword index and skips only the embeddings. The next run
embeds what it skipped.

```ts
hooks: { embedOnCommit: true }
```

The hook passes `--on-commit` to `brain index`, and the CLI makes the decision.
A brain whose hooks were installed before 0.38.0 needs `brain setup` to pick up
the new hook.

## `media`

How `brain sync assess` treats binaries and big files, and where `brain
doctor`'s `tracked-media` check draws its line. See [media.md](media.md).

| Key               | Type       | Default          | Means                                                                            |
| ----------------- | ---------- | ---------------- | -------------------------------------------------------------------------------- |
| `maxTrackedBytes` | `number`   | `5242880` (5 MiB) | A file over this is `LARGE` in `sync assess`, and a `tracked-media` warning in `brain doctor` |
| `track`           | `string[]` | `[]`             | Globs that are always `TRACK`                                                    |
| `ignore`          | `string[]` | `[]`             | Globs that are always `ARTIFACT`                                                 |

`sync assess` applies `ignore`, then `track`, before any other class except
`SENSITIVE`, which always comes first. Generated output that matches sync's
own artifact patterns (logs, temp files, tool leftovers) stays `ARTIFACT`
even over the size limit, because it is never committed. Office files,
presentations included, are `MEDIA` or `LARGE`. A glob's `*` matches any run of
characters, and a glob with no `/` also matches the file name alone.

```ts
media: { ignore: ["assets/renders/*"], track: ["me/*.jpg"] }
```

## `sync`

How `brain sync` settles what git cannot: a note both clones changed, and a
changed file its classifier has no rule for.

| Key     | Type              | Default | Means |
| ------- | ----------------- | ------- | ----- |
| `judge` | `"jev" \| "off"` | `"jev"` | Who answers the two judgments a sync needs. `"jev"` asks TypeSafe AI's Jev classifier when `TYPESAFE_API_KEY` is set. `"off"` never calls it. |

```ts
sync: { judge: "off" }
```

The two judgments are whether an `UNKNOWN` file is an artifact or content to
track, and how two edits of one passage relate: the same fact, one replacing
the other, or both worth keeping. Each answer is used only when its
confidence clears a fixed line: 0.8 for a file, 0.8 for "same fact", 0.85
for a replacement, and 0.6 for "keep both". A passage pair is asked in both
orders and used only when the two answers agree. Anything else takes the
conservative default: the file stays `UNKNOWN` and is left for the agent or
the report, and both passages are kept, the newer first. The key missing,
`judge: "off"`, a timeout or any error all mean the same defaults. A request
has a 10-second budget, and after the first one that fails the sync stops
asking for the rest of that run.

### Merge strategies

`brain sync resolve` (and `brain sync run`) picks one strategy for each
conflicted file. The first match wins:

1. A derived cache (`.context-cache.jsonl`, `.asset-cache.jsonl`) is
   `cache-union`. `brain sync pull` has already unioned it.
2. A file that is not markdown, and `CLAUDE.md` or `AGENTS.md`, is
   `code-merge`.
3. The document's type sets `mergeStrategy`. The type is the one its
   frontmatter `type` names (ours, then theirs, then base), else the type
   whose directory holds the file.
4. An `_index.md` is `table-union`.
5. A document with a `Timeline` heading on any side is `timeline-append`.
6. Anything else is `synthesize`.

| Strategy | What it does |
| -------- | ------------ |
| `synthesize` | Sections and blocks (paragraphs, list items, table rows, fenced code) merge three-way. A section either side added is kept. A block both sides changed is a judgment; unjudged, both are kept, the newer first. |
| `table-union` | Table rows keyed by their first cell, merged row by row. A row both sides changed goes to its later `Updated` date, else to a judgment. Our header and row order, then the rows only theirs has. The rest of the document as `synthesize`. |
| `timeline-append` | Timeline entries merged by date, exact duplicates dropped, both kept when one date has different text, in the direction ours uses. The rest as `synthesize`. |
| `keep-both` | When both sides changed the file, ours stays in place and theirs is written beside it as `<name>-remote.md`. When only one side changed it, that side. |
| `latest-wins-additive` | Per section, the side with the later `updated`; a section either side added is kept. |
| `code-merge` | Not merged by rule. Left in conflict for the agent. |
| `cache-union` | Handled by `brain sync pull`, never by `resolve`. |

Every strategy merges frontmatter the same way: a field only one side changed
takes that side; when both changed it, `updated` is the later date, `created`
the earlier, `tags` the sorted union, `status` theirs when ours left it
alone, and any other field ours. A field only one side added is kept. The
merged text is always made of blocks the two sides wrote, never new text. A
binary file, a side over 100 KB, or markdown that does not parse is left in
conflict, like `code-merge`.

## `modules`

Enables workflow modules. A key is either an npm package name
(`"@schlessera/brain-module-jobs"`) or a **local path** (`"./modules/catalog"`); the
value is that module's config block, validated by the module's own schema. Load
order follows config order. See [modules.md](modules.md).

```ts
modules: {
  "@schlessera/brain-module-speaking": { travelParty: [{ name: "Alex Example", role: "partner" }] },
  "@schlessera/brain-module-finance":  { clientsDir: "clients", feeTolerance: 30 },
  "./modules/catalog":          { owners: ["your-org"] },
}
```

## Environment variables

Configuration lives in `brain.config.ts`; environment holds the things that
must not be committed (keys) or that differ per machine (paths, endpoints).
Nothing here is required — every feature that needs a key degrades to a keyless
path and says so, rather than failing at the call.

| Variable | Read by | Effect |
|---|---|---|
| `BRAIN_ROOT` | root resolution | Which brain to operate on. See below. |
| `GEMINI_API_KEY` | embeddings, completions, images | Semantic search and asset descriptions (`brain index --embeddings`), the completions provider, and the Gemini image models. Overridable per feature via `embeddings.apiKeyEnv` / `completions.apiKeyEnv`. |
| `OPENAI_API_KEY` | images | The OpenAI image models — the only ones that do masked inpainting, transparent backgrounds, PNG/WebP output and exact pixel sizes. GPT-image models also need API Organization Verification on the account. |
| `ANTHROPIC_API_KEY` | completions | The `anthropic-haiku` completions provider. Overridable via `completions.apiKeyEnv`, and cleared inside a Claude subscription chat turn. |
| `TYPESAFE_API_KEY` | `brain sync` | The Jev judgments a sync asks. Without it every judgment takes its conservative default. See [`sync`](#sync). |
| `GOOGLE_API_KEY` | embeddings, completions | Not read as a key — temporarily unset around Gemini SDK calls to suppress its dual-key warning. Set it for other tooling if you like; brain-kit will not use it. |
| `BRAIN_RERANK_MODE` | search | Overrides the configured reranker: `jev`, `heuristic` or `none`. An explicit `--rerank` still wins. |
| `TYPESAFE_API_KEY` | search | Key for the built-in `jev` reranker (default name; `reranker.apiKeyEnv` can point elsewhere). Absent → the `heuristic` ordering. |
| `XDG_BIN_HOME` | `brain setup`, `brain doctor` | Where the `brain` symlink is written. Default `~/.local/bin`. |
| `NO_COLOR` | CLI output | Suppresses ANSI colour, per the informal standard. |
| `BRAIN_SKIP_HOOKS` | git hooks | `=1` bypasses the installed pre-commit/post-commit/post-checkout/post-merge hooks. |
| `CHROME_CDP_URL` | `brain jobs scrape --browser` | Headless-Chrome DevTools endpoint. Default `http://127.0.0.1:9222`. |
| `PUPPETEER_EXECUTABLE_PATH`, `BRAIN_UI_CHROME_PATH` | `brain render` | Where to find Chrome, when it is not on a well-known path. Point it at `chrome-headless-shell` to render in about half the time of full Chrome. |
| `BRAIN_CHROME_NO_SANDBOX`, `BRAIN_UI_CHROME_NO_SANDBOX` | `brain render` | `=1` launches Chrome without its sandbox. Required when running as root, as in a container; strictly weaker, so it is opt-in. |
| `OPENAI_BASE_URL`, `GEMINI_BASE_URL` | images | Point a provider at a proxy or a compatible endpoint. |

Two notes that have cost people time:

- **A key present in a container is not automatically present in cron.** Cron
  builds each job's environment from `/etc/environment`, not from the container
  environment, so a deployment must export the keys its scheduled jobs need.
  The failure reads as "no provider configured", not as a missing variable.
- **Keys are read at the moment a feature needs one.** `brain image models`,
  `brain doctor` and `brain config check` all report what is actually reachable,
  which is a faster way to answer "did my key land?" than reading a shell.

## Activity (chat-UI observability)

The chat-UI server records agent activity (turns, tool calls, subagent runs,
cron runs) into its own SQLite database and streams it to the Activity
surface. Behavior is tuned through the server's `settings` KV table (edited
via SQL or a future settings screen; every key has a safe default):

| Key | Default | Meaning |
|-----|---------|---------|
| `activity.timezone` | `UTC` | IANA zone for the per-day cost/token rollups' day boundary |
| `activity.watchdog.thresholdMs` | 45 min | A live run older than this is flagged *stuck* (a signal, not a termination) |
| `activity.watchdog.perJobMs` | `{}` | Per-job overrides, e.g. `{"sync": 7200000}` |
| `activity.notify.completions` | `[]` | Job names whose successful completion also notifies |

Retention: full-detail spans are pruned once the daily digest has covered
them (and unconditionally after ~90 days, so a broken digest job cannot
freeze pruning); per-run rollups are kept forever, so any run id that ever
existed still resolves. VAPID keys for web push are generated at first boot
and live in their own table — there is nothing to configure and no key to
provision.

## Root resolution and `BRAIN_ROOT`

The `brain` CLI resolves the brain root (the directory it operates on) in this
order:

1. An explicit path argument, if the command takes one.
2. The `BRAIN_ROOT` environment variable.
3. The nearest ancestor of the current directory containing a `brain.config.ts`
   or `brain.config.json`.
4. The nearest ancestor containing a `.git` directory.
5. The current directory.

Set `BRAIN_ROOT` to run `brain` commands against a brain from anywhere:

```sh
BRAIN_ROOT=~/my-brain brain search "hybrid search"
```

## The `brain.config.json` variant

For no-code users, brain-kit accepts `brain.config.json` with the same schema. It
is only read when no `brain.config.ts` is present.

```json
{
  "profile": { "name": "Alex Example" },
  "embeddings": { "provider": "gemini" },
  "modules": { "@schlessera/brain-module-speaking": {} }
}
```

JSON can express everything **except passed-in provider values** — those require
importing an implementation, which only the `.ts` form can do. If you use custom
providers or import a local module by value, use `brain.config.ts`.

## See also

- [concepts.md](concepts.md) — the taxonomy model these keys configure.
- [modules.md](modules.md) — module config blocks in depth.
- [extending/README.md](extending/README.md) — the provider dual convention.
- [integration-contract.md](integration-contract.md) — the stable machine surface.
