---
"@schlessera/brain-ui-server": patch
---

The human-owner check outside `app.ts` is one predicate, `isHumanOwner`, and the storage maintenance, attachment removal and turn revert routes share one `requireHumanOwner` middleware (#4757). A human owner is a principal of kind `owner` or `ambient` that did not authenticate by delegation, which was already the rule of the live-persona routes and the conversation host. No principal the server writes changes outcome at any route: the server never pairs kind `owner` with a delegated auth method, so the extra condition only refuses a hand-built row the schema does not forbid. Every status code, body and header stays the same.
