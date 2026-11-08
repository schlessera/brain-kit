---
"@schlessera/brain-backend-claude": patch
---

The Claude backend's turn runner is now split into its terminal state, host inference relay, prompt gate, runtime reporting and stream loop. Turns behave as before: frames, outcomes, refusals and cleanup are unchanged.
