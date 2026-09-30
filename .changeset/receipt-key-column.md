---
"@schlessera/brain-ui-kit": patch
---

`Receipt`: a key wider than its column no longer runs into its value. The key column is sized once per receipt, to the widest key, never narrower than `keyWidth` and never wider than 90px; a key past 90px wraps inside the column and is never cut. Receipts whose keys already fit render as before.
