# Session-stable appends and owned new-turn context

The maintainer selected option B on [#2047](https://github.com/schlessera/brain-kit/issues/2047#issuecomment-6212451069)
on 2026-10-16, within the provider-history work tracked by
[#2053](https://github.com/schlessera/brain-kit/issues/2053).

A conversation retains one exact system append in internal session storage.
The model receives relevant changed facts only in newly appended user content
or equivalent new-turn hook context. Earlier provider messages, tool results,
tool arrays and the stored append remain unchanged. Authoritative host state,
change tracking and replay provenance remain internal. This is the selected
exception to the parent epic's internal-only wording, not an exception to
append-only provider history.

The fixed append carries static configured inference warn/stop limits.
Relevant device/capability, sandbox/profile/protected-path, writable-area,
journal/revert and actionable threshold changes belong in new context. Routine
running totals do not. Unknown device probes never mean absent hardware.
Enforcement remains in worker boundaries and permission/budget checks; a
prompt paragraph grants no authority.

Replay uses structured internal message ownership to present the actual
user's text. It never strips substrings or host-looking patterns. Literal
user-authored lookalikes remain intact. Delivery tracking must survive resumed
workers and retry after a send that never reached saved history.

Keeping every changed fact internal was rejected because the model would
retain stale device and operating facts until a refusal. Updating only
operational constraints was rejected because device and reading-layout facts
would remain stale. Rebuilding the system append was rejected because it
either changes the provider's cached prefix or is ignored by native system
snapshot recording. The selected new-tail addition costs context tokens on
later requests while preserving the existing prefix.

The provider-history guard's existing scope excludes native `cache_control`
breakpoint movement from message-content comparison: changing cache metadata
does not edit prior content. Other provider content remains compared exactly.
Offline fake-origin request-byte proof does not establish first-party provider
cache hits, savings or current account-specific snapshot availability.

[Session prompt context](../hosting/session-prompt-context.md) describes
first-turn facts, changes, unknowns, retries, persistence and the independent
Claude snapshot-off control. The broader provider-history record and its
cross-cause guards remain the scope of #2053.
