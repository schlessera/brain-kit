# Configuration

`brain.config.ts` is the single source of truth for your brain's shape:
its taxonomy, providers, and enabled modules. This reference follows `main`;
check `brain --version` and the installed package changelog for release
availability. In particular, per-type `embed` and explicit `reranker.enabled`
are 0.40.0 additions and are absent from published 0.39.0. The travel module
also joins 0.40.0; its config below assumes that release is installed.

The file default-exports `defineConfig({...})`. `defineConfig` is a typed
identity helper — it gives you autocomplete and type-checking while you edit;
validation happens when the config is loaded, against a zod schema. `brain
validate` runs config validation first and refuses on schema errors.

```ts
import { defineConfig } from "@schlessera/brain";

export default defineConfig({
  profile: { name: "Odysseus", cliTitle: "Odysseus's knowledge base" },
  taxonomy: { /* … */ },
  embeddings: { provider: "gemini" },
  modules: { "@schlessera/brain-module-speaking": {} },
});
```

A brand-new brain works with an almost-empty config: the four core types
(`identity`, `context`, `note`, `index`) are built in, so `defineConfig({})` is
valid. Everything below is optional and additive.

The [supported-input policy](supported-inputs.md) defines compatibility for these
keys, package environment inputs and canonical module formats, including precedence
and migration obligations.

## `profile`

Cosmetic identity for the CLI.

| Key        | Type     | Default | Notes                          |
| ---------- | -------- | ------- | ------------------------------ |
| `name`     | `string` | —       | Your name.                     |
| `cliTitle` | `string` | —       | Shown in `brain --help`.       |

```ts
profile: { name: "Odysseus", cliTitle: "Odysseus's personal knowledge base" }
```

## `taxonomy`

The heart of the config: types, directory anchors, canonical documents, and the
rules that keep the corpus tidy. All keys are optional. See
[concepts.md](concepts.md) for the model.

### `taxonomy.types`

A record mapping a **type name** to its spec. Type names must match
`^[a-z][a-z0-9-]*$` (lowercase, digits, hyphens; starting with a letter).

You can add new types and override core/module types here.

