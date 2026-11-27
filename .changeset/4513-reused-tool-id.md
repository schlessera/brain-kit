---
"@schlessera/brain-ui-react": patch
---

When differently named calls in one turn reuse a tool-use ID, the safety review shows the action as unknown instead of naming the first call, and the input appears once with the same count whether the steps are collapsed or expanded. The input sits on the first drawn step under the ID, never on an ask exchange that draws none. Once two names were seen under an ID, a later replay that carries only one of the calls still shows the action as unknown. Tool cards under a reused ID keep distinct identities, including after a history replay that carries both calls.
