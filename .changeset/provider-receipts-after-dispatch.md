---
"@schlessera/brain-ui-sdk": patch
---

The CLI provider relay now publishes a provider attempt receipt only for an attempt whose upstream request actually started (#4370). An ordinary relay, Gemini Files or Files-cleanup attempt refused at preparation, at the final charge or egress fence, at dispatch, or by a request constructor that throws synchronously no longer reports a `cancelled` receipt, so the host books no usage row and no unknown spend for work that never left the host. The caller's refusal and the `refused` diagnostic are unchanged. A started attempt still reports `dispatched` and exactly one terminal outcome, now also when its dispatch fails after the request started.
