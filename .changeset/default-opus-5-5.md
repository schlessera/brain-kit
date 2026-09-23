---
"@schlessera/brain-ui-server": minor
---

The built-in Claude profile now defaults to `claude-opus-5-5` (Claude Opus 5.5)
when `BRAIN_UI_CLAUDE_DEFAULT_MODEL` is unset; it was `claude-sonnet-4-6`.
Setting the variable still overrides it. The default is now written once, so
the documented default and the one a deployment actually gets cannot drift
apart again. Opus 5.5 is priced at $4 / $20 per million input / output tokens
in the current litellm catalog; offline, before the catalog has been fetched,
its runs count as unpriced rather than as $0.
