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

## `exclude`

Paths the indexer ignores. Your entries are **added to** the built-in defaults,
never replace them.

| Key        | Type       | Built-in default                                                                                  |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `dirs`     | `string[]` | `.git`, `node_modules`, `.claude`, `.agents`, `scripts`, `logs`, `tmp`, `workspaces`              |
| `files`    | `string[]` | `CLAUDE.md`, `README.md`, `AGENTS.md`                                                              |
| `segments` | `string[]` | *(none in core; modules may add — e.g. speaking excludes `alt-decks`, `versions`, `deck`)*        |

- `dirs` — a top-level directory (or any path under it) is excluded.
- `files` — an exact relative path.
- `segments` — any path containing this directory segment at any depth.

```ts
exclude: { dirs: ["drafts"], segments: ["private"] }
```

## Providers

Three provider seams, all following the same **dual convention**: a config value
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

Built-ins: `gemini-flash`, `anthropic-haiku`. A configured `fallback` wraps the
primary and advertises the primary's capabilities, so pair it with a fallback at
least as capable. See [extending/completions.md](extending/completions.md).

```ts
completions: { provider: "gemini-flash", fallback: "anthropic-haiku" }
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

## `skills`

Controls which agent formats `brain skills sync` emits skills for. The `claude`
emitter always runs; list additional built-in emitters to also emit for them.

| Key        | Type       | Default | Built-ins available    |
| ---------- | ---------- | ------- | ---------------------- |
| `emitters` | `string[]` | `[]`    | `codex`, `gemini`      |

```ts
skills: { emitters: ["codex"] }   // also emit .codex/prompts + AGENTS.md index
```

See [extending/skill-emitters.md](extending/skill-emitters.md).

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
