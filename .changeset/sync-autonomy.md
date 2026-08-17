---
"@schlessera/brain": minor
---

Give the `sync` skill explicit autonomy rules

A sync is frequently unattended — on a schedule, from a container, or through an
agent runner with nobody watching. The skill did not say so, and an agent
applying its default caution would enter a plan-and-approve mode or stop to ask
a question, which in that setting means the sync simply never happens.

Adds an "Autonomy — no plans, no approval" section: never plan, never ask, take
the defined conservative default and report what was decided. It also names the
leftover repo state a previous interrupted run can leave behind — stale unmerged
index entries, stale `AUTO_MERGE` refs, autostash entries — as part of the job
rather than a reason to stop, and limits the allowed leftovers to genuinely
unresolvable items (malformed stash entries, binary conflicts, files over 100KB).

The rules hold in an interactive session too: every decision in the skill already
has a conservative default, so there is nothing worth stopping to ask about. This
is consistent with the rest of the skill, which warns, flags and reports but
never asks.
