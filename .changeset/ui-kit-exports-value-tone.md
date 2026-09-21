---
"@schlessera/brain-ui-kit": patch
---

`ValueTone` and `InkTone` are exported from the package root. Several block
props were already typed with `ValueTone` (`StatTile.tone`,
`ComparisonColumn.tone`, `ReceiptRow.tone`, `ContactFact.tone`), so a consumer
could receive the type but not name it.