Only configured own entries of the effective core/module/user taxonomy are valid
types and classifier-hint targets. Inherited object names do not define a type or
a module owner. A schema-valid name such as `constructor` works when explicitly
configured, including module contributions and user overrides.

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
| `orphanExempt`  | `boolean`                         | `false`                     | Exempt from the orphan audit; see [the link-based definition](concepts.md#staleness-and-the-audit-model). |
| `embed`         | `boolean`                         | `true`                      | Generate chunk contexts and vectors for this type. `false` keeps keyword search, links, audit and ordinary counts. |
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

### Per-type embedding eligibility

Available in 0.40.0+.

Set `taxonomy.types.<type>.embed` to `false` for bulk or generated material
that should remain findable by keyword without paying for chunk context or
embedding generation:

```ts
taxonomy: { types: { generated: { dir: "imports", embed: false } } }
```

The next `brain index` removes that type's stored vectors, including when
files are unchanged and the run omits `--embeddings`. Its documents, chunks,
full-text entries, links and audit findings stay in the index. Existing chunk
contexts and committed caches may remain; they cannot restore opted-out
vectors, including during `--force` rebuilds. Image/PDF vectors obey the same
policy. Their descriptions still follow the existing enrichment behavior,
because keyword search uses them too.

Set `embed` back to `true`, then run `brain index --embeddings` to generate
missing vectors. A plain index makes the type eligible but does not generate
vectors. Omitting the setting in an override preserves an earlier layer's
type policy; when no layer sets it, eligibility defaults to `true`. Values are
validated as booleans. See the [decision](decisions/embedding-eligibility.md).

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
Unset keys return no path, including names inherited from the object prototype.

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
| `scope`       | nonempty `string`, up to 4000 characters | Declared purpose and required coverage of the derivatives, used by opted-in freshness review. A document's `propagation_scope` overrides it. |

### `hygiene.propagation`

Optional automatic propagation review, **off until `enabled: true`**. It keeps
complete current/reference source texts and an explicit source diff. Only a
positive currency judgment meeting the owner's policy can acknowledge freshness.
Source and derivative content, `created` and `updated` stay byte-identical; the
receipt lives in `context/hygiene/propagation-reviews.md`. Missing context,
provider failure and every other judgment remain for the owner.

```ts
hygiene: {
  propagation: { enabled: true, profile: "balanced" },
},
taxonomy: {
  propagation: [{
    source: "notes/voyage-plan.md",
    derivatives: "notes/command-summary.md",
    scope: "Current ship commander only; omit provisions.",
  }],
},
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Persistent owner authorization for this automation. A key or CLI flag cannot turn it on. |
| `profile` | `"balanced"` | `conservative`: floor 0.9 plus cross-checks; `balanced`: 0.7 plus cross-checks; `permissive`: floor 0, currency question only. |
| `minConfidence` | From profile | Optional 0–1 override; every required answer must meet it. This is answer concentration, **not** a probability of correctness. |
| `crossChecks` | From profile | Also require positive answers on support for all included assertions and sufficient in-scope coverage. They can only veto the currency answer; confidence is never averaged or multiplied. |
| `maxFiles` | `10` | At most 1–100 uncached model judgments per invocation. Cached negatives do not consume the quota. |
| `timeoutMs` | `5000` | Per-request deadline, 100–30000 ms, bounded by the remaining run budget. |
| `budgetMs` | `10000` | Run dispatch budget, 100–60000 ms, shared by history/diff preparation and provider calls. |
| `maxInputChars` | `40000` | Complete request character bound, 1000–80000. Oversize inputs are left for review, never clipped. Provider context limits can still refuse a request. |
| `exclude` | `[]` | Additional contained paths/prefixes/globs never sent to the provider. Taxonomy exclusions also apply, including canonical symlink targets. |

The presets are policy choices, not calibrated correctness guarantees. Start
with `brain hygiene propagation --dry-run --json`: it reports individual
judgments and acceptance at several floors, both currency-only and cross-checked,
without extra calls for that sensitivity table. It replays the saved answers;
changing the question bundle on a fresh request may also change the primary
answer. The [measured tradeoff](decisions/propagation-triage.md#user-selected-confidence-and-cross-checks)
is from short authored examples, not an expected production error rate.
The distinction follows [TypeSafe's confidence definition](https://docs.typesafe.ai/confidence):
it summarizes the answer distribution, not independently verified correctness.

Scope must be explicit, in a matching propagation rule or the derivative's
nonempty `propagation_scope` frontmatter. `propagation_reference` may name the
full Git commit ID of a known reference source snapshot. Otherwise review uses
the commit recording the exact current derivative bytes. That is a recorded
content version, **not** an inferred generation time. An uncommitted derivative
without an explicit reference, missing historical source, historical symlink,
unclear scope or unavailable source stays for review. Dates alone never select
history. All configured sources plus a Markdown `generated_from` are consulted.

The concrete model is pinned to the evaluated `jev-1.13.0`; `TYPESAFE_API_KEY`
authenticates it. Successful typed judgments, including those left for humans,
are cached by source/derivative bytes, scope and model/question version. Changing
a threshold re-applies the policy locally to those answers. The UTC observation
day is part of the evidence: time-dependent judgments expire on a new day, even
when files did not change. Unseen/oldest-reviewed paths go first so bounded runs
can advance through a backlog. Enabling additional
checks asks again only if their answers are missing. Source, derivative or
scope changes invalidate the evidence; model/question upgrades require review
again. Disabling the feature stops using its acknowledgements. Deleting the
disposable index does not lose the Markdown receipts.

Ordinary `hygiene reconcile` and non-preview `hygiene next` run the prepass when
enabled and credentials are available. `audit` only reads receipts and never
calls a model; `next --dry-run` never starts provider work. Hosted interactive
review remains credential-free. For hosted scheduling, opt into
`BRAIN_UI_CRON_PROPAGATION=on` as well: the generated daily 05:45
`hygiene-propagation` job runs through credentialed, exclusive maintenance,
separately from the credential-free weekly hygiene job. It also requires core
0.45.0+ and the brain's persistent opt-in; it is never an unwrapped trusted job.

### `taxonomy.facts`

Declares facts that documents restate, so `brain audit` can catch a copy that
drifted. The value lives in the source document's `facts:` frontmatter map; the
config says where that is and how the fact is phrased elsewhere.

```ts
taxonomy: {
  facts: {
    troy_fell: { source: "me/basics/FACTS.md", patterns: ["Troy fell in (\\d{4})"] },
  },
}
```

```yaml
# me/basics/FACTS.md
facts: { troy_fell: 2016 }
```

| Key        | Type       | Meaning                                                                                  |
| ---------- | ---------- | ---------------------------------------------------------------------------------------- |
| `source`   | `string`   | Exact path of the document whose `facts:` frontmatter holds the canonical value.          |
| `patterns` | `string[]` | Regular expressions, matched case-insensitively, each with exactly one capture group: the value. |

Every non-archived markdown document other than the source is scanned outside
its code. A captured value that differs from the canonical one is a
`fact-drift` warning, once per document per fact. Comparison trims surrounding
whitespace and compares numeric values exactly, preserving significant digits
rather than rounding them to JavaScript numbers.

The existing numeric admission boundary is a nonempty string whose JavaScript
`Number` conversion is finite: signed decimal integers/fractions (including
`.5` and `12.`), decimal exponents, and unsigned hexadecimal (`0x`), binary
(`0b`) and octal (`0o`) integers. Leading/trailing zeros, equivalent exponent
spellings and signed zero remain equivalent. Nonzero underflows remain distinct
from zero and from one another; exponents are kept symbolic without expanding
decimal places. Values whose conversion overflows, `Infinity`, `NaN`, numeric
separators, `n` suffixes and signed base-prefixed integers retain trimmed,
case-sensitive text comparison. Empty captures also remain text.

Quote high-precision canonical facts in YAML, for example
`facts: { count: "9007199254740993" }`. Unquoted numeric scalars may already
lose precision during YAML parsing; comparison cannot recover those digits.
A document that is right to state an old value, such as a retrospective, lists
the key under `facts_ignore: [troy_fell]`. A pattern that does not compile, or
that has other than one capture group, fails config load with a message naming
the fact. Drift is reported, never rewritten.

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
    vocabulary: ["navigation", "route", "shipbuilding"],
    aliases: { "ship-building": "shipbuilding", "star-guide": "navigation" },
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
| `dirs`     | `string[]` | `.git`, `node_modules`, `.claude`, `.agents`, `scripts`, `logs`, `tmp`, `workspaces`, `okf-dist`, `.brain/scratch`, `evals`, `context/scheduled-tasks` |
| `files`    | `string[]` | `CLAUDE.md`, `README.md`, `AGENTS.md`, `GEMINI.md`                                                 |
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

The root agent instruction files are excluded from content indexing and
validation, including `GEMINI.md` generated by `brain skills sync`. These are
exact root-relative paths: a content note at `notes/GEMINI.md` is still included.
Adding your own `exclude.files` entries keeps the built-in exclusions.

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

## `geo`

Available in 0.40.0+. Core's geo commands and the standalone
[`@schlessera/brain-geo`](../packages/geo/README.md) use one concrete configuration
shape. This is endpoint configuration, without a provider registry. Omitting
`geo` leaves every new service disabled and keeps an empty config as `{}`.
`defineConfig` accepts partial authoring; validation supplies defaults when loaded.

```ts
geo: {
  userAgent: "your-app/1.0 (https://your-app.example/contact)",
  cacheDir: ".brain/geo",
  geocoding: { enabled: true, url: "https://geocoder.example" },
  overpass: { enabled: true, endpoints: ["https://overpass.example/api/interpreter"] },
  routing: { endpoints: { foot: {
    url: "https://routes.example/route/v1", profile: "foot",
    preparedMode: "foot", dataset: "walking-data",
    verification: "Operator confirms this endpoint is prepared for walking.",
  } } },
}
```

An identifying application/operator User-Agent is required before any service
request. New public geocoding needs explicit informed eligibility; routing demo
fallback is separately off until enabled and eligible. Neither flag grants
service permission. Read the [geo policies and defaults](../packages/geo/README.md#configuration)
before selecting an endpoint. Prepared datasets determine routing modes;
changing a profile token cannot establish support.

Core's `cacheDir` is repo-relative and must remain inside the brain, including
through symlinks. Without it, the library uses its global disposable response
cache. Aggregate operator admission remains global and independent of this
response-cache directory, so separate brains/processes do not each gain their
own public allowance. Caches are not content and never make `brain.db`
authoritative.

SDK `ReverseGeocodeConfig.geo` and `CoastlineConfig.geo` accept the same canonical
input. UI servers accept `BRAIN_GEO_CONFIG_JSON`, or explicit `coastline.geo` in
`ServerConfig`. JSON settings override legacy `OVERPASS_URL`/`OVERPASS_USER_AGENT`
service settings; relative response-cache paths resolve from `BRAIN_PATH`.
Invalid JSON/configuration refuses startup. `COASTLINE_CACHE_DIR` continues to
control the separate permanent geometry cache, and `BRAIN_UI_COASTLINE=false`
still prevents new requests. The library/server allow an explicit absolute
response-cache location; core's brain config retains its repo containment rule.
Backend location options can inject canonical SDK configuration; their existing
Nominatim environment settings remain the legacy adapter.

## Providers

Four provider seams, all following the same **dual convention**: a config value
is either a **string** (the name of a built-in, resolved against a static
registry compiled into core) or a **passed-in implementation** (a value you
import and hand over). See [extending/README.md](extending/README.md).

```ts
import { defineConfig } from "@schlessera/brain";
import { ollamaEmbeddings } from "brain-embeddings-ollama"; // hypothetical 3rd-party pkg

export default defineConfig({
  embeddings: { provider: "gemini" },                          // built-in, by name
  // embeddings: { provider: ollamaEmbeddings({ model: "nomic-embed-text" }) }, // custom, by value
});
```

### `embeddings`

Vector embeddings for semantic/hybrid search. When omitted, the `gemini` built-in
is used but stays dormant until a key is present. Search falls back to
full-text and reports the unavailable vector capability in its warnings.

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

Markdown chunk input includes title, heading, optional context and content.
There is no metadata-prefix setting: type, status, tags and dates use the
existing filters, keyword retrieval and ranking paths where supported.
See [why metadata stays outside embedding prefixes](decisions/embedding-metadata.md)
for the reuse and cost rationale. This does not strip metadata terms already
present in prose or context.

```ts
embeddings: { provider: "gemini", model: "gemini-embedding-2", apiKeyEnv: "GEMINI_API_KEY" }
```

### `completions`

Plain (non-agentic) LLM completions for enrichment (chunk contexts, asset
descriptions) and note processing. `brain briefing` itself is mechanical;
the `/whatsup` skill adds an agent's interpretation.

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

**Name the Anthropic key separately when the chat server runs Claude.** A Claude chat
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

Explicit activation with `enabled` is available in 0.40.0+. In 0.39.0 a usable
configured reranker can activate without that field; check the installed
changelog before relying on the opt-in behavior below.

How search orders what it retrieves, for `brain search`, `brain context`,
`brain eval`, the MCP tools and the chat backends. Model judgment is off by
default: only `reranker.enabled: true` activates it. A key, a provider,
`--rerank jev`, MCP `rerank: "jev"` or `BRAIN_RERANK_MODE=jev` cannot enable
it. While off, search uses local `heuristic` ordering unless `none` is selected.

| Key          | Type                   | Default            | Notes |
| ------------ | ---------------------- | ------------------ | ----- |
| `enabled`    | `boolean`              | `false`            | Explicit opt-in for built-in and custom judgment providers; omission means off. |
| `provider`   | `string \| Reranker`   | `"jev"`            | `jev` (relevance judgment), `heuristic` (lifecycle multipliers only), `none`, or a custom value. |
| `model`      | `string`               | `jev-1.13.0`       | Pinned on purpose; `jev-latest` moves and `brain doctor` warns on it. |
| `apiKeyEnv`  | `string`               | `TYPESAFE_API_KEY` | Env var holding the key. |
| `exclude`    | `string[]`             | —                  | Paths never sent to a network reranker: a bare name is a directory or file prefix, anything else a glob. Withheld results keep their retrieval rank. |
| `timeoutMs`  | `number` (positive)    | `3000`             | Deadline for the rerank call; past it, the retrieval order stands. |
| `depth`      | `number` (≥ 2)         | `50`               | How many top candidates are judged; the rest follow in retrieval order. |
| `skipMargin` | `number` (≥ 0)         | —                  | Skip the judgment when the vector lane's top result leads the second by this similarity margin. A cost lever, off by default; derive it with `brain eval`. |

```ts
reranker: { enabled: true, provider: "jev", exclude: ["career", "clients/**/ledger.md"] }
```

`jev` does not apply the `heuristic` lifecycle multipliers on top of its
order. It sends each candidate's `status`, `relevance` and `updated` as
evidence instead: measured, the multipliers after a judgment undid most of its
gain. `supersedes` demotion still applies in every mode.

Per request, `brain search --rerank none|heuristic|jev` overrides the selected
mode, subject to activation. Explicit `jev` requests while off warn and return
local heuristic results; `brain eval` refuses to score that fallback, including
when `BRAIN_RERANK_MODE=jev` made the request. When enabled, missing-key
fallback and the existing deadlines, exclusions and validation still apply.
`--rerank-dry-run` constructs the outbound request without sending it, even
while disabled or without a key.

To turn judgment off, change only `enabled` to `false` in the canonical
`brain.config.ts` or `brain.config.json`. Keep provider, model, key-variable,
exclusion and bound fields there; setting `enabled` back to `true` reuses them.
The JSON equivalent is `{ "reranker": { "enabled": true, "provider": "jev" } }`.
The field accepts booleans only, and the provider may be omitted to use `jev`.
Each CLI invocation reloads configuration. Restart a running MCP or embedding
host after editing it; libraries recreate their context with freshly loaded
config. TypeScript config imports are cached within a process, so restart that
process to reload them. This setting adds no live reload or separate store.

**Migration from credential-triggered activation (0.39.0):** add
`enabled: true` to retain model ordering. Leaving it out now keeps model
judgment off even if `TYPESAFE_API_KEY` is set. Local `heuristic` and `none`
modes remain available. The approved behavior change is recorded in
[decisions/reranker-activation.md](decisions/reranker-activation.md). See [extending/rerankers.md](extending/rerankers.md) for the
interface, the measurements and how to add your own.

## `compute`

External compute: named provider instances that can allocate a disposable
sandbox, run a command in it, return its results and release it. Absent by
default. With no `compute` key there is no provider and no network access, and
every compute operation except health refuses with `compute_disabled`. Nothing
runs remotely unless a caller names an instance; no instance is a default.
[decisions/external-compute.md](decisions/external-compute.md) is the contract.

```ts
compute: {
  providers: {
    "boat-small": {
      provider: "boat",              // a built-in name, or a ComputeProvider value
      apiKeyEnv: "BOAT_CI_KEY",      // the variable holding this instance's key
      options: { machine: "small" }, // validated by the provider's own schema
      lease: { maxSeconds: 3600 },   // required, finite
      maxConcurrent: 2,
      hourlyCeilingUsd: 0.1,
    },
    "ithaca-host": {
      provider: sshCompute({ host: "ithaca.example", workRoot: "/srv/jobs" }), // hypothetical package
      lease: { maxSeconds: 1800 },
    },
  },
},
```

| Key | Meaning |
| --- | --- |
| `providers.<id>` | One instance. The id is lowercase letters, digits and hyphens, at most 63 characters, and is what a caller names. Two instances of one implementation keep separate options and keys. |
| `provider` | `"boat"` (the separate `@schlessera/brain-compute-boat` package, an optional peer loaded only when an instance names it; see [Boat](#boat)) or a `ComputeProvider` value. An unknown name is `provider_unknown`; a missing package, an unset key or options the provider rejects make the instance `provider_unavailable`. |
| `apiKeyEnv` | The environment variable name holding the instance's key. The key never appears in config, job records, receipts, tool arguments, results or the sandbox environment. Without it a built-in reads its own default variable. |
| `options` | Opaque to core; validated by the implementation's `configSchema`. |
| `lease.maxSeconds` | Required. The longest lease a job on this instance may hold, at most seven days and never more than the provider's own ceiling. A job asks for this lease unless it names a shorter one. |
| `maxConcurrent` | Jobs at once on this instance, counting finished jobs whose cleanup has not been confirmed and retained jobs until their retention ends. Default 1. |
| `hourlyCeilingUsd` | Optional. When set, admission reserves `ceiling × lease` against the host's budgets. When absent the job runs with its cost recorded as unknown, bounded by the lease and the concurrency cap. |
| `retainOnRelease` | Release keeps the sandbox's data for the provider's retention limit instead of discarding it. Refused when the provider cannot retain. A job may opt out (`retain: false`) but may only ask to retain (`--retain`, `retain: true`) on an instance that sets this. |

### Boat

`provider: "boat"` needs `@schlessera/brain-compute-boat` installed beside
`@schlessera/brain`. Without `apiKeyEnv` the instance reads
`BRAIN_COMPUTE_BOAT_API_KEY`, never the variable Boat's own CLI uses; give it a
scoped key with the actions the
[package README](../packages/compute-boat/README.md#the-key) lists (Boat's
`ci` preset), never an account administration key. Its `options`, all
optional and validated strictly:

| Option | Meaning |
| --- | --- |
| `machine` | `small`, `default`, `large` or `xlarge`. |
| `from` | A saved snapshot name or share code to start from. |
| `environment` | A Boat environment to attach. Without it the sandbox gets none of the account's secrets or logins (`noEnv`). |
| `org` | The organization wallet to bill. |

A retained release keeps the sandbox's data for at most 14 days. Actual cost
is Boat's own usage report at list price, and unknown without one.

Job records, leases, reservations and collected artifacts live in a compute
state directory outside the brain checkout and outside `brain.db`: by default
`$XDG_STATE_HOME/brain/compute/<brain key>/` (`~/.local/state` when unset), or
`BRAIN_COMPUTE_STATE_DIR`. It is deliberately not a config key: the brain is
agent-editable. A state directory inside the brain is refused. `brain index
--force` neither reads nor rebuilds it. See
[extending/compute-providers.md](extending/compute-providers.md) for the job
lifecycle and how to write a provider, and [`brain compute`](cli.md#external-compute)
and the [`brain_compute_*` MCP tools](mcp.md#tools) for running jobs.

## `graph`

`graph.root` is a repository-relative document path from which the knowledge
graph measures distances. Omission uses `AGENTS.md`, then `CLAUDE.md`; an
index-excluded instruction file can be a virtual root. This config controls
graph traversal, not a search-ranking boost. See the
[graph decision](decisions/graph-ranking-signal.md).

## `skills`

Controls which agent formats `brain skills sync` emits skills for. The `claude`
emitter always runs; list additional built-in emitters to also emit for them.

| Key        | Type       | Default | Built-ins available    |
| ---------- | ---------- | ------- | ---------------------- |
| `emitters` | `string[]` | `[]`    | `codex`, `gemini`, `pi` |

```ts
skills: { emitters: ["codex", "gemini", "pi"] }   // contract in AGENTS.md and GEMINI.md; .pi/skills symlinks
```

Codex and Gemini discover `.agents/skills/` natively. Their emitters embed the
installed `CONTRACT.md` in their instruction files and refresh it on every
sync. Gemini's old Skills index is replaced by that contract; text outside
managed blocks is preserved. Ambiguous markers or an unreadable installed
contract leave `GEMINI.md` unchanged and produce a warning.

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
  `was star guide`.
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
| `coverageFloor`     | `number` | `0.9`   | Coverage of embedding-eligible chunks below this needs attention |
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

`brain config media <add-track|remove-track|add-ignore|remove-ignore>
<pattern>` changes one entry without running the config: it previews the
change with `--dry-run`, including the files sync sees now that the pattern
matches, then applies it with `--expect-sha` from that preview. It works only
when the lists are literal arrays in a directly exported object; anything
else is refused, for you to edit by hand
([cli.md](integration-contract/cli.md)).

## `sync`

How `brain sync` integrates remote commits and settles what git cannot: a
note both clones changed, and a changed file its classifier has no rule for.

| Key     | Type              | Default | Means |
| ------- | ----------------- | ------- | ----- |
| `pull` | `"rebase" \| "merge"` | `"rebase"` | For divergent history, replay unpublished local commits on `origin/main`; if rebase stops, abort it and use the usual merge. `"merge"` always uses the merge path. Applies to `sync pull`, `sync run` and bare `sync`. |
| `judge` | `"jev" \| "off"` | `"jev"` | Who answers the two judgments a sync needs. `"jev"` asks TypeSafe AI's Jev classifier when `TYPESAFE_API_KEY` is set. `"off"` never calls it. |

```ts
sync: { pull: "merge", judge: "off" }
```

The default keeps history linear when local commits apply cleanly. It replays
only commits absent from `origin/main`, never autostashes unrelated work or
updates another local branch, and does not preserve local merge commits with
`--rebase-merges`. A successful pull reports `rebased`; a stopped attempt is
aborted before merge conflicts are exposed, so OURS remains local and THEIRS
remote. Existing merge/index state is handled first; an existing rebase or
apply operation is left untouched. Local derived-cache changes are set aside
and restored or unioned with the integrated cache. If an abort cannot restore
the original HEAD and clear operation state, the pull reports `merge-failed`
with a reason and leaves that operation for its owner.

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

`brain sync group` groups exact root `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`
as configuration. Same-named nested files keep their taxonomy grouping and
content/index membership; the root-relative content exclusions are unchanged.

`brain sync resolve` (and `brain sync run`) picks one strategy for each
conflicted file. The first match wins:

1. A derived cache (`.brain-cache/contexts.jsonl`, `.brain-cache/assets.jsonl`,
   or the root-level `.context-cache.jsonl` and `.asset-cache.jsonl` an older
   clone still writes) is `cache-union`. `brain sync pull` has already unioned
   it.
2. A file that is not markdown, or whose exact basename is `CLAUDE.md`,
   `AGENTS.md` or `GEMINI.md` at any depth, is `code-merge`. The stats
   history (`.stats-history.jsonl`) rarely gets here: `brain sync pull` merges
   a conflicted history by day itself, keeping both clones' days and the later
   recording of a shared one, even without its `.gitattributes` union line. A
   side that is not a history stays conflicted for judgment. Conflicted
   instructions and their Git index stages stay intact for agent/person
   judgment. No instruction synthesis or remote-copy resolution occurs.
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

Instruction filename matching is case-sensitive; ordinary notes and near-match
filenames keep their existing strategies. Clean Git line merges are unchanged.

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
order follows config order. A `settings/<manifest-name>.json` object overrides
that block one key at a time before the same module schema validates it. Nested
objects merge; arrays and scalar values replace. Schema defaults apply afterward.
The CLI and Settings → Modules write these JSON overrides without rewriting a
TypeScript config. `brain config get modules --json` returns the effective
validated blocks. See [modules.md](modules.md#editable-module-settings).

An optional `enabled` boolean inside each entry defaults to `true`. Core owns
and validates it separately from the module's domain schema. `false` keeps the
module loaded and its config validated, retaining document types and anchors
while parking its workflows. Use `brain module disable <name>` / `enable <name>`
to update the flag, sync managed skills and regenerate owned instructions;
legacy mixed instruction sections require [explicit migration](modules.md#instruction-migration).

```ts
modules: {
  "@schlessera/brain-module-speaking": {},
  "@schlessera/brain-module-travel": { travelParty: [{ name: "Odysseus" }, { name: "Penelope", role: "partner" }] },
  "@schlessera/brain-module-finance":  { clientsDir: "clients", feeTolerance: 30 },
  "./modules/catalog":          { owners: ["your-org"] },
}
```

## Environment variables

Configuration lives in `brain.config.ts`; environment holds the things that
must not be committed (keys) or that differ per machine (paths, endpoints).
Basic capture and keyword search require no provider key. Search reports
degradation when optional providers are unavailable; capabilities that require
a provider, such as image generation, can refuse the request instead. Select
the capability you need and read its command's requirements.

| Variable | Read by | Effect |
|---|---|---|
| `BRAIN_STORAGE_GIT_ROOTS` | storage inventory | Trusted JSON array of up to 16 absolute external Git roots; absent means no external roots. Never a request parameter. |
| `BRAIN_ROOT` | root resolution | Which brain to operate on. See below. |
| `GEMINI_API_KEY` | embeddings, completions, images | Semantic search and asset descriptions (`brain index --embeddings`), the completions provider, and the Gemini image models. Overridable per feature via `embeddings.apiKeyEnv` / `completions.apiKeyEnv`. |
| `OPENAI_API_KEY` | images | OpenAI image generation. Mask, transparency, output-format and exact-size requirements route by capability; see the [images reference](../packages/module-images/README.md). |
| `ANTHROPIC_API_KEY` | completions | The `anthropic-haiku` completions provider. Overridable via `completions.apiKeyEnv`, and cleared inside a Claude subscription chat turn. |
| `TYPESAFE_API_KEY` | `brain sync` | The Jev judgments a sync asks. Without it every judgment takes its conservative default. See [`sync`](#sync). |
| `GOOGLE_API_KEY` | upstream Gemini SDK | Not a brain-kit key input. Providers pass their selected key explicitly; the SDK may emit a cosmetic dual-key warning. The variable is not temporarily unset. |
| `BRAIN_MEDIA_PINNED_PATH_LIMIT` | `brain hygiene`, `brain sync` | Trusted host bound on the conversation-pinned scratch paths one media inventory reads. Default `5000`. Past it, review reports that conversation links were not fully checked. A value that is not a positive integer stops media detection. |
| `BRAIN_MEDIA_REFERENCE_LIMITS` | `brain hygiene`, `brain sync` | Trusted host bounds on the declared reference scan behind every media finding, as `<limit>=<n>` pairs: `notes` (50000), `noteBytes` (256 MiB), `perNote` (4 MiB, at most `noteBytes`), `scanTime` in ms (20000), `refsPerFinding` (500), and for a media effect's plan `rewrittenNotes` (200) and `preview` in bytes (1 MiB; a hosted review also refuses a previewed Action past its 512,000-byte transport limit, whatever this says). Past a limit the scan or plan is refused and nothing claims the references were checked. An invalid value stops media detection. |
| `BRAIN_RERANK_MODE` | search | Selects `jev`, `heuristic` or `none`. An explicit `--rerank` still wins; neither can enable model judgment while `reranker.enabled` is false. |
| `TYPESAFE_API_KEY` | search | Key for the built-in `jev` reranker (default name; `reranker.apiKeyEnv` can point elsewhere). Model search also requires `reranker.enabled: true`; absent key → the `heuristic` ordering. |
| `XDG_BIN_HOME` | `brain setup`, `brain doctor` | Where the `brain` symlink is written. Default `~/.local/bin`. |
| `BRAIN_COMPUTE_STATE_DIR` | external compute | Absolute directory for compute job records and artifacts, outside the brain checkout. Default `$XDG_STATE_HOME/brain/compute/<brain key>`. |
| `XDG_STATE_HOME` | external compute | Base of the default compute state directory. Default `~/.local/state`. |
| `BRAIN_COMPUTE_BOAT_API_KEY` | external compute | Default key variable of a `boat` instance without `apiKeyEnv`. Read on the trusted host only; never forwarded into a sandbox. |
| `NO_COLOR` | CLI output | Suppresses ANSI colour, per the informal standard. |
| `BRAIN_SKIP_HOOKS` | git hooks | `=1` bypasses the installed pre-commit/post-commit/post-checkout/post-merge hooks. |
| `CHROME_CDP_URL` | jobs scraping | Retained alias for `SCRAPE_CHROME_URL`; the latter wins when both are set. Without an endpoint the shared scraper can launch its own browser. |
| `PUPPETEER_EXECUTABLE_PATH`, `BRAIN_UI_CHROME_PATH` | `brain render` | Where to find Chrome, when it is not on a well-known path. `chrome-headless-shell` is also supported. |
| `BRAIN_CHROME_NO_SANDBOX`, `BRAIN_UI_CHROME_NO_SANDBOX` | `brain render` | `=1` launches Chrome without its sandbox. Required when running as root, as in a container; strictly weaker, so it is opt-in. |
| `OPENAI_BASE_URL`, `GEMINI_BASE_URL` | images | Point a provider at a proxy or a compatible endpoint. |

For the complete package-owned literal and dynamically named inventory, parsing
rules and precedence boundaries, see [environment inputs](supported-inputs.md#environment-inputs).

Two notes that have cost people time:

- **A key in your shell is not automatically present in a scheduled job.**
  Verify the environment of the process that executes the command. The chat
  server forwards a per-audience allowlist; custom variable names require
  explicit admission through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. See
  [hosting](hosting/README.md#subprocess-environment-allowlist-0331).
- **Keys are read at the moment a feature needs one.** `brain image models`,
  `brain doctor` and `brain config check` report catalog availability or
  configuration health. Those checks do not prove that a provider will accept
  a live request under your account's access and quota.

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
  "profile": { "name": "Odysseus" },
  "embeddings": { "provider": "gemini" },
  "modules": { "@schlessera/brain-module-speaking": {} }
}
```

JSON can express everything **except passed-in provider values** — those require
importing an implementation, which only the `.ts` form can do. Local modules
are enabled by their path under `modules` in either format; modules are not
passed-in provider values.

## See also

- [concepts.md](concepts.md) — the taxonomy model these keys configure.
- [modules.md](modules.md) — module config blocks in depth.
- [extending/README.md](extending/README.md) — the provider dual convention.
- [integration-contract.md](integration-contract.md) — the stable machine surface.
