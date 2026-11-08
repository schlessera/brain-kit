# @schlessera/brain

> **Requires Bun ≥ 1.3 — npm/npx will not warn you (npm ignores `engines.bun`);
> install from https://bun.sh.**

The core brain-kit package provides the `brain` CLI, the stdio MCP server, hybrid
search and indexing libraries, onboarding commands, git hooks, and core skills
for a file-first personal knowledge base.

Install it with Bun:

```sh
bun add @schlessera/brain
```

Then run `brain --help`. The full quickstart and reference documentation live
at [github.com/schlessera/brain-kit](https://github.com/schlessera/brain-kit).

## Environment

Every variable this package reads, and what happens when it is unset. This
table is generated from the package's env chokepoint — the single file allowed
to touch `process.env`.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Default API key for the built-in Anthropic completion provider (default name only — a config `apiKeyEnv` can point elsewhere). | — |
| `APIFY_TOKEN` | Apify API token for a standalone `brain apify` or `brain mcp` process (#3162). Used only while the governance policy sets apify.enabled: true, and only as a bearer header to the fixed Apify origins; never printed. A chat worker never receives it. | unset: Apify refuses as authentication_required |
| `BRAIN_AGENT_RUNNER_UNAVAILABLE` | Internal: set to `1` by the worker launcher in a credential-free maintenance worker, such as the one hosted `brain sync` runs in, where no agent can log in. The configured agent runner is then treated as absent: bare `brain sync` hands nothing to an agent and reports that judgment is unavailable, so a conflict it leaves is resolved by hand; set by the worker launcher, not an operator input. | the configured agent runner is used |
| `BRAIN_APIFY_LEDGER` | Absolute path of the shared Apify ledger a standalone `brain apify` or `brain mcp` process accounts in (#3162): the file the UI server opens, so the account's day limit and concurrency bound every process. A chat worker never receives it. | unset: every Apify operation refuses as accounting_unavailable |
| `BRAIN_CHROME_NO_SANDBOX` | "1" launches the render Chrome without its sandbox (required when running as root). | sandbox on |
| `BRAIN_COMPUTE_STATE_DIR` | Absolute directory for external compute job records, leases, reservations and artifacts. Must lie outside the brain checkout; it is never in brain.config because the brain is agent-editable. | $XDG_STATE_HOME/brain/compute/<brain key> |
| `BRAIN_MEDIA_PINNED_PATH_LIMIT` | Trusted host bound on the distinct conversation-pinned scratch paths one media inventory reads (`brain hygiene`, review and `brain sync`'s media count). A positive integer; past it the inventory reports that conversation links were not fully checked, and never claims an exhaustive scan. Anything else stops media detection rather than being guessed. | 5000 |
| `BRAIN_MEDIA_REFERENCE_LIMITS` | Trusted host bounds on the declared reference scan behind every media finding (`brain hygiene`, review and `brain sync`'s media count): comma-separated `<limit>=<positive integer>` pairs over `notes` (50000), `noteBytes` (268435456), `perNote` (4194304), `scanTime` in milliseconds (20000), `refsPerFinding` (500), and for a media effect's plan `rewrittenNotes` (200) and `preview` in bytes (1048576), with `perNote` at most `noteBytes`. Past a limit the scan or plan is refused and nothing claims the references were checked. Anything else stops media detection rather than being guessed. | the Q1 defaults |
| `BRAIN_PROVIDER_RELAY_SOCKET` | Internal: absolute path of the server's provider relay socket in a governed or strict agent worker or a relayed maintenance worker. A built-in Gemini, Anthropic or OpenAI image provider whose key the server withheld sends its native request there, and the server adds the key, meters the request and refuses it once a budget is blocked; set by the worker launcher, not an operator input. | no relay; a provider uses its key from the environment |
| `BRAIN_RERANK_MODE` | Search reranker mode: "jev", "heuristic" or "none". Overrides the configured `reranker.provider`; an explicit --rerank still wins. Cannot enable model reranking: reranker.enabled must be true. | the configured provider when enabled and available, else heuristic |
| `BRAIN_ROOT` | Brain repository root, overriding cwd-based discovery. | nearest ancestor with brain.config.* or .git, else cwd |
| `BRAIN_STORAGE_GIT_ROOTS` | Trusted storage inventory allowlist: JSON array of up to 16 absolute external Git store roots. Request flags cannot expand it. | no external Git stores |
| `BRAIN_UI_CHROME_NO_SANDBOX` | Same as BRAIN_CHROME_NO_SANDBOX, in the BRAIN_UI_* spelling a chat-server deployment sets; the server passes it to the brain CLI it spawns. | sandbox on |
| `BRAIN_WITHHELD_KEYS` | Internal: comma-separated names (never values) of the provider keys the server withheld from this governed or strict agent worker. A command that needs one names the provider with a `provider_unavailable` notice and degrades where it can; set by the worker launcher, not an operator input. | no key is withheld; a missing key keeps the ordinary keyless behaviour |
| `BRAIN_WORKER_CONFIG_ROOT` | Internal immutable configuration execution root for maintenance and hosted turn workers, supplied by the trusted worker launch. Root discovery maps it to BRAIN_WORKER_DATA_ROOT; configuration loading maps the data root back here. | — |
| `BRAIN_WORKER_DATA_ROOT` | Internal data root for maintenance and hosted turn workers, supplied by the trusted worker launch together with BRAIN_WORKER_CONFIG_ROOT; not an operator input. | — |
| `BRAIN_WORKER_OUTPUT_ALLOWANCE` | Internal: JSON `{"bytes":N,"setting":"NAME"}` naming the size of a maintenance worker's private writable output stage and the host setting that controls it. When `brain maintain`'s git packing runs out of space, its `git` step names that allowance and setting; set by the worker launcher, not an operator input. | the step reports the space shortfall without a setting |
| `CLAUDE_CODE_PATH` | Claude Code binary the Claude agent runner spawns, as for the chat server. | the Agent SDK's built-in binary when the SDK is installed, else `claude` on PATH |
| `GEMINI_API_KEY` | Default API key for the built-in Gemini embedding/completion providers (default name only — a config `apiKeyEnv` can point elsewhere). Absent key degrades vector search to FTS. | — |
| `NO_COLOR` | Any non-empty value suppresses ANSI color in CLI output. | — |
| `TYPESAFE_API_KEY` | Default TypeSafe AI key for Jev: the built-in jev search reranker (default name only — a config `apiKeyEnv` can point elsewhere) and the judgments `brain sync` asks, plus opted-in hygiene propagation review. Search also requires reranker.enabled: true; propagation requires hygiene.propagation.enabled: true. Absent key keeps the lifecycle (heuristic) search ordering, and every sync judgment takes its conservative default. | — |
| `XDG_BIN_HOME` | Directory the `brain` CLI symlink is installed into. | ~/.local/bin |
| `XDG_STATE_HOME` | Base directory for the default external compute state directory. | ~/.local/state |

Reads whose variable *name* is configuration rather than code:

| Name comes from | What the value is used for |
| --- | --- |
| brain.config `compute.providers.<id>.apiKeyEnv` | Credential for one external compute provider instance, read on the trusted host at call time and never forwarded into a sandbox, a job record or a result (default: the built-in's own name, BRAIN_COMPUTE_BOAT_API_KEY for `boat`). |
| brain.config `embeddings.apiKeyEnv` / `completions.apiKeyEnv` / `completions.fallbackApiKeyEnv` / `reranker.apiKeyEnv` | API key for a built-in provider or completion fallback, read at call time under whatever name the config declares (defaults: GEMINI_API_KEY, ANTHROPIC_API_KEY, TYPESAFE_API_KEY). |
| call-time inherited environment snapshot (`inheritedEnv`) | Internal agent-CLI transport: copies the calling process's environment at spawn time and merges explicit overrides last. Unlike the UI's filtered subprocess environment, this snapshot is inherited in full; it does not make every inherited variable supported brain configuration. |

Generated from `packages/core/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->

### Content-index query results

`@schlessera/brain/queries` offers supported synchronous graph, link-walk,
voice-vocabulary, listing and complete hygiene metadata results over an existing
index. It opens read-only per operation and returns detached values or safe typed
errors. See the [API specification](../../docs/content-index-queries.md) for
options, defaults, compatibility and snapshot semantics. Existing CLI/MCP
behavior and direct-SQL guarantees remain binding during consumer migration.

`@schlessera/brain/module` holds the supported module-authoring helpers: path
containment, atomic writes, scratch, generated regions, the corpus walk, the
index registry and completion-provider resolution
([modules guide](../../docs/modules.md#the-module-authoring-entry)).

`@schlessera/brain/internal` holds first-party native-handle search/context and
write helpers. It has no compatibility guarantee and requires the same
lockstep version; integrations should use the supported query results.

### Host storage integration

Host-shell authors can call `readStorageInventory` from
`@schlessera/brain/storage` to obtain bounded live metadata without executing
Git, repository configuration or the brain CLI. Enforce owner authorization and
choose explicit roots at the host boundary. The [host reader contract](../../docs/integration-contract/package-api.md#host-storage-reader-additive-2010)
defines resource bounds, Git marker support, unknown evidence and cancellation.

`brain storage pack --json` runs the existing non-destructive Git packing tasks
without expiring history or refs. Its [qualified result](../../docs/integration-contract/cli.md#storage-packing-additive-0440-2011)
reports refusal/partial outcomes and workload-dependent temporary headroom.
Governed hosts invoke it through their credential-free maintenance worker.

The same Storage entry exports narrow raw attachment inspection/removal/restore
primitives and bounded consequence inspection. Their [caller obligations and
limits](../../docs/integration-contract/package-api.md#selected-attachment-application-additive-0440-2012)
are part of the contract: callers own exclusive coordination, current authority
and durable verified recovery before removal. Consequence inspection evaluates
Git and belongs in a credential-free worker in hosted consumers. It does not
change the metadata-only inventory reader or add an unjournaled delete command.
