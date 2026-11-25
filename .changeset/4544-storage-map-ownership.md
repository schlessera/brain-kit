---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

The storage map shows ownership by tint, edge and label instead of hatching (#4544). Brain tiles have a solid edge, App an inner dotted edge, Operator a dashed edge and the "N smaller" aggregate a neutral outline. Labelled tiles start with the owner's letter (`A · Packs`) at any width; the legend decodes the letters. `StorageMap` gains optional `highlightedId`, `onHighlight` and `muted`; `StorageMapItem` is unchanged.

New presentational pieces for the breakdown: `StorageMapLegend` (owner chips with an edge sample, plus `? n stores · size unknown · not drawn`), `StorageConsumerList` (a sortable table with `aria-sort`), `StorageConsumerRow` (one button per row, `›` drills and `⋯` inspects, with a dashed `?` row for an unknown size), `StorageFilterRow` (checkbox and inspect as sibling cells, with Git facet, link evidence and an eligibility word), `StorageSelectionBar`, `StorageBreadcrumb` and `StorageSummaryRow` ("What this app added", taking the sparkline as a node). `storageUnknownReason` maps a store's reason to its short copy.

Settings › Storage's map description now names the new edges.
