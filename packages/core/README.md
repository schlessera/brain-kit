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
| `BRAIN_RERANK_MODE` | Search reranker mode: "heuristic" or "none". | heuristic |
| `BRAIN_ROOT` | Brain repository root, overriding cwd-based discovery. | nearest ancestor with brain.config.* or .git, else cwd |
| `BRAIN_UI_CHROME_NO_SANDBOX` | Same as BRAIN_CHROME_NO_SANDBOX — the spelling the brain-ui Docker image already sets. | sandbox on |
| `GEMINI_API_KEY` | Default API key for the built-in Gemini embedding/completion providers (default name only — a config `apiKeyEnv` can point elsewhere). Absent key degrades vector search to FTS. | — |
| `NO_COLOR` | Any non-empty value suppresses ANSI color in CLI output. | — |
| `XDG_BIN_HOME` | Directory the `brain` CLI symlink is installed into. | ~/.local/bin |

Reads whose variable *name* is configuration rather than code:

| Name comes from | What the value is used for |
| --- | --- |
| brain.config `embeddings.apiKeyEnv` / `completions.apiKeyEnv` | API key for a built-in provider, read at call time under whatever name the config declares (defaults: GEMINI_API_KEY, ANTHROPIC_API_KEY). |

Generated from `packages/core/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->
