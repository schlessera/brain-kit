---
"@schlessera/brain": patch
---

Hybrid search weights its two lanes when it fuses them. The vector lane keeps weight 1 and the full-text lane gets 0.8. When the full-text lane returns fewer candidates than half the result limit, its weight drops to 0.05, so a few weak text matches can no longer outvote the vector lane's first place just by appearing in both lists. A document that both lanes rank well still comes first. The constants are provisional until a keyed `brain eval` measures them (#468).
