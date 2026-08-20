---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": minor
---

Confirm destructive Bash commands, and stop implying approvals are containment.

`Bash` is auto-allowed and the Agent SDK never consults `canUseTool` for an
allow-listed tool, so `brain archive x.md` typed into Bash ran with no prompt
while the identical operation through the `brain_archive` MCP tool raised an
approval card. The brain repo's own CLAUDE.md documents the CLI form, so the
gated path was the one an agent is least likely to take — the confirmation sat
on the road nobody drives.

A Bash command matching a configured pattern now raises the normal approval
card, from the `PreToolUse` hook. That hook is the right place for the same
reason the write lock lives there: it fires before every tool execution
regardless of how the tool was permitted. The prompt happens BEFORE the write
lock is taken, so a user deliberating does not block every other session.

The pattern list is configuration, not code: `BRAIN_UI_CONFIRM_BASH` takes a
JSON array of regex sources. Unset uses the shipped defaults (`brain archive`,
recursive `rm`, `git push --force`, `git reset --hard`, `git clean -f`,
`git checkout --`). An explicit `[]` disables confirmation and is honoured as
given. A malformed value falls back to the defaults rather than throwing — a
typo must not stop the server booting, and the safe direction to fail is more
confirmation, not less.

`brain archive` is on the list because archiving is a VISIBILITY change, not
because it is hard to undo. An archived document drops out of search, briefings
and context assembly, so a silent archive surfaces later as holes in output
nobody can account for.

SECURITY.md previously claimed "write-capable tools sit behind your agent's
permission gating". That was not true and is now corrected, with a section
stating plainly what approvals are: a seatbelt against a destructive command
you did not intend, not a control that stops an agent working around it. The
real boundary is auth.
