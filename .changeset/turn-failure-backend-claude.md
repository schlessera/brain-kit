---
"@schlessera/brain-backend-claude": minor
---

A failed API call no longer ends a Claude turn as a success (#575). A `result` with `subtype: "success"` and `is_error: true` now ends the turn with `outcome: "error"` and a `failure` that carries the class from the runtime's API-error message, the status from `api_error_status`, and the runtime's text. The API-error message is no longer dropped. A stream that ends after one without a `result` still carries its failure. On a subscription profile, an auth failure also carries its `authAction`, and a turn the subscription gate refuses carries `subscription_required` with `check_config`. `api_retry` messages become `status: "thinking"` frames with a `retry` and a readable `detail`. After a reload, the history reader turns the runtime's API-error message into the assistant message's `failure` instead of prose.
