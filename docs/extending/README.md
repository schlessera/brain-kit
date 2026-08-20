# Extending brain-kit

brain-kit is provider-agnostic by architecture. Where a second implementation of
something is plausibly wanted within a year, there is a small typed **seam** you
can slot your own implementation into. Everywhere else, the code stays concrete
on purpose — see [the not-pluggable list](#explicitly-not-pluggable) below.

## The meta-mechanism

Every seam works the same way, and it is deliberately boring:

> **A typed interface in a core package → config accepts a built-in name
> (string) OR a passed-in implementation (value) → optionally shared as an npm
> package.**

There is no plugin loader, no dependency-injection container, and no runtime
discovery. Concretely:

1. **Built-ins are strings.** `{ provider: "gemini" }` resolves against a static
   registry compiled into `@schlessera/brain` — a plain `Record<string, factory>`.
2. **Custom implementations are values.** You write an object that satisfies the
   interface, import it into `brain.config.ts`, and pass it in:
   `{ provider: myEmbeddings }`. It is used as-is.
3. **Sharing is an ordinary package.** Publish your implementation as
   `brain-kit-<kind>-<vendor>` (e.g. `brain-embeddings-ollama`) and other
   people `import` and pass it the same way. Third parties never touch the
   registry; graduating a community implementation to a built-in is one PR.

```ts
import { ollamaEmbeddings } from "brain-embeddings-ollama";

export default defineConfig({
  embeddings: { provider: "gemini" },                                  // built-in
  // embeddings: { provider: ollamaEmbeddings({ model: "nomic-embed-text" }) }, // custom
});
```

### The contributor story (≤3 steps)

1. **Implement the interface** via its typed helper — `defineEmbeddingProvider`,
   `defineCompletionProvider`, `defineAgentRunner`, or `defineSkillEmitter` from
   `@schlessera/brain` (identity functions that give you inference and
   excess-property checking) — or as a plain object typed as the interface.
2. **Reference it in config** by value — it works immediately, no registration.
3. **(Optional) publish** it as `brain-kit-<kind>-<vendor>` so others can import it.

### Capability discovery and degradation

Each interface carries a `capabilities` object (and some optional methods). Core
inspects these and **degrades rather than fails**: a completion provider without
vision falls back to title-only asset descriptions; an embedding provider without
`embedImage` embeds the text description instead; with no usable embedder at all,
search runs full-text-only. Degraded modes are reported through the existing
`warnings` envelope — `brain search --json` returns `{ results, warnings }` where
`warnings` flags things like "no vectors", "model mismatch", or "missing key".

### Stability

All seams are marked `@experimental` until 1.0. Breaking changes to a seam are
announced in the CHANGELOG; a breaking change to the stable contract requires a
`CONTRACT:` commit prefix and a major version bump. See
[integration-contract.md](../integration-contract.md).

## The seams

Four seams live in `@schlessera/brain`:

| Seam                                       | Interface            | What it swaps                         |
| ------------------------------------------ | -------------------- | ------------------------------------- |
| [Embeddings](embeddings.md)                | `EmbeddingProvider`  | The vectorizer behind semantic search |
| [Completions](completions.md)              | `CompletionProvider` | Plain LLM calls for enrichment        |
| [Agent runners](agent-runners.md)          | `AgentRunner`        | The coding-agent CLI skills shell out to |
| [Skill emitters](skill-emitters.md)        | `SkillEmitter`       | The agent format skills are emitted for |

The self-hosted chat UI adds four more in `@schlessera/brain-ui-sdk` (ships with the
brain-ui repo, v0.1): `AgentBackend` and `SpeechProvider` (server), `ToolRenderer`
and `AsrClient` (client). Those are documented with brain-ui.

`@schlessera/brain-scrape` adds one more, `SiteAdapter`, for modules that fetch
from the web. It clears the second-implementation bar by a distance — eleven
sites already implement it — and it exists because the alternative was
observed: without a seam that is actually load-bearing, `module-jobs` grew a
SECOND scraper with its own site registry and its own browser client, and
implemented one site through both. `needsBrowser` on the adapter is the only
thing that decides how it is served.

Note the split: **modules** contribute content-domain things (types, skills, CLI
words — see [modules.md](../modules.md)); **provider seams** are infrastructure.
They are separate mechanisms. A module never contributes an embedding provider.

## Explicitly NOT pluggable

These are the product, not configuration surface. They are stated verbatim so
there is no ambiguity:

- SQLite + FTS5 + sqlite-vec as the index engine, and `brain.db`'s schema. No
  StorageProvider, no Postgres/pgvector surface.
- Markdown files + git as the source of truth, including the frontmatter model —
  modules may extend taxonomy values, but the file-first model is fixed.
- The chunking strategy and hybrid-search ranking pipeline (fusion weights,
  heuristic reranker). Tunable constants, not interfaces.
- The wire protocol (`packages/ui-sdk/src/protocol.ts`, published as
  `@schlessera/brain-ui-sdk/protocol`) — it is the contract every backend
  targets.
- Bun + Hono server, React PWA client — no framework adapters.
- The `brain` CLI surface and MCP tool names (contract-stable per the integration
  contract).

## See also

- [configuration.md](../configuration.md) — where seam config lives.
- [modules.md](../modules.md) — the other extension mechanism.
- [integration-contract.md](../integration-contract.md) — stability guarantees.
