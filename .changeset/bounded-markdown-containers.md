---
"@schlessera/brain": patch
---

Refuse excessive Markdown container prefixes before sync merge tokenization, preserving the existing unresolved nesting reason and avoiding quadratic work on deeply nested blockquotes.
