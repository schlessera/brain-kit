---
"@schlessera/brain-ui-server": minor
---

Installation migration (breaking): the knowledge graph and the index-derived
voice vocabulary now read the brain index through core's supported
`@schlessera/brain/queries` entry instead of the server's own SQL, and
`@schlessera/brain` is a new **optional peer**. A host that serves the graph
view or keyterm-capable dictation must now add `@schlessera/brain` (same
lockstep version; `>=0.40.0 <1.0.0` is accepted) to its own dependencies.
Without it the server still boots: the five `/api/graph/*` endpoints answer
503 `graph_unavailable`/`core_unavailable`, keyterms degrade to an empty
vocabulary while pronunciation overrides keep working, and every other
feature is unaffected. The peer is resolved once per app and checked for
package identity, version range and required operations; there is no SQL,
PATH-CLI or subprocess fallback. Graph 500 bodies are now a sanitized
`internal_error`, a locked index answers 503 `index_busy`, an index claiming
the graph layout without its tables also refuses neighborhoods, and
`writeCache` (including the post-sync rebuild) never persists a degraded
vocabulary.
