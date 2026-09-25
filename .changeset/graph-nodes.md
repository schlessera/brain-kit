---
"@schlessera/brain": minor
---

`brain_graph` now also returns `nodes`, with the `path`, `title`, `type`, `summary` and `updated` of every document its edges touch. An agent no longer needs one read per neighbour to learn what it is linked to. Unresolved link targets stay in `edges` only. Outgoing targets are resolved in the edge query itself instead of one lookup per edge, and `edges` is unchanged.
