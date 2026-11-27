---
"@schlessera/brain": patch
---

A supported-API local graph (`readGraphNeighborhood`) on a read-only index from before schema 9, which has no `links(target_id)` index, no longer scans `links` once per frontier node (#4878). A walk that follows in-links on such an index loads the link structure once and visits neighbours in the same ascending-id order as the indexed lookups, so it returns the same nodes and edges as on a current index. Schema 9 and later, and outbound-only walks, are unchanged.
