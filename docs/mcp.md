# MCP Server Reference

A stdio MCP server exposing the brain to any MCP-capable agent (Claude Code,
desktop clients, editors). Tool names and input schemas are contract-stable —
see [integration-contract.md](integration-contract.md).

## Registration

```sh
claude mcp add brain -- bun node_modules/.bin/brain mcp
```

The template ships a project-scoped `.mcp.json` with this entry, so agents that
read project MCP config need no registration step. `/brain-init` verifies the
registration with an in-session `brain_search` call; `brain doctor` checks it.

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

See also: [cli.md](cli.md) · [integration-contract.md](integration-contract.md)
