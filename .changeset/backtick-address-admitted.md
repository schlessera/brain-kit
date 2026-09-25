---
"@schlessera/brain-ui-sdk": patch
---

A bare address with a backtick in it, such as `` <eury`bates@ithaca.example> `` or a URL whose path holds one, now flattens to its text like any other bare address. Before, it kept the whole table, list, quote or key-value run it sat in out of the classification pass.
