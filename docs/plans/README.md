# Plans

Design for work that has **not been built yet**, and is too large to fit in an
issue body.

There is normally at most one of these. A plan exists because a body of work has
a shape that has to be agreed before any of it can start — the sequencing
matters, the units depend on each other, and a reader needs the whole thing to
judge any part of it. Once it ships, the plan stops being a plan: the durable
half moves to [`../decisions/`](../decisions/README.md) and the rest is deleted,
because the code has become the better answer to "what does this do".

| Plan | Design |
| --- | --- |
| [async-collaboration.md](async-collaboration.md) | The cross-package containment and collaboration design. |
| [async-collaboration-requirements.md](async-collaboration-requirements.md) | The requirements it came from. |
| [policy-write-boundary.md](policy-write-boundary.md) | U10's measured filesystem boundaries, escape cases and worker/effect-route ruling required before implementation. |
| [index-query-api.md](index-query-api.md) | Proposed supported content-index results, reader inventory, package/context choices and safe SQL retirement. |
| [voice-conversation.md](voice-conversation.md) | Proposed turn-taking, screen and interruption model; requirements for the later speech-architecture ruling. |

## What does not live here

- **Status.** No plan in this directory carries a `status:` field, a unit
  checklist, or a progress log. Four plans used to, and every reader had to work
  out which lines were still true. Open work is in the issue tracker; see
  [`../process/github.md`](../process/github.md).
- **Decisions that bind future work.** Those go in
  [`../decisions/`](../decisions/README.md) the moment they are made, not when
  the plan closes.
- **Anything already built.** If it shipped, this is the wrong directory.

## Writing one

Most work does not need a plan. An epic with sub-issues carries sequencing
perfectly well, and it has the advantage of being where the work actually
happens.

Write a plan when all three are true: the work spans several packages, the units
have a required order, and getting that order wrong is expensive. The
async-collaboration plan is the example — its containment unit is on the
critical path because autonomous execution over untrusted content without
containment is the thing you do not ship, and that constraint is invisible from
any single unit.

When it is written, file the epic and let the epic point here. Do not maintain
both.
