---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain-backend-pi": patch
---

Activity-layer review follow-ups (the items deferred from the 0.19.0 review):

- **Watchdog** (ui-server): a per-job stuck-threshold override below the
  default now actually fires — the scan uses the smallest effective
  threshold, the per-span check still applies each job's own.
- **Push retry** (ui-server): `send_failed` intents are retried with a
  3-attempt budget and 5-minute backoff (migration 009 adds
  `send_attempts`) — a transient push-service failure no longer forfeits
  push delivery for that notification.
- **Restart notification** (ui-server): turns interrupted by a server
  restart now produce a failure intent — the boot orphan sweep runs after
  the notifier exists, so its terminal writes are seen by the first tick.
- **Digest** (ui-server): generation is one immediate transaction and the
  covered-until write is monotonic — a manual run racing the cron job can
  no longer double-count a window or regress the retention floor.
- **Prune index** (ui-server): migration 009 adds the partial index the
  hourly prune's candidate query needed and drops the unused
  `idx_activity_spans_session`.
- **PushToggle** (ui-react): now performs the server-disagreement check —
  a subscription bound to a stale VAPID key is dropped (surfacing the
  re-enable button) and a server-side pruned row is healed by re-asserting
  the subscription.
- **Span naming** (ui-sdk): the `execute_tool <name>`/`invoke_agent`
  convention is now exported protocol constants
  (`SPAN_OP_EXECUTE_TOOL`, `SPAN_OP_INVOKE_AGENT`, `SPAN_TOOL_NAME_PREFIX`)
  instead of three independent restatements.
- **pi usage** (backend-pi): the turn-usage accumulator narrows the SDK's
  typed `message_end` variant instead of a hand-rolled double cast.
