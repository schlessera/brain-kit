---
"@schlessera/brain-ui-kit": patch
---

End the loading ghost's handoff when its fade ends, not 600ms after the data arrives, so a late first frame no longer removes the ghost from partial opacity. Where no fade runs (reduced motion, `animation: none`) the handoff still ends after 600ms.
