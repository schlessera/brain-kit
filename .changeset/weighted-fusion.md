---
"@schlessera/brain": patch
---

Hybrid search weights its two lanes when it fuses them. The vector lane keeps weight 1 and the full-text lane gets 0.8. When the full-text lane returns fewer candidates than half the result limit, its weight drops to 0.05. A few weak text matches then count for much less: appearing in both lists no longer lifts a document far down the vector lane above the vector lane's first place, though an overlap already near the top can still pass it. When the full-text lane is full, a document that both lanes rank well still comes first. The constants are provisional until a keyed `brain eval` measures them (#468).
