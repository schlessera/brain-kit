---
"@schlessera/brain-ui-react": patch
---

When calls in one turn reuse a tool-use ID, the safety input appears once, on the first drawn step under the ID, with the same count whether the steps are collapsed or expanded, and never on an ask exchange that draws no step. Tool cards under a reused ID keep distinct identities.
