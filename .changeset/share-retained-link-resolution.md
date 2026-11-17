---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain": patch
---
Fix hosted shares that retain a file never completing. `complete_share` now accepts a retained file's Markdown link when it resolves to the retained path from the filed note's own folder — document-relative (`../../assets/x.pdf`), brain-root-absolute (`/assets/x.pdf`) or root-relative from a root-level note, including percent-encoded spaces — and its refusal names the expected target with an example link. Links inside code and wiki-links still do not count. When a note was rewritten, the receipt matching its current content proves it, and a stale receipt is refused by name. A filing turn that ends without completing no longer spends the share's retry attempts, so a share can still complete once its filing is fixed; a share earlier turns left `failed` is recovered by its filing session. The `complete_share` description and the share skill state the accepted link forms.
