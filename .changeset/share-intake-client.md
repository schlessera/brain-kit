---
"@schlessera/brain-ui-react": minor
---

Pick up a system share and file it, behind one confirmation

Third phase of the Android share target: the app now claims what the service
worker stashed, shows it, and — once the user taps "Add to brain" — uploads it
to the staging directory and starts a chat session whose first turn reads,
stores and processes it. The user watches the tool timeline and keeps talking in
the same session.

**The confirmation is the security boundary, not a nicety.** The share target is
reachable by any website: a page that auto-submits a cross-site form to it is
indistinguishable from the system share sheet. Acting on a share automatically
would let a drive-by write into the knowledge base, spend subscription credit,
and put attacker-authored text in front of a model with tool access. So nothing
is uploaded and no turn starts until the arriving share has been shown — title,
url, text, thumbnails — and confirmed. A real share pays one tap.

Shares queue and run one at a time. That is also a correctness requirement, not
just pacing: the client holds a single unbound chat draft, so two turns started
before the first `session_info` arrives would land in the same buffer and the
second session's transcript would be dropped for the rest of the connection.

`?share=<id>` is moved into a localStorage claim and stripped from the URL
immediately, so the intake survives a login round-trip, a manual reload, and the
shell's own service-worker auto-reload — a reload preserves the query string,
and a second pass over the same id while the first upload was in flight would
file the share twice. `ShareStore.take()` makes the claim atomic underneath
that. Orphans are recovered from the stash by listing it, because a share whose
landing page never ran leaves a record nobody holds the id for.

`sendClientMessage()` is now exported from `use-websocket`: `useWebSocket()`
owns the socket through a per-instance guard, so a second caller would build a
second client and orphan the first. Anything that needs to send but not to own
goes through the module-level sender, which reports failure instead of dropping
silently.

`hasPendingShare()` is exported for the deployment shell's reload guard —
reloading mid-intake is exactly what the claim above protects against.

The upload does not go through `api-client`: `fetchJson` hardcodes a JSON
content type, which would break the multipart boundary, and flattens errors to a
message, discarding the `limit` a 413 carries — the only thing that lets the
card say which cap was hit.
