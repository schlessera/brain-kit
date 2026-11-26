---
"@schlessera/brain-ui-react": patch
---

When differently named calls in one turn reuse a tool-use ID, the safety review shows the action as unknown instead of naming the first call, and the input appears once with the same count whether the steps are collapsed or expanded. Tool cards under a reused ID keep distinct identities.
