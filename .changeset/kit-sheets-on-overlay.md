---
"@schlessera/brain-ui-kit": patch
"@schlessera/brain-ui-react": patch
---

Move the Working and Pending follow-up sheets and the phone ModelPicker onto the kit Overlay's native modal coordination, preserving their contents and caller actions. Keep existing sheet chrome, inherit subtree themes without sheet portals, and enforce the removal of the two legacy overlay exceptions.
