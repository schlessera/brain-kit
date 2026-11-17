---
"@schlessera/brain-ui-server": patch
---

A scheduled job that keeps failing now notifies again (#3354). Before, a failure notification nobody acknowledged in Activity muted every later failure of the same job, so a nightly job could fail for weeks without another push. Repeats inside a 12-hour quiet window still coalesce into one notification; a failure after it supersedes the unacknowledged one with a fresh notification that says how many runs in a row have failed and for how long, without job output or error text. Opening a push notification still does not acknowledge it, and a failure seen while someone was watching the run is still recorded without a push.
