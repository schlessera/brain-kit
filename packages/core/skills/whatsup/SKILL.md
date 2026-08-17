---
name: whatsup
description: Use for a catch-up on what deserves attention right now — a morning briefing, an on-demand check for anything urgent, overdue, or coming up soon, or a quick answer to what should be worked on next.
---

# What's Up — Dynamic Daily Briefing

Produces a compact, scannable briefing of what needs attention right now. The structure changes
every time based on what's actually going on — this is not a fixed template.

**This skill orchestrates; `brain briefing` supplies the data.** The mechanical layer (`brain
briefing`) filters and sorts; the interpreting layer is the agent (or, in a non-interactive
context, the configured completions provider). Don't re-query the database — briefing already did.

## Input

None. This skill takes no input.

## 1. Gather data

```bash
brain briefing
```

This emits only the sections that have data: Current Focus, Focus-Linked Documents, Upcoming
Deadlines, Overdue Reviews, Recently Active docs, Silently Modified files, and Stale Context
warnings.

## 2. Read 1–3 files for detail (optional)

If something looks actionable but the summary is thin (e.g. an opportunity in "negotiating"
status, a conference with an imminent deadline), read those specific files for the key detail.
Read **no more than 3** files total.

## 3. Produce the briefing

Interpret everything and write a compact output:

- **No predefined sections.** Organize by what's actually urgent. Lead with deadlines if there are
  any; highlight a pending negotiation; if everything is quiet, say so in three lines.
- Lead with the most time-sensitive or decision-requiring items.
- Group related items naturally; distinguish "needs action" from "FYI".
- Terse bullet points, no prose, no filler. Target 15–30 lines, scannable in about 10 seconds.
- Omit any section that would have zero items.

## Notes

- Speed matters: one data call, minimal follow-up reads, then output.
- Current focus is the anchor — it defines what matters right now; everything else is supporting
  context.
- Silently modified files (filesystem mtime > frontmatter `updated`) are edits made without
  bumping frontmatter — worth flagging.
- Overdue reviews come from `next_review`; upcoming deadlines from `deadline`. If a field has no
  data, its section is simply absent.
- When invoked from a terminal wrapper, output goes straight to the terminal — keep it clean.

## CLI it relies on

- `brain briefing` — assembles all briefing data from the indexed database.
