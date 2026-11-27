---
"@schlessera/brain-ui-server": minor
---

Static SPA assets served from `staticRoot` now carry a cache policy (#4815). Every static response, including the `index.html` deep-link fallback, is `Cache-Control: no-cache`, unless the embedder names the build's content-hashed directory with the new optional `CreateAppOptions.staticImmutablePrefix` (for example `"/assets/"`): an existing file under it is served `Cache-Control: public, max-age=31536000, immutable`. A value that does not start and end with `/`, or `/` itself, is refused when the app is created. A `.br`, `.zst` or `.gz` sibling is served with `Content-Encoding` and `Vary: Accept-Encoding` to a request that accepts it. Embedders that pass `staticRoot` see the new headers even without the option.
