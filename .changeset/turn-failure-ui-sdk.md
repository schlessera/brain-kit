---
"@schlessera/brain-ui-sdk": minor
---

A turn whose model call failed now says so on the wire (#575). `result` and a bare turn-ending `error` gain an optional `failure` (`TurnFailure`: `errorClass`, `status?`, `message`, `authAction?`), replayed assistant messages gain the same `failure`, and a `status: "thinking"` frame gains an optional `retry` (`TurnRetry`) while the runtime backs off from a failed call. All additive: the schemas drop an unreadable `failure` or `retry` rather than the frame. `describeRetry` gives every backend and client one wording for a retry. `SubscriptionAuthAction`, `SUBSCRIPTION_AUTH_INSTRUCTIONS`, `SUBSCRIPTION_RELOGIN_PROCEDURE` and `subscriptionAuthAction` are now exported from `/protocol` as well as `/server`, so a client can show the #254 instructions. The shared backend contract suite gains optional `apiFailure` and `retrying` harness cases.
