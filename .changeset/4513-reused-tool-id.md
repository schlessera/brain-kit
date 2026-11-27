---
"@schlessera/brain-ui-react": patch
---

When differently named calls in one turn reuse a tool-use ID, the safety review shows the action as unknown instead of naming the first call, and the input appears once with the same count whether the steps are collapsed or expanded. The input sits on the first drawn step under the ID, never on an ask exchange that draws none. Once the client has observed two names under an ID, live or in any replay, including a replay without a turn ID or an empty one in between, the action stays unknown. Tool cards under a reused ID keep distinct identities, including after a history replay that carries both calls.
