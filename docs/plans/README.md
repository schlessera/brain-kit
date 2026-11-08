# Plans

Design for work that has **not been built yet**, and is too large to fit in an
issue body.

There is normally at most one of these. A plan exists because a body of work has
a shape that has to be agreed before any of it can start — the sequencing
matters, the units depend on each other, and a reader needs the whole thing to
judge any part of it. Once it ships, the plan stops being a plan: the durable
half moves to [`../decisions/`](../decisions/README.md) and the rest is deleted,
because the code has become the better answer to "what does this do".

| Plan | Design | Open work |
| --- | --- | --- |
| [async-collaboration.md](async-collaboration.md) | The cross-package containment and collaboration design. | [#51](https://github.com/schlessera/brain-kit/issues/51) |
| [async-collaboration-requirements.md](async-collaboration-requirements.md) | The requirements it came from. | [#51](https://github.com/schlessera/brain-kit/issues/51) |
| [index-query-api.md](index-query-api.md) | Consumer migration using supported query results, approved optional-peer/root-bound context boundaries, reader inventory and safe SQL retirement. | [#701](https://github.com/schlessera/brain-kit/issues/701) |
| [voice-conversation.md](voice-conversation.md) | Proposed turn-taking, screen and interruption model; requirements for the later speech-architecture ruling. | [#54](https://github.com/schlessera/brain-kit/issues/54) |
| [eleven-realtime-evaluation.md](eleven-realtime-evaluation.md) | Documentation-stage evaluation of Eleven Realtime v1 Max as a third live-conversation engine, the API choice, the unresolved nonblocking-result question and the prepared live probe. | [#3100](https://github.com/schlessera/brain-kit/issues/3100) |
| [host-owned-web-search.md](host-owned-web-search.md) | Pinned MCP/full-extension comparison, offline worker prototypes and authority boundaries for executor selection. | [#1863](https://github.com/schlessera/brain-kit/issues/1863) |
| [module-renderers.md](module-renderers.md) | The content-renderer seam, Mermaid on it, the diagram spec, computed geometry, the brain-kit skin, surface and print matrix, ordering, and the upstream sync procedure. | [#2079](https://github.com/schlessera/brain-kit/issues/2079) |
| [chat-attachments.md](chat-attachments.md) | Generic composer attachments: source inventory, capability matrix, routing, admission/ownership/cleanup schema, bounded on-demand reader, composer states and the proof briefs for #3153–#3155. | [#3150](https://github.com/schlessera/brain-kit/issues/3150) |
| [chat-history-deletion.md](chat-history-deletion.md) | Approved local deletion policy with unbuilt lifecycle design, retained-record boundaries and proof obligations. | [#3234](https://github.com/schlessera/brain-kit/issues/3234) |
| [reviewable-session-safety.md](reviewable-session-safety.md) | Proposed occurrence/coverage/review DTOs, finite limits, human authority and prospective trust publication; no runtime APIs implied. | [#3596](https://github.com/schlessera/brain-kit/issues/3596), [#3597](https://github.com/schlessera/brain-kit/issues/3597), [#3598](https://github.com/schlessera/brain-kit/issues/3598) |
| [selectable-dictation.md](selectable-dictation.md) | Dictation provider registration, discovery, precedence and per-take/upload binding; the Gemini 3.5 Transcribe Live provider/client transport; Voice-pane dictation states and the #3707–#3710 proof split. | [#3705](https://github.com/schlessera/brain-kit/issues/3705) |

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
