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
| `BRAIN_CHROME_NO_SANDBOX` | "1" launches the render Chrome without its sandbox (required when running as root). | sandbox on |
| `BRAIN_RERANK_MODE` | Search reranker mode: "jev", "heuristic" or "none". Overrides the configured `reranker.provider`; an explicit --rerank still wins. | the configured reranker (jev with its key, else heuristic) |
| `BRAIN_ROOT` | Brain repository root, overriding cwd-based discovery. | nearest ancestor with brain.config.* or .git, else cwd |
| `BRAIN_UI_CHROME_NO_SANDBOX` | Same as BRAIN_CHROME_NO_SANDBOX, in the BRAIN_UI_* spelling a chat-server deployment sets; the server passes it to the brain CLI it spawns. | sandbox on |
| `CLAUDE_CODE_PATH` | Claude Code binary the Claude agent runner spawns, as for the chat server. | the Agent SDK's built-in binary when the SDK is installed, else `claude` on PATH |
| `GEMINI_API_KEY` | Default API key for the built-in Gemini embedding/completion providers (default name only — a config `apiKeyEnv` can point elsewhere). Absent key degrades vector search to FTS. | — |
| `NO_COLOR` | Any non-empty value suppresses ANSI color in CLI output. | — |
| `TYPESAFE_API_KEY` | Default API key for the built-in jev search reranker (default name only — a config `apiKeyEnv` can point elsewhere). Absent key keeps the lifecycle (heuristic) ordering. | — |
| `XDG_BIN_HOME` | Directory the `brain` CLI symlink is installed into. | ~/.local/bin |

Reads whose variable *name* is configuration rather than code:

| Name comes from | What the value is used for |
| --- | --- |
| brain.config `embeddings.apiKeyEnv` / `completions.apiKeyEnv` / `reranker.apiKeyEnv` | API key for a built-in provider, read at call time under whatever name the config declares (defaults: GEMINI_API_KEY, ANTHROPIC_API_KEY, TYPESAFE_API_KEY). |

Generated from `packages/core/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->
