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
touching `brain.db`.

## Tools

| Tool | Kind | structuredContent |
|---|---|---|
| `brain_search` | read-only | `{ results, warnings }` — same envelope as the CLI |
| `brain_context` | read-only | `{ context, warnings }` |
| `brain_read` | read-only | file text; `section` returns one section, and `max_tokens` returns the frontmatter and an outline when the file is larger. `max_tokens` is a threshold, not a cap on the output |
| `brain_list` | read-only | `{ documents, warnings }` |
| `brain_graph` | read-only | `{ edges, nodes, warnings }` — the wiki-link graph, and the title, type, summary and date of each document in it |
| `brain_add` | write (non-destructive) | ingest result object |
| `brain_update` | write (idempotent) | update result object |
| `brain_archive` | write (idempotent) | archive result object |

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

## Module tools

Available in 0.40.0+. Published 0.39.0 serves the eight core tools only.

Enabled modules may declare tools served as `<module>_<local>`, after the
eight core tools in config and declaration order. Discover them through
`tools/list`; their descriptions, input and output schemas, and annotations
travel with each entry. Server instructions continue to describe core tools.
Module tools follow the same compatibility policy as core tools, with each
module documenting the supported surface of its own tools.

Each call receives its module's validated config and the effective taxonomy.
Input and output use strict schemas. Results provide structured content and
a compact JSON text copy; invalid calls and failed operations return tool
errors. Client cancellation aborts the call's signal, allowing the operation
to stop; effects already completed remain completed.

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

See [Module tools in the integration contract](integration-contract.md#module-tools)
and the [module-tool decision](decisions/module-mcp-tools.md).

See also: [cli.md](cli.md) · [integration-contract.md](integration-contract.md)
