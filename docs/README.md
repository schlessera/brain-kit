# brain-kit documentation

A file-first personal knowledge base your coding agent operates. Markdown is the
source of truth; the search index is disposable and rebuilt on demand.

## Get started

- [Quickstart](quickstart.md) — create a private brain, capture a note and find
  it without API keys; then choose whether to personalize it with an agent.
- [Concepts](concepts.md) — learn how files, frontmatter, types and links fit
  together, and what the disposable index does.
- [Daily workflow](daily-workflow.md) — capture, connect and review notes,
  refresh the index, and sync a brain you already own.

These pages are the reading order for a new user. The guides below explain
optional capabilities; the references answer a specific command or setting
question. This Markdown index is also the navigation source for public docs.

## Guides

| Guide | Use it to |
| --- | --- |
| [Modules](modules.md) | Enable domain workflows or author a local module; follow links to each module's full reference. |
| [Media](media.md) | Decide which assets to keep in git and how large files behave during sync. |
| [Evaluating search](evaluating-search.md) | Build a query set and measure retrieval without mistaking an invalid set for a useful score. |
| [Hosting](hosting/README.md) | Back up a local brain and understand the separate, not-yet-published hosting-template path. |
| [Extending](extending/README.md) | Implement a provider at an existing experimental seam; modules and infrastructure providers are separate mechanisms. |

## Reference

These references follow the source in this repository. Check `brain --version`
and the installed package's `CHANGELOG.md` when using a published release;
versioned additions are not available in older packages. The quickstart uses
the published template rather than a source checkout.

| Doc | What's in it |
| --- | --- |
| [configuration.md](configuration.md) | The full `brain.config.ts` reference — every key, its type, default, and an example — plus every environment variable brain-kit reads, root resolution, and the `brain.config.json` variant. |
| [cli.md](cli.md) | Command reference for the `brain` bin — all commands, key flags, and which `--json` shapes are contract-bound. |
| [mcp.md](mcp.md) | The stdio MCP server: registration, the eight core `brain_*` tools and module tools, staleness warnings, and taxonomy-generated type filters. |
| [extending/README.md](extending/README.md) | Provider configuration and each seam's registration entry point, the bar for promoting a community provider to a built-in, and the verbatim not-pluggable list. |
| [extending/embeddings.md](extending/embeddings.md) | The `EmbeddingProvider` seam. |
| [extending/completions.md](extending/completions.md) | The `CompletionProvider` seam. |
| [extending/agent-runners.md](extending/agent-runners.md) | The `AgentRunner` seam. |
| [extending/rerankers.md](extending/rerankers.md) | The opt-in `Reranker` seam and its evaluation evidence. |
| [extending/skill-emitters.md](extending/skill-emitters.md) | The `SkillEmitter` seam. |
| [extending/agent-backends.md](extending/agent-backends.md) | The `AgentBackend` seam: authoring a chat-UI agent backend — turn lifecycle, the permission bridge, and how ui-server loads backends. |
| [conditional-forms.md](conditional-forms.md) | Conditional questions in one card, visible-answer results, configurable limits and keyless schema-cost estimates. |
| [http-api.md](http-api.md) | Complete mounted-route inventory, supported HTTP authentication/inputs/responses/errors, SDK dependencies and internal UI transport boundary. |
| [content-index-queries.md](content-index-queries.md) | Supported synchronous content-index results, validation, compatibility and snapshot lifetime. |
| [inbox-storage.md](inbox-storage.md) | Internal durable Queue and Action storage, guarded transactions, checkpoints, cursor replay and recovery ownership. |
| [inbox-actions.md](inbox-actions.md) | Atomic escalation and exactly-once decisions, deterministic snooze, cap/expiry/suppression, bounded retries and staging compensation. |
| [inbox-budget.md](inbox-budget.md) | Autonomous spend/turn admission, conservative reservations, frozen settlement and crash recovery. |
| [inbox-runtime.md](inbox-runtime.md) | Queue lifecycle, expired-lease recovery and the protected local HTTP poke with boot token rotation. |
| [inbox-recovery.md](inbox-recovery.md) | Complete operational backup, staging consistency, empty-target restore, crash resumption and the 24-hour recovery point. |
| [integration-contract.md](integration-contract.md) | The stable machine surface: CLI `--json` shapes, MCP tools, supported HTTP/wire behavior, `brain.db` reads, and versioning rules. |

## Working on brain-kit itself

| Doc | What's in it |
| --- | --- |
| [process/github.md](process/github.md) | Where work lives: the label taxonomy, what a milestone commits to, the project board's fields, the issue lifecycle, and what an agent does before writing code. |
| [process/feature-captures.md](process/feature-captures.md) | Editorial screenshot and demo recipes, source/readiness rules and public asset provenance. |
| [visitor-feedback-investigation.md](visitor-feedback-investigation.md) | Dated visitor-path and mailing-service comparison behind the public website's release-signup policy. |
| [decisions/README.md](decisions/README.md) | Why things are the way they are — the alternatives rejected and the measurements that decided them. Read the record for whatever you are about to change. |
| [audit-capability-investigation.md](audit-capability-investigation.md) | Actual audit suggestion/handler boundaries and keyless repair-capability controls. |
| [canonical-conflict-investigation.md](canonical-conflict-investigation.md) | Source/evidence boundaries and report-only controls for unkeyed canonical conflicts; live comparison remains unmeasured. |
| [job-fit-investigation.md](job-fit-investigation.md) | Actual keyword scoring, private semantic fit/unknown-value controls and the unmeasured live comparison boundary. |
| [note-disposition-investigation.md](note-disposition-investigation.md) | Source discovery and keyless controls for evaluating note disposition; live model results remain unmeasured. |
| [mechanical-hygiene-investigation.md](mechanical-hygiene-investigation.md) | Existing hygiene capabilities, a private mechanical-repair prototype and offline runtime/write controls; actual agent savings remain unmeasured. |
| [opportunity-lifecycle-investigation.md](opportunity-lifecycle-investigation.md) | Explicit job lifecycle events, real file/deadline controls and the remaining comparative evaluation. |
| [import-enrichment-investigation.md](import-enrichment-investigation.md) | Actual import/stamp boundaries, private resumable enrichment controls and the remaining live model comparison. |
| [plans/README.md](plans/README.md) | Design for work that is not built yet. Normally at most one. |

## See also

- The agent contract (`@schlessera/brain/CONTRACT.md`) — the Layer-1 rules imported
  into every brain's `CLAUDE.md`.
- Each first-party module's own README for its full field reference.
