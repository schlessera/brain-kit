---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

Answer a system share in the service worker

Second phase of the Android share target: `@schlessera/brain-ui-sdk/share-target`
is a new export holding the service-worker half — `registerShareTarget()`,
`handleShareTargetRequest()`, and an IndexedDB store that parks the payload
until the app can upload it.

A POST share target is a cross-site POST *navigation*, and it has to be answered
locally rather than by a server route, for two independent reasons. The session
cookie is `SameSite=Strict`, which is exactly the case such a navigation does not
carry — a server route would see an unauthenticated request with the payload
already consumed and unrecoverable. And answering locally keeps the payload on
the device until the app is authenticated and online, so a share made offline or
logged out is queued rather than lost. The handler therefore stashes the payload
and redirects to the app with `?share=<id>`.

It never rejects and never hangs: a browser mid-navigation has to land
somewhere, so a body that will not parse (what Chrome produces when the
manifest's `accept` lists an extension without its MIME type), an empty share, a
share past the caps, or a store that refuses — or takes longer than five seconds
to accept — the write each redirect with `?share_error=` for the app to explain.
The timeout matters because `indexedDB.open()` can hang with no event at all on
a corrupted backing store, and an unsettled response promise is a blank tab.

The caps the server enforces are enforced here too, before anything touches the
device: an oversized body is refused on `content-length` before `formData()`
buffers it whole in the worker, and file count, per-file size, total size and
text length are checked after parsing. Otherwise a share is written to the
user's own phone first and only refused minutes later, on upload.

`ShareStore.take()` reads and deletes in one transaction. The shell reloads
itself when a new worker takes over and a reload keeps the query string, so
`?share=<id>` can be read twice; the atomic claim is what stops one share being
filed into the knowledge base twice.

Anything reachable by the share sheet is also reachable by any website — a page
that auto-submits a cross-site form to the action URL is indistinguishable from
a real share, and `Sec-Fetch-Site` cannot tell them apart from inside a worker.
A stashed share is therefore untrusted input, and the client intake that follows
shows it on a confirmation card rather than acting on it.

The stash is bounded: after each successful stash the handler prunes records
older than `SHARE_STASH_TTL_MS` (24h), so a share abandoned behind a login
prompt does not sit on the device holding whole files forever.

No Workbox dependency — a plain `fetch` listener works with or without a router,
and Workbox's own routes are GET-only by default, so nothing competes for the
POST. It is a separate export subpath so a service worker can import it without
dragging in the renderer and ASR registries that `./client` holds. Persistence
stays concrete — the swap and in-memory implementations are named `*ForTests`
and are not part of the package's public exports, so this is a test hook and
not a storage seam.

`@schlessera/brain-ui-react` gains a dev-only `ShareHarness` component: it posts
the same multipart body to the same path from inside the page, through exactly
the same handler, stash and redirect. Everything except the manifest
registration itself can be verified without reinstalling the PWA — which on
Android means waiting for a WebAPK update.
