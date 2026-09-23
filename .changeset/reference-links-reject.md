---
"@schlessera/brain-ui-sdk": minor
---

A reference-style link, image or footnote (`[the docs][ref]`, `![alt][ref]`,
`[^note]`) now keeps its candidate out of the classification pass, as an inline
link already did. Before, it flattened to its text and lost where it pointed.
A `mailto:` at the end of another word (`notmailto:x@…`) is no longer taken for
the scheme and cut from the address.
