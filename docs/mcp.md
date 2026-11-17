# MCP Server Reference

A stdio MCP server exposing the brain to any MCP-capable agent (Claude Code,
desktop clients, editors). Tool names and input schemas are contract-stable —
see [integration-contract.md](integration-contract.md).

## Registration

```sh
claude mcp add brain -- bun node_modules/.bin/brain mcp
```

Run registration from your brain repository. The template already ships a
project-scoped `.mcp.json`, so a client that reads it needs no duplicate entry.
Approve the server in your client's interface if required. `brain doctor`
checks configuration; it does not prove that the current agent loaded this
brain's tools. `/brain-init` reads `me/identity.md` through an in-session MCP
tool and compares it with the file on disk to check the responding brain.
The remaining live onboarding verification is tracked in
[#26](https://github.com/schlessera/brain-kit/issues/26).

For other clients, configure a stdio server with command `bun`, arguments
`["node_modules/.bin/brain", "mcp"]` and this brain repository as its working
directory. MCP access and [skill discovery](extending/skill-emitters.md) are
separate setup steps.

`brain mcp` starts the stdio server in-process. If the packaged bin is not
available while developing from a source checkout, the source entry remains a
fallback:

```sh
claude mcp add brain -- bun packages/core/src/mcp-server.ts
```

## Instructions

At `initialize` the server sends a short paragraph of `instructions`, which
clients such as Claude Code put into the agent's context. It tells the agent
that the brain is the source of truth for facts about its owner (named from
`profile.name` in `brain.config`), which tool to use to search, brief, read and
follow links, and to write through `brain_add` and `brain_update` rather than
touching `brain.db`. It also says the `brain_apify_*` tools are paid remote
extraction under your governance policy, not web search.

## Tools

| Tool | Kind | structuredContent |
|---|---|---|
| `brain_search` | read-only | `{ results, warnings }` — same envelope as the CLI |
| `brain_context` | read-only | `{ context, warnings }`; with `include`/`exclude` paths, also `coverage`: what the briefing holds and what it left out ([scoped context](integration-contract/mcp.md#scoped-context-additive-0450-3644)) |
| `brain_read` | read-only | file text; `section` returns one section, and `max_tokens` returns the frontmatter and an outline when the file is larger. `max_tokens` is a threshold, not a cap on the output |
| `brain_list` | read-only | `{ documents, warnings }` |
| `brain_read_many` | read-only | one JSON text block: up to 20 documents or sections under one size cap, each `full`, `outline`, `partial` (with where to continue), `duplicate` or `error` ([bounded multi-read](integration-contract/mcp.md#bounded-multi-read-additive-0450-3642)) |
| `brain_graph` | read-only | `{ edges, nodes, warnings }` — the wiki-link graph, and the title, type, summary and date of each document in it |
| `brain_add` | write (non-destructive) | ingest result object |
| `brain_update` | write (idempotent) | update result object |
| `brain_archive` | write (idempotent) | archive result object |
| `brain_compute_health` | read-only (asks the provider) | configured compute instances and readiness |
| `brain_compute_plan` | read-only | admission without effect: lease, source manifest, estimate |
| `brain_compute_run` | external effect, may cost money | starts a job and returns its id once started |
| `brain_compute_status` | external effect (advances the job) | state, exit, cleanup and cost |
| `brain_compute_cancel` | destructive | cancels and reports whether release was confirmed |
| `brain_compute_collect` | external effect (advances the job) | bounded output and artifact references |
| `brain_apify_discover`, `brain_apify_inspect`, `brain_apify_prepare`, `brain_apify_run`, `brain_apify_status`, `brain_apify_results`, `brain_apify_abort` | open-world; only `run` and `abort` change anything | the Apify envelope, as `brain apify --json` prints it |

Notes:

- Read tools append an **index-staleness warning** when markdown files are
  newer than their indexed state — the agent learns the index lags without a
  failed call.
- Type filters in tool schemas are generated from your effective taxonomy, so
  an agent sees *your* document types, not a hardcoded list.
- Writes go through the same ingestion path as `brain add` — markdown files
  are written and the index syncs; the database is never the source of truth.
- Search degradation (no embeddings key, model mismatch) is reported in
  `warnings`, identical to the CLI.
- The six `brain_compute_*` tools (0.45.0+) are the
  [`brain compute`](cli.md#external-compute) operations with the same
  envelopes. They are listed whether or not `compute` is configured, so the
  tool roster never depends on it; without a configured instance they refuse
  with `compute_disabled`. Jobs belong to the server process's user and are
  not visible to `brain compute` in a shell. `brain_compute_run` returns once
  the command has started, and the server keeps advancing the jobs it started
  until it exits. See the
  [contract](integration-contract/mcp.md#external-compute-tools-additive-0450-3107).
- The Apify tools stay off until the governance policy sets
  `apify.enabled: true`. They then need `APIFY_TOKEN` and `BRAIN_APIFY_LEDGER`
  in the server's environment, and nobody can be asked from here: a run
  needs an exact standing grant in the policy, otherwise it refuses as
  `approval_required`. See [the CLI](cli.md#apify) and
  [the contract](integration-contract/mcp.md#apify-tools-additive-0450-3162).

## Module tools

Available in 0.40.0+. Published 0.39.0 serves the eight core tools only.

Enabled modules may declare tools served as `<module>_<local>`, after the
core tools in config and declaration order. Discover them through
`tools/list`; their descriptions, input and output schemas, and annotations
travel with each entry. Server instructions continue to describe core tools.
Module tools follow the same compatibility policy as core tools, with each
module documenting the supported surface of its own tools.

Each call receives its module's validated config and the effective taxonomy.
Input and output use strict schemas. Results provide structured content and
a compact JSON text copy; invalid calls and failed operations return tool
errors. Client cancellation aborts the call's signal, allowing the operation
to stop; effects already completed remain completed.

A module dormant at server startup contributes no tools to `tools/list`, and
its tool definitions are not imported. Registration uses the shared loaded
module state. `brain module list --json` still shows its declared tool names,
so the owner can see what activation would add. Dormancy controls context; it
is not permission revocation.

Definitions load once at server startup. If one definition fails, none of
that module's tools are registered; other modules and core still work. The
failure is reported on stderr and in core tools' warnings. Invalid module
declarations instead trigger the existing degraded core mode for an invalid
config.

The tool list stays fixed until the process restarts, with no list-changed
notifications. A config edit takes effect in the next process and does not
revoke a running process's tools. A stale name that was not registered returns
`MCP error -32602: Tool <name> not found`. Annotations do not grant backend
permissions; a module tool needs the same explicit name-based permission as
other tools.

See [Module tools in the integration contract](integration-contract/mcp.md#module-tools)
and the [module-tool decision](decisions/module-mcp-tools.md).

See also: [cli.md](cli.md) · [integration-contract.md](integration-contract.md)
