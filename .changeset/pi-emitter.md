---
"@schlessera/brain": minor
---

Add a `pi` skill emitter

The extending docs stated that "the pi family needs no emitter — pi and
OMP-style agents discover `.agents/skills/` natively". That is not what pi does.
pi 0.80.6 loads skills from `<agentDir>/skills` (user level — `$PI_AGENT_DIR`,
else `~/.pi/agent`) and from `<cwd>/.pi/skills` (project level); its config
directory name is `.pi`, and `.agents/skills/` is never consulted. A brain's
skills were therefore invisible to pi while sitting one directory away.

The new `pi` emitter symlinks each skill into `.pi/skills/<name>`, structurally
identical to the `claude` emitter: relative links into the canonical
`.agents/skills/` home, a Windows junction fallback, stale-link pruning, and
never clobbering a real file or directory at the target path. Links rather than
copies, so a skill keeps exactly one source of truth.

Opt in with `skills: { emitters: ["pi"] }`. The docs are corrected.
