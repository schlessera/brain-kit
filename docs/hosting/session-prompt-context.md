# Session prompt context

The [session prompt context decision](../decisions/session-prompt-context.md)
records the selected policy and rejected alternatives.

Interactive Claude and Pi conversations retain the exact first system append
in host-owned session storage outside the brain. Claude also explicitly asks
the installed runtime to snapshot its rendered system prompt. The host copy
keeps the append stable when runtime snapshot recording is unavailable; a
worker restart or a changed device does not rebuild it from new facts.

The fixed append contains the response surface, execution guidance, stable
bridge-tool descriptions and the configured inference warn/stop limits.
Running usage, reading width, device probes, sandbox/profile/protected-path
facts, writable areas and journal/revert availability are current-turn facts.
Their first known values and relevant changes reach the model only after the
new user's text in that new message. An unchanged acknowledged fact adds no
new context. Prompt text grants no permission: worker mounts, tool boundaries
and budget checks continue to enforce the actual current state.

The host keeps the user's original text, a digest of the exact transmitted
text and its provider-message identity as internal ownership records. Replay
uses those records without editing provider transcripts or matching a textual
host-block pattern. A user's literal lookalike block remains their text. A send that never reaches
saved native history does not mark facts delivered. Claude acknowledges
only an exact UUID/text match in the saved native transcript after copy-out;
Pi binds the host record to the new user entry in the worker's transcript
snapshot. For image normalization, the host records the complete observed
provider text digest at that delivery boundary, including native hints; replay
uses that exact ownership record and never infers a removable suffix. Retries
therefore retain facts that never reached saved history.

Camera and microphone values remain unknown until enumeration settles.
Unknown is withheld from absence claims; a settled probe can explicitly report
absence. The welcome and message states both expose the same capped reading
column, so the first message does not measure the whole window.

Restricted autonomous turns retain their separate immutable envelope and do
not use conversation snapshots or this host context ledger. For a conversation
created before host snapshots existed, the host retains the first append it
observes after upgrade; it cannot retroactively change earlier provider
requests. Native Claude prompt recording, where available, continues to retain
that conversation's original rendered system prompt.

Offline tests run three turns through the real installed Claude CLI and fresh
Pi workers against loopback fake origins. Claude is checked both with native
snapshot recording requested and explicitly disabled. The tests capture the
request bodies and compare system bytes and prior message content.
As specified by the provider-history guard, native `cache_control` breakpoint
movement is the sole ignored message metadata field. These checks establish
request stability, not first-party cache hits or savings.

The fixed lifecycle brief uses no per-turn duration. The exact current timeout
travels as a changed-only tail fact, so a later timeout change cannot leave
the model with the first turn's number. Enforcement still uses the current
host deadline independently of this advisory text.

Capability booleans reuse the backend's current handler/posture availability
predicate. They are advisory availability facts, not permission grants; tool
allowlists, input-sensitive confirmations and server policy still decide each
call. Inbox read handlers are reported independently from write handlers.
Claude voice controls use enforced no-grant posture; Pi refuses voice before
inference and delivers no new prompt context for that rejected request.
