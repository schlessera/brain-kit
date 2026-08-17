---
"@schlessera/brain": minor
"@schlessera/brain-module-jobs": minor
"@schlessera/brain-module-speaking": minor
---

Rewrite every skill description as a trigger, not a summary

A skill's description is the entire triggering mechanism — it is all an agent
sees when deciding whether the skill is relevant to what the user just asked.
Most of these descriptions were written as summaries: they led with what the
skill does and how it works, and appended a short "Use when …" clause at the
end. Some had no trigger at all.

All 24 shipped descriptions now lead with the situation that should pull the
skill in, phrased the way a user would actually put it, with mechanism left to
the body where it belongs. `content-hygiene`, `sync` and `talk-ideas` gained a
trigger they never had.

Three CI gates keep it that way: shipped skills must lint clean (no errors *and*
no warnings), must describe when to use them, and must stay within the
specification's 1024-character cap.
