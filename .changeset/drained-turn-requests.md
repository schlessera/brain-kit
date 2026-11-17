---
"@schlessera/brain-ui-server": patch
---

A question, tool approval, location or mask request that a backend raises after its turn's pending requests were drained (for example when the host's turn limit ran out before the question reached the bridge) is now refused at once with the drain's reason, instead of waiting forever and holding the session's turn open. A refused question is recorded as closed, so a late answer is told the question ended.
