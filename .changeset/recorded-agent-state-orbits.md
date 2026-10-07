---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

Render Activity run subagents through AgentOrbit using recorded identities and
needs-you/running/ended rings. Denied and cancelled agents use the neutral
stopped state; no radius represents progress.

Pre-1.0 migration approved in #1145: callers must pass agents with stable id
and state. Remove orbit/angle props; the kit computes placement and accepts
an optional state ring. Pass coreMeta explicitly. Empty/missing data draws
no sample agents. RunState now includes stopped, also styled neutrally in
AgentRunCard. Phone hosts pass compact; labelled pills use onOpen(id) and
onOverflow callbacks, with a truthful count legend.
