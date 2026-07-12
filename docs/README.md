# brainform documentation

A file-first personal knowledge base your coding agent operates. Markdown is the
source of truth; the search index is disposable and rebuilt on demand.

Start with the [quickstart](quickstart.md), then read [concepts](concepts.md) to
understand the model. The rest is reference.

| Doc | What's in it |
| --- | --- |
| [quickstart.md](quickstart.md) | Clone the template to a working brain: the `gh` one-liner, `bun install`, `/brain-init`, first capture and search, the degradation ladder, and `/brain-doctor`. |
| [concepts.md](concepts.md) | The core model: markdown-as-truth, the frontmatter schema, document types and the taxonomy merge, `_index.md` and the Index Sync Principle, wiki-link resolution, the notes inbox, staleness/audit, and sidecar caches. |
| [configuration.md](configuration.md) | The full `brain.config.ts` reference — every key, its type, default, and an example — plus root resolution, `BRAIN_ROOT`, and the `brain.config.json` variant. |
| [modules.md](modules.md) | What a module is, enabling/disabling via `/brain-module`, the three first-party modules (jobs, speaking, finance), local path modules, and authoring with `/new-module`. |
| [cli.md](cli.md) | Command reference for the `brain` bin — all commands, key flags, and which `--json` shapes are contract-bound. |
| [mcp.md](mcp.md) | The stdio MCP server: registration, the eight `brain_*` tools, staleness warnings, and taxonomy-generated type filters. |
| [extending/README.md](extending/README.md) | The seam meta-mechanism (typed interface → string-or-value config → optional package) and the verbatim not-pluggable list. |
| [extending/embeddings.md](extending/embeddings.md) | The `EmbeddingProvider` seam. |
| [extending/completions.md](extending/completions.md) | The `CompletionProvider` seam. |
| [extending/agent-runners.md](extending/agent-runners.md) | The `AgentRunner` seam. |
| [extending/skill-emitters.md](extending/skill-emitters.md) | The `SkillEmitter` seam. |
| [hosting/README.md](hosting/README.md) | Self-host overview: brain-ui, `/brain-host`, auth modes, the honest cost table, encryption reality, and backups. |
| [integration-contract.md](integration-contract.md) | The stable machine surface: CLI `--json` shapes, MCP tools, `brain.db` reads, and versioning rules. |

## See also

- The agent contract (`@brainform/core/CONTRACT.md`) — the Layer-1 rules imported
  into every brain's `CLAUDE.md`.
- Each first-party module's own README for its full field reference.
