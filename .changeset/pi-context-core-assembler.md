---
"@schlessera/brain-backend-pi": patch
"@schlessera/brain": minor
---

The pi backend's `brain_context` tool now assembles its hits with core's assembler, the same one `brain context` uses. The pool of hits is sized from the budget, a hit that does not fit is skipped instead of ending the block, and each hit gets core's one-line header. Snippets no longer carry `>>>`/`<<<` highlight markers or open sections of their own. Identity and current focus stay out, since the pi session already loads them. Search warnings still lead the block, but only in whatever budget the block leaves. `@schlessera/brain` now exports `assembleContext`, `estimateTokens` and the `AssembleOptions` type. `AssembleOptions` takes a `warnings` array that collects the search's warnings.
