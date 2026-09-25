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
   `brain-<kind>-<vendor>` under your own npm scope (e.g.
   `brain-embeddings-ollama`) and other people `import` and pass it the same
   way. Third parties never touch the registry. Graduating a community
   implementation to a built-in is one PR, once it clears
   [the promotion bar](#promoting-a-community-provider-to-a-built-in).

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
3. **(Optional) publish** it as `brain-<kind>-<vendor>` (your own npm scope) so
   others can import it.

### Capability discovery and degradation

Each interface carries a `capabilities` object (and some optional methods). Core
inspects these and **degrades rather than fails**: a completion provider without
vision falls back to title-only asset descriptions; an embedding provider without
`embedImage` embeds the text description instead; with no usable embedder at all,
search runs full-text-only. Degraded modes are reported through the existing
`warnings` envelope — `brain search --json` returns `{ results, warnings }` where
`warnings` flags things like "no vectors", "model mismatch", or "missing key".

### Stability

Every seam is marked `@experimental` until 1.0 on its own declaration, as are
some of the types it is made of; the integration contract lists which. Breaking
changes to a seam are
announced in the CHANGELOG; a change to the stable contract requires a
`CONTRACT:` commit prefix, and a breaking one a maintainer ruling first (a major
version bump from 1.0). See [integration-contract.md](../integration-contract.md).

## The seams

There are nine. This table is the list; the integration contract's
"Extension interfaces" table names the same nine, and `tests/seam-list.test.ts`
fails when the two or the `@experimental` tags in the source disagree.

| Seam                                | Interface            | Imported from                     | What it swaps                            |
| ----------------------------------- | -------------------- | --------------------------------- | ---------------------------------------- |
| [Embeddings](embeddings.md)         | `EmbeddingProvider`  | `@schlessera/brain`               | The vectorizer behind semantic search    |
| [Completions](completions.md)       | `CompletionProvider` | `@schlessera/brain`               | Plain LLM calls for enrichment           |
| [Agent runners](agent-runners.md)   | `AgentRunner`        | `@schlessera/brain`               | The coding-agent CLI skills shell out to |
| [Skill emitters](skill-emitters.md) | `SkillEmitter`       | `@schlessera/brain`               | The agent format skills are emitted for  |
| [Agent backends](agent-backends.md) | `AgentBackend`       | `@schlessera/brain-ui-sdk/server` | The runtime that drives a chat session   |
| Speech                              | `SpeechProvider`     | `@schlessera/brain-ui-sdk/server` | Who mints a dictation session            |
| Speech                              | `AsrClient`          | `@schlessera/brain-ui-sdk/client` | The browser end of that session          |
| Tool renderers                      | `ToolRenderer`       | `@schlessera/brain-ui-sdk/client` | How one tool call looks in the timeline  |
| Site adapters                       | `SiteAdapter`        | `@schlessera/brain-scrape`        | The site a module fetches from           |

The first four live in core. The self-hosted chat UI adds four in
`@schlessera/brain-ui-sdk` (`packages/ui-sdk` in this monorepo).

- **[Agent backends](agent-backends.md)** — `BackendModule`, the package-level
  descriptor, constructs an `AgentBackend`, the runtime that drives a chat
  conversation. Has its own authoring guide.
- **`SpeechProvider`** (server) — mints per-session STT connection material
  (endpoint URL, short-lived token, params) for the client's matching
  `AsrClient`; audio never transits the brain-ui server unless the provider
  itself proxies. Carries `SpeechCapabilities` the UI degrades against.
  Contract and `defineSpeechProvider` helper:
  `packages/ui-sdk/src/server/speech.ts`.
- **`AsrClient`** (client) — the browser half of the same seam:
  `start` / `stop` / `drainAndStop` over the session the provider minted,
  registered per provider id via `registerAsrClient`. Contract:
  `packages/ui-sdk/src/client/asr.ts`.
- **`ToolRenderer`** (client) — per-tool rendering for the chat timeline
  (icon, summary, input/output React components), registered at build time in
  `RendererPack`s; resolution is backend-scoped name → global name → scored
  predicate → generic fallback. Contract:
  `packages/ui-sdk/src/client/renderers.ts`.

`@schlessera/brain-scrape` adds one more, `SiteAdapter`, for modules that fetch
from the web. It exists because the alternative was observed: without a
shared seam, `module-jobs` grew a SECOND scraper with its own site registry and
its own browser client, and implemented one site through both. No production
adapter implements `SiteAdapter` yet. `module-jobs`' ten boards implement that
module's own `ScraperAdapter`
(`ScraperAdapter`, `packages/module-jobs/src/types.ts:147-170`), which takes
the package's `ScrapeContext` through `bind` rather than through `scrape`, and
they do not run through `runAdapters`. `needsBrowser` on the
adapter is the only thing that decides how it is served. Contract:
`packages/scrape/src/adapter/types.ts`.

Note the split: **modules** contribute content-domain things (types, skills, CLI
words — see [modules.md](../modules.md)); **provider seams** are infrastructure.
They are separate mechanisms. A module never contributes an embedding provider.

## Promoting a community provider to a built-in

A built-in is a string name in a registry: `{ provider: "gemini" }` instead of
`{ provider: geminiEmbeddings() }`. That is all a user gains from promotion.
It is not all the maintainer takes on, which is why the bar is written down
here, before there is a candidate, rather than negotiated with one.

Nothing has been promoted. Every name a seam resolves today resolves to
first-party code: `EMBEDDING_PROVIDERS`, `COMPLETION_PROVIDERS` and
`AGENT_RUNNERS` in `packages/core/src/lib/registry.ts`, `BUILTIN_EMITTERS` in
`packages/core/src/lib/skills/index.ts`, the `FIRST_PARTY_BACKENDS` table in
`packages/ui-server/src/agent/backend.ts`, and — the same thing written by hand
rather than as a registry — the two `VOICE_PROVIDER` names `pickSpeechProvider`
accepts in `packages/ui-server/src/voice/speech-providers.ts`.

Promotion is therefore only a question for some of the seams. The two client
seams are not in it: a `ToolRenderer` pack and an `AsrClient` are registered by
the app that bundles them, through `registerToolRenderers` and
`registerAsrClient` — public API a community pack calls exactly as a
first-party one does — so there is no registry to join and a registry entry
would add nothing. `SpeechProvider` is the other exception, for the opposite
reason: `pickSpeechProvider` resolves `VOICE_PROVIDER` and takes no passed-in
value, so a community speech provider has no by-value path to be promoted
*from*. Giving it one is a seam change, decided on its own before promotion is
a question — see item 7 below.

### What promotion costs

Promotion moves the code under this repository's maintenance, and the
maintainer is one person. A promoted provider becomes:

- **Code the maintainer maintains.** Its vendor's API deprecations, its SDK's
  breaking releases and its bug reports are this project's problem, including
  at 2am.
- **Part of everyone's install.** A core-seam built-in ships inside
  `@schlessera/brain` — the providers under `packages/core/src/providers/`, the
  skill emitters under `packages/core/src/lib/skills/emitters/`. They keep
  their footprint small on purpose: the Anthropic
  completions provider calls the Messages API over plain `fetch`, the agent
  runners spawn a CLI, and the two Gemini providers load `@google/genai`
  lazily as an optional peer dependency of core
  (`packages/core/package.json`), so a brain that never selects them never
  installs it. A promoted provider is held to the same shape, and whatever it
  does depend on becomes core's dependency to keep patched.
- **A package that versions in lockstep.** A backend is its own package,
  `@schlessera/brain-backend-<vendor>`: an optional `*`-ranged peer of
  `@schlessera/brain-ui-server`, an entry in `FIRST_PARTY_BACKENDS` with its
  own profile plumbing in `packages/ui-server/src/config/env.ts`, a line in
  `scripts/publish.ts` and `scripts/build.ts` in dependency order, a member of
  the changesets `fixed` group, and a row in every enumeration
  `tests/release-manifest.test.ts` asserts. It then ships in every release,
  changed or not.
- **A config-visible name.** Once a string resolves, taking it away breaks
  every config that names it. Until 1.0 that is a minor-version event announced
  in the CHANGELOG ([integration-contract.md](../integration-contract.md#extension-interfaces));
  after 1.0 it is a major.
- **Documented surface.** A row in the seam's "Built-ins" table in this
  directory, an entry under the config key in
  [configuration.md](../configuration.md), and the same leakage and
  invisible-character gates as the rest of the tree.

"It has real users" is therefore necessary and not sufficient.

### The bar

A provider is considered only when every item holds. The maintainer decides;
there is no vote and no score.

1. **Real users, verifiably.** People other than the author run it in their
   brain, and that is visible somewhere public: an issue or discussion opened
   by someone who is not the author, a public repository that depends on it, a
   thread that names it. A download count is not evidence. It has been in use
   across more than one brain-kit release, so it has already absorbed a seam
   or SDK change without anyone in this repository noticing.
2. **A maintenance commitment.** The author stays reachable, keeps answering
   issues on the provider after it moves, and is willing to be named as its
   contact. An author who wants to hand the code over and leave has not met
   this bar; "If the author stops" below is why.
3. **Keyless, deterministic tests that exercise the runtime.** They run with
   no API key and no network, like every test in this repository. For a
   backend that means `runBackendContract` from
   `@schlessera/brain-ui-sdk/testing`, the harness both first-party backends
   run. For a core seam it means the seam's suite from
   `@schlessera/brain/testing` (`runEmbeddingProviderContract`,
   `runCompletionProviderContract`, `runAgentRunnerContract` or
   `runSkillEmitterContract`), run against the real provider code driven
   through an isolated `fetch` or a fake binary, as
   `packages/core/tests/seam-contracts.test.ts` runs every built-in. The suite
   is the floor: cover every method and every `capabilities` flag the provider
   declares beyond it too. A test of a predicate is not proof for anything with
   a runtime.
4. **Degradation matches the seam.** A missing key, an unreachable vendor, an
   absent optional method: each produces the degraded behaviour the seam's
   page documents and a `warnings` entry, never a crash and never a silently
   different result. Tier 0 stays keyless.
5. **MIT, and nothing that cannot be redistributed under it.** The tree is
   MIT and every publishable package carries a `LICENSE` file, which the
   release manifest test asserts. A dependency whose licence or terms forbid
   redistribution, or a vendor SDK that is not itself openly licensed, keeps
   the provider in community space.
6. **Clean under the gates.** No personal data, no raw invisible characters,
   fixtures under the "Alex Example" persona. A provider is not given an
   exemption from a gate; it is rewritten until it passes.
7. **It fits the seam as it is.** A provider that needs a new method on the
   interface, a new config key, or a new capability flag is proposing a seam
   change, which is decided first and on its own. Promotion never carries a
   seam change with it.
8. **It covers something no built-in covers** — a vendor, a local runtime, an
   agent. A variant of an existing built-in is a config value or a
   community package, not a second registry entry.

### How to ask

Open a [discussion](https://github.com/schlessera/brain-kit/discussions), not
an issue: a promotion request is a question with no work attached until it is
accepted. Link the package, the public evidence of use, and the tests. An
accepted request becomes an issue and one PR — the code move, the registry
entry, the docs row, a changeset. A declined one stays a discussion, with the
reason written in it.

### What promotion does not mean

- **A declined promotion is not a judgement on the provider.** By-value
  configuration is the design, not a waiting room. A community provider
  passed as a value is loaded by the same code as a built-in, degrades through
  the same warnings, and is never second-class at runtime. The bar is about
  what this repository can afford to own, and most good providers belong
  where their author can release them on their own schedule.
- **Promotion is not an endorsement of the vendor**, and it does not make the
  vendor's service a dependency of brain-kit.
- **Promotion is not a transfer of authorship.** The author keeps the credit
  and the history; the maintainer takes on the release.
- **Promotion is not permanent.** The next section says what ends it.

### If the author stops

Two cases, and they are different.

**A community provider whose author stops** costs brain-kit nothing. The
package keeps working for as long as it installs, because nothing in this
repository ever depended on it; a fork under another scope is an ordinary npm
event, and a user's config changes by one import line. This is why the
extension path is by value, and why the bar asks for the maintenance
commitment before the move rather than after it.

**A promoted provider that goes unmaintained** — its SDK stops building, its
tests can no longer be kept keyless, nobody can verify a fix — is demoted, not
carried. Demotion is promotion in reverse: the registry entry and the docs row
go, the code returns to a community package under the author's scope or goes
to a contributor who wants it, and the change ships with a CHANGELOG entry
under the rule for `@experimental` interfaces. A config that still names the
core built-in fails when the config resolves, with the error an unknown name
gets today — `Unknown <kind> "<name>". Available built-ins: <list>. Pass a
custom <Interface> value instead.` — and the fix is the one-import-line change
above. A demoted provider is not erased from history and is not barred from
being promoted again.

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
