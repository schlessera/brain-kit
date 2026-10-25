---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-pi": patch
---

A governed or strict pi turn no longer waits for a full journal observation after a call that is proven read-only (#2834). The host observes after every tool result unless the backend reported, from what the call actually did, that it ran a host bridge read (`brain_read_base`, `query_activity`, `inbox_list`, `inbox_get`, `show_block`, `ask_user*`, `get_current_location`) or pi's own `read_file`, no other call is still running, and no call in the turn could still be writing in the background. `bash`, `grep`, `brain_search` and the other index tools, extension tools, unknown tools and every Claude tool are observed as before, and after one of them every later result in that turn is observed too. Writers are observed after their own result. Only a pi worker that loads no extensions (`loadExtensions: false`, or a restricted autonomous turn) reports this evidence: with extensions loaded, the default, every result is observed as before. Turn begin and finish, the 15-second observation and scope-limit enforcement are unchanged.
