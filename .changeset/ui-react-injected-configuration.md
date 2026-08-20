---
"@schlessera/brain-ui-react": minor
---

Take backend URL and dev-tools configuration through `configureBrainUi()`
instead of reading `import.meta.env`.

`ui-server` already resolves its configuration once at the edge and never
touches the ambient environment below that point; this is the browser-side
mirror. The package read `VITE_BACKEND_URL` and `DEV` at module load, which
pinned it to Vite — a webpack or Next.js consumer had no way to reach a
split-topology backend at all, and no way to discover that from the types.
`scripts/check-env-access.ts` gained a fourth rule refusing `import.meta.env`
anywhere in a package's `src`, so the loophole cannot reopen.

**Breaking for direct importers:** the `API_BASE` constant is now the
`apiBase()` function. A constant would freeze the value at import time, and ES
imports are hoisted, so it would always capture the default rather than what
the shell configured. `configureBrainUi` gains `backendUrl` (empty = the
same-origin default) and `devTools`; both are optional.
