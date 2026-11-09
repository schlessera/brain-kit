---
"@schlessera/brain-ui-server": patch
---

Undoing a media effect from hygiene review now updates the review's media count when another card is pending or the pass has ended. Before, the count kept the undone effect until the next selection, so it disagreed with `brain sync`.
