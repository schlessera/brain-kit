---
"@schlessera/brain-ui-server": minor
---

BREAKING (pre-1.0, approved for 0.45.0): `propose_policy_change` now refuses previously accepted unclosed frontmatter, annotated opening fences such as `---yaml`, and closing prefixes such as `---x` or `----` before approval. Submit closed, standalone `---` delimiter lines, optionally followed by spaces/tabs. Accepted BOM, LF/CRLF and EOF forms retain exact bytes; valid replacements can still repair existing ambiguous policies. Other frontmatter parser callers are unchanged.
